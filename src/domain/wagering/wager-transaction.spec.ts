import { describe, expect, it } from 'bun:test';
import { InsufficientFundsError, InvalidTransactionError, InvalidTransactionStateError } from '../shared/errors';
import { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/ledger-direction';
import { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

const Kind = WagerTransactionKind;
const Status = WagerTransactionStatus;
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const AT = new Date('2026-10-07T12:00:00.000Z');

// Eu monto uma BET válida e troco só o que cada teste precisa.
let sequence = 0;
const makeTx = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction => {
  sequence += 1;
  return WagerTransaction.create({
    id: `tx-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${sequence}`,
    idempotencyKey: `provider-a:ext-${sequence}`,
    payloadHash: `hash-${sequence}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: AT,
    ...overrides,
  });
};

// Atalho: cria uma transação e já marca como PROCESSED (para servir de referência).
const processed = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction => {
  const tx = makeTx(overrides);
  tx.markProcessed(tx.requiresReference() ? 'ref-internal' : undefined, AT);
  return tx;
};

describe('WagerTransaction.create', () => {
  it('nasce em PENDING', () => {
    const tx = makeTx();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
  });

  it('bloqueia OPENING vindo de fora, mas createOpening funciona', () => {
    expect(() => makeTx({ kind: Kind.Opening })).toThrow(InvalidTransactionError);
    const opening = WagerTransaction.createOpening({
      id: 'open-1',
      providerId: 'internal',
      externalTransactionId: 'opening-wallet-1',
      idempotencyKey: 'internal:opening-wallet-1',
      payloadHash: 'hash-open',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'opening',
      gameId: 'opening',
      money: brl('100.00'),
      createdAt: AT,
    });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(Status.Pending);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('REFUND e ROLLBACK exigem referência', () => {
    expect(() => makeTx({ kind: Kind.Refund })).toThrow(InvalidTransactionError);
    expect(() => makeTx({ kind: Kind.Rollback })).toThrow(InvalidTransactionError);
    expect(makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  it('BET não pode ter referência; WIN e LOSS podem ter', () => {
    expect(() => makeTx({ kind: Kind.Bet, referenceExternalTransactionId: 'x' })).toThrow(InvalidTransactionError);
    expect(() => makeTx({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' })).not.toThrow();
    expect(() => makeTx({ kind: Kind.Loss, referenceExternalTransactionId: 'bet-1' })).not.toThrow();
  });

  it('rejeita referência vazia', () => {
    expect(() => makeTx({ kind: Kind.Win, referenceExternalTransactionId: '  ' })).toThrow(InvalidTransactionError);
  });

  it.each(['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const)(
    'rejeita %s vazio',
    (field) => {
      expect(() => makeTx({ [field]: ' ' })).toThrow(InvalidTransactionError);
    },
  );

  it('valor: zero só é aceito em LOSS', () => {
    expect(() => makeTx({ kind: Kind.Loss, money: brl('0.00') })).not.toThrow();
    expect(() => makeTx({ kind: Kind.Bet, money: brl('0.00') })).toThrow(InvalidTransactionError);
    expect(() => makeTx({ kind: Kind.Win, money: brl('0.00') })).toThrow(InvalidTransactionError);
    expect(() => makeTx({ kind: Kind.Bet, money: brl('5.00').negate() })).toThrow(InvalidTransactionError);
  });

  it('rejeita kind desconhecido', () => {
    expect(() => makeTx({ kind: 'JACKPOT' as WagerTransactionKind })).toThrow(InvalidTransactionError);
  });
});

describe('consultas de domínio', () => {
  it('affectsBalance é falso só para LOSS', () => {
    expect(makeTx({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    expect(makeTx({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    expect(makeTx({ kind: Kind.Win }).affectsBalance()).toBe(true);
  });

  it('matchesPayload compara o hash (mesma key com hash diferente é conflito)', () => {
    const tx = makeTx({ payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });
});

describe('ledgerDirectionFor', () => {
  it('BET debita; WIN e REFUND creditam', () => {
    expect(makeTx({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(makeTx({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  it('LOSS não tem direção', () => {
    expect(() => makeTx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  it('ROLLBACK faz o inverso da referência', () => {
    const rollback = makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'r' });
    expect(rollback.ledgerDirectionFor(processed({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processed({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(
      rollback.ledgerDirectionFor(processed({ kind: Kind.Refund, referenceExternalTransactionId: 'b' })),
    ).toBe(LedgerDirection.Debit);
  });

  it('ROLLBACK sem a referência lança erro', () => {
    const rollback = makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'r' });
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
});

describe('transições de status', () => {
  it('PENDING -> PROCESSED', () => {
    const tx = makeTx();
    tx.markProcessed(undefined, AT);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(AT);
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING -> PENDING_REFERENCE -> PROCESSED guarda a referência interna', () => {
    const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('internal-bet-id', AT);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('internal-bet-id');
  });

  it('PENDING_REFERENCE -> REJECTED com código (esgotou as tentativas)', () => {
    const tx = makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    tx.markPendingReference();
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it('PENDING -> REJECTED e PENDING -> FAILED guardam o código', () => {
    const rejected = makeTx();
    rejected.reject(FailureCode.InsufficientFunds);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    const failed = makeTx();
    failed.fail(FailureCode.InternalError);
    expect(failed.status).toBe(Status.Failed);
    expect(failed.failureCode).toBe(FailureCode.InternalError);
  });

  it('REFUND e ROLLBACK não podem ser marcados como processados sem a referência interna', () => {
    const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    expect(() => tx.markProcessed(undefined, AT)).toThrow(InvalidTransactionError);
    expect(tx.status).toBe(Status.Pending);
  });

  it('markPendingReference exige que a transação aponte para uma referência', () => {
    expect(() => makeTx({ kind: Kind.Bet }).markPendingReference()).toThrow(InvalidTransactionError);
  });

  it('PENDING_REFERENCE não volta para PENDING_REFERENCE', () => {
    const tx = makeTx({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference();
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  const terminals: Array<[string, () => WagerTransaction]> = [
    ['PROCESSED', () => processed()],
    [
      'REJECTED',
      () => {
        const tx = makeTx();
        tx.reject(FailureCode.InsufficientFunds);
        return tx;
      },
    ],
    [
      'FAILED',
      () => {
        const tx = makeTx();
        tx.fail(FailureCode.InternalError);
        return tx;
      },
    ],
  ];

  it.each(terminals)('estado terminal %s não aceita nenhuma transição', (_name, build) => {
    const tx = build();
    const statusBefore = tx.status;
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed(undefined, AT)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(statusBefore);
  });
});

describe('validateReference', () => {
  const bet = () => processed({ kind: Kind.Bet, externalTransactionId: 'bet-1' });
  const refund = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
    makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1', ...overrides });

  it('REFUND de uma BET processada, do mesmo escopo e com o mesmo valor, é válido', () => {
    expect(refund().validateReference(bet())).toBeUndefined();
  });

  it('ROLLBACK de BET, WIN ou REFUND é válido', () => {
    const rollback = () => makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback().validateReference(bet())).toBeUndefined();
    expect(rollback().validateReference(processed({ kind: Kind.Win }))).toBeUndefined();
    expect(
      rollback().validateReference(processed({ kind: Kind.Refund, referenceExternalTransactionId: 'b' })),
    ).toBeUndefined();
  });

  it('WIN de uma BET processada é válido e o valor pode ser diferente', () => {
    const win = makeTx({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1', money: brl('99.00') });
    expect(win.validateReference(bet())).toBeUndefined();
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-2' }],
    ['moeda', { money: usd('25.00') }],
  ] as const)('escopo diferente (%s) dá REFERENCE_MISMATCH', (_name, overrides) => {
    expect(refund(overrides).validateReference(bet())).toBe(FailureCode.ReferenceMismatch);
  });

  it('REFUND de um WIN dá REFERENCE_KIND_INVALID', () => {
    expect(refund().validateReference(processed({ kind: Kind.Win }))).toBe(FailureCode.ReferenceKindInvalid);
  });

  it('ROLLBACK de LOSS ou de outro ROLLBACK dá REFERENCE_KIND_INVALID', () => {
    const rollback = makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.validateReference(processed({ kind: Kind.Loss }))).toBe(FailureCode.ReferenceKindInvalid);
    expect(
      rollback.validateReference(processed({ kind: Kind.Rollback, referenceExternalTransactionId: 'y' })),
    ).toBe(FailureCode.ReferenceKindInvalid);
  });

  it('referência que não está PROCESSED dá REFERENCE_NOT_PROCESSED', () => {
    const pendingBet = makeTx({ kind: Kind.Bet });
    const rejectedBet = makeTx({ kind: Kind.Bet });
    rejectedBet.reject(FailureCode.InsufficientFunds);
    expect(refund().validateReference(pendingBet)).toBe(FailureCode.ReferenceNotProcessed);
    expect(refund().validateReference(rejectedBet)).toBe(FailureCode.ReferenceNotProcessed);
  });

  it('valor de reversão diferente do da referência dá AMOUNT_MISMATCH', () => {
    expect(refund({ money: brl('10.00') }).validateReference(bet())).toBe(FailureCode.AmountMismatch);
  });
});

// Aqui eu junto as peças como o use case vai fazer no passo 4: a transação diz a direção
// e a wallet aplica o débito ou o crédito. É a semente do use case.
describe('regras de negócio aplicadas na wallet', () => {
  const apply = (wallet: Wallet, tx: WagerTransaction, reference?: WagerTransaction) => {
    if (!tx.affectsBalance()) {
      return undefined;
    }
    const props = { entryId: `entry-${tx.id}`, transactionId: tx.id, money: tx.money, at: AT };
    return tx.ledgerDirectionFor(reference) === LedgerDirection.Debit ? wallet.debit(props) : wallet.credit(props);
  };
  const newWallet = (initial: string) =>
    Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(initial), createdAt: AT });

  it('BET debita e WIN credita', () => {
    const wallet = newWallet('100.00');
    apply(wallet, makeTx({ kind: Kind.Bet, money: brl('25.00') }));
    expect(wallet.balance.toString()).toBe('75.00');
    apply(wallet, makeTx({ kind: Kind.Win, money: brl('60.00') }));
    expect(wallet.balance.toString()).toBe('135.00');
  });

  it('LOSS não mexe no saldo, não gera lançamento e não sobe a version', () => {
    const wallet = newWallet('100.00');
    const entry = apply(wallet, makeTx({ kind: Kind.Loss, money: brl('25.00') }));
    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('REFUND devolve o valor da BET', () => {
    const wallet = newWallet('100.00');
    const bet = processed({ kind: Kind.Bet, money: brl('40.00') });
    apply(wallet, bet);
    apply(wallet, makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'b', money: brl('40.00') }));
    expect(wallet.balance.toString()).toBe('100.00');
  });

  it('ROLLBACK de uma WIN debita o valor da WIN', () => {
    const wallet = newWallet('100.00');
    const win = processed({ kind: Kind.Win, money: brl('30.00') });
    apply(wallet, win);
    expect(wallet.balance.toString()).toBe('130.00');
    apply(wallet, makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'w', money: brl('30.00') }), win);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  it('ROLLBACK que deixaria o saldo negativo lança InsufficientFundsError (o use case troca pelo código REVERSAL_WOULD_OVERDRAW)', () => {
    const wallet = newWallet('10.00');
    const win = processed({ kind: Kind.Win, money: brl('50.00') });
    apply(wallet, win); // 60.00
    apply(wallet, makeTx({ kind: Kind.Bet, money: brl('55.00') })); // 5.00
    const rollback = makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'w', money: brl('50.00') });
    expect(() => apply(wallet, rollback, win)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('5.00');
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('reconstrói o estado salvo sem revalidar', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx-db',
      providerId: 'provider-a',
      externalTransactionId: 'ext-db',
      idempotencyKey: 'provider-a:ext-db',
      payloadHash: 'h',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: Kind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'bet-1',
      createdAt: AT,
      status: Status.Processed,
      referenceTransactionId: 'internal-bet',
      processedAt: AT,
    });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('internal-bet');
    expect(tx.isTerminal()).toBe(true);
  });
});