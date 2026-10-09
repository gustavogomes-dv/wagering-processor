import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { PostgresWalletRepository } from '../../src/infra/persistence/postgres/postgres-wallet-repository';
import { PostgresWagerTransactionRepository } from '../../src/infra/persistence/postgres/postgres-wager-transaction-repository';
import { PostgresLedgerRepository } from '../../src/infra/persistence/postgres/postgres-ledger-repository';
import type { TransactionSession } from '../../src/application/ports/transaction-context';
import { IdempotencyConflictError, ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import { CreateWallet } from '../../src/application/use-cases/create-wallet';
import { InboxPayloadConflictError } from '../../src/application/ports/inbox-repository';
import { PostgresTransactionContext } from '../../src/infra/persistence/postgres/postgres-transaction-context';
import { PostgresOutboxRepository } from '../../src/infra/persistence/postgres/postgres-outbox-repository';
import { PostgresInboxRepository } from '../../src/infra/persistence/postgres/postgres-inbox-repository';
import { PendingReferenceWorker } from '../../src/infra/messaging/pending-reference.worker';
import { OutboxPublisherWorker } from '../../src/infra/messaging/outbox-publisher.worker';
import { Money } from '../../src/domain/shared/money';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../src/domain/wallet/wallet';
import {
  createTestOrm,
  createWallet,
  insertLedgerEntry,
  insertTransaction,
  markProcessed,
  moveFunds,
  testDatabaseUrl,
  uuid,
  walletMatchesLedger,
} from '../support/test-database';

let orm: MikroORM;
let sqs: SQSClient;

beforeAll(async () => {
  orm = await createTestOrm();
  sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(process.env.SQS_ENDPOINT === undefined ? {} : { endpoint: process.env.SQS_ENDPOINT }),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
});

afterAll(async () => {
  sqs.destroy();
  await orm.close();
});

// Cada comando usa um EntityManager novo para um teste não atrapalhar o outro.
const db = () => orm.em.fork();

// Adapta o EntityManager de teste ao contrato SQL usado pelos repositórios.
const session: TransactionSession = {
  execute: async <T = unknown>(sql: string, parameters?: readonly unknown[]): Promise<T> => {
    const result = await db().execute(sql, parameters ? [...parameters] : []);
    return result as unknown as T;
  },
};

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

  it('publisher envia evento FIFO ao LocalStack e só depois marca como publicado', async () => {
    const id = uuid();
    await db().execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, created_at)
       values (?, ?, 'IntegrationTestEvent', ?::jsonb, now(), now())`,
      [id, `integration-${id}`, JSON.stringify({ eventId: id, eventType: 'IntegrationTestEvent' })],
    );
    const worker = new OutboxPublisherWorker(
      { run: (work) => new PostgresTransactionContext(db()).run(work) },
      new PostgresOutboxRepository(),
      sqs,
    );

    const result = await worker.runOnce();
    const [row] = await db().execute('select published_at from outbox_messages where id = ?', [id]);

    expect(result.published).toBeGreaterThanOrEqual(1);
    expect(row?.published_at).toBeDefined();
  });

  it('falha de publicação incrementa tentativas e agenda backoff no banco', async () => {
    const id = uuid();
    await db().execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, created_at)
       values (?, ?, 'RetryTestEvent', ?::jsonb, now(), now())`,
      [id, `retry-${id}`, JSON.stringify({ eventId: id })],
    );
    const unavailableSqs = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    try {
      const worker = new OutboxPublisherWorker(
        { run: (work) => new PostgresTransactionContext(db()).run(work) },
        new PostgresOutboxRepository(),
        unavailableSqs,
      );

      const result = await worker.runOnce();
      const [row] = await db().execute(
        `select attempts, next_attempt_at from outbox_messages where id = ?`,
        [id],
      );

      expect(result.retried).toBeGreaterThanOrEqual(1);
      expect(Number(row?.attempts)).toBe(1);
      expect(row?.next_attempt_at).toBeDefined();
    } finally {
      unavailableSqs.destroy();
    }
  });
});

