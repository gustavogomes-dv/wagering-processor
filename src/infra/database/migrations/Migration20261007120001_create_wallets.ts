import { Migration } from '@mikro-orm/migrations';

// Primeira migration: a tabela de wallets e as regras que eu quero que o BANCO garanta
// sozinho, mesmo que o código da aplicação tenha um bug.
export class CreateWallets extends Migration {
  override up(): void {
    // Função genérica que eu reaproveito nas outras tabelas para bloquear TRUNCATE.
    this.addSql(`
      create function forbid_truncate() returns trigger language plpgsql as $$
      begin
        raise exception '% cannot be truncated', tg_table_name using errcode = 'check_violation';
      end;
      $$
    `);

    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null,
        balance numeric(19,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        -- no máximo uma wallet por jogador e moeda
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_player_id_not_blank check (btrim(player_id) <> ''),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        -- o saldo nunca fica negativo, nem por race, nem por bug
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1)
      )
    `);

    // Esse trigger protege o que não pode mudar e garante a regra da version:
    // ela sobe exatamente 1 quando o saldo muda e não muda quando o saldo não muda.
    this.addSql(`
      create function wallets_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wallets: rows cannot be deleted' using errcode = 'check_violation';
        end if;
        if new.id is distinct from old.id
           or new.player_id is distinct from old.player_id
           or new.currency is distinct from old.currency
           or new.created_at is distinct from old.created_at then
          raise exception 'wallets: id, player_id, currency and created_at are immutable'
            using errcode = 'check_violation';
        end if;
        if new.balance <> old.balance then
          if new.version <> old.version + 1 then
            raise exception 'wallets: version must increase by exactly 1 when the balance changes'
              using errcode = 'check_violation';
          end if;
        elsif new.version <> old.version then
          raise exception 'wallets: version can only change together with the balance'
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wallets_guard_trg before update or delete on wallets
        for each row execute function wallets_guard()
    `);
    this.addSql(`
      create trigger wallets_no_truncate_trg before truncate on wallets
        for each statement execute function forbid_truncate()
    `);
  }

  override down(): void {
    this.addSql('drop trigger wallets_no_truncate_trg on wallets');
    this.addSql('drop trigger wallets_guard_trg on wallets');
    this.addSql('drop function wallets_guard()');
    this.addSql('drop table wallets');
    this.addSql('drop function forbid_truncate()');
  }
}