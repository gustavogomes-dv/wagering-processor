import { InboxPayloadConflictError, type InboxRepository } from '../../../application/ports/inbox-repository';
import type { TransactionSession } from '../../../application/ports/transaction-context';

/** Inbox persistente: conflito de mensagem e operação financeira compartilham a mesma transação. */
export class PostgresInboxRepository implements InboxRepository {
  async receive(
    session: TransactionSession,
    consumerName: string,
    messageId: string,
    payloadHash: string,
    receivedAt: Date,
  ): Promise<boolean> {
    const inserted = await session.execute<Array<{ message_id: string }>>(
      `
        insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
        values (?, ?, ?, ?)
        on conflict (consumer_name, message_id) do nothing
        returning message_id
      `,
      [consumerName, messageId, payloadHash, receivedAt],
    );
    if (inserted.length > 0) return true;

    const existing = await session.execute<Array<{ payload_hash: string }>>(
      `select payload_hash from inbox_messages where consumer_name = ? and message_id = ?`,
      [consumerName, messageId],
    );
    if (existing[0]?.payload_hash !== payloadHash) throw new InboxPayloadConflictError();
    return false;
  }

  async markProcessed(
    session: TransactionSession,
    consumerName: string,
    messageId: string,
    processedAt: Date,
  ): Promise<void> {
    await session.execute(
      `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`,
      [processedAt, consumerName, messageId],
    );
  }
}
