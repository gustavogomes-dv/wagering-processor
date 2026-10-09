import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import { PostgresTransactionContext } from '../persistence/postgres/postgres-transaction-context';
import { PostgresWagerTransactionRepository } from '../persistence/postgres/postgres-wager-transaction-repository';
import type { MetricsPort } from '../../application/ports/metrics';

const BATCH_SIZE = 25;
const POLL_INTERVAL_MS = 1_000;
const CLAIM_LEASE_MS = 60_000;

/** Reavalia referências que chegaram fora de ordem; SKIP LOCKED permite várias instâncias. */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    @Inject('ORM') private readonly orm: MikroORM,
    private readonly processor: ProcessWagerTransaction,
    @Optional() @Inject('METRICS') private readonly metrics?: MetricsPort,
  ) {}

  onApplicationBootstrap(): void {
    this.stopping = false;
    this.loop = this.runLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  async runOnce(): Promise<number> {
    const now = new Date();
    const repository = new PostgresWagerTransactionRepository();
    const due = await new PostgresTransactionContext(this.orm.em.fork()).run((session) =>
      repository.claimPendingReferences(
        session,
        BATCH_SIZE,
        now,
        new Date(now.getTime() + CLAIM_LEASE_MS),
      ),
    );
    let completed = 0;
    for (const state of due) {
      try {
        this.metrics?.recordRetry();
        await this.processor.execute({
          id: state.id,
          providerId: state.providerId,
          externalTransactionId: state.externalTransactionId,
          idempotencyKey: state.idempotencyKey,
          payloadHash: state.payloadHash,
          walletId: state.walletId,
          playerId: state.playerId,
          roundId: state.roundId,
          gameId: state.gameId,
          kind: state.kind,
          money: state.money,
          referenceExternalTransactionId: state.referenceExternalTransactionId,
          correlationId: state.id,
          retryPendingReference: true,
          referenceAttempts: state.referenceAttempts,
        });
        completed += 1;
      } catch {
        // O lease expira depois da falha transitória e outra tentativa poderá assumir.
        console.error(JSON.stringify({ event: 'pending_reference_retry_failed', transactionId: state.id }));
      }
    }
    return completed;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const count = await this.runOnce();
        if (count === 0) await this.wait(POLL_INTERVAL_MS);
      } catch {
        await this.wait(POLL_INTERVAL_MS);
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
