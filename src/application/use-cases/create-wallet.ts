import { Money } from '../../domain/shared/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionProcessed } from '../../domain/wagering/wager-events';
import { LedgerDirection } from '../../domain/wallet/ledger-direction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { WalletBalanceChanged } from '../../domain/wallet/wallet-balance-changed';
import type { LedgerRepository } from '../ports/ledger-repository';
import type { OutboxRepository } from '../ports/outbox-repository';
import type { TransactionContext, TransactionSession } from '../ports/transaction-context';
import type { WagerTransactionRepository } from '../ports/wager-transaction-repository';
import type { WalletRepository } from '../ports/wallet-repository';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: Money;
  walletId?: string;
  correlationId?: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
}

export interface CreateWalletDependencies {
  transactionContext: TransactionContext;
  walletRepository: (session: TransactionSession) => WalletRepository;
  wagerTransactionRepository: WagerTransactionRepository;
  ledgerRepository: LedgerRepository;
  outboxRepository: OutboxRepository;
  newId?: () => string;
  now?: () => Date;
}

/** Cria wallet e, se vier saldo inicial, cria o lançamento OPENING atomicamente. */
export class CreateWallet {
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly dependencies: CreateWalletDependencies) {
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
    this.now = dependencies.now ?? (() => new Date());
  }

  execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    return this.dependencies.transactionContext.run(async (session) => {
      const at = this.now();
      const wallet = Wallet.open({
        id: input.walletId ?? this.newId(),
        playerId: input.playerId,
        initialBalance: input.initialBalance,
        createdAt: at,
      });
      const walletRepository = this.dependencies.walletRepository(session);
      await walletRepository.create(wallet);

      if (input.initialBalance.isPositive()) {
        const transaction = WagerTransaction.createOpening({
          id: this.newId(),
          providerId: 'internal',
          externalTransactionId: `opening-${wallet.id}`,
          idempotencyKey: `opening:${wallet.id}`,
          payloadHash: `opening:${wallet.id}:${input.initialBalance.toString()}`,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'wallet-opening',
          gameId: 'internal',
          money: input.initialBalance,
          createdAt: at,
      });
      const entry = WalletLedgerEntry.create({
          id: this.newId(),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction: LedgerDirection.Credit,
          money: input.initialBalance,
          balanceBefore: Money.zero(input.initialBalance.currency),
          balanceAfter: input.initialBalance,
          createdAt: at,
        });
        // Inserimos primeiro em PENDING para respeitar o CHECK de processed_at;
        // a mudança de status só ocorre depois que o lançamento já está no ledger.
        await this.dependencies.wagerTransactionRepository.create(session, transaction);
        await this.dependencies.ledgerRepository.create(session, entry, wallet.version);
        transaction.markProcessed(undefined, at, wallet.balance);
        await this.dependencies.wagerTransactionRepository.updateStatus(session, transaction);

        const common = {
          aggregateId: transaction.id,
          correlationId: input.correlationId ?? transaction.id,
          occurredAt: at,
        };
        await this.dependencies.outboxRepository.enqueue(
          session,
          WagerTransactionProcessed.from(transaction, {
            eventId: this.newId(),
            ...common,
          }),
        );
        await this.dependencies.outboxRepository.enqueue(
          session,
          WalletBalanceChanged.from(wallet, entry, {
            eventId: this.newId(),
            ...common,
          }),
        );
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance,
        version: wallet.version,
      };
    });
  }
}
