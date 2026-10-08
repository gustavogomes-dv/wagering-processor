import { Migration } from '@mikro-orm/migrations';

// Terceira migration: o ledger. É o coração da auditoria, então aqui eu coloquei mais regras no banco:
// o lançamento não muda nunca, a conta tem que fechar e saldo e ledger andam sempre juntos.
export class CreateWalletLedgerEntries extends Migration {
  override up(): void {
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        -- version da wallet depois dessa movimentação: dá ordem total ao ledger e serve de cursor
        wallet_version integer not null,
        direction text not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        balance_before numeric(19,2) not null,
        balance_after numeric(19,2) not null,
        created_at timestamptz not null,

        -- uma transação gera no máximo um lançamento por wallet
        constraint wallet_ledger_entries_wallet_transaction_uq unique (wallet_id, transaction_id),
        constraint wallet_ledger_entries_wallet_version_uq unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_version_positive check (wallet_version >= 1),
        constraint wallet_ledger_entries_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        -- a conta fecha: crédito soma, débito subtrai
        constraint wallet_ledger_entries_arithmetic check (
          (direction = 'CREDIT' and balance_before + amount = balance_after)
          or (direction = 'DEBIT' and balance_before - amount = balance_after)
        )
      )
    `);

    // Imutabilidade: nenhum UPDATE, DELETE ou TRUNCATE passa.
    this.addSql(`
      create function wallet_ledger_entries_immutable() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'check_violation';
      end;
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable_trg before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_immutable()
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate_trg before truncate on wallet_ledger_entries
        for each statement execute function forbid_truncate()
    `);

    // Validação na hora de inserir: o lançamento tem que combinar com a transação e com a wallet,
    // a direção tem que combinar com o tipo, e a cadeia de saldos não pode ter buraco.
    this.addSql(`
      create function wallet_ledger_entries_validate() returns trigger language plpgsql as $$
      declare
        v_tx record;
        v_wallet_currency text;
        v_prev record;
      begin
        select wallet_id, currency, amount, kind into v_tx
          from wager_transactions where id = new.transaction_id;
        if not found then
          raise exception 'wallet_ledger_entries: transaction not found' using errcode = 'check_violation';
        end if;
        if v_tx.wallet_id <> new.wallet_id or v_tx.currency <> new.currency or v_tx.amount <> new.amount then
          raise exception 'wallet_ledger_entries: entry must match the wallet, currency and amount of its transaction'
            using errcode = 'check_violation';
        end if;
        select currency into v_wallet_currency from wallets where id = new.wallet_id;
        if v_wallet_currency <> new.currency then
          raise exception 'wallet_ledger_entries: entry currency must match the wallet currency'
            using errcode = 'check_violation';
        end if;
        if v_tx.kind = 'LOSS' then
          raise exception 'wallet_ledger_entries: LOSS does not move the balance' using errcode = 'check_violation';
        elsif v_tx.kind = 'BET' and new.direction <> 'DEBIT' then
          raise exception 'wallet_ledger_entries: BET must be a DEBIT' using errcode = 'check_violation';
        elsif v_tx.kind in ('WIN', 'REFUND', 'OPENING') and new.direction <> 'CREDIT' then
          raise exception 'wallet_ledger_entries: % must be a CREDIT', v_tx.kind using errcode = 'check_violation';
        end if;

