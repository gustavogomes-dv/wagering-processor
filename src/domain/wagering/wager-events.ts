import type { MoneyProps } from '../shared/money';
import { IntegrationEvent, type IntegrationEventProps } from '../shared/integration-event';
import type { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  status: string;
  balance?: MoneyProps;
  failureCode?: FailureCode;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, props: Omit<IntegrationEventProps<WagerTransactionEventData>, 'data'>) {
    return new WagerTransactionProcessed({
      ...props,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        status: transaction.status,
        ...(transaction.observedBalance === undefined ? {} : { balance: transaction.observedBalance.toJSON() }),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, props: Omit<IntegrationEventProps<WagerTransactionEventData>, 'data'>) {
    return new WagerTransactionRejected({
      ...props,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        status: transaction.status,
        failureCode: transaction.failureCode,
      },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, props: Omit<IntegrationEventProps<WagerTransactionEventData>, 'data'>) {
    return new WagerTransactionPendingReference({
      ...props,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        status: transaction.status,
      },
    });
  }
}
