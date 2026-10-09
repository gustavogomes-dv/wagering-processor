import type {
  TransactionSession,
} from './transaction-context';
import type {
  WagerTransaction,
  WagerTransactionState,
} from '../../domain/wagering/wager-transaction';

export interface WagerTransactionRepository {
  findById(
    session: TransactionSession,
    id: string,
  ): Promise<WagerTransactionState | undefined>;

  findByIdempotencyKey(
    session: TransactionSession,
    idempotencyKey: string,
  ): Promise<WagerTransactionState | undefined>;

  findByProviderExternalId(
    session: TransactionSession,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionState | undefined>;

  findProcessedReversal(
    session: TransactionSession,
    referenceTransactionId: string,
    kind: WagerTransaction['kind'],
  ): Promise<boolean>;

  claimPendingReferences(
    session: TransactionSession,
    limit: number,
    now: Date,
    leaseUntil: Date,
  ): Promise<WagerTransactionState[]>;

  scheduleReferenceCheck(
    session: TransactionSession,
    transactionId: string,
    attempts: number,
    nextCheckAt: Date,
  ): Promise<void>;

  create(
    session: TransactionSession,
    transaction: WagerTransaction,
  ): Promise<void>;

  updateStatus(
    session: TransactionSession,
    transaction: WagerTransaction,
  ): Promise<void>;
}
