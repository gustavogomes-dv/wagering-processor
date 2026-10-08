import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidWalletError,
} from '../shared/errors';
import type { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

// Dados de uma wallet. Eu uso esse formato para reconstruir do banco (rehydrate).
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt: Date;
}

// Dados que eu preciso para mexer no saldo. Os ids e a data vêm de fora de propósito:
// assim o domínio não gera nada sozinho e os testes ficam previsíveis.
export interface MoveFundsProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  // Abre uma wallet nova. A version começa em 1 mesmo com saldo inicial: o lançamento
  // de abertura (OPENING) eu crio fora, na mesma transação SQL, com saldo antes = 0.
  static open(props: OpenWalletProps): Wallet {
    if (props.id.trim() === '' || props.playerId.trim() === '') {
      throw new InvalidWalletError('wallet id and playerId are required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance cannot be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.createdAt,
      props.createdAt,
    );
  }

  // Reconstrói do banco: não revalida nada, só devolve o estado que já foi salvo.
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // Tira dinheiro da wallet e devolve o lançamento DEBIT correspondente.
  // Se o saldo não cobre, lanço InsufficientFundsError e não mexo em nada.
  // Quem chama (o use case) decide o failureCode: aposta sem saldo ou reversão que estouraria o saldo.
  debit(props: MoveFundsProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, props, this._balance.subtract(props.money));
  }

  // Coloca dinheiro na wallet e devolve o lançamento CREDIT correspondente.
  credit(props: MoveFundsProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, props, this._balance.add(props.money));
  }

  // Aplica a movimentação. Eu crio o lançamento ANTES de alterar o estado: se o create
  // falhar, a wallet continua exatamente como estava. Saldo e ledger andam sempre juntos.
  private apply(
    direction: LedgerDirection,
    props: MoveFundsProps,
    newBalance: Money,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: props.at,
    });
    this._balance = newBalance;
    this._version += 1; // a version só sobe quando o saldo muda
    this._updatedAt = props.at;
    return entry;
  }

  // Valida moeda e valor antes de qualquer movimentação.
  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidAmountError('amount to move must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}