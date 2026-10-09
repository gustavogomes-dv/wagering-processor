import type { Money } from '../../domain/shared/money';
import type { Wallet, WalletState } from '../../domain/wallet/wallet';

export interface WalletRepository {
  findById(id: string): Promise<WalletState | undefined>;

  /**
   * Usa lock pessimista somente durante o processamento financeiro.
   * Wallets diferentes continuam podendo ser processadas em paralelo.
   */
  findByIdForUpdate(id: string): Promise<WalletState | undefined>;

  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<WalletState | undefined>;

  create(wallet: Wallet): Promise<void>;

  updateBalance(
    walletId: string,
    expectedVersion: number,
    balance: Money,
    updatedAt: Date,
  ): Promise<void>;
}