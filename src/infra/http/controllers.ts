import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  Body,
} from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Money, type MoneyProps } from '../../domain/shared/money';
import { DomainError, WalletNotFoundError } from '../../domain/shared/errors';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { CreateWallet } from '../../application/use-cases/create-wallet';
import { hashWagerPayload } from '../../application/hash-wager-payload';
import {
  IdempotencyConflictError,
  ProcessWagerTransaction,
  type ProcessWagerTransactionInput,
} from '../../application/use-cases/process-wager-transaction';
import { PostgresTransactionContext } from '../persistence/postgres/postgres-transaction-context';
import { PostgresWalletRepository } from '../persistence/postgres/postgres-wallet-repository';
import { PostgresLedgerRepository } from '../persistence/postgres/postgres-ledger-repository';
import { PostgresWagerTransactionRepository } from '../persistence/postgres/postgres-wager-transaction-repository';
import type { ProviderIdentityPort } from '../../application/ports/provider-identity';
import type { MetricsPort } from '../../application/ports/metrics';

interface HttpStatusResponse {
  status(code: number): HttpStatusResponse;
}

function requiredText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} is required`);
  }
  return value;
}

function requiredUuid(body: Record<string, unknown>, field: string): string {
  const value = requiredText(body, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function moneyFrom(value: unknown): Money {
  if (typeof value !== 'object' || value === null || !('amount' in value) || !('currency' in value)) {
    throw new BadRequestException('money must contain amount and currency');
  }
  try {
    return Money.from(value as MoneyProps);
  } catch (error) {
    if (error instanceof DomainError) throw new BadRequestException(error.message);
    throw error;
  }
}

function transactionBody(body: Record<string, unknown>, idempotencyKey: string): Omit<ProcessWagerTransactionInput, 'payloadHash'> {
  const kindValue = requiredText(body, 'kind');
  if (!Object.values(WagerTransactionKind).includes(kindValue as WagerTransactionKind)) {
    throw new BadRequestException('kind is not supported');
  }
  const reference = body.referenceExternalTransactionId;
  if (reference !== undefined && typeof reference !== 'string') {
    throw new BadRequestException('referenceExternalTransactionId must be a string');
  }
  return {
    providerId: requiredText(body, 'providerId'),
    externalTransactionId: requiredText(body, 'externalTransactionId'),
    idempotencyKey,
    playerId: requiredText(body, 'playerId'),
    walletId: requiredUuid(body, 'walletId'),
    roundId: requiredText(body, 'roundId'),
    gameId: requiredText(body, 'gameId'),
    kind: kindValue as WagerTransactionKind,
    money: moneyFrom(body.money),
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
  };
}

function serializeTransaction(state: Awaited<ReturnType<PostgresWagerTransactionRepository['findById']>>) {
  if (state === undefined) throw new NotFoundException('Wager transaction was not found');
  return {
    transactionId: state.id,
    status: state.status,
    balance: state.observedBalance?.toJSON(),
    failureCode: state.failureCode,
  };
}

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWallet,
    @Inject('ORM') private readonly orm: MikroORM,
    @Inject('METRICS') private readonly metrics: MetricsPort,
  ) {}

  @Post()
  async create(@Body() body: Record<string, unknown>) {
    try {
      const result = await this.createWallet.execute({
        playerId: requiredText(body, 'playerId'),
        initialBalance: moneyFrom(body.initialBalance),
      });
      return { ...result, balance: result.balance.toJSON() };
    } catch (error) {
      if (error instanceof DomainError) throw new BadRequestException(error.message);
      if (String(error).includes('wallets_player_currency_uq')) {
        throw new ConflictException('A wallet already exists for this player and currency');
      }
      throw error;
    }
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer from 1 to 100');
    }
    const cursorVersion = cursor === undefined ? undefined : this.decodeCursor(cursor);
    const context = new PostgresTransactionContext(this.orm.em.fork());
    return context.run(async (session) => {
      const wallets = new PostgresWalletRepository(session);
      if (await wallets.findById(walletId) === undefined) throw new NotFoundException('Wallet was not found');
      const rows = await new PostgresLedgerRepository().listByWallet(session, walletId, limit + 1, cursorVersion);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        entries: page.map(({ entry, walletVersion }) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
          walletVersion,
        })),
        nextCursor: hasMore && page.length > 0
          ? Buffer.from(String(page[page.length - 1]!.walletVersion)).toString('base64url')
          : null,
      };
    });
  }

  @Get(':walletId')
  async find(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    const context = new PostgresTransactionContext(this.orm.em.fork());
    const state = await context.run((session) => new PostgresWalletRepository(session).findById(walletId));
    if (state === undefined) throw new NotFoundException('Wallet was not found');
    return {
      id: state.id,
      playerId: state.playerId,
      balance: state.balance.toJSON(),
      version: state.version,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    const context = new PostgresTransactionContext(this.orm.em.fork());
    const result = await context.run(async (session) => {
      const wallet = await new PostgresWalletRepository(session).findById(walletId);
      if (wallet === undefined) throw new NotFoundException('Wallet was not found');
      const [row] = await session.execute<Array<{
        calculated_balance: string;
        checked_entries: string | number;
      }>>(
        `
          select coalesce(
                   sum(case when direction = 'CREDIT' then amount else -amount end),
                   0
                 )::text as calculated_balance,
                 count(*)::text as checked_entries
            from wallet_ledger_entries
           where wallet_id = ?
        `,
        [walletId],
      );
      const calculatedBalance = Money.from({
        amount: row?.calculated_balance ?? '0.00',
        currency: wallet.currency,
      });
      const difference = wallet.balance.subtract(calculatedBalance);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: Number(row?.checked_entries ?? 0),
      };
    });

    if (!result.consistent) {
      this.metrics.recordReconciliationMismatch();
      // Logamos só o identificador e a contagem; não despejamos valores financeiros no log.
      console.error(JSON.stringify({
        event: 'wallet_reconciliation_mismatch',
        walletId: result.walletId,
        checkedEntries: result.checkedEntries,
      }));
    }
    return result;
  }

  private decodeCursor(cursor: string): number {
    try {
      const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid cursor');
      return value;
    } catch {
      throw new BadRequestException('cursor is invalid');
    }
  }
}

@Controller()
export class WagerTransactionController {
  constructor(
    private readonly processTransaction: ProcessWagerTransaction,
    @Inject('ORM') private readonly orm: MikroORM,
    @Inject('PROVIDER_IDENTITY') private readonly providerIdentity: ProviderIdentityPort,
  ) {}

  @Post('wagering/transactions')
  @HttpCode(200)
  async submit(
    @Body() body: Record<string, unknown>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpStatusResponse,
  ) {
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    const business = transactionBody(body, idempotencyKey);
    this.providerIdentity.assertAllowed(business.providerId);
    try {
      const result = await this.processTransaction.execute({
        ...business,
        payloadHash: hashWagerPayload(business),
      });
      if (result.status === WagerTransactionStatus.PendingReference) response.status(202);
      else if (result.status === WagerTransactionStatus.Rejected) response.status(422);
      return {
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balance?.toJSON(),
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      };
    } catch (error) {
      if (error instanceof IdempotencyConflictError) throw new ConflictException(error.message);
      if (error instanceof WalletNotFoundError) throw new NotFoundException(error.message);
      if (error instanceof DomainError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Get('wagering/transactions/:transactionId')
  async findById(@Param('transactionId', new ParseUUIDPipe()) transactionId: string) {
    const context = new PostgresTransactionContext(this.orm.em.fork());
    const state = await context.run((session) =>
      new PostgresWagerTransactionRepository().findById(session, transactionId),
    );
    return serializeTransaction(state);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const context = new PostgresTransactionContext(this.orm.em.fork());
    const state = await context.run((session) =>
      new PostgresWagerTransactionRepository().findByProviderExternalId(session, providerId, externalTransactionId),
    );
    return serializeTransaction(state);
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject('ORM') private readonly orm: MikroORM,
    @Inject('SQS') private readonly sqs: SQSClient,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    let postgres: 'ok' | 'error' = 'ok';
    let sqs: 'ok' | 'error' = 'ok';
    try {
      await this.orm.em.fork().execute('select 1');
    } catch {
      postgres = 'error';
    }
    const inputQueue = process.env.SQS_QUEUE_URL;
    const eventsQueue = process.env.SQS_EVENTS_QUEUE_URL ??
      inputQueue?.replace(/wager-transactions\.fifo$/, 'integration-events.fifo');
    try {
      if (inputQueue === undefined || eventsQueue === undefined) throw new Error('SQS queue URL is missing');
      for (const queueUrl of [inputQueue, eventsQueue]) {
        await this.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
        );
      }
    } catch {
      sqs = 'error';
    }
    if (postgres !== 'ok' || sqs !== 'ok') {
      throw new ServiceUnavailableException({ status: 'not_ready', postgres, sqs });
    }
    return { status: 'ready', postgres, sqs };
  }
}
