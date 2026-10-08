//atençao trechos de códigos gerado com ajuda de ia para fins de testes e ajuda para aperfeiçoamento do código, não deve ser usado em produção sem revisão de alguém.

import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from', () => {
    it('aceita valores com 2 casas', () => {
    expect(brl('25.00').toString()).toBe('25.00');
});

    it('normaliza a escala para 2 casas', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('0.05').toString()).toBe('0.05');
});

it('aceita zero', () => {
    expect(brl('0').isZero()).toBe(true);
    expect(brl('0.00').isZero()).toBe(true);
});

it('aceita o maior valor que cabe em NUMERIC(19,2)', () => {
    expect(brl('99999999999999999.99').toString()).toBe('99999999999999999.99');
});

it.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '-1.00',
    '+1.00',
    '1.234',
    '1,00',
    '.50',
    '1.',
    '00.50',
    'abc',
    '0x10',
    '1 000.00',
    ' 1.00',
    '1.00 ',
    '100000000000000000.00',
  ])('rejeita amount inválido: "%s"', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejeita amount que não é string', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it('rejeita entrada que não é objeto', () => {
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(
      InvalidMoneyError,
    );
  });

  it.each(['', 'brl', 'BR', 'BRLX', 'R$', '123'])('rejeita moeda inválida: "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  it('o erro carrega um código estável', () => {
    try {
      brl('1e3');
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect((error as InvalidMoneyError).code).toBe('INVALID_MONEY');
    }
  });
});

describe('Money.zero', () => {
  it('cria zero na moeda informada', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.toString()).toBe('0.00');
    expect(zero.currency).toBe('BRL');
  });

  it('rejeita moeda inválida', () => {
    expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
  });
});

describe('aritmética', () => {
  it('soma sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  it('mantém precisão em valores grandes', () => {
    expect(brl('99999999999999999.99').add(brl('0.01')).toString()).toBe('100000000000000000.00');
  });

  it('subtrai', () => {
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  it('subtração pode resultar em negativo e isso é detectável', () => {
    const result = brl('5.00').subtract(brl('10.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.isPositive()).toBe(false);
    expect(result.toString()).toBe('-5.00');
  });

  it('negate inverte o sinal', () => {
    expect(brl('5.00').negate().toString()).toBe('-5.00');
    expect(brl('5.00').negate().negate().equals(brl('5.00'))).toBe(true);
    expect(brl('0.00').negate().isZero()).toBe(true);
  });

  it('é imutável: operações não alteram a instância original', () => {
    const original = brl('10.00');
    original.add(brl('5.00'));
    original.subtract(brl('3.00'));
    original.negate();
    expect(original.toString()).toBe('10.00');
  });

  it('formata valores abaixo de 1 real', () => {
    expect(brl('0.01').toString()).toBe('0.01');
    expect(brl('0.10').toString()).toBe('0.10');
    expect(brl('1.00').subtract(brl('1.01')).toString()).toBe('-0.01');
  });
});

describe('comparações', () => {
  it('isPositive, isZero, isNegative', () => {
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
  });

  it('isLessThan', () => {
    expect(brl('19.99').isLessThan(brl('20.00'))).toBe(true);
    expect(brl('20.00').isLessThan(brl('20.00'))).toBe(false);
    expect(brl('20.01').isLessThan(brl('20.00'))).toBe(false);
  });

  it('equals compara valor e moeda', () => {
    expect(brl('25.00').equals(brl('25'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('25.00').equals(usd('25.00'))).toBe(false);
  });
});

describe('conflito de moeda', () => {
  it('add lança erro de domínio', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  it('subtract lança erro de domínio', () => {
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  it('isLessThan lança erro de domínio', () => {
    expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  it('o erro carrega um código estável', () => {
    try {
      brl('1.00').add(usd('1.00'));
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect((error as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
    }
  });
});

describe('serialização', () => {
  it('toJSON gera o contrato { amount, currency } com escala 2', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('JSON.stringify usa toJSON e mantém a ordem dos campos', () => {
    expect(JSON.stringify({ money: brl('25.5') })).toBe(
      '{"money":{"amount":"25.50","currency":"BRL"}}',
    );
  });

  it('ida e volta: from(toJSON()) devolve um valor igual', () => {
    const original = brl('1234.56');
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });
});