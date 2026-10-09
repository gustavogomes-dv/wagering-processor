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

  create(
    session: TransactionSession,
    transaction: WagerTransaction,
  ): Promise<void>;

  updateStatus(
    session: TransactionSession,
    transaction: WagerTransaction,
  ): Promise<void>;
}