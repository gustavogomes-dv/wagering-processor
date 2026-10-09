
import { Money } from '../../../domain/shared/money';
import type { Wallet, WalletState } from '../../../domain/wallet/wallet';
import type { WalletRepository } from '../../../application/ports/wallet-repository';
import type { TransactionSession } from '../../../application/ports/transaction-context';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Adapter PostgreSQL da Wallet.
 *
 * O repositório transforma linhas SQL em WalletState/Money.
 * Nenhuma regra financeira é calculada aqui; o domínio continua responsável
 * por debit, credit e pelas invariantes da Wallet.
 */
export class PostgresWalletRepository implements WalletRepository {
  constructor(private readonly session: TransactionSession) {}

  async findById(id: string): Promise<WalletState | undefined> {
    const rows = await this.session.execute<WalletRow[]>(
      `
        select id, player_id, currency, balance, version, created_at, updated_at
          from wallets
         where id = ?
      `,
      [id],
    );

    return rows[0] === undefined ? undefined : this.toState(rows[0]);
  }

  async findByIdForUpdate(id: string): Promise<WalletState | undefined> {
    const rows = await this.session.execute<WalletRow[]>(
      `
        select id, player_id, currency, balance, version, created_at, updated_at
          from wallets
         where id = ?
         for update
      `,
      [id],
    );

    return rows[0] === undefined ? undefined : this.toState(rows[0]);
  }

  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<WalletState | undefined> {
    const rows = await this.session.execute<WalletRow[]>(
      `
        select id, player_id, currency, balance, version, created_at, updated_at
          from wallets
         where player_id = ?
           and currency = ?
      `,
      [playerId, currency],
    );

    return rows[0] === undefined ? undefined : this.toState(rows[0]);
  }

  async create(wallet: Wallet): Promise<void> {
    await this.session.execute(
      `
        insert into wallets (
          id,
          player_id,
          currency,
          balance,
          version,
          created_at,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toString(),
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
  }

  async updateBalance(
    walletId: string,
    expectedVersion: number,
    balance: Money,
    updatedAt: Date,
  ): Promise<void> {
    // RETURNING confirma se a versão esperada foi atualizada sem depender
    // do formato de contagem de linhas retornado pelo driver.
    const rows = await this.session.execute<Array<{ id: string }>>(
      `
        update wallets
           set balance = ?,
               version = version + 1,
               updated_at = ?
         where id = ?
           and version = ?
        returning id
      `,
      [balance.toString(), updatedAt, walletId, expectedVersion],
    );

    // Nenhuma linha retornada significa que a Wallet mudou desde a leitura.
    if (rows.length === 0) {
      throw new Error(
        `Wallet ${walletId} was changed by another transaction`,
      );
    }
  }

  private toState(row: WalletRow): WalletState {
    return {
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: Money.from({
        amount: String(row.balance),
        currency: row.currency,
      }),
      version: Number(row.version),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
