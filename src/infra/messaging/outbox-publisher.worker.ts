import { Injectable, OnApplicationBootstrap, OnApplicationShutdown, Inject, Optional } from '@nestjs/common';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { TransactionContext } from '../../application/ports/transaction-context';
import type { OutboxRepository } from '../../application/ports/outbox-repository';
import type { MetricsPort } from '../../application/ports/metrics';

const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Publica eventos já confirmados no banco; mais de uma instância pode rodar este worker. */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    @Inject('OUTBOX_CONTEXT') private readonly transactionContext: TransactionContext,
    @Inject('OUTBOX_REPOSITORY') private readonly repository: OutboxRepository,
    @Inject('SQS') private readonly sqs: SQSClient,
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

  /** Processa um lote. Exposto para integração e operação manual controlada. */
  async runOnce(): Promise<{ published: number; retried: number }> {
    const queueUrl = process.env.SQS_EVENTS_QUEUE_URL ??
      process.env.SQS_QUEUE_URL?.replace(/wager-transactions\.fifo$/, 'integration-events.fifo');
    if (queueUrl === undefined || queueUrl === '') throw new Error('SQS_QUEUE_URL is required');

    return this.transactionContext.run(async (session) => {
      const due = await this.repository.findDue(session, BATCH_SIZE, new Date());
      this.metrics?.setOutboxLag(
        due.length === 0 ? 0 : (Date.now() - due[0]!.occurredAt.getTime()) / 1_000,
      );
      let published = 0;
      let retried = 0;

      // As linhas permanecem bloqueadas até publicar ou registrar o retry.
      // Se o processo cair após o SendMessage e antes do COMMIT, o evento pode repetir,
      // então eventId é enviado como deduplication id e o envelope continua idempotente.
      for (const message of due) {
        try {
          await this.sqs.send(new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
          }));
          await this.repository.markPublished(session, message.id, new Date());
          published += 1;
        } catch {
          const delay = Math.min(1_000 * (2 ** Math.min(message.attempts, 8)), MAX_BACKOFF_MS);
          await this.repository.scheduleRetry(session, message.id, new Date(Date.now() + delay));
          this.metrics?.recordRetry();
          retried += 1;
          // Log estruturado sem imprimir o payload financeiro ou dados do provedor.
          console.error(JSON.stringify({ event: 'outbox_publish_failed', outboxId: message.id }));
        }
      }
      return { published, retried };
    });
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.runOnce();
        if (result.published === 0 && result.retried === 0) await this.wait(POLL_INTERVAL_MS);
      } catch {
        // Falha de banco/configuração é transitória: aguarda antes de tentar outra vez.
        await this.wait(POLL_INTERVAL_MS);
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
