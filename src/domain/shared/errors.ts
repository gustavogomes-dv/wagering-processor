// Eu uso essa classe como base de todos os erros de regra de negócio do domínio.
// Cada erro tem um "code" fixo, que eu consigo mapear depois para status HTTP, logs e failureCode.
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    // Eu coloco o nome da classe filha no erro para ele aparecer certo nos logs.
    this.name = new.target.name;
  }
}

// Valor ou moeda inválidos na entrada (formato, escala, sinal).
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

// Eu lanço esse erro quando tento misturar moedas (somar BRL com USD, por exemplo).
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

// Eu lanço quando tento debitar mais do que a wallet tem.
// A mensagem não leva valores de propósito: não quero dinheiro vazando em log.
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor() {
    super('Insufficient funds');
  }
}

// Valor de movimentação que não faz sentido (zero ou negativo onde precisa ser positivo).
export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';

  constructor(message: string) {
    super(message);
  }
}

// Wallet montada com dados inválidos (id vazio, saldo inicial negativo).
export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';

  constructor(message: string) {
    super(message);
  }
}

// Lançamento de ledger com aritmética errada, moeda trocada ou saldo negativo.
export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';

  constructor(message: string) {
    super(message);
  }
}

// Transação montada com dados inválidos. No HTTP isso vira "payload inválido".
export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';

  constructor(message: string) {
    super(message);
  }
}

// Tentativa de mudar o status de um jeito que não é permitido (por exemplo, sair de um status terminal).
// Isso é erro de programação, não caminho de negócio.
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(from: string, to: string) {
    super(`Invalid transaction transition from ${from} to ${to}`);
  }
}

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor() {
    super('Wallet was not found');
  }
}
