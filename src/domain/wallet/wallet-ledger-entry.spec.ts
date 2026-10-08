import { describe, expect, it } from 'bun:test';
import { InvalidLedgerEntryError } from '../shared/errors';
import { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';
import { type CreateLedgerEntryProps, WalletLedgerEntry } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const AT = new Date('2026-10-07T12:00:00.000Z');

// Eu monto um lançamento válido de débito (100.00 - 80.00 = 20.00) e troco só o que cada teste precisa.
const validDebit = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('80.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('20.00'),
  createdAt: AT,
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  it('cria um débito com a conta fechando', () => {
    const entry = WalletLedgerEntry.create(validDebit());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toString()).toBe('20.00');
  });

  it('cria um crédito com a conta fechando', () => {
    const entry = WalletLedgerEntry.create(
      validDebit({
        direction: LedgerDirection.Credit,
        money: brl('50.00'),
        balanceBefore: brl('20.00'),
        balanceAfter: brl('70.00'),
      }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejeita aritmética errada', () => {
    expect(() => WalletLedgerEntry.create(validDebit({ balanceAfter: brl('25.00') }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejeita direção trocada (débito somando)', () => {
    expect(() =>
      WalletLedgerEntry.create(validDebit({ balanceBefore: brl('20.00'), balanceAfter: brl('100.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita valor zero ou negativo', () => {
    expect(() => WalletLedgerEntry.create(validDebit({ money: brl('0.00') }))).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create(validDebit({ money: brl('80.00').negate() }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejeita moedas diferentes entre valor e saldos', () => {
    expect(() => WalletLedgerEntry.create(validDebit({ balanceBefore: usd('100.00') }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejeita saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create(
        validDebit({ money: brl('120.00'), balanceBefore: brl('100.00'), balanceAfter: brl('20.00').negate() }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });
});

describe('imutabilidade', () => {
  it('o objeto fica congelado e qualquer alteração lança erro', () => {
    const entry = WalletLedgerEntry.create(validDebit());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { id: string }).id = 'outro';
    }).toThrow();
    expect(entry.id).toBe('entry-1');
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('não revalida: reconstrói o que veio do banco, mesmo inconsistente', () => {
    const entry = WalletLedgerEntry.rehydrate(validDebit({ balanceAfter: brl('25.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});