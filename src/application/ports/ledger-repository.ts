import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { TransactionSession } from './transaction-context';

export interface LedgerRepository {
  create(
    session: TransactionSession,
    entry: WalletLedgerEntry,
    walletVersion: number,
  ): Promise<void>;

  findByTransactionId(
    session: TransactionSession,
    transactionId: string,
  ): Promise<LedgerEntryWithVersion | undefined>;

  listByWallet(
    session: TransactionSession,
    walletId: string,
    limit: number,
    cursor?: number,
  ): Promise<LedgerEntryWithVersion[]>;
}
/** A versão ordena o ledger e permite continuar a paginação pelo cursor. */
export interface LedgerEntryWithVersion {
  entry: WalletLedgerEntry;
  walletVersion: number;
}
