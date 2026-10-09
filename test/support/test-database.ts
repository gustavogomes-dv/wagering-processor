import { MikroORM, type SqlEntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/shared/money';
import { buildOrmConfig } from '../../src/infra/database/mikro-orm.config';

export type Em = SqlEntityManager;

// Os testes de integração usam um banco só deles, para eu nunca apagar dados do banco de desenvolvimento.
const TEST_DATABASE_NAME = 'wager_test';

export const uuid = (): string => crypto.randomUUID();

// URL isolada que os processos filhos usam sem passar pelo reset de schema do createTestOrm.
export function testDatabaseUrl(): string {
  return urlFor(TEST_DATABASE_NAME);
}

// Monto a URL de um banco qualquer a partir do DATABASE_URL (troco só o nome do banco).
function urlFor(databaseName: string): string {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://wager:wager@localhost:5432/wager');
  url.pathname = `/${databaseName}`;
  return url.toString();
}

// Se o banco de teste ainda não existe, eu crio conectando no banco administrativo "postgres".
async function ensureTestDatabase(): Promise<void> {
  const admin = await MikroORM.init(buildOrmConfig(urlFor('postgres')));
  try {
    const found = await admin.em.execute('select 1 from pg_database where datname = ?', [TEST_DATABASE_NAME]);
    if (found.length === 0) {
      await admin.em.execute(`create database ${TEST_DATABASE_NAME}`);
    }
  } finally {
    await admin.close();
  }
}

// Devolve um ORM ligado ao banco de teste, com o schema zerado e todas as migrations aplicadas.
export async function createTestOrm(): Promise<MikroORM> {
  await ensureTestDatabase();
  const orm = await MikroORM.init(buildOrmConfig(urlFor(TEST_DATABASE_NAME)));
  await orm.em.execute('drop schema public cascade');
  await orm.em.execute('create schema public');
  await orm.migrator.up();
  return orm;
}

export interface TransactionInsert {
  id?: string;
  walletId: string;
  kind?: string;
  status?: string;
  amount?: string;
  currency?: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  playerId?: string;
  roundId?: string;
  referenceExternalId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  observedBalance?: string | null;
}

// Insere uma linha em wager_transactions. Por padrão é uma BET de 25.00 em PENDING.
// Eu deixo tudo configurável para conseguir montar também os casos inválidos.
export async function insertTransaction(em: Em, o: TransactionInsert): Promise<string> {
  const id = o.id ?? uuid();
  const providerId = o.providerId ?? 'provider-a';
  const externalId = o.externalId ?? `ext-${id}`;
  const status = o.status ?? 'PENDING';
  await em.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, status, amount, currency, reference_external_transaction_id,
        reference_transaction_id, failure_code, observed_balance, created_at, processed_at, updated_at)
     values (?, ?, ?, ?, 'hash', ?, ?, ?, 'game-1', ?, ?, ?, ?, ?, ?, ?, ?, now(), ?, now())`,
    [
      id,
      providerId,
      externalId,
      o.idempotencyKey ?? `${providerId}:${externalId}`,
      o.walletId,
      o.playerId ?? 'player-1',
      o.roundId ?? 'round-1',
      o.kind ?? 'BET',
      status,
      o.amount ?? '25.00',
      o.currency ?? 'BRL',
      o.referenceExternalId ?? null,
      o.referenceTransactionId ?? null,
      o.failureCode ?? null,
      o.observedBalance ?? null,
      status === 'PROCESSED' ? new Date() : null,
    ],
  );
  return id;
}

export async function insertLedgerEntry(
  em: Em,
  o: {
    walletId: string;
    transactionId: string;
    walletVersion: number;
    direction: string;
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    currency?: string;
  },
): Promise<string> {
  const id = uuid();
  await em.execute(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      id,
      o.walletId,
      o.transactionId,
      o.walletVersion,
      o.direction,
      o.amount,
      o.currency ?? 'BRL',
      o.balanceBefore,
      o.balanceAfter,
    ],
  );
  return id;
}

// Marca uma transação como PROCESSED guardando o saldo observado.
export async function markProcessed(
  em: Em,
  transactionId: string,
  observedBalance: string,
  referenceTransactionId: string | null = null,
): Promise<void> {
  await em.execute(
    `update wager_transactions
        set status = 'PROCESSED', processed_at = now(), observed_balance = ?,
            reference_transaction_id = ?, updated_at = now()
      where id = ?`,
    [observedBalance, referenceTransactionId, transactionId],
  );
}

// Cria uma wallet do jeito certo: tudo na mesma transação SQL.
// Se tem saldo inicial, nasce junto a transação OPENING e o lançamento de crédito.
export async function createWallet(
  orm: MikroORM,
  o: { playerId?: string; currency?: string; balance?: string } = {},
): Promise<{ id: string; playerId: string; currency: string }> {
  const id = uuid();
  const playerId = o.playerId ?? `player-${id}`;
  const currency = o.currency ?? 'BRL';
  const balance = o.balance ?? '0.00';
  await orm.em.fork().transactional(async (em) => {
    await em.execute(
      'insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, ?, 1, now(), now())',
      [id, playerId, currency, balance],
    );
    if (balance !== '0.00') {
      const transactionId = await insertTransaction(em, {
        walletId: id,
        playerId,
        kind: 'OPENING',
        amount: balance,
        currency,
        providerId: 'internal',
        externalId: `opening-${id}`,
      });
      await insertLedgerEntry(em, {
        walletId: id,
        transactionId,
        walletVersion: 1,
        direction: 'CREDIT',
        amount: balance,
        balanceBefore: '0.00',
        balanceAfter: balance,
        currency,
      });
      await markProcessed(em, transactionId, balance);
    }
  });
  return { id, playerId, currency };
}

// Faz uma movimentação completa e válida, tudo na mesma transação SQL:
// trava a wallet, calcula o novo saldo, grava a transação, atualiza a wallet, grava o lançamento
// e marca a transação como PROCESSED. Se o saldo ficar negativo o próprio banco recusa.
export async function moveFunds(
  orm: MikroORM,
  walletId: string,
  o: {
    kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';
    direction: 'DEBIT' | 'CREDIT';
    amount: string;
    referenceTransactionId?: string;
    referenceExternalId?: string;
    externalId?: string;
  },
): Promise<{ transactionId: string; externalId: string; balanceAfter: string }> {
  return orm.em.fork().transactional(async (em) => {
    const [wallet] = await em.execute(
      'select player_id, currency, balance, version from wallets where id = ? for update',
      [walletId],
    );
    if (wallet === undefined) {
      throw new Error(`wallet ${walletId} not found`);
    }
    const before = Money.from({ amount: wallet.balance, currency: wallet.currency });
    const amount = Money.from({ amount: o.amount, currency: wallet.currency });
    const after = o.direction === 'CREDIT' ? before.add(amount) : before.subtract(amount);
    const externalId = o.externalId ?? `ext-${uuid()}`;
    const transactionId = await insertTransaction(em, {
      walletId,
      playerId: wallet.player_id,
      kind: o.kind,
      amount: o.amount,
      currency: wallet.currency,
      externalId,
      referenceExternalId: o.referenceExternalId ?? null,
    });
    await em.execute('update wallets set balance = ?, version = ?, updated_at = now() where id = ?', [
      after.toString(),
      wallet.version + 1,
      walletId,
    ]);
    await insertLedgerEntry(em, {
      walletId,
      transactionId,
      walletVersion: wallet.version + 1,
      direction: o.direction,
      amount: o.amount,
      balanceBefore: before.toString(),
      balanceAfter: after.toString(),
      currency: wallet.currency,
    });
    await markProcessed(em, transactionId, after.toString(), o.referenceTransactionId ?? null);
    return { transactionId, externalId, balanceAfter: after.toString() };
  });
}

// A invariante final de todos os testes: saldo da wallet == saldo reconstruído pelo ledger.
export async function walletMatchesLedger(orm: MikroORM, walletId: string): Promise<boolean> {
  const [row] = await orm.em.fork().execute(
    `select w.balance = coalesce(
             (select sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end)
                from wallet_ledger_entries e where e.wallet_id = w.id), 0) as matches
       from wallets w where w.id = ?`,
    [walletId],
  );
  return row?.matches === true;
}
