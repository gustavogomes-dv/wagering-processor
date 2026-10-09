import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';

/** A aplicação depende apenas do contrato de métricas; a implementação é infraestrutura. */
export interface MetricsPort {
  recordTransaction(status: WagerTransactionStatus): void;
  recordDuplicate(): void;
  recordRetry(): void;
  recordDlqMessage(): void;
  recordLockConflict(): void;
  recordProcessingLatency(milliseconds: number): void;
  setOutboxLag(seconds: number): void;
}
