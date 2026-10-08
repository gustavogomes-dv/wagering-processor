import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
    amount: string;
    currency: string;
}

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
    // valor em centavos guardado em bigint pra evitar problema de precisao com float e number.
    private constructor(
        private readonly cents: bigint,
        public readonly currency: string,
    ) { }

    //cria uma entrada para os valores monetários, validando a entrada e convertendo para centavos.
    static from(props: MoneyProps): Money {
        if (props === null || typeof props !== 'object') {
            throw new InvalidMoneyError('Money must be an object with amount and currency');
        }
        const { amount, currency } = props;
        Money.assertValidCurrency(currency);
        if (typeof amount !== 'string') {
            throw new InvalidMoneyError('amount must be a decimal string');
        }
        const match = AMOUNT_PATTERN.exec(amount);
        if (!match) {
            throw new InvalidMoneyError(
                'amount must be a non-negative decimal string with at most 2 decimal places',
            );
        }
        const whole = match[1]!;
        const fraction = (match[2] ?? '').slice(1).padEnd(2, '0');
        return new Money(BigInt(whole + fraction), currency);
    }

    static zero(currency: string): Money {
        Money.assertValidCurrency(currency);
        return new Money(0n, currency);
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.cents + other.cents, this.currency);
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.cents - other.cents, this.currency);
    }

    negate(): Money {
        return new Money(-this.cents, this.currency);
    }

    isZero(): boolean {
        return this.cents === 0n;
    }

    isPositive(): boolean {
        return this.cents > 0n;
    }

    isNegative(): boolean {
        return this.cents < 0n;
    }

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.cents < other.cents;
    }

    // Compara se dois valores monetários são iguais em valor e moeda.
    equals(other: Money): boolean {
        return this.currency === other.currency && this.cents === other.cents;
    }

    toJSON(): MoneyProps {
        return { amount: this.toString(), currency: this.currency };
    }

    // somente duas casas decimais, sem arredondar e sem not. cientifica
    toString(): string {
        const negative = this.cents < 0n;
        const abs = negative ? -this.cents : this.cents;
        const whole = abs / 100n;
        const fraction = (abs % 100n).toString().padStart(2, '0');
        return `${negative ? '-' : ''}${whole}.${fraction}`;
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new CurrencyMismatchError(this.currency, other.currency);
        }
    }

    private static assertValidCurrency(currency: unknown): asserts currency is string {
        if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
            throw new InvalidMoneyError('currency must be a 3-letter uppercase ISO-4217 code');
        }
    }
}