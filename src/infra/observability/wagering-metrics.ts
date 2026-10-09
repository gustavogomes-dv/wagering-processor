import { Injectable } from '@nestjs/common';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import type { MetricsPort } from '../../application/ports/metrics';

/** Métricas locais de diagnóstico; nenhuma decisão financeira depende destes contadores. */
@Injectable()
export class WageringMetrics implements MetricsPort {
  private readonly transactions = new Map<WagerTransactionStatus, number>();
  private readonly counters = new Map<string, number>();
  private processingCount = 0;
  private processingLatencyTotalMs = 0;
  private outboxLagSeconds = 0;

  constructor() {
    for (const status of Object.values(WagerTransactionStatus)) this.transactions.set(status, 0);
  }

  recordTransaction(status: WagerTransactionStatus): void {
    this.transactions.set(status, (this.transactions.get(status) ?? 0) + 1);
  }

  recordDuplicate(): void {
    this.increment('wagering_idempotent_replays_total');
  }

  recordRetry(): void {
    this.increment('wagering_retries_total');
  }

  recordDlqMessage(): void {
    this.increment('wagering_dlq_messages_total');
  }

  recordLockConflict(): void {
    this.increment('wagering_lock_conflicts_total');
  }

  recordProcessingLatency(milliseconds: number): void {
    this.processingCount += 1;
    this.processingLatencyTotalMs += milliseconds;
  }

  setOutboxLag(seconds: number): void {
    this.outboxLagSeconds = Math.max(0, seconds);
  }

  toPrometheusText(): string {
    const lines = [
      '# HELP wagering_transactions_total Terminal and pending transaction outcomes.',
      '# TYPE wagering_transactions_total counter',
      ...[...this.transactions.entries()].map(([status, count]) =>
        `wagering_transactions_total{status="${status}"} ${count}`),
      '# HELP wagering_idempotent_replays_total Replayed requests and duplicate deliveries.',
      '# TYPE wagering_idempotent_replays_total counter',
      `wagering_idempotent_replays_total ${this.get('wagering_idempotent_replays_total')}`,
      '# HELP wagering_retries_total Retry attempts across SQS, outbox and pending references.',
      '# TYPE wagering_retries_total counter',
      `wagering_retries_total ${this.get('wagering_retries_total')}`,
      '# HELP wagering_dlq_messages_total Messages moved to the dead-letter queue.',
      '# TYPE wagering_dlq_messages_total counter',
      `wagering_dlq_messages_total ${this.get('wagering_dlq_messages_total')}`,
      '# HELP wagering_lock_conflicts_total Database lock conflicts.',
      '# TYPE wagering_lock_conflicts_total counter',
      `wagering_lock_conflicts_total ${this.get('wagering_lock_conflicts_total')}`,
      '# HELP wagering_outbox_lag_seconds Age of the oldest unpublished event.',
      '# TYPE wagering_outbox_lag_seconds gauge',
      `wagering_outbox_lag_seconds ${this.outboxLagSeconds.toFixed(3)}`,
      '# HELP wagering_processing_latency_ms_sum Total transaction-processing latency.',
      '# TYPE wagering_processing_latency_ms_sum counter',
      `wagering_processing_latency_ms_sum ${this.processingLatencyTotalMs}`,
      '# HELP wagering_processing_latency_ms_count Number of transaction-processing samples.',
      '# TYPE wagering_processing_latency_ms_count counter',
      `wagering_processing_latency_ms_count ${this.processingCount}`,
    ];
    return `${lines.join('\n')}\n`;
  }

  private increment(name: string): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  private get(name: string): number {
    return this.counters.get(name) ?? 0;
  }
}
