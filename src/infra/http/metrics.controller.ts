import { Controller, Get, Header, Inject } from '@nestjs/common';
import { WageringMetrics } from '../observability/wagering-metrics';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject('METRICS') private readonly metrics: WageringMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  read(): string {
    return this.metrics.toPrometheusText();
  }
}
