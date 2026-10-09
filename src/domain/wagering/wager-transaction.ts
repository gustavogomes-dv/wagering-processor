import { InvalidTransactionError, InvalidTransactionStateError } from '../shared/errors';
import type { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/ledger-direction';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // esperando a transação referenciada chegar
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violou regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal)
}

const Kind = WagerTransactionKind;
const Status = WagerTransactionStatus;

// Transições de status que eu permito. Quem está em PROCESSED, REJECTED ou FAILED não sai mais.
const ALLOWED_TRANSITIONS: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [Status.Pending]: [Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed],
  [Status.PendingReference]: [Status.Processed, Status.Rejected, Status.Failed],
  [Status.Processed]: [],
  [Status.Rejected]: [],
  [Status.Failed]: [],
};

// Quais tipos de transação cada tipo pode referenciar.
const ALLOWED_REFERENCE_KINDS: Record<WagerTransactionKind, readonly WagerTransactionKind[]> = {
  [Kind.Opening]: [],
  [Kind.Bet]: [],
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

export interface CreateWagerTransactionProps {
  id: string;
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
  // id da referência no provedor (não é o id interno)
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

// Estado completo, usado para reconstruir do banco (rehydrate).
export interface WagerTransactionState {
  id: string;
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
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
    // Saldo observado quando a operação foi processada; necessário para replay idempotente.
  observedBalance?: Money | undefined;
  referenceAttempts?: number;
  nextReferenceCheckAt?: Date;
}

// Texto obrigatório: não pode ser vazio nem só espaços.
function requireText(field: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidTransactionError(`${field} is required`);
  }
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _observedBalance: Money | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._observedBalance = state.observedBalance;
  }

  // Cria uma transação que veio de fora (API ou fila). Ela nasce em PENDING.
  // OPENING é interno, então eu bloqueio aqui: ninguém de fora consegue criar uma.
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) {
      throw new InvalidTransactionError('OPENING is internal and cannot be submitted');
    }
    return WagerTransaction.build(props);
  }

  // Cria a transação interna de abertura da wallet (crédito do saldo inicial).
  static createOpening(
    props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>,
  ): WagerTransaction {
    return WagerTransaction.build({
      ...props,
      kind: Kind.Opening,
      referenceExternalTransactionId: undefined,
    });
  }

  // Reconstrói do banco: não revalida nada.
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.validate(props);
    return new WagerTransaction({
      ...props,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      status: Status.Pending,
    });
  }

  private static validate(props: CreateWagerTransactionProps): void {
    requireText('id', props.id);
    requireText('providerId', props.providerId);
    requireText('externalTransactionId', props.externalTransactionId);
    requireText('idempotencyKey', props.idempotencyKey);
    requireText('payloadHash', props.payloadHash);
    requireText('walletId', props.walletId);
    requireText('playerId', props.playerId);
    requireText('roundId', props.roundId);
    requireText('gameId', props.gameId);

    if (!Object.values(Kind).includes(props.kind)) {
      throw new InvalidTransactionError('kind is not supported');
    }

    // LOSS pode ter valor zero (registra o resultado sem mexer no saldo).
    // Todos os outros tipos precisam de valor maior que zero.
    const moneyIsValid = props.kind === Kind.Loss ? !props.money.isNegative() : props.money.isPositive();
    if (!moneyIsValid) {
      throw new InvalidTransactionError('money amount is not valid for this kind');
    }

    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined) {
      requireText('referenceExternalTransactionId', reference);
    }
    // REFUND e ROLLBACK não existem sem referência.
    if ((props.kind === Kind.Refund || props.kind === Kind.Rollback) && reference === undefined) {
      throw new InvalidTransactionError('referenceExternalTransactionId is required for this kind');
    }
    // BET e OPENING são o começo da cadeia, então não podem apontar para nada.
    if ((props.kind === Kind.Bet || props.kind === Kind.Opening) && reference !== undefined) {
      throw new InvalidTransactionError('referenceExternalTransactionId is not allowed for this kind');
    }
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  // ---- transições de status

  // Marca como aplicada. REFUND e ROLLBACK precisam informar o id interno da referência.
  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance: Money,
  ): void {
    // Reversões precisam apontar para a transação interna que estão revertendo.
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidTransactionError(
        'referenceTransactionId is required to process this kind',
      );
    }
    if (observedBalance.currency !== this.money.currency) {
      throw new InvalidTransactionError(
        'observed balance currency must match transaction currency',
      );
    }
    if (observedBalance.isNegative()) {
      throw new InvalidTransactionError('observed balance cannot be negative');
    }
    this.assertCanMoveTo(Status.Processed);
    this._status = Status.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
  }

  // Marca como "esperando a referência chegar". Só faz sentido se a transação aponta para uma referência.
  markPendingReference(): void {
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionError('a transaction without reference cannot wait for one');
    }
    this.assertCanMoveTo(Status.PendingReference);
    this._status = Status.PendingReference;
  }

  // Rejeita por regra de negócio, guardando o código do motivo.
  reject(code: FailureCode): void {
    this.assertCanMoveTo(Status.Rejected);
    this._status = Status.Rejected;
    this._failureCode = code;
  }

  // Falha permanente de infraestrutura, também com código.
  fail(code: FailureCode): void {
    this.assertCanMoveTo(Status.Failed);
    this._status = Status.Failed;
    this._failureCode = code;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return ALLOWED_TRANSITIONS[this._status].length === 0;
  }

  // LOSS é o único tipo que não mexe no saldo.
  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === Kind.Refund || this.kind === Kind.Rollback;
  }

  // Compara o hash do payload. Se a mesma idempotency key chega com hash diferente, é conflito.
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  // Diz se o lançamento é DEBIT ou CREDIT.
  // BET debita. WIN, REFUND e OPENING creditam. ROLLBACK faz o inverso da referência.
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Win:
      case Kind.Refund:
      case Kind.Opening:
        return LedgerDirection.Credit;
      case Kind.Loss:
        throw new InvalidTransactionError('LOSS does not move the balance');
      case Kind.Rollback: {
        if (reference === undefined) {
          throw new InvalidTransactionError('ROLLBACK needs the reference to know the direction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  // Confere se a referência encontrada serve para esta transação.
  // Devolve o failureCode do problema, ou undefined se estiver tudo certo.
  // Atenção: "REFERENCE_NOT_PROCESSED" aqui só diz que a referência não está PROCESSED.
  // O use case decide: se ela ainda está em andamento eu espero, se foi rejeitada eu rejeito.
  // A regra "não reverter duas vezes" depende do banco, então ela fica fora daqui.
  validateReference(reference: WagerTransaction): FailureCode | undefined {
    const sameScope =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.roundId === this.roundId &&
      reference.money.currency === this.money.currency;
    if (!sameScope) {
      return FailureCode.ReferenceMismatch;
    }
    if (!ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind)) {
      return FailureCode.ReferenceKindInvalid;
    }
    if (reference.status !== Status.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    // Reversão parcial está fora de escopo: o valor tem que ser igual ao da referência.
    if (this.requiresReference() && !reference.money.equals(this.money)) {
      return FailureCode.AmountMismatch;
    }
    return undefined;
  }

  private assertCanMoveTo(next: WagerTransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this._status, next);
    }
  }
}
