import type { IntegrationEvent } from '../../domain/shared/integration-event';
import type { TransactionSession } from './transaction-context';

export interface OutboxRepository {
  enqueue(session: TransactionSession, event: IntegrationEvent<unknown>): Promise<void>;

  findDue(session: TransactionSession, limit: number, now: Date): Promise<OutboxRecord[]>;

  markPublished(session: TransactionSession, id: string, at: Date): Promise<void>;

  scheduleRetry(session: TransactionSession, id: string, nextAttemptAt: Date): Promise<void>;
}

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  occurredAt: Date;
}
