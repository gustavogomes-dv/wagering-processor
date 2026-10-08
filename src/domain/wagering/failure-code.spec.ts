import { describe, expect, it } from 'bun:test';
import { FailureCode, ProviderAction, providerActionFor } from './failure-code';

describe('FailureCode', () => {
  it('todo código tem uma ação definida para o provedor', () => {
    for (const code of Object.values(FailureCode)) {
      expect(Object.values(ProviderAction)).toContain(providerActionFor(code));
    }
  });

  it('os valores são estáveis e em maiúsculas com underscore', () => {
    for (const code of Object.values(FailureCode)) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });

  it('saldo insuficiente e reversão que estoura o saldo são códigos diferentes', () => {
    expect(FailureCode.InsufficientFunds).not.toBe(FailureCode.ReversalWouldOverdraw);
  });
});