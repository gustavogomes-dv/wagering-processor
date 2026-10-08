import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import {
  createTestOrm,
  createWallet,
  insertLedgerEntry,
  insertTransaction,
  markProcessed,
  moveFunds,
  uuid,
  walletMatchesLedger,
} from '../support/test-database';

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  await orm.close();
});

// Cada comando usa um EntityManager novo para um teste não atrapalhar o outro.
const db = () => orm.em.fork();

const wallets = async (id: string) => {
  const [row] = await db().execute('select balance, version from wallets where id = ?', [id]);
  return row as { balance: string; version: number };
};

describe('migrations', () => {
  it('criam todas as tabelas', async () => {
    const rows = await db().execute(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const names = rows.map((r) => r.table_name);
    for (const table of [
      'wallets',
      'wager_transactions',
      'wallet_ledger_entries',
      'inbox_messages',
      'outbox_messages',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('são reversíveis: down deixa o schema limpo e up recria tudo', async () => {
    const down = await orm.migrator.down({ to: 0 });
    expect(down.length).toBe(5);
    const tables = await db().execute(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name <> 'mikro_orm_migrations'`,
    );
    expect(tables.length).toBe(0);
    const functions = await db().execute(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
    );
    expect(functions.length).toBe(0);

    const up = await orm.migrator.up();
    expect(up.length).toBe(5);
    const pending = await orm.migrator.getPending();
    expect(pending.length).toBe(0);
  });
});

describe('wallets', () => {
  it('aceita uma wallet por jogador e moeda e recusa a segunda', async () => {
    const playerId = `player-${uuid()}`;
    await createWallet(orm, { playerId, currency: 'BRL' });
    await createWallet(orm, { playerId, currency: 'USD' });
    await expect(createWallet(orm, { playerId, currency: 'BRL' })).rejects.toThrow(/wallets_player_currency_uq/);
  });

  it('recusa saldo negativo', async () => {
    await expect(
      db().execute(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, 'p', 'BRL', -0.01, 1, now(), now())`,
        [uuid()],
      ),
    ).rejects.toThrow(/wallets_balance_non_negative/);
  });

  it('recusa moeda fora do formato ISO e version menor que 1', async () => {
    await expect(
      db().execute(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, 'p', 'brl', 0, 1, now(), now())`,
        [uuid()],
      ),
      // A migration 5 restringe a moeda à lista suportada pelo domínio.
      // Por isso, o banco agora identifica a violação como currency_supported.
    ).rejects.toThrow(/wallets_currency_supported/);
    await expect(
      db().execute(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, 'p', 'BRL', 0, 0, now(), now())`,
        [uuid()],
      ),
    ).rejects.toThrow(/wallets_version_positive/);
  });

  it('a version sobe exatamente 1 quando o saldo muda', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    await expect(
      db().execute('update wallets set balance = 90 where id = ?', [wallet.id]),
    ).rejects.toThrow(/version must increase by exactly 1/);
    await expect(
      db().execute('update wallets set balance = 90, version = 5 where id = ?', [wallet.id]),
    ).rejects.toThrow(/version must increase by exactly 1/);
  });

  it('a version não muda sozinha', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    await expect(db().execute('update wallets set version = version + 1 where id = ?', [wallet.id])).rejects.toThrow(
      /version can only change together with the balance/,
    );
  });

  it('id, jogador, moeda e criação são imutáveis, e a wallet não pode ser apagada', async () => {
    const wallet = await createWallet(orm);
    await expect(db().execute(`update wallets set player_id = 'outro' where id = ?`, [wallet.id])).rejects.toThrow(
      /immutable/,
    );
    await expect(db().execute(`update wallets set currency = 'USD' where id = ?`, [wallet.id])).rejects.toThrow(
      /immutable/,
    );
    await expect(db().execute('delete from wallets where id = ?', [wallet.id])).rejects.toThrow(/cannot be deleted/);
  });
});

describe('wager_transactions', () => {
  it('idempotency key repetida é recusada (idempotência persistente)', async () => {
    const wallet = await createWallet(orm);
    const key = `provider-a:${uuid()}`;
    await insertTransaction(db(), { walletId: wallet.id, idempotencyKey: key });
    await expect(insertTransaction(db(), { walletId: wallet.id, idempotencyKey: key })).rejects.toThrow(
      /wager_transactions_idempotency_key_uq/,
    );
  });

  it('o mesmo id externo no mesmo provedor é recusado, mas em outro provedor passa', async () => {
    const wallet = await createWallet(orm);
    const externalId = `ext-${uuid()}`;
    await insertTransaction(db(), { walletId: wallet.id, providerId: 'provider-a', externalId });
    await expect(
      insertTransaction(db(), {
        walletId: wallet.id,
        providerId: 'provider-a',
        externalId,
        idempotencyKey: `outra-${uuid()}`,
      }),
    ).rejects.toThrow(/wager_transactions_provider_external_uq/);
    await insertTransaction(db(), { walletId: wallet.id, providerId: 'provider-b', externalId });
  });

  it('recusa tipo, status e código de falha inventados', async () => {
    const wallet = await createWallet(orm);
    await expect(insertTransaction(db(), { walletId: wallet.id, kind: 'JACKPOT' })).rejects.toThrow(
      /wager_transactions_kind_valid/,
    );
    await expect(insertTransaction(db(), { walletId: wallet.id, status: 'DONE' })).rejects.toThrow(
      /wager_transactions_status_valid/,
    );
    await expect(
      insertTransaction(db(), { walletId: wallet.id, status: 'REJECTED', failureCode: 'QUALQUER_COISA' }),
    ).rejects.toThrow(/wager_transactions_failure_code_valid/);
  });

  it('os valores aceitos pelo banco são os mesmos do domínio (sem desvio entre enum e schema)', async () => {
    const definitionOf = async (constraint: string): Promise<string> => {
      const [row] = await db().execute(
        'select pg_get_constraintdef(oid) as definition from pg_constraint where conname = ?',
        [constraint],
      );
      return (row?.definition ?? '') as string;
    };
    const quoted = (definition: string): string[] =>
      [...definition.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);

    const kinds = await definitionOf('wager_transactions_kind_valid');
    expect(new Set(quoted(kinds))).toEqual(new Set(Object.values(WagerTransactionKind)));

    const statuses = await definitionOf('wager_transactions_status_valid');
    expect(new Set(quoted(statuses))).toEqual(new Set(Object.values(WagerTransactionStatus)));

    const codes = await definitionOf('wager_transactions_failure_code_valid');
    expect(new Set(quoted(codes))).toEqual(new Set(Object.values(FailureCode)));
  });

  it('valor zero só é aceito em LOSS', async () => {
    const wallet = await createWallet(orm);
    await expect(insertTransaction(db(), { walletId: wallet.id, kind: 'BET', amount: '0.00' })).rejects.toThrow(
      /wager_transactions_amount_valid/,
    );
    await insertTransaction(db(), { walletId: wallet.id, kind: 'LOSS', amount: '0.00' });
  });

  it('REFUND e ROLLBACK exigem referência, BET não pode ter', async () => {
    const wallet = await createWallet(orm);
    await expect(insertTransaction(db(), { walletId: wallet.id, kind: 'REFUND' })).rejects.toThrow(
      /wager_transactions_reference_by_kind/,
    );
    await expect(insertTransaction(db(), { walletId: wallet.id, kind: 'ROLLBACK' })).rejects.toThrow(
      /wager_transactions_reference_by_kind/,
    );
    await expect(
      insertTransaction(db(), { walletId: wallet.id, kind: 'BET', referenceExternalId: 'x' }),
    ).rejects.toThrow(/wager_transactions_reference_by_kind/);
    await insertTransaction(db(), { walletId: wallet.id, kind: 'WIN', referenceExternalId: 'bet-1' });
  });

  it('código de falha só existe em REJECTED e FAILED, e eles sempre têm código', async () => {
    const wallet = await createWallet(orm);
    await expect(insertTransaction(db(), { walletId: wallet.id, status: 'REJECTED' })).rejects.toThrow(
      /wager_transactions_failure_code_by_status/,
    );
    await expect(
      insertTransaction(db(), { walletId: wallet.id, status: 'PENDING', failureCode: 'INTERNAL_ERROR' }),
    ).rejects.toThrow(/wager_transactions_failure_code_by_status/);
    await insertTransaction(db(), { walletId: wallet.id, status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    await insertTransaction(db(), { walletId: wallet.id, status: 'FAILED', failureCode: 'INTERNAL_ERROR' });
  });

  it('PROCESSED exige saldo observado e processed_at', async () => {
    const wallet = await createWallet(orm);
    const id = await insertTransaction(db(), { walletId: wallet.id, kind: 'LOSS', amount: '5.00' });
    await expect(
      db().execute(`update wager_transactions set status = 'PROCESSED' where id = ?`, [id]),
    ).rejects.toThrow(/wager_transactions_processed_at_by_status/);
  });

  describe('máquina de estados', () => {
    it('um status terminal nunca mais muda', async () => {
      const wallet = await createWallet(orm);
      const id = await insertTransaction(db(), {
        walletId: wallet.id,
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
      });
      await expect(
        db().execute(`update wager_transactions set updated_at = now() where id = ?`, [id]),
      ).rejects.toThrow(/a REJECTED transaction cannot change anymore/);
      await expect(
        db().execute(`update wager_transactions set status = 'PENDING', failure_code = null where id = ?`, [id]),
      ).rejects.toThrow(/cannot change anymore/);
    });

    it('PENDING_REFERENCE não volta para PENDING', async () => {
      const wallet = await createWallet(orm);
      const id = await insertTransaction(db(), {
        walletId: wallet.id,
        kind: 'WIN',
        referenceExternalId: 'bet-1',
      });
      await db().execute(
        `update wager_transactions set status = 'PENDING_REFERENCE', next_reference_check_at = now() where id = ?`,
        [id],
      );
      await expect(
        db().execute(
          `update wager_transactions set status = 'PENDING', next_reference_check_at = null where id = ?`,
          [id],
        ),
      ).rejects.toThrow(/invalid status transition from PENDING_REFERENCE to PENDING/);
    });

    it('PENDING_REFERENCE pode atualizar tentativas sem sair do status', async () => {
      const wallet = await createWallet(orm);
      const id = await insertTransaction(db(), { walletId: wallet.id, kind: 'WIN', referenceExternalId: 'bet-1' });
      await db().execute(
        `update wager_transactions set status = 'PENDING_REFERENCE', next_reference_check_at = now() where id = ?`,
        [id],
      );
      await db().execute(
        `update wager_transactions set reference_attempts = 1, next_reference_check_at = now() where id = ?`,
        [id],
      );
      const [row] = await db().execute('select reference_attempts from wager_transactions where id = ?', [id]);
      expect(row?.reference_attempts).toBe(1);
    });

    it('campos de negócio são imutáveis e a transação não pode ser apagada', async () => {
      const wallet = await createWallet(orm);
      const id = await insertTransaction(db(), { walletId: wallet.id });
      await expect(db().execute('update wager_transactions set amount = 1 where id = ?', [id])).rejects.toThrow(
        /immutable/,
      );
      await expect(
        db().execute(`update wager_transactions set payload_hash = 'outro' where id = ?`, [id]),
      ).rejects.toThrow(/immutable/);
      await expect(db().execute('delete from wager_transactions where id = ?', [id])).rejects.toThrow(
        /cannot be deleted/,
      );
    });
  });

  describe('reversão única', () => {
    it('o mesmo REFUND não passa duas vezes na mesma BET, e a segunda tentativa não deixa rastro', async () => {
      const wallet = await createWallet(orm, { balance: '100.00' });
      const bet = await moveFunds(orm, wallet.id, { kind: 'BET', direction: 'DEBIT', amount: '30.00' });
      const refund = {
        kind: 'REFUND' as const,
        direction: 'CREDIT' as const,
        amount: '30.00',
        referenceExternalId: bet.externalId,
        referenceTransactionId: bet.transactionId,
      };
      await moveFunds(orm, wallet.id, refund);
      expect((await wallets(wallet.id)).balance).toBe('100.00');

      await expect(moveFunds(orm, wallet.id, refund)).rejects.toThrow(/wager_transactions_reversal_once_uq/);
      // a transação inteira foi desfeita: saldo, version e ledger continuam como antes
      const after = await wallets(wallet.id);
      expect(after.balance).toBe('100.00');
      expect(after.version).toBe(3);
      expect(await walletMatchesLedger(orm, wallet.id)).toBe(true);
    });

    it('um ROLLBACK da mesma BET ainda é permitido, porque é outro tipo de operação', async () => {
      const wallet = await createWallet(orm, { balance: '100.00' });
      const bet = await moveFunds(orm, wallet.id, { kind: 'BET', direction: 'DEBIT', amount: '30.00' });
      await moveFunds(orm, wallet.id, {
        kind: 'REFUND',
        direction: 'CREDIT',
        amount: '30.00',
        referenceExternalId: bet.externalId,
        referenceTransactionId: bet.transactionId,
      });
      const rollback = await moveFunds(orm, wallet.id, {
        kind: 'ROLLBACK',
        direction: 'CREDIT',
        amount: '30.00',
        referenceExternalId: bet.externalId,
        referenceTransactionId: bet.transactionId,
      });
      expect(rollback.balanceAfter).toBe('130.00');
    });
  });
});

describe('wallet_ledger_entries', () => {
    it('rejeita ROLLBACK com a mesma direção da transação referenciada', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });

    // Cria um BET válido: saldo 100 -> 20, version 1 -> 2,
    // e grava corretamente a transação e o lançamento DEBIT.
    const bet = await moveFunds(orm, wallet.id, {
      kind: 'BET',
      direction: 'DEBIT',
      amount: '80.00',
      externalId: `bet-${uuid()}`,
    });

    const rollbackId = await insertTransaction(db(), {
      walletId: wallet.id,
      playerId: 'player-1',
      kind: 'ROLLBACK',
      amount: '80.00',
      currency: 'BRL',
      externalId: `rollback-${uuid()}`,
      referenceExternalId: bet.externalId,
      referenceTransactionId: bet.transactionId,
    });

    // O BET original foi DEBIT. Um ROLLBACK correto deveria ser CREDIT.
    // A tentativa abaixo usa DEBIT novamente e deve ser bloqueada pelo trigger.
    await expect(
      insertLedgerEntry(db(), {
        walletId: wallet.id,
        transactionId: rollbackId,
        walletVersion: 3,
        direction: 'DEBIT',
        amount: '80.00',
        balanceBefore: '20.00',
        balanceAfter: '0.00',
        currency: 'BRL',
      }),
    ).rejects.toThrow(/ROLLBACK direction must be opposite/);
  });
  
  it('fluxo válido: BET de 80 na wallet de 100 deixa 20 e um único débito, e o ledger fecha com a wallet', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const bet = await moveFunds(orm, wallet.id, { kind: 'BET', direction: 'DEBIT', amount: '80.00' });
    expect(bet.balanceAfter).toBe('20.00');
    const state = await wallets(wallet.id);
    expect(state.balance).toBe('20.00');
    expect(state.version).toBe(2);
    const entries = await db().execute(
      `select direction, amount, balance_before, balance_after from wallet_ledger_entries
        where wallet_id = ? and direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(entries.length).toBe(1);
    expect(await walletMatchesLedger(orm, wallet.id)).toBe(true);
  });

  it('a aritmética precisa fechar', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const txId = await insertTransaction(db(), { walletId: wallet.id, amount: '80.00' });
    await expect(
      insertLedgerEntry(db(), {
        walletId: wallet.id,
        transactionId: txId,
        walletVersion: 2,
        direction: 'DEBIT',
        amount: '80.00',
        balanceBefore: '100.00',
        balanceAfter: '30.00',
      }),
    ).rejects.toThrow(/wallet_ledger_entries_arithmetic/);
  });

  it('o lançamento não pode ser alterado, apagado nem truncado', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    await expect(
      db().execute('update wallet_ledger_entries set amount = 1 where wallet_id = ?', [wallet.id]),
    ).rejects.toThrow(/append-only/);
    await expect(db().execute('delete from wallet_ledger_entries where wallet_id = ?', [wallet.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(db().execute('truncate wallet_ledger_entries')).rejects.toThrow(/cannot be truncated/);
  });

  it('a cadeia de saldos não pode ter buraco', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const skipVersion = await insertTransaction(db(), { walletId: wallet.id, amount: '10.00' });
    await expect(
      insertLedgerEntry(db(), {
        walletId: wallet.id,
        transactionId: skipVersion,
        walletVersion: 4,
        direction: 'DEBIT',
        amount: '10.00',
        balanceBefore: '100.00',
        balanceAfter: '90.00',
      }),
    ).rejects.toThrow(/balance chain is broken/);
    await expect(
      insertLedgerEntry(db(), {
        walletId: wallet.id,
        transactionId: skipVersion,
        walletVersion: 2,
        direction: 'DEBIT',
        amount: '10.00',
        balanceBefore: '95.00',
        balanceAfter: '85.00',
      }),
    ).rejects.toThrow(/balance chain is broken/);
  });

  it('o primeiro lançamento parte do saldo zero', async () => {
    const wallet = await createWallet(orm);
    const txId = await insertTransaction(db(), { walletId: wallet.id, kind: 'WIN', amount: '10.00' });
    await expect(
      insertLedgerEntry(db(), {
        walletId: wallet.id,
        transactionId: txId,
        walletVersion: 2,
        direction: 'CREDIT',
        amount: '10.00',
        balanceBefore: '5.00',
        balanceAfter: '15.00',
      }),
    ).rejects.toThrow(/first entry must start from zero/);
  });

  it('a mesma transação não gera dois lançamentos', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const bet = await moveFunds(orm, wallet.id, { kind: 'BET', direction: 'DEBIT', amount: '10.00' });
    await expect(
      insertLedgerEntry(db(), {
        walletId: wallet.id,
        transactionId: bet.transactionId,
        walletVersion: 3,
        direction: 'DEBIT',
        amount: '10.00',
        balanceBefore: '90.00',
        balanceAfter: '80.00',
      }),
    ).rejects.toThrow(/wallet_ledger_entries_wallet_transaction_uq/);
  });

  it('a direção precisa combinar com o tipo da transação', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const bet = await insertTransaction(db(), { walletId: wallet.id, kind: 'BET', amount: '10.00' });
    await expect(
      insertLedgerEntry(db(), {
        walletId: wallet.id,
        transactionId: bet,
        walletVersion: 2,
        direction: 'CREDIT',
        amount: '10.00',
        balanceBefore: '100.00',
        balanceAfter: '110.00',
      }),
    ).rejects.toThrow(/BET must be a DEBIT/);
    const win = await insertTransaction(db(), { walletId: wallet.id, kind: 'WIN', amount: '10.00' });
    await expect(
      insertLedgerEntry(db(), {
        walletId: wallet.id,
        transactionId: win,
        walletVersion: 2,
        direction: 'DEBIT',
        amount: '10.00',
        balanceBefore: '100.00',
        balanceAfter: '90.00',
      }),
    ).rejects.toThrow(/WIN must be a CREDIT/);
  });

  it('LOSS não pode ter lançamento', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const loss = await insertTransaction(db(), { walletId: wallet.id, kind: 'LOSS', amount: '10.00' });
    await expect(
      insertLedgerEntry(db(), {
        walletId: wallet.id,
        transactionId: loss,
        walletVersion: 2,
        direction: 'DEBIT',
        amount: '10.00',
        balanceBefore: '100.00',
        balanceAfter: '90.00',
      }),
    ).rejects.toThrow(/LOSS does not move the balance/);
  });

  it('o lançamento precisa combinar com a transação (wallet e valor)', async () => {
    const walletA = await createWallet(orm, { balance: '100.00' });
    const walletB = await createWallet(orm, { balance: '100.00' });
    const txOfB = await insertTransaction(db(), { walletId: walletB.id, amount: '10.00' });
    await expect(
      insertLedgerEntry(db(), {
        walletId: walletA.id,
        transactionId: txOfB,
        walletVersion: 2,
        direction: 'DEBIT',
        amount: '10.00',
        balanceBefore: '100.00',
        balanceAfter: '90.00',
      }),
    ).rejects.toThrow(/must match the wallet, currency and amount/);
    const txA = await insertTransaction(db(), { walletId: walletA.id, amount: '10.00' });
    await expect(
      insertLedgerEntry(db(), {
        walletId: walletA.id,
        transactionId: txA,
        walletVersion: 2,
        direction: 'DEBIT',
        amount: '20.00',
        balanceBefore: '100.00',
        balanceAfter: '80.00',
      }),
    ).rejects.toThrow(/must match the wallet, currency and amount/);
  });

  describe('atomicidade entre wallet, ledger e transação (conferida no COMMIT)', () => {
    it('saldo alterado sem lançamento é recusado', async () => {
      const wallet = await createWallet(orm, { balance: '100.00' });
      await expect(
        db().transactional(async (em) => {
          await em.execute('update wallets set balance = 50, version = 2 where id = ?', [wallet.id]);
        }),
      ).rejects.toThrow(/do not match its last ledger entry/);
      expect((await wallets(wallet.id)).balance).toBe('100.00');
    });

    it('lançamento sem alterar o saldo é recusado', async () => {
      const wallet = await createWallet(orm, { balance: '100.00' });
      await expect(
        db().transactional(async (em) => {
          const txId = await insertTransaction(em, { walletId: wallet.id, amount: '25.00' });
          await insertLedgerEntry(em, {
            walletId: wallet.id,
            transactionId: txId,
            walletVersion: 2,
            direction: 'DEBIT',
            amount: '25.00',
            balanceBefore: '100.00',
            balanceAfter: '75.00',
          });
        }),
      ).rejects.toThrow(/last ledger entry|ledger entries/);
      expect((await wallets(wallet.id)).version).toBe(1);
    });

    it('BET processada sem lançamento é recusada', async () => {
      const wallet = await createWallet(orm, { balance: '100.00' });
      await expect(
        db().transactional(async (em) => {
          const txId = await insertTransaction(em, { walletId: wallet.id, amount: '25.00' });
          await markProcessed(em, txId, '100.00');
        }),
      ).rejects.toThrow(/must have exactly one ledger entry/);
    });

    it('transação REJECTED com lançamento é recusada', async () => {
      const wallet = await createWallet(orm, { balance: '100.00' });
      await expect(
        db().transactional(async (em) => {
          const txId = await insertTransaction(em, { walletId: wallet.id, amount: '25.00' });
          await em.execute('update wallets set balance = 75, version = 2 where id = ?', [wallet.id]);
          await insertLedgerEntry(em, {
            walletId: wallet.id,
            transactionId: txId,
            walletVersion: 2,
            direction: 'DEBIT',
            amount: '25.00',
            balanceBefore: '100.00',
            balanceAfter: '75.00',
          });
          await em.execute(
            `update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS' where id = ?`,
            [txId],
          );
        }),
      ).rejects.toThrow(/must not have ledger entries/);
    });

    it('LOSS processada sem lançamento é aceita e não mexe no saldo', async () => {
      const wallet = await createWallet(orm, { balance: '100.00' });
      await db().transactional(async (em) => {
        const txId = await insertTransaction(em, { walletId: wallet.id, kind: 'LOSS', amount: '25.00' });
        await markProcessed(em, txId, '100.00');
      });
      expect(await wallets(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    });

    it('wallet com saldo inicial e sem lançamento de abertura é recusada', async () => {
      await expect(
        db().execute(
          `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
           values (?, ?, 'BRL', 10, 1, now(), now())`,
          [uuid(), `player-${uuid()}`],
        ),
      ).rejects.toThrow(/without ledger entries/);
    });
  });

  it('invariante em uma sequência de movimentações: saldo da wallet == saldo reconstruído pelo ledger', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const bet = await moveFunds(orm, wallet.id, { kind: 'BET', direction: 'DEBIT', amount: '40.00' });
    await moveFunds(orm, wallet.id, { kind: 'WIN', direction: 'CREDIT', amount: '75.50' });
    await moveFunds(orm, wallet.id, {
      kind: 'REFUND',
      direction: 'CREDIT',
      amount: '40.00',
      referenceExternalId: bet.externalId,
      referenceTransactionId: bet.transactionId,
    });
    await expect(moveFunds(orm, wallet.id, { kind: 'BET', direction: 'DEBIT', amount: '9999.00' })).rejects.toThrow(
      /wallets_balance_non_negative/,
    );
    expect((await wallets(wallet.id)).balance).toBe('175.50');
    expect(await walletMatchesLedger(orm, wallet.id)).toBe(true);
  });
});

