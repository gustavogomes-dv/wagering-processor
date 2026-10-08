import { InvalidLedgerEntryError } from '../shared/errors';
import type { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';

// Os dados de um lançamento. Eu uso o mesmo formato para criar (create) e para
// reconstruir do banco (rehydrate).
export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

// Um lançamento do ledger nunca muda depois de criado.
// Eu garanto isso de dois jeitos: todos os campos são readonly e eu congelo o objeto no construtor.
export class WalletLedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly direction: LedgerDirection;
  public readonly money: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;
  public readonly createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.createdAt = state.createdAt;
    // Depois do freeze, qualquer tentativa de alterar um campo lança erro.
    Object.freeze(this);
  }

  // Eu uso create quando estou gerando um lançamento novo: aqui eu valido tudo.
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    // Lançamento com valor zero ou negativo não tem sentido.
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger entry money must be positive');
    }
    // Valor, saldo antes e saldo depois precisam estar na mesma moeda.
    const currency = props.money.currency;
    if (props.balanceBefore.currency !== currency || props.balanceAfter.currency !== currency) {
      throw new InvalidLedgerEntryError('ledger entry currencies must match');
    }
    // O saldo da wallet nunca fica negativo, então o ledger também não pode registrar isso.
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('ledger entry balances cannot be negative');
    }
    const entry = new WalletLedgerEntry(props);
    // Última checagem: a conta fecha? (saldo antes +/- valor == saldo depois)
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('balanceBefore and balanceAfter do not match the movement');
    }
    return entry;
  }

  // Eu uso rehydrate só para reconstruir o que já está no banco, por isso não revalido nada.
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  // Confere a aritmética: crédito soma, débito subtrai.
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}