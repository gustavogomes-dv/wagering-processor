import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { DomainError } from '../../domain/shared/errors';
import { Money, type MoneyProps } from '../../domain/shared/money';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import { InboxPayloadConflictError } from '../../application/ports/inbox-repository';
import { hashWagerPayload } from '../../application/hash-wager-payload';
import { IdempotencyConflictError, ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import type { MetricsPort } from '../../application/ports/metrics';

const CONSUMER_NAME = 'wager-transaction-consumer';
const POLL_SECONDS = 20;

interface WagerRequestEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt?: string;
  correlationId?: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  };
}

class PermanentMessageError extends Error {}

function parseEnvelope(body: string): WagerRequestEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new PermanentMessageError('message body is not valid JSON');
  }
  if (typeof value !== 'object' || value === null) throw new PermanentMessageError('message envelope is invalid');
  const envelope = value as Record<string, unknown>;
  if (
    typeof envelope.messageId !== 'string' ||
    envelope.messageId.trim() === '' ||
    envelope.type !== 'WagerTransactionRequested' ||
    typeof envelope.data !== 'object' || envelope.data === null
  ) {
    throw new PermanentMessageError('message envelope is missing required fields');
  }
  const data = envelope.data as Record<string, unknown>;
  const textFields = [
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
  ] as const;
  for (const field of textFields) {
    if (typeof data[field] !== 'string' || data[field].trim() === '') {
      throw new PermanentMessageError(`${field} is missing`);
    }
  }
  if (!Object.values(WagerTransactionKind).includes(data.kind as WagerTransactionKind)) {
    throw new PermanentMessageError('kind is not supported');
  }
  if (typeof data.money !== 'object' || data.money === null) throw new PermanentMessageError('money is invalid');
  if (
    data.referenceExternalTransactionId !== undefined &&
    typeof data.referenceExternalTransactionId !== 'string'
  ) {
    throw new PermanentMessageError('referenceExternalTransactionId is invalid');
  }

  try {
    Money.from(data.money as MoneyProps);
  } catch {
    throw new PermanentMessageError('money is invalid');
  }
  return envelope as unknown as WagerRequestEnvelope;
}

/** Consome SQS; só apaga a mensagem depois que inbox e processamento financeiro commitam. */
@Injectable()
export class SqsWagerConsumerWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    @Inject('SQS') private readonly sqs: SQSClient,
    private readonly processTransaction: ProcessWagerTransaction,
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

  private async runLoop(): Promise<void> {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (queueUrl === undefined || queueUrl === '') throw new Error('SQS_QUEUE_URL is required');

    while (!this.stopping) {
      try {
        const response = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: POLL_SECONDS,
          VisibilityTimeout: 30,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));
        for (const message of response.Messages ?? []) {
          if (this.stopping) break;
          await this.handleMessage(message);
        }
      } catch {
        // Falha de transporte é transitória; mensagens não apagadas voltam pela visibilidade.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private async handleMessage(message: {
    Body?: string;
    MessageId?: string;
    ReceiptHandle?: string;
  }): Promise<void> {
    if (message.Body === undefined || message.ReceiptHandle === undefined) return;
    const queueUrl = process.env.SQS_QUEUE_URL!;
    let envelope: WagerRequestEnvelope;
    try {
      envelope = parseEnvelope(message.Body);
    } catch (error) {
      if (!(error instanceof PermanentMessageError)) throw error;
      await this.moveToDlq(message, error.message);
      return;
    }

    const money = Money.from(envelope.data.money);
    const request = {
      ...envelope.data,
      money,
    };
    try {
      await this.processTransaction.execute({
        ...request,
        payloadHash: hashWagerPayload(request),
        correlationId: envelope.correlationId ?? envelope.messageId,
        inboxMessage: { consumerName: CONSUMER_NAME, messageId: envelope.messageId },
      });
      // execute() resolve só depois do COMMIT da transação com a inbox.
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      if (error instanceof DomainError || error instanceof IdempotencyConflictError) {
        console.error(JSON.stringify({ event: 'wager_message_rejected', messageId: envelope.messageId, code: error.name }));
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
        return;
      }
      if (error instanceof InboxPayloadConflictError) {
        await this.moveToDlq(message, 'message id reused with a different payload');
        return;
      }
      // Sem DeleteMessage: banco indisponível ou erro inesperado gera retry do broker.
      this.metrics?.recordRetry();
      console.error(JSON.stringify({ event: 'wager_message_retry', messageId: envelope.messageId }));
    }
  }

  private async moveToDlq(
    message: { Body?: string; MessageId?: string; ReceiptHandle?: string },
    reason: string,
  ): Promise<void> {
    const dlqUrl = process.env.SQS_DLQ_URL;
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (dlqUrl === undefined || queueUrl === undefined || message.ReceiptHandle === undefined) {
      throw new Error('SQS queue URLs and receipt handle are required for DLQ delivery');
    }
    const deduplicationId = message.MessageId ?? crypto.randomUUID();
    await this.sqs.send(new SendMessageCommand({
      QueueUrl: dlqUrl,
      MessageBody: JSON.stringify({ reason, originalBody: message.Body }),
      MessageGroupId: 'invalid-wager-messages',
      MessageDeduplicationId: deduplicationId,
    }));
    this.metrics?.recordDlqMessage();
    // Apaga da fila principal só depois da confirmação do envio para a DLQ.
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }
}
