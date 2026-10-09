import { Money } from '../../domain/shared/money';
import { InsufficientFundsError, WalletNotFoundError } from '../../domain/shared/errors';
import { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { WalletBalanceChanged } from '../../domain/wallet/wallet-balance-changed';
import { LedgerDirection } from '../../domain/wallet/ledger-direction';
import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../../domain/wagering/wager-events';
import type { LedgerRepository } from '../ports/ledger-repository';
import type { InboxRepository } from '../ports/inbox-repository';
import { InboxPayloadConflictError } from '../ports/inbox-repository';
import type { OutboxRepository } from '../ports/outbox-repository';
import type { TransactionContext, TransactionSession } from '../ports/transaction-context';
import type { WagerTransactionRepository } from '../ports/wager-transaction-repository';
import type { WalletRepository } from '../ports/wallet-repository';
import type { MetricsPort } from '../ports/metrics';

export interface ProcessWagerTransactionInput {
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  causationId?: string;
  inboxMessage?: { consumerName: string; messageId: string };
  retryPendingReference?: boolean;
  referenceAttempts?: number;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: Money;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
  duplicateDelivery?: boolean;
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor() {
    super('Idempotency key was already used with a different payload');
    this.name = 'IdempotencyConflictError';
  }
}

export interface ProcessWagerTransactionDependencies {
  transactionContext: TransactionContext;
  walletRepository: (session: TransactionSession) => WalletRepository;
  wagerTransactionRepository: WagerTransactionRepository;
  ledgerRepository: LedgerRepository;
  outboxRepository: OutboxRepository;
  inboxRepository?: InboxRepository;
  newId?: () => string;
  now?: () => Date;
  metrics?: MetricsPort;
}

const MAX_REFERENCE_ATTEMPTS = 5;
const MAX_REFERENCE_BACKOFF_MS = 5 * 60_000;

/**
 * Orquestra uma operação financeira dentro de uma única transação SQL.
 * O lock é por wallet, então concorrência em contas diferentes continua independente.
 */
export class ProcessWagerTransaction {
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly dependencies: ProcessWagerTransactionDependencies) {
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionResult> {
    const startedAt = Date.now();
    try {
      const result = await this.dependencies.transactionContext.run(async (session) => {
        if (input.inboxMessage !== undefined) {
          if (this.dependencies.inboxRepository === undefined) {
            throw new Error('InboxRepository is required for SQS messages');
          }
          const inserted = await this.dependencies.inboxRepository.receive(
            session,
            input.inboxMessage.consumerName,
            input.inboxMessage.messageId,
            input.payloadHash,
            this.now(),
          );
          if (!inserted) {
            return {
              transactionId: '',
              status: WagerTransactionStatus.Processed,
              idempotentReplay: true,
              duplicateDelivery: true,
            };
          }
        }

        const result = await this.process(session, input);
        if (input.inboxMessage !== undefined) {
          await this.dependencies.inboxRepository!.markProcessed(
            session,
            input.inboxMessage.consumerName,
            input.inboxMessage.messageId,
            this.now(),
          );
        }
        return result;
      });
      this.dependencies.metrics?.recordTransaction(result.status);
      if (result.idempotentReplay || result.duplicateDelivery) this.dependencies.metrics?.recordDuplicate();
      this.dependencies.metrics?.recordProcessingLatency(Date.now() - startedAt);
      console.info(JSON.stringify({
        event: 'wager_transaction_result',
        correlationId: input.correlationId ?? input.idempotencyKey,
        ...(input.inboxMessage === undefined ? {} : { messageId: input.inboxMessage.messageId }),
        ...(result.transactionId === '' ? {} : { transactionId: result.transactionId }),
        walletId: input.walletId,
        providerId: input.providerId,
        status: result.status,
        replay: result.idempotentReplay || result.duplicateDelivery === true,
      }));
      return result;
    } catch (error) {
      this.dependencies.metrics?.recordProcessingLatency(Date.now() - startedAt);
      if (this.isLockConflict(error)) this.dependencies.metrics?.recordLockConflict();
      if (error instanceof IdempotencyConflictError || error instanceof InboxPayloadConflictError) {
        throw error;
      }
      // Se outra instância ganhou a corrida pela chave, sua transação já confirmou
      // quando o índice único retorna conflito. Lemos o resultado persistido para replay.
      const existing = await this.dependencies.transactionContext.run((session) =>
        this.dependencies.wagerTransactionRepository.findByIdempotencyKey(session, input.idempotencyKey),
      );
      if (existing === undefined) throw error;
      return this.replay(existing, input.payloadHash);
    }
  }

  private isLockConflict(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const values = [
      (error as { code?: unknown }).code,
      (error as { cause?: { code?: unknown } }).cause?.code,
    ];
    return values.some((code) => code === '40P01' || code === '40001' || code === '55P03');
  }

  private async process(
    session: TransactionSession,
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionResult> {
    const transactionRepository = this.dependencies.wagerTransactionRepository;
    const previous = await transactionRepository.findByIdempotencyKey(session, input.idempotencyKey);
    const retryingReference =
      input.retryPendingReference === true && previous?.status === WagerTransactionStatus.PendingReference;
    if (previous !== undefined && !retryingReference) return this.replay(previous, input.payloadHash);

    const walletRepository = this.dependencies.walletRepository(session);
    // A trava serializa as operações da mesma wallet em todas as instâncias.
    const walletState = await walletRepository.findByIdForUpdate(input.walletId);
    if (walletState === undefined) {
      throw new WalletNotFoundError();
    }

    const createdAt = this.now();
    const transaction = retryingReference
      ? WagerTransaction.rehydrate(previous!)
      : WagerTransaction.create({
          id: input.id ?? this.newId(),
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
          payloadHash: input.payloadHash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          money: input.money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          createdAt,
        });
    if (!retryingReference) await transactionRepository.create(session, transaction);

    const wallet = Wallet.rehydrate(walletState);
    const walletFailure = this.walletFailure(wallet, input);
    if (walletFailure !== undefined) {
      transaction.reject(walletFailure);
      await transactionRepository.updateStatus(session, transaction);
      await this.enqueueRejected(session, transaction, input);
      return this.result(transaction, false);
    }

    let reference: WagerTransaction | undefined;
    if (input.referenceExternalTransactionId !== undefined) {
      const referenceState = await transactionRepository.findByProviderExternalId(
        session,
        input.providerId,
        input.referenceExternalTransactionId,
      );
      if (
        referenceState === undefined ||
        referenceState.status === WagerTransactionStatus.Pending ||
        referenceState.status === WagerTransactionStatus.PendingReference
      ) {
        // A operação dependente fica persistida para o worker tentar novamente depois.
        const attempts = input.referenceAttempts ?? previous?.referenceAttempts ?? 0;
        if (attempts >= MAX_REFERENCE_ATTEMPTS) {
          transaction.reject(FailureCode.ReferenceNotFound);
          await transactionRepository.updateStatus(session, transaction);
          await this.enqueueRejected(session, transaction, input);
          return this.result(transaction, false);
        }
        if (!retryingReference) {
          transaction.markPendingReference();
          await transactionRepository.updateStatus(session, transaction);
          const event = WagerTransactionPendingReference.from(
            transaction,
            this.eventProps(transaction.id, input),
          );
          await this.dependencies.outboxRepository.enqueue(session, event);
        }
        const delay = Math.min(1_000 * (2 ** attempts), MAX_REFERENCE_BACKOFF_MS);
        await transactionRepository.scheduleReferenceCheck(
          session,
          transaction.id,
          attempts,
          new Date(this.now().getTime() + delay),
        );
        return this.result(transaction, false);
      }
      reference = WagerTransaction.rehydrate(referenceState);
      const referenceFailure = transaction.validateReference(reference);
      if (referenceFailure !== undefined) {
        transaction.reject(referenceFailure);
        await transactionRepository.updateStatus(session, transaction);
        await this.enqueueRejected(session, transaction, input);
        return this.result(transaction, false);
      }
      if (
        transaction.requiresReference() &&
        await transactionRepository.findProcessedReversal(session, reference.id, transaction.kind)
      ) {
        transaction.reject(FailureCode.AlreadyReversed);
        await transactionRepository.updateStatus(session, transaction);
        await this.enqueueRejected(session, transaction, input);
        return this.result(transaction, false);
      }
    }

    let ledgerEntry: WalletLedgerEntry | undefined;
    if (transaction.kind !== WagerTransactionKind.Loss) {
      const at = this.now();
      const movement = {
        entryId: this.newId(),
        transactionId: transaction.id,
        money: transaction.money,
        at,
      };
      try {
        const direction = transaction.ledgerDirectionFor(reference);
        const entry = direction === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);

        await walletRepository.updateBalance(wallet.id, walletState.version, wallet.balance, at);
        await this.dependencies.ledgerRepository.create(session, entry, wallet.version);
        ledgerEntry = entry;
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
        transaction.reject(
          transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientFunds
            : FailureCode.ReversalWouldOverdraw,
        );
        await transactionRepository.updateStatus(session, transaction);
        await this.enqueueRejected(session, transaction, input);
        return this.result(transaction, false);
      }
    }

    transaction.markProcessed(reference?.id, this.now(), wallet.balance);
    await transactionRepository.updateStatus(session, transaction);
    await this.dependencies.outboxRepository.enqueue(
      session,
      WagerTransactionProcessed.from(transaction, this.eventProps(transaction.id, input)),
    );
    if (ledgerEntry !== undefined) {
      await this.dependencies.outboxRepository.enqueue(
        session,
        WalletBalanceChanged.from(wallet, ledgerEntry, this.eventProps(transaction.id, input)),
      );
    }
    return this.result(transaction, false);
  }

  private async enqueueRejected(
    session: TransactionSession,
    transaction: WagerTransaction,
    input: ProcessWagerTransactionInput,
  ): Promise<void> {
    await this.dependencies.outboxRepository.enqueue(
      session,
      WagerTransactionRejected.from(transaction, this.eventProps(transaction.id, input)),
    );
  }

  private eventProps(aggregateId: string, input: ProcessWagerTransactionInput) {
    return {
      eventId: this.newId(),
      aggregateId,
      correlationId: input.correlationId ?? input.idempotencyKey,
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      occurredAt: this.now(),
    };
  }

  private walletFailure(
    wallet: Wallet,
    input: ProcessWagerTransactionInput,
  ): FailureCode | undefined {
    if (wallet.playerId !== input.playerId) return FailureCode.WalletPlayerMismatch;
    if (wallet.currency !== input.money.currency) return FailureCode.WalletCurrencyMismatch;
    return undefined;
  }

  private replay(
    state: WagerTransactionState,
    payloadHash: string,
  ): ProcessWagerTransactionResult {
    if (state.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError();
    }
    return {
      transactionId: state.id,
      status: state.status,
      balance: state.observedBalance,
      failureCode: state.failureCode,
      idempotentReplay: true,
    };
  }

  private result(
    transaction: WagerTransaction,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.observedBalance,
      failureCode: transaction.failureCode,
      idempotentReplay,
    };
  }
}
