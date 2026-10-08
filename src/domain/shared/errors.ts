//estacionando os erros de negócio do domínio em um único arquivo para facilitar a manutenção e a consistência das mensagens de erro.
export abstract class DomainError extends Error {
    abstract readonly code: string;

    protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    }
}

export class InvalidMoneyError extends DomainError {
    readonly code = 'INVALID_MONEY';

    constructor(message: string) {
    super(message);
    }
}

export class CurrencyMismatchError extends DomainError {
    readonly code = 'CURRENCY_MISMATCH';

    constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
    }
}