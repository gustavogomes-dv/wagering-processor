import { Migration } from '@mikro-orm/migrations';

export class HardenCurrencyAndReversalRules extends Migration {
  override up(): void {
    const currencies = `'ARS','AUD','BRL','CAD','CHF','EUR','GBP','MXN','USD'`;
    // Garante no banco que um ROLLBACK realmente inverta a direção do lançamento da transação referenciada
    // A regra também existe no domínio, mas fica repetida no PostgreSQL
    // porque o banco precisa continuar protegendo o ledger mesmo se houver
    // um bug ou outro consumidor gravando diretamente no banco.
    this.addSql(`
      create function validate_rollback_direction() returns trigger language plpgsql as $$
      declare
        v_reference_transaction_id uuid;
        v_reference_direction text;
      begin
        -- Para transações que não são ROLLBACK, não há validação adicional.
        select reference_transaction_id
          into v_reference_transaction_id
          from wager_transactions
         where id = new.transaction_id
           and kind = 'ROLLBACK';

        if v_reference_transaction_id is null then
          return new;
        end if;

        -- A referência precisa ter um lançamento no ledger.
        select direction
          into v_reference_direction
          from wallet_ledger_entries
         where transaction_id = v_reference_transaction_id
           and wallet_id = new.wallet_id
         limit 1;

        if not found then
          raise exception
            'wallet_ledger_entries: ROLLBACK reference has no ledger entry'
            using errcode = 'check_violation';
        end if;

        -- DEBIT deve ser revertido por CREDIT.
        -- CREDIT deve ser revertido por DEBIT.
        if v_reference_direction = new.direction then
          raise exception
            'wallet_ledger_entries: ROLLBACK direction must be opposite to the reference'
            using errcode = 'check_violation';
        end if;

        return new;
      end;
      $$
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_rollback_direction_trg
        before insert on wallet_ledger_entries
        for each row execute function validate_rollback_direction()
    `);
  

    this.addSql(`
      alter table wallets
        drop constraint wallets_currency_format,
        add constraint wallets_currency_supported
          check (currency in (${currencies}))
    `);

    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_currency_format,
        add constraint wager_transactions_currency_supported
          check (currency in (${currencies}))
    `);

    this.addSql(`
      alter table wallet_ledger_entries
        drop constraint wallet_ledger_entries_currency_format,
        add constraint wallet_ledger_entries_currency_supported
          check (currency in (${currencies}))
    `);
  }

  override down(): void {

    // Remove a proteção adicional criada para a direção do ROLLBACK.
    this.addSql(`
      drop trigger wallet_ledger_entries_rollback_direction_trg
        on wallet_ledger_entries
    `);

    this.addSql(`
      drop function validate_rollback_direction()
    `);

    this.addSql(`
      alter table wallet_ledger_entries
        drop constraint wallet_ledger_entries_currency_supported,
        add constraint wallet_ledger_entries_currency_format
          check (currency ~ '^[A-Z]{3}$')
    `);

    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_currency_supported,
        add constraint wager_transactions_currency_format
          check (currency ~ '^[A-Z]{3}$')
    `);

    this.addSql(`
      alter table wallets
        drop constraint wallets_currency_supported,
        add constraint wallets_currency_format
          check (currency ~ '^[A-Z]{3}$')
    `);
  }
}