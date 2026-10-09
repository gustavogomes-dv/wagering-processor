import type { OutboxRecord, OutboxRepository } from '../../../application/ports/outbox-repository';
import type { TransactionSession } from '../../../application/ports/transaction-context';
import type { IntegrationEvent } from '../../../domain/shared/integration-event';

/** Persiste o envelope JSON na mesma conexão da operação financeira. */
export class PostgresOutboxRepository implements OutboxRepository {
  async enqueue(session: TransactionSession, event: IntegrationEvent<unknown>): Promise<void> {
    await session.execute(
      `
        insert into outbox_messages (
          id, aggregate_id, event_type, payload, occurred_at, created_at
        ) values (?, ?, ?, ?::jsonb, ?, ?)
      `,
      [
        event.eventId,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.toJSON()),
        event.occurredAt,
        event.occurredAt,
      ],
    );
  }

  async findDue(session: TransactionSession, limit: number, now: Date): Promise<OutboxRecord[]> {
    const rows = await session.execute<Array<{
      id: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      attempts: number;
      occurred_at: Date;
    }>>(
      `
        select id, aggregate_id, event_type, payload, attempts, occurred_at
          from outbox_messages
         where published_at is null
           and (next_attempt_at is null or next_attempt_at <= ?)
         order by occurred_at, id
         limit ?
         for update skip locked
      `,
      [now, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      attempts: Number(row.attempts),
      occurredAt: new Date(row.occurred_at),
    }));
  }

  async markPublished(session: TransactionSession, id: string, at: Date): Promise<void> {
    await session.execute('update outbox_messages set published_at = ? where id = ?', [at, id]);
  }

  async scheduleRetry(session: TransactionSession, id: string, nextAttemptAt: Date): Promise<void> {
    await session.execute(
      'update outbox_messages set attempts = attempts + 1, next_attempt_at = ? where id = ?',
      [nextAttemptAt, id],
    );
  }
}