describe('PostgresWalletRepository', () => {
  it('cria e reidrata uma wallet como estado de domínio', async () => {
    const repository = new PostgresWalletRepository(session);
    const now = new Date();

    const wallet = Wallet.open({
      id: uuid(),
      playerId: `repository-player-${uuid()}`,
      // A criação isolada da wallet começa em zero.
      // Saldo inicial positivo será tratado pelo use case junto com OPENING e ledger.
      initialBalance: Money.zero('BRL'),
      createdAt: now,
    });

    await repository.create(wallet);

    const state = await repository.findById(wallet.id);

    expect(state).toBeDefined();
    expect(state?.id).toBe(wallet.id);
    expect(state?.playerId).toBe(wallet.playerId);
    expect(state?.balance.toString()).toBe('0.00');
    expect(state?.version).toBe(1);
  });

  it('encontra uma wallet por jogador e moeda', async () => {
    const repository = new PostgresWalletRepository(session);
    const now = new Date();
    const playerId = `repository-player-${uuid()}`;

    const wallet = Wallet.open({
      id: uuid(),
      playerId,
      initialBalance: Money.zero('USD'),
      createdAt: now,
    });

    await repository.create(wallet);

    const state = await repository.findByPlayerAndCurrency(
      playerId,
      'USD',
    );

    expect(state?.id).toBe(wallet.id);
    expect(state?.currency).toBe('USD');
  });

  it('não atualiza saldo quando a versão esperada está desatualizada', async () => {
    const wallet = await createWallet(orm);
    const repository = new PostgresWalletRepository(session);

    await expect(
      repository.updateBalance(wallet.id, 0, Money.from({ amount: '5.00', currency: 'BRL' }), new Date()),
    ).rejects.toThrow(/changed by another transaction/);
  });
});

describe('PostgresWagerTransactionRepository', () => {
  it('persiste e consulta por id, idempotência e identificador externo', async () => {
    const wallet = await createWallet(orm);
    const repository = new PostgresWagerTransactionRepository();
    const id = uuid();
    const externalId = `external-${id}`;
    const tx = WagerTransaction.create({
      id,
      providerId: 'repository-provider',
      externalTransactionId: externalId,
      idempotencyKey: `key-${id}`,
      payloadHash: 'payload-hash',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-repository',
      gameId: 'game-repository',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '12.50', currency: wallet.currency }),
      createdAt: new Date(),
    });

    await repository.create(session, tx);

    expect((await repository.findById(session, id))?.id).toBe(id);
    expect((await repository.findByIdempotencyKey(session, tx.idempotencyKey))?.id).toBe(id);
    expect((await repository.findByProviderExternalId(session, tx.providerId, externalId))?.id).toBe(id);
  });

  it('reidrata o saldo observado gravado na transação OPENING', async () => {
    const wallet = await createWallet(orm, { balance: '80.00' });
    const [row] = await db().execute(
      `select id from wager_transactions where wallet_id = ? and kind = 'OPENING'`,
      [wallet.id],
    );
    if (row === undefined) throw new Error('OPENING transaction was not created');
    const repository = new PostgresWagerTransactionRepository();

    const state = await repository.findById(session, row.id as string);

    expect(state?.status).toBe(WagerTransactionStatus.Processed);
    expect(state?.observedBalance?.toString()).toBe('80.00');
  });
});

