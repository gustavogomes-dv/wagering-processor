import { describe, expect, it } from 'bun:test';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { WageringMetrics } from './wagering-metrics';

describe('WageringMetrics', () => {
  it('expõe status, duplicatas, retries, DLQ, locks, latência e atraso da outbox', () => {
    const metrics = new WageringMetrics();
    metrics.recordTransaction(WagerTransactionStatus.Processed);
    metrics.recordDuplicate();
    metrics.recordRetry();
    metrics.recordDlqMessage();
    metrics.recordLockConflict();
    metrics.recordProcessingLatency(12);
    metrics.setOutboxLag(2.5);

    const output = metrics.toPrometheusText();

    expect(output).toContain('wagering_transactions_total{status="PROCESSED"} 1');
    expect(output).toContain('wagering_idempotent_replays_total 1');
    expect(output).toContain('wagering_retries_total 1');
    expect(output).toContain('wagering_dlq_messages_total 1');
    expect(output).toContain('wagering_lock_conflicts_total 1');
    expect(output).toContain('wagering_outbox_lag_seconds 2.500');
    expect(output).toContain('wagering_processing_latency_ms_sum 12');
    expect(output).toContain('wagering_processing_latency_ms_count 1');
  });
});
