import type { WagerTransactionRepository } from '../../../application/ports/wager-transaction-repository';
import type { TransactionSession } from '../../../application/ports/transaction-context';
import {
  WagerTransaction,
  type WagerTransactionState,
} from '../../../domain/wagering/wager-transaction';
import { Money } from '../../../domain/shared/money';
import type { FailureCode } from '../../../domain/wagering/failure-code';

interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionState['kind'];
  money_amount?: string;
  amount?: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  created_at: Date;
  status: WagerTransactionState['status'];
  failure_code: FailureCode | null;
  processed_at: Date | null;
  observed_balance: string | null;
}

/**
 * Adapter SQL das transações.
 *
 * Ele não decide se uma aposta pode ou não ser aceita.
 * Apenas converte linhas do banco para o estado do domínio e persiste
 * as mudanças feitas pelo use case.
 */
export class PostgresWagerTransactionRepository
  implements WagerTransactionRepository
{
  async findById(
    session: TransactionSession,
    id: string,
  ): Promise<WagerTransactionState | undefined> {
    const rows = await this.select(
      session,
      'where id = ?',
      [id],
    );

    return rows[0] === undefined ? undefined : this.toState(rows[0]);
  }

  async findByIdempotencyKey(
    session: TransactionSession,
    idempotencyKey: string,
  ): Promise<WagerTransactionState | undefined> {
    const rows = await this.select(
      session,
      'where idempotency_key = ?',
      [idempotencyKey],
    );

    return rows[0] === undefined ? undefined : this.toState(rows[0]);
  }

  async findByProviderExternalId(
    session: TransactionSession,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionState | undefined> {
    const rows = await this.select(
      session,
      'where provider_id = ? and external_transaction_id = ?',
      [providerId, externalTransactionId],
    );

    return rows[0] === undefined ? undefined : this.toState(rows[0]);
  }

  async create(
    session: TransactionSession,
    transaction: WagerTransaction,
  ): Promise<void> {
    await session.execute(
      `
        insert into wager_transactions (
          id,
          provider_id,
          external_transaction_id,
          idempotency_key,
          payload_hash,
          wallet_id,
          player_id,
          round_id,
          game_id,
          kind,
          status,
          amount,
          currency,
          reference_external_transaction_id,
          reference_transaction_id,
          created_at,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        transaction.id,
        transaction.providerId,
        transaction.externalTransactionId,
        transaction.idempotencyKey,
        transaction.payloadHash,
        transaction.walletId,
        transaction.playerId,
        transaction.roundId,
        transaction.gameId,
        transaction.kind,
        transaction.status,
        transaction.money.toString(),
        transaction.money.currency,
        transaction.referenceExternalTransactionId ?? null,
        transaction.referenceTransactionId ?? null,
        transaction.createdAt,
        transaction.createdAt,
      ],
    );
  }

  async updateStatus(
    session: TransactionSession,
    transaction: WagerTransaction,
  ): Promise<void> {
    await session.execute(
      `
        update wager_transactions
           set status = ?,
               reference_transaction_id = ?,
               failure_code = ?,
               processed_at = ?,
               updated_at = ?,
               -- Guardamos o saldo da resposta original para responder replay idempotente.
               observed_balance = ?
         where id = ?
      `,
      [
        transaction.status,
        transaction.referenceTransactionId ?? null,
        transaction.failureCode ?? null,
        transaction.processedAt ?? null,
        new Date(),
        transaction.observedBalance?.toString() ?? null,
        transaction.id,
      ],
    );
  }

  private async select(
    session: TransactionSession,
    condition: string,
    parameters: readonly unknown[],
  ): Promise<WagerTransactionRow[]> {
    return session.execute<WagerTransactionRow[]>(
      `
        select
          id,
          provider_id,
          external_transaction_id,
          idempotency_key,
          payload_hash,
          wallet_id,
          player_id,
          round_id,
          game_id,
          kind,
          amount,
          currency,
          reference_external_transaction_id,
          reference_transaction_id,
          created_at,
          status,
          failure_code,
          processed_at,
          observed_balance
        from wager_transactions
        ${condition}
      `,
      parameters,
    );
  }

  private toState(row: WagerTransactionRow): WagerTransactionState {
    return {
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: Money.from({
        amount: String(row.amount ?? row.money_amount),
        currency: row.currency,
      }),
      
      referenceExternalTransactionId:
        row.reference_external_transaction_id ?? undefined,
      referenceTransactionId:
        row.reference_transaction_id ?? undefined,
      createdAt: new Date(row.created_at),
      status: row.status,
      failureCode: row.failure_code ?? undefined,
      processedAt: row.processed_at
        ? new Date(row.processed_at)
        : undefined,
      observedBalance: row.observed_balance
        ? Money.from({
            amount: String(row.observed_balance),
            currency: row.currency,
          })
        : undefined,
    };
  }
}