        select wallet_version, balance_after into v_prev
          from wallet_ledger_entries where wallet_id = new.wallet_id
          order by wallet_version desc limit 1;
        if not found then
          if new.balance_before <> 0 or new.wallet_version not in (1, 2) then
            raise exception 'wallet_ledger_entries: the first entry must start from zero balance'
              using errcode = 'check_violation';
          end if;
        elsif new.wallet_version <> v_prev.wallet_version + 1 or new.balance_before <> v_prev.balance_after then
          raise exception 'wallet_ledger_entries: the balance chain is broken' using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_validate_trg before insert on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_validate()
    `);

    // Conferência de consistência: wallet e ledger concordam?
    this.addSql(`
      create function assert_wallet_ledger_consistent(p_wallet_id uuid) returns void language plpgsql as $$
      declare
        v_wallet record;
        v_last record;
      begin
        select balance, version into v_wallet from wallets where id = p_wallet_id;
        if not found then
          return;
        end if;
        select wallet_version, balance_after into v_last
          from wallet_ledger_entries where wallet_id = p_wallet_id
          order by wallet_version desc limit 1;
        if not found then
          if v_wallet.balance <> 0 or v_wallet.version <> 1 then
            raise exception 'wallet % has balance or version changes without ledger entries', p_wallet_id
              using errcode = 'check_violation';
          end if;
        elsif v_last.wallet_version <> v_wallet.version or v_last.balance_after <> v_wallet.balance then
          raise exception 'wallet % balance and version do not match its last ledger entry', p_wallet_id
            using errcode = 'check_violation';
        end if;
      end;
      $$
    `);
    // Conferência de consistência: transação e ledger concordam?
    // PROCESSED que mexe no saldo tem exatamente 1 lançamento. Todas as outras têm zero.
    this.addSql(`
      create function assert_transaction_ledger_coherent(p_transaction_id uuid) returns void language plpgsql as $$
      declare
        v_tx record;
        v_count integer;
      begin
        select status, kind into v_tx from wager_transactions where id = p_transaction_id;
        if not found then
          return;
        end if;
        select count(*) into v_count from wallet_ledger_entries where transaction_id = p_transaction_id;
        if v_tx.status = 'PROCESSED' and v_tx.kind <> 'LOSS' then
          if v_count <> 1 then
            raise exception 'transaction % must have exactly one ledger entry', p_transaction_id
              using errcode = 'check_violation';
          end if;
        elsif v_count <> 0 then
          raise exception 'transaction % (status %, kind %) must not have ledger entries',
            p_transaction_id, v_tx.status, v_tx.kind using errcode = 'check_violation';
        end if;
      end;
      $$
    `);

    // Essas conferências rodam no COMMIT (deferred), depois que a transação inteira já mexeu
    // na wallet, no ledger e na transação. Se algo não fecha, o commit inteiro é recusado.
    this.addSql(`
      create function wallets_check_ledger() returns trigger language plpgsql as $$
      begin
        perform assert_wallet_ledger_consistent(new.id);
        return null;
      end;
      $$
    `);
    this.addSql(`
      create constraint trigger wallets_ledger_consistency_trg after insert or update on wallets
        deferrable initially deferred for each row execute function wallets_check_ledger()
    `);
    this.addSql(`
      create function wager_transactions_check_ledger() returns trigger language plpgsql as $$
      begin
        perform assert_transaction_ledger_coherent(new.id);
        return null;
      end;
      $$
    `);
    this.addSql(`
      create constraint trigger wager_transactions_ledger_consistency_trg
        after insert or update on wager_transactions
        deferrable initially deferred for each row execute function wager_transactions_check_ledger()
    `);
    this.addSql(`
      create function wallet_ledger_entries_check_consistency() returns trigger language plpgsql as $$
      begin
        perform assert_wallet_ledger_consistent(new.wallet_id);
        perform assert_transaction_ledger_coherent(new.transaction_id);
        return null;
      end;
      $$
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_consistency_trg after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function wallet_ledger_entries_check_consistency()
    `);
  }

  override down(): void {
    this.addSql('drop trigger wallet_ledger_entries_consistency_trg on wallet_ledger_entries');
    this.addSql('drop function wallet_ledger_entries_check_consistency()');
    this.addSql('drop trigger wager_transactions_ledger_consistency_trg on wager_transactions');
    this.addSql('drop function wager_transactions_check_ledger()');
    this.addSql('drop trigger wallets_ledger_consistency_trg on wallets');
    this.addSql('drop function wallets_check_ledger()');
    this.addSql('drop function assert_transaction_ledger_coherent(uuid)');
    this.addSql('drop function assert_wallet_ledger_consistent(uuid)');
    this.addSql('drop trigger wallet_ledger_entries_validate_trg on wallet_ledger_entries');
    this.addSql('drop function wallet_ledger_entries_validate()');
    this.addSql('drop trigger wallet_ledger_entries_no_truncate_trg on wallet_ledger_entries');
    this.addSql('drop trigger wallet_ledger_entries_immutable_trg on wallet_ledger_entries');
    this.addSql('drop function wallet_ledger_entries_immutable()');
    this.addSql('drop table wallet_ledger_entries');
  }
}