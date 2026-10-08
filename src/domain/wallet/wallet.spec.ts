import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidWalletError,
} from '../shared/errors';
import { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';
import { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const AT = new Date('2026-10-07T12:00:00.000Z');
const LATER = new Date('2026-10-07T13:00:00.000Z');

const openWallet = (initial = '100.00') =>
  Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(initial), createdAt: AT });

// Atalho para montar os dados de uma movimentação.
const move = (id: string, amount: string, at = LATER) => ({
  entryId: `entry-${id}`,
  transactionId: `tx-${id}`,
  money: brl(amount),
  at,
});

describe('Wallet.open', () => {
  it('abre com version 1, saldo e moeda do saldo inicial', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.updatedAt).toEqual(AT);
  });

  it('aceita saldo inicial zero', () => {
    expect(openWallet('0.00').balance.isZero()).toBe(true);
  });

  it('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('10.00').negate(), createdAt: AT }),
    ).toThrow(InvalidWalletError);
  });

  it('rejeita id ou playerId vazio', () => {
    expect(() =>
      Wallet.open({ id: ' ', playerId: 'p', initialBalance: brl('1.00'), createdAt: AT }),
    ).toThrow(InvalidWalletError);
    expect(() =>
      Wallet.open({ id: 'w', playerId: '', initialBalance: brl('1.00'), createdAt: AT }),
    ).toThrow(InvalidWalletError);
  });
});

describe('Wallet.debit', () => {
  it('reduz o saldo, sobe a version e devolve o lançamento DEBIT', () => {
    const wallet = openWallet();
    const entry = wallet.debit(move('1', '80.00'));
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(LATER);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-1');
  });

  it('permite zerar o saldo', () => {
    const wallet = openWallet();
    wallet.debit(move('1', '100.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('com saldo insuficiente lança erro e não altera nada', () => {
    const wallet = openWallet();
    expect(() => wallet.debit(move('1', '100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(AT);
  });

  it('cenário da seção 8 em sequência: duas apostas de 80 com saldo 100', () => {
    const wallet = openWallet();
    wallet.debit(move('1', '80.00'));
    expect(() => wallet.debit(move('2', '80.00'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });
});

describe('Wallet.credit', () => {
  it('aumenta o saldo, sobe a version e devolve o lançamento CREDIT', () => {
    const wallet = openWallet();
    const entry = wallet.credit(move('1', '50.00'));
    expect(wallet.balance.toString()).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.toString()).toBe('150.00');
  });
});

describe('validações de movimentação', () => {
  it('moeda diferente lança erro e não altera nada', () => {
    const wallet = openWallet();
    const props = { entryId: 'e', transactionId: 't', money: usd('10.00'), at: LATER };
    expect(() => wallet.debit(props)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(props)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('valor zero ou negativo lança erro', () => {
    const wallet = openWallet();
    expect(() => wallet.debit(move('1', '0.00'))).toThrow(InvalidAmountError);
    expect(() => wallet.credit(move('1', '0.00'))).toThrow(InvalidAmountError);
    const negative = { ...move('1', '5.00'), money: brl('5.00').negate() };
    expect(() => wallet.credit(negative)).toThrow(InvalidAmountError);
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.rehydrate', () => {
  it('devolve exatamente o estado salvo, sem mexer na version', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: AT,
      updatedAt: LATER,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('42.00');
    expect(wallet.updatedAt).toEqual(LATER);
  });
});

describe('invariante: saldo da wallet == saldo reconstruído pelo ledger', () => {
  it('vale depois de uma sequência de operações, inclusive as que falharam', () => {
    const initial = brl('100.00');
    const wallet = openWallet('100.00');
    const entries: WalletLedgerEntry[] = [];

    entries.push(wallet.debit(move('1', '30.00')));
    entries.push(wallet.credit(move('2', '12.50')));
    try {
      wallet.debit(move('3', '500.00'));
    } catch {
      // essa falhou de propósito e não pode ter deixado rastro no saldo nem no ledger
    }
    entries.push(wallet.debit(move('4', '82.50')));

    // Eu refaço a conta do zero, só com os lançamentos, partindo do saldo inicial.
    const rebuilt = entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit
          ? balance.add(entry.money)
          : balance.subtract(entry.money),
      initial,
    );

    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toString()).toBe('0.00');
    expect(entries.every((entry) => entry.isBalanced())).toBe(true);
    expect(wallet.version).toBe(1 + entries.length);
  });
});