describe('PostgresLedgerRepository', () => {
  it('reidrata o lançamento e pagina usando a versão da wallet', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const opening = await db().execute(
      `select transaction_id from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
    );
    if (opening[0] === undefined) throw new Error('OPENING ledger entry was not created');
    await moveFunds(orm, wallet.id, { kind: 'BET', direction: 'DEBIT', amount: '10.00' });
    const repository = new PostgresLedgerRepository();

    const firstPage = await repository.listByWallet(session, wallet.id, 1);
    const nextPage = await repository.listByWallet(
      session,
      wallet.id,
      1,
      firstPage[0]?.walletVersion,
    );
    const openingEntry = await repository.findByTransactionId(
      session,
      opening[0].transaction_id as string,
    );

    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]?.entry.direction).toBe(LedgerDirection.Debit);
    expect(firstPage[0]?.walletVersion).toBe(2);
    expect(nextPage[0]?.walletVersion).toBe(1);
    expect(openingEntry?.entry.balanceAfter.toString()).toBe('100.00');
  });
});

describe('ProcessWagerTransaction', () => {
  const createUseCase = () => new ProcessWagerTransaction({
    // Um EntityManager por chamada faz Promise.all disputar locks usando conexões distintas.
    transactionContext: {
      run: <T>(work: (transactionSession: TransactionSession) => Promise<T>) =>
        new PostgresTransactionContext(db()).run(work),
    },
    walletRepository: (transactionSession) => new PostgresWalletRepository(transactionSession),
    wagerTransactionRepository: new PostgresWagerTransactionRepository(),
    ledgerRepository: new PostgresLedgerRepository(),
    outboxRepository: new PostgresOutboxRepository(),
    inboxRepository: new PostgresInboxRepository(),
  });

  const bet = (walletId: string, playerId: string, suffix: string) => ({
    providerId: 'processor-test',
    externalTransactionId: `bet-${suffix}`,
    idempotencyKey: `processor-test:bet-${suffix}`,
    payloadHash: `hash-${suffix}`,
    walletId,
    playerId,
    roundId: 'round-processor',
    gameId: 'game-processor',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '80.00', currency: 'BRL' }),
  });

  it('serializa duas apostas concorrentes e só permite um débito', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const processor = createUseCase();

    const [first, second] = await Promise.all([
      processor.execute(bet(wallet.id, wallet.playerId, 'parallel-a')),
      processor.execute(bet(wallet.id, wallet.playerId, 'parallel-b')),
    ]);
    const storedWallet = await wallets(wallet.id);
    const transactions = await db().execute(
      `select status, failure_code from wager_transactions
        where wallet_id = ? and external_transaction_id like 'bet-parallel-%'`,
      [wallet.id],
    );
    const entries = await db().execute(
      `select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [wallet.id],
    );
    const events = await db().execute(
      `select id, event_type from outbox_messages where aggregate_id in
        (select id::text from wager_transactions where wallet_id = ? and external_transaction_id like 'bet-parallel-%')`,
      [wallet.id],
    );

    expect([first.status, second.status].filter((status) => status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect([first.status, second.status].filter((status) => status === WagerTransactionStatus.Rejected)).toHaveLength(1);
    expect(transactions.find((row) => row.status === WagerTransactionStatus.Rejected)?.failure_code).toBe(
      FailureCode.InsufficientFunds,
    );
    expect(storedWallet.balance).toBe('20.00');
    expect(entries).toHaveLength(1);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.id)).size).toBe(3);
    expect(events.map((event) => event.event_type)).toContain('WagerTransactionRejected');
    expect(events.map((event) => event.event_type)).toContain('WagerTransactionProcessed');
    expect(events.map((event) => event.event_type)).toContain('WalletBalanceChanged');
  });

  it('50 redeliveries paralelas com a mesma chave geram um único débito', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const request = bet(wallet.id, wallet.playerId, 'fifty-retries');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => createUseCase().execute(request)),
    );
    const ledger = await db().execute(
      `select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [wallet.id],
    );

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect((await wallets(wallet.id)).balance).toBe('20.00');
    expect(ledger).toHaveLength(1);
  });

  it('três processos independentes disputam a mesma wallet sem duplicar o débito', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const request = bet(wallet.id, wallet.playerId, 'three-processes');
    const script = `${process.cwd()}/test/support/process-wager-child.ts`;
    const children = Array.from({ length: 3 }, () =>
      Bun.spawn([process.execPath, 'run', script], {
        env: {
          DATABASE_URL: testDatabaseUrl(),
          WAGER_INPUT: JSON.stringify(request),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    const results = await Promise.all(children.map(async (child) => {
      const [exitCode, output, errorOutput] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`Child process failed: ${errorOutput}`);
      return JSON.parse(output.trim().split(/\r?\n/).at(-1)!) as {
        transactionId: string;
        idempotentReplay: boolean;
      };
    }));
    const ledger = await db().execute(
      `select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [wallet.id],
    );

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect((await wallets(wallet.id)).balance).toBe('20.00');
    expect(ledger).toHaveLength(1);
  });

  it('mesma chave retorna o resultado original e não repete o débito', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const processor = createUseCase();
    const request = bet(wallet.id, wallet.playerId, 'replay');

    const first = await processor.execute(request);
    const replay = await processor.execute(request);

    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance?.toString()).toBe(first.balance?.toString());
    expect((await wallets(wallet.id)).balance).toBe('20.00');
    const outbox = await db().execute(
      `select id from outbox_messages where aggregate_id = ?`,
      [first.transactionId],
    );
    expect(outbox).toHaveLength(2);

    await expect(
      processor.execute({ ...request, payloadHash: 'different-business-payload' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('processa uma única REFUND por BET e audita a tentativa duplicada', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const processor = createUseCase();
    const originalBet = bet(wallet.id, wallet.playerId, 'to-refund');
    const betResult = await processor.execute(originalBet);
    const refundInput = {
      ...bet(wallet.id, wallet.playerId, 'refund-a'),
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: originalBet.externalTransactionId,
    };
    const refund = await processor.execute(refundInput);
    const duplicateRefund = await processor.execute({
      ...refundInput,
      externalTransactionId: 'refund-duplicate',
      idempotencyKey: 'processor-test:refund-duplicate',
      payloadHash: 'hash-refund-duplicate',
    });

    expect(betResult.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(duplicateRefund.status).toBe(WagerTransactionStatus.Rejected);
    expect(duplicateRefund.failureCode).toBe(FailureCode.AlreadyReversed);
    expect((await wallets(wallet.id)).balance).toBe('100.00');
    const ledger = await db().execute(
      `select id from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
    );
    expect(ledger).toHaveLength(3); // OPENING, BET e apenas uma REFUND
  });

  it('registra LOSS como processada sem alterar saldo ou criar ledger', async () => {
    const wallet = await createWallet(orm, { balance: '35.00' });
    const processor = createUseCase();
    const loss = await processor.execute({
      ...bet(wallet.id, wallet.playerId, 'loss'),
      kind: WagerTransactionKind.Loss,
      money: Money.zero('BRL'),
    });

    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.balance?.toString()).toBe('35.00');
    expect((await wallets(wallet.id)).balance).toBe('35.00');
    const events = await db().execute('select event_type from outbox_messages where aggregate_id = ?', [loss.transactionId]);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionProcessed']);
    const transactionLedger = await db().execute(
      'select id from wallet_ledger_entries where transaction_id = ?',
      [loss.transactionId],
    );
    expect(transactionLedger).toHaveLength(0);
  });

  it('guarda operação dependente em PENDING_REFERENCE e coloca evento na outbox', async () => {
    const wallet = await createWallet(orm, { balance: '35.00' });
    const processor = createUseCase();
    const pending = await processor.execute({
      ...bet(wallet.id, wallet.playerId, 'waiting-refund'),
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'not-arrived-yet',
    });

    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect((await wallets(wallet.id)).balance).toBe('35.00');
    const events = await db().execute('select event_type from outbox_messages where aggregate_id = ?', [pending.transactionId]);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionPendingReference']);
  });

  it('deduplica mensagem SQS pela inbox na mesma transação da aposta', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const processor = createUseCase();
    const message = { consumerName: 'integration-consumer', messageId: `msg-${uuid()}` };
    const request = {
      ...bet(wallet.id, wallet.playerId, 'inbox'),
      inboxMessage: message,
    };

    const first = await processor.execute(request);
    const duplicate = await processor.execute(request);
    const [inbox] = await db().execute(
      `select processed_at from inbox_messages where consumer_name = ? and message_id = ?`,
      [message.consumerName, message.messageId],
    );

    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(duplicate.duplicateDelivery).toBe(true);
    expect(inbox?.processed_at).toBeDefined();
    expect((await wallets(wallet.id)).balance).toBe('20.00');

    await expect(
      processor.execute({ ...request, payloadHash: 'different-message-content' }),
    ).rejects.toBeInstanceOf(InboxPayloadConflictError);
  });

  it('worker reprocessa referência fora de ordem quando a BET chega', async () => {
    const wallet = await createWallet(orm, { balance: '100.00' });
    const processor = createUseCase();
    const refund = await processor.execute({
      ...bet(wallet.id, wallet.playerId, 'out-of-order-refund'),
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'late-reference-bet',
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    await processor.execute({
      ...bet(wallet.id, wallet.playerId, 'late-bet'),
      externalTransactionId: 'late-reference-bet',
    });
    await db().execute(
      `update wager_transactions set next_reference_check_at = now() - interval '1 second' where id = ?`,
      [refund.transactionId],
    );
    const worker = new PendingReferenceWorker(orm, processor);

    expect(await worker.runOnce()).toBeGreaterThanOrEqual(1);
    const transaction = await new PostgresTransactionContext(db()).run((transactionSession) =>
      new PostgresWagerTransactionRepository().findById(transactionSession, refund.transactionId),
    );

    expect(transaction?.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction?.referenceTransactionId).toBeDefined();
    expect((await wallets(wallet.id)).balance).toBe('100.00');
  });
});

describe('CreateWallet', () => {
  const createUseCase = () => new CreateWallet({
    transactionContext: {
      run: <T>(work: (transactionSession: TransactionSession) => Promise<T>) =>
        new PostgresTransactionContext(db()).run(work),
    },
    walletRepository: (transactionSession) => new PostgresWalletRepository(transactionSession),
    wagerTransactionRepository: new PostgresWagerTransactionRepository(),
    ledgerRepository: new PostgresLedgerRepository(),
    outboxRepository: new PostgresOutboxRepository(),
  });

  it('cria saldo inicial com OPENING, ledger e eventos na mesma transação', async () => {
    const result = await createUseCase().execute({
      playerId: `opening-player-${uuid()}`,
      initialBalance: Money.from({ amount: '250.00', currency: 'BRL' }),
    });
    const opening = await db().execute(
      `select id, status, observed_balance from wager_transactions where wallet_id = ? and kind = 'OPENING'`,
      [result.id],
    );
    const ledger = await db().execute(
      `select direction, wallet_version, balance_before, balance_after
         from wallet_ledger_entries where wallet_id = ?`,
      [result.id],
    );
    const events = await db().execute(
      `select event_type from outbox_messages where aggregate_id = ?`,
      [opening[0]?.id as string],
    );

    expect(result.balance.toString()).toBe('250.00');
    expect(result.version).toBe(1);
    expect(opening[0]?.status).toBe(WagerTransactionStatus.Processed);
    expect(String(opening[0]?.observed_balance)).toBe('250.00');
    expect(ledger[0]).toEqual({
      direction: LedgerDirection.Credit,
      wallet_version: 1,
      balance_before: '0.00',
      balance_after: '250.00',
    });
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('cria wallet zerada sem inventar transação ou lançamento', async () => {
    const result = await createUseCase().execute({
      playerId: `empty-player-${uuid()}`,
      initialBalance: Money.zero('BRL'),
    });

    expect(result.balance.toString()).toBe('0.00');
    expect(result.version).toBe(1);
    expect(await db().execute('select id from wager_transactions where wallet_id = ?', [result.id])).toHaveLength(0);
    expect(await db().execute('select id from wallet_ledger_entries where wallet_id = ?', [result.id])).toHaveLength(0);
  });
});
