import { createHash } from 'node:crypto';
import type { ProcessWagerTransactionInput } from './use-cases/process-wager-transaction';

/** Hash estável do conteúdo de negócio; não inclui header de idempotência nem metadados de transporte. */
export function hashWagerPayload(
  input: Pick<
    ProcessWagerTransactionInput,
    | 'providerId'
    | 'externalTransactionId'
    | 'playerId'
    | 'walletId'
    | 'roundId'
    | 'gameId'
    | 'kind'
    | 'money'
    | 'referenceExternalTransactionId'
  >,
): string {
  const canonical = {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money.toJSON(),
    playerId: input.playerId,
    providerId: input.providerId,
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    roundId: input.roundId,
    walletId: input.walletId,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
