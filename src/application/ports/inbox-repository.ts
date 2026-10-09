import type { TransactionSession } from './transaction-context';

export interface InboxRepository {
  receive(
    session: TransactionSession,
    consumerName: string,
    messageId: string,
    payloadHash: string,
    receivedAt: Date,
  ): Promise<boolean>;

  markProcessed(
    session: TransactionSession,
    consumerName: string,
    messageId: string,
    processedAt: Date,
  ): Promise<void>;
}

export class InboxPayloadConflictError extends Error {
  constructor() {
    super('SQS message id was already used with a different payload');
    this.name = 'InboxPayloadConflictError';
  }
}
