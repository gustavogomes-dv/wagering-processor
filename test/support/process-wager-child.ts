import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/shared/money';
import { ProcessWagerTransaction, type ProcessWagerTransactionInput } from '../../src/application/use-cases/process-wager-transaction';
import { PostgresLedgerRepository } from '../../src/infra/persistence/postgres/postgres-ledger-repository';
import { PostgresInboxRepository } from '../../src/infra/persistence/postgres/postgres-inbox-repository';
import { PostgresOutboxRepository } from '../../src/infra/persistence/postgres/postgres-outbox-repository';
import { PostgresTransactionContext } from '../../src/infra/persistence/postgres/postgres-transaction-context';
import { PostgresWagerTransactionRepository } from '../../src/infra/persistence/postgres/postgres-wager-transaction-repository';
import { PostgresWalletRepository } from '../../src/infra/persistence/postgres/postgres-wallet-repository';
import { buildOrmConfig } from '../../src/infra/database/mikro-orm.config';
import type { TransactionSession } from '../../src/application/ports/transaction-context';

async function main(): Promise<void> {
  const raw = process.env.WAGER_INPUT;
  if (raw === undefined) throw new Error('WAGER_INPUT is required');
  const input = JSON.parse(raw) as Omit<ProcessWagerTransactionInput, 'money'> & {
    money: { amount: string; currency: string };
  };
  const orm = await MikroORM.init(buildOrmConfig());
  try {
    const processor = new ProcessWagerTransaction({
      transactionContext: {
        run: <T>(work: (session: TransactionSession) => Promise<T>) =>
          new PostgresTransactionContext(orm.em.fork()).run(work),
      },
      walletRepository: (session) => new PostgresWalletRepository(session),
      wagerTransactionRepository: new PostgresWagerTransactionRepository(),
      ledgerRepository: new PostgresLedgerRepository(),
      outboxRepository: new PostgresOutboxRepository(),
      inboxRepository: new PostgresInboxRepository(),
    });
    const result = await processor.execute({
      ...input,
      money: Money.from(input.money),
    });
    console.log(JSON.stringify({ ...result, balance: result.balance?.toJSON() }));
  } finally {
    await orm.close();
  }
}

void main();
