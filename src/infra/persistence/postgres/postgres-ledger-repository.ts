import type { LedgerEntryWithVersion, LedgerRepository } from '../../../application/ports/ledger-repository';
import type { TransactionSession } from '../../../application/ports/transaction-context';
import { Money } from '../../../domain/shared/money';
import {
  WalletLedgerEntry,
  type LedgerEntryState,
} from '../../../domain/wallet/wallet-ledger-entry';
import type { LedgerDirection } from '../../../domain/wallet/ledger-direction';

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  wallet_version: number;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

/**
 * O ledger é append-only.
 * Este adapter só possui create e consultas; não existe update nem delete.
 */
export class PostgresLedgerRepository implements LedgerRepository {
  async create(
    session: TransactionSession,
    entry: WalletLedgerEntry,
    walletVersion: number,
  ): Promise<void> {
    await session.execute(
      `
        insert into wallet_ledger_entries (
          id,
          wallet_id,
          transaction_id,
          wallet_version,
          direction,
          amount,
          currency,
          balance_before,
          balance_after,
          created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        // A versão do ledger é a versão da wallet depois da movimentação.
        walletVersion,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.createdAt,
      ],
    );
  }

  async findByTransactionId(
    session: TransactionSession,
    transactionId: string,
  ): Promise<LedgerEntryWithVersion | undefined> {
    const rows = await session.execute<LedgerRow[]>(
      `
        select
          id,
          wallet_id,
          transaction_id,
          wallet_version,
          direction,
          amount,
          currency,
          balance_before,
          balance_after,
          created_at
        from wallet_ledger_entries
        where transaction_id = ?
      `,
      [transactionId],
    );

    return rows[0] === undefined
      ? undefined
      : this.toRecord(rows[0]);
  }

  async listByWallet(
    session: TransactionSession,
    walletId: string,
    limit: number,
    cursor?: number,
  ): Promise<LedgerEntryWithVersion[]> {
    // Evitamos comparar NULL com uma coluna inteira: sem cursor usamos
    // uma consulta própria; com cursor buscamos versões anteriores.
    const query = cursor === undefined
      ? `
        select
          id,
          wallet_id,
          transaction_id,
          wallet_version,
          direction,
          amount,
          currency,
          balance_before,
          balance_after,
          created_at
        from wallet_ledger_entries
        where wallet_id = ?
        order by wallet_version desc
        limit ?
      `
      : `
        select
          id,
          wallet_id,
          transaction_id,
          wallet_version,
          direction,
          amount,
          currency,
          balance_before,
          balance_after,
          created_at
        from wallet_ledger_entries
        where wallet_id = ?
          and wallet_version < ?
        order by wallet_version desc
        limit ?
      `;
    const parameters = cursor === undefined
      ? [walletId, limit]
      : [walletId, cursor, limit];
    const rows = await session.execute<LedgerRow[]>(query, parameters);

    return rows.map((row) => this.toRecord(row));
  }

  private toDomain(row: LedgerRow): WalletLedgerEntry {
    const state: LedgerEntryState = {
      id: row.id,
      walletId: row.wallet_id,
      transactionId: row.transaction_id,
      direction: row.direction,
      money: Money.from({
        amount: String(row.amount),
        currency: row.currency,
      }),
      balanceBefore: Money.from({
        amount: String(row.balance_before),
        currency: row.currency,
      }),
      balanceAfter: Money.from({
        amount: String(row.balance_after),
        currency: row.currency,
      }),
      createdAt: new Date(row.created_at),
    };

    return WalletLedgerEntry.rehydrate(state);
  }

    private toRecord(row: LedgerRow): LedgerEntryWithVersion {
    return {
      entry: this.toDomain(row),
      // A versão será usada para criar o cursor da próxima página.
      walletVersion: Number(row.wallet_version),
    };
  }
}