describe('inbox_messages', () => {
  const insertInbox = (consumer: string, messageId: string, hash = 'h1') =>
    db().execute(
      'insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, now())',
      [consumer, messageId, hash],
    );

  it('a mesma mensagem para o mesmo consumidor é recusada (deduplicação persistente)', async () => {
    const messageId = `msg-${uuid()}`;
    await insertInbox('wager-consumer', messageId);
    await expect(insertInbox('wager-consumer', messageId)).rejects.toThrow(/inbox_messages_pk/);
    await insertInbox('outro-consumer', messageId);
  });

  it('processed_at é gravado uma vez, o conteúdo não muda e a linha não é apagada', async () => {
    const messageId = `msg-${uuid()}`;
    await insertInbox('wager-consumer', messageId);
    await db().execute(
      `update inbox_messages set processed_at = now() where consumer_name = 'wager-consumer' and message_id = ?`,
      [messageId],
    );
    await expect(
      db().execute(
        `update inbox_messages set processed_at = now() + interval '1 hour'
          where consumer_name = 'wager-consumer' and message_id = ?`,
        [messageId],
      ),
    ).rejects.toThrow(/processed_at cannot change/);
    await expect(
      db().execute(
        `update inbox_messages set payload_hash = 'outro' where consumer_name = 'wager-consumer' and message_id = ?`,
        [messageId],
      ),
    ).rejects.toThrow(/identity fields are immutable/);
    await expect(
      db().execute(`delete from inbox_messages where consumer_name = 'wager-consumer' and message_id = ?`, [
        messageId,
      ]),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(db().execute('truncate inbox_messages')).rejects.toThrow(/cannot be truncated/);
  });
});

describe('outbox_messages', () => {
  const insertOutbox = (payload: string = '{"a":1}', id: string = uuid()) =>
    db()
      .execute(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, created_at)
         values (?, 'wallet-1', 'WalletBalanceChanged', ?::jsonb, now(), now())`,
        [id, payload],
      )
      .then(() => id);

  it('o payload precisa ser um objeto JSON', async () => {
    await expect(insertOutbox('[1,2]')).rejects.toThrow(/outbox_messages_payload_is_object/);
    await insertOutbox('{"ok":true}');
  });

  it('o conteúdo do evento não muda, mas as tentativas podem subir (nunca descer)', async () => {
    const id = await insertOutbox();
    await expect(db().execute(`update outbox_messages set payload = '{"b":2}' where id = ?`, [id])).rejects.toThrow(
      /event content is immutable/,
    );
    await db().execute(
      `update outbox_messages set attempts = 1, next_attempt_at = now() + interval '5 seconds' where id = ?`,
      [id],
    );
    await expect(db().execute('update outbox_messages set attempts = 0 where id = ?', [id])).rejects.toThrow(
      /attempts cannot decrease/,
    );
  });

  it('mensagem não publicada não pode ser apagada; publicada fica final mas pode ser removida', async () => {
    const id = await insertOutbox();
    await expect(db().execute('delete from outbox_messages where id = ?', [id])).rejects.toThrow(
      /unpublished message cannot be deleted/,
    );
    await db().execute('update outbox_messages set published_at = now() where id = ?', [id]);
    await expect(db().execute('update outbox_messages set attempts = 5 where id = ?', [id])).rejects.toThrow(
      /published message cannot change/,
    );
    await db().execute('delete from outbox_messages where id = ?', [id]);
  });

  it('SKIP LOCKED: dois publishers pegam mensagens diferentes', async () => {
    const ids = [await insertOutbox(), await insertOutbox(), await insertOutbox()];
    const claimed: string[][] = [];
    await Promise.all(
      [0, 1].map(() =>
        db().transactional(async (em) => {
          const rows = await em.execute(
            `select id from outbox_messages
              where published_at is null and id = any(?::uuid[])
              order by occurred_at, id limit 2 for update skip locked`,
            [`{${ids.join(',')}}`],
          );
          claimed.push(rows.map((r) => r.id as string));
          // seguro a transação um instante para o outro publisher disputar as mesmas linhas
          await em.execute('select pg_sleep(0.3)');
        }),
      ),
    );
    const all = claimed.flat();
    expect(all.length).toBe(3);
    expect(new Set(all).size).toBe(3);
  });
});