import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { CreateWallet } from './application/use-cases/create-wallet';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import {
  HealthController,
  WalletController,
  WagerTransactionController,
} from './infra/http/controllers';
import { buildOrmConfig } from './infra/database/mikro-orm.config';
import { PostgresLedgerRepository } from './infra/persistence/postgres/postgres-ledger-repository';
import { PostgresOutboxRepository } from './infra/persistence/postgres/postgres-outbox-repository';
import { PostgresInboxRepository } from './infra/persistence/postgres/postgres-inbox-repository';
import { PostgresTransactionContext } from './infra/persistence/postgres/postgres-transaction-context';
import { PostgresWagerTransactionRepository } from './infra/persistence/postgres/postgres-wager-transaction-repository';
import { PostgresWalletRepository } from './infra/persistence/postgres/postgres-wallet-repository';
import { OutboxPublisherWorker } from './infra/messaging/outbox-publisher.worker';
import { SqsWagerConsumerWorker } from './infra/messaging/sqs-wager-consumer.worker';
import { PendingReferenceWorker } from './infra/messaging/pending-reference.worker';
import type { TransactionSession } from './application/ports/transaction-context';
import { WageringMetrics } from './infra/observability/wagering-metrics';
import { MetricsController } from './infra/http/metrics.controller';
import { AllowAllProviderIdentity } from './application/ports/provider-identity';

function createSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(accessKeyId === undefined || secretAccessKey === undefined
      ? {}
      : { credentials: { accessKeyId, secretAccessKey } }),
  });
}

@Module({
  controllers: [WalletController, WagerTransactionController, HealthController, MetricsController],
  providers: [
    { provide: 'ORM', useFactory: () => MikroORM.init(buildOrmConfig()) },
    { provide: 'SQS', useFactory: createSqsClient },
    { provide: 'METRICS', useClass: WageringMetrics },
    { provide: 'PROVIDER_IDENTITY', useClass: AllowAllProviderIdentity },
    {
      provide: 'OUTBOX_CONTEXT',
      inject: ['ORM'],
      useFactory: (orm: MikroORM) => ({
        run: <T>(work: (session: TransactionSession) => Promise<T>) =>
          new PostgresTransactionContext(orm.em.fork()).run(work),
      }),
    },
    { provide: 'OUTBOX_REPOSITORY', useFactory: () => new PostgresOutboxRepository() },
    OutboxPublisherWorker,
    SqsWagerConsumerWorker,
    PendingReferenceWorker,
    {
      provide: CreateWallet,
      inject: ['ORM'],
      useFactory: (orm: MikroORM) => new CreateWallet({
        // Cada operação recebe um EntityManager próprio e transacional.
        transactionContext: {
          run: (work) => new PostgresTransactionContext(orm.em.fork()).run(work),
        },
        walletRepository: (session) => new PostgresWalletRepository(session),
        wagerTransactionRepository: new PostgresWagerTransactionRepository(),
        ledgerRepository: new PostgresLedgerRepository(),
        outboxRepository: new PostgresOutboxRepository(),
      }),
    },
    {
      provide: ProcessWagerTransaction,
      inject: ['ORM', 'METRICS'],
      useFactory: (orm: MikroORM, metrics: WageringMetrics) => new ProcessWagerTransaction({
        transactionContext: {
          run: (work) => new PostgresTransactionContext(orm.em.fork()).run(work),
        },
        walletRepository: (session) => new PostgresWalletRepository(session),
        wagerTransactionRepository: new PostgresWagerTransactionRepository(),
        ledgerRepository: new PostgresLedgerRepository(),
        outboxRepository: new PostgresOutboxRepository(),
        inboxRepository: new PostgresInboxRepository(),
        metrics,
      }),
    },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject('ORM') private readonly orm: MikroORM,
    @Inject('SQS') private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close();
  }
}
