import { Migration } from '@mikro-orm/migrations';

// Segunda migration: as transações de aposta. Aqui mora a idempotência persistente
// (as duas chaves únicas) e a regra de que ninguém reverte a mesma referência duas vezes.
export class CreateWagerTransactions extends Migration {
  override up(): void {
    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        status text not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        -- id da referência no provedor (é assim que a referência chega no payload)
        reference_external_transaction_id text,
        -- id interno da referência, preenchido quando eu consigo resolver
        reference_transaction_id uuid references wager_transactions (id),
        failure_code text,
        -- saldo da wallet no momento em que eu decidi a transação (para o replay devolver o mesmo)
        observed_balance numeric(19,2),
        -- controle do worker de PENDING_REFERENCE
        reference_attempts integer not null default 0,
        next_reference_check_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        updated_at timestamptz not null,

        -- idempotência persistente: a mesma chave nunca entra duas vezes
        constraint wager_transactions_idempotency_key_uq unique (idempotency_key),
        -- e o mesmo id do provedor também não
        constraint wager_transactions_provider_external_uq unique (provider_id, external_transaction_id),

        constraint wager_transactions_text_not_blank check (
          btrim(provider_id) <> '' and btrim(external_transaction_id) <> ''
          and btrim(idempotency_key) <> '' and btrim(payload_hash) <> ''
          and btrim(player_id) <> '' and btrim(round_id) <> '' and btrim(game_id) <> ''
        ),
        constraint wager_transactions_kind_valid check (
          kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        constraint wager_transactions_status_valid check (
          status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        constraint wager_transactions_failure_code_valid check (
          failure_code is null or failure_code in (
            'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'REFERENCE_NOT_FOUND',
            'REFERENCE_KIND_INVALID', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_MISMATCH',
            'AMOUNT_MISMATCH', 'ALREADY_REVERSED', 'WALLET_NOT_FOUND',
            'WALLET_CURRENCY_MISMATCH', 'WALLET_PLAYER_MISMATCH', 'INTERNAL_ERROR'
          )
        ),
        constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
        -- valor positivo em todos os tipos, só LOSS pode ser zero
        constraint wager_transactions_amount_valid check (amount >= 0 and (amount > 0 or kind = 'LOSS')),
        -- REFUND e ROLLBACK exigem referência; BET e OPENING não podem ter
        constraint wager_transactions_reference_by_kind check (
          (kind in ('REFUND', 'ROLLBACK') and reference_external_transaction_id is not null)
          or (kind in ('BET', 'OPENING') and reference_external_transaction_id is null)
          or kind in ('WIN', 'LOSS')
        ),
        constraint wager_transactions_reference_not_blank check (
          reference_external_transaction_id is null or btrim(reference_external_transaction_id) <> ''
        ),
        constraint wager_transactions_reference_not_self check (
          reference_transaction_id is null or reference_transaction_id <> id
        ),
        -- código de falha só existe em REJECTED e FAILED, e eles sempre têm código
        constraint wager_transactions_failure_code_by_status check (
          (status in ('REJECTED', 'FAILED')) = (failure_code is not null)
        ),
        -- processed_at só existe em PROCESSED, e PROCESSED sempre tem
        constraint wager_transactions_processed_at_by_status check (
          (status = 'PROCESSED') = (processed_at is not null)
        ),
        constraint wager_transactions_processed_has_balance check (
          status <> 'PROCESSED' or observed_balance is not null
        ),
        constraint wager_transactions_reversal_has_reference check (
          status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null
        ),
        constraint wager_transactions_observed_balance_valid check (
          observed_balance is null or observed_balance >= 0
        ),
        constraint wager_transactions_attempts_valid check (reference_attempts >= 0),
        constraint wager_transactions_next_check_by_status check (
          status = 'PENDING_REFERENCE' or next_reference_check_at is null
        )
      )
    `);

    // Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.
    // Eu uso índice único parcial: só conta quem já foi PROCESSED.
    this.addSql(`
      create unique index wager_transactions_reversal_once_uq
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    `);
    // Índice do worker que reprocessa referências que chegaram fora de ordem.
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_reference_check_at, id)
        where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      create index wager_transactions_wallet_created_idx
        on wager_transactions (wallet_id, created_at desc)
    `);

    // Esse trigger faz o banco respeitar a máquina de estados:
    // terminal não muda mais, campos de identidade não mudam, e só as transições válidas passam.
    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions: rows cannot be deleted' using errcode = 'check_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager_transactions: a % transaction cannot change anymore', old.status
            using errcode = 'check_violation';
        end if;
        if new.id is distinct from old.id
           or new.provider_id is distinct from old.provider_id
           or new.external_transaction_id is distinct from old.external_transaction_id
           or new.idempotency_key is distinct from old.idempotency_key
           or new.payload_hash is distinct from old.payload_hash
           or new.wallet_id is distinct from old.wallet_id
           or new.player_id is distinct from old.player_id
           or new.round_id is distinct from old.round_id
           or new.game_id is distinct from old.game_id
           or new.kind is distinct from old.kind
           or new.amount is distinct from old.amount
           or new.currency is distinct from old.currency
           or new.reference_external_transaction_id is distinct from old.reference_external_transaction_id
           or new.created_at is distinct from old.created_at then
          raise exception 'wager_transactions: identity and business fields are immutable'
            using errcode = 'check_violation';
        end if;
        if new.status <> old.status and not (
          (old.status = 'PENDING' and new.status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
          or (old.status = 'PENDING_REFERENCE' and new.status in ('PROCESSED', 'REJECTED', 'FAILED'))
        ) then
          raise exception 'wager_transactions: invalid status transition from % to %', old.status, new.status
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wager_transactions_guard_trg before update or delete on wager_transactions
        for each row execute function wager_transactions_guard()
    `);
    this.addSql(`
      create trigger wager_transactions_no_truncate_trg before truncate on wager_transactions
        for each statement execute function forbid_truncate()
    `);
  }

  override down(): void {
    this.addSql('drop trigger wager_transactions_no_truncate_trg on wager_transactions');
    this.addSql('drop trigger wager_transactions_guard_trg on wager_transactions');
    this.addSql('drop function wager_transactions_guard()');
    this.addSql('drop table wager_transactions');
  }
}