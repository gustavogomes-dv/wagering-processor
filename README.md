# Wagering Processor

Serviço backend para processar apostas com saldo exato, ledger auditável, idempotência persistente e publicação confiável de eventos.

## Requisitos

- Bun 1.x
- Docker Desktop com Docker Compose

## Executar localmente

1. Instale as dependências:

   ```powershell
   bun install
   ```

2. Copie `.env.example` para `.env` e ajuste as portas se necessário.

3. Inicie PostgreSQL e LocalStack:

   ```powershell
   docker compose up -d --wait
   ```

4. Aplique as migrations:

   ```powershell
   bun run db:migrate
   bun run db:status
   ```

5. Inicie a API e os workers:

   ```powershell
   bun run dev
   ```

O NestJS atende em `http://localhost:3000`. O LocalStack cria a fila de entrada `wager-transactions.fifo`, a DLQ e a fila de eventos `integration-events.fifo`.

## Testes e checagem de tipos

Os testes de integração usam o banco isolado `wager_test` e LocalStack real. Deixe os containers iniciados antes de rodar:

```powershell
bun run typecheck
bun run test
```

`bun run test:unit` executa testes de domínio e métricas. `bun run test:integration` verifica migrations, constraints, repositórios, concorrência, inbox/outbox e SQS.

## Endpoints

- `POST /wallets` — cria uma wallet; saldo inicial positivo gera `OPENING` e crédito no ledger.
- `GET /wallets/:walletId` — consulta saldo e versão.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50` — consulta ledger com cursor opaco.
- `POST /wallets/:walletId/reconciliation` — compara o saldo armazenado com a soma do ledger.
- `POST /wagering/transactions` — envia uma operação; exige `Idempotency-Key`.
- `GET /wagering/transactions/:transactionId` — consulta por id interno.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — consulta pela referência do provedor.
- `GET /health/live` e `GET /health/ready` — liveness e prontidão de PostgreSQL e SQS.
- `GET /metrics` — métricas em formato Prometheus.

Exemplo de aposta:

```powershell
$body = @{
  providerId = 'provider-a'
  externalTransactionId = 'transaction-123'
  playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1'
  walletId = '0192f291-27dd-5c58-bdb2-814ad6a0f4a1'
  roundId = 'round-987'
  gameId = 'fortune-chimp'
  kind = 'BET'
  money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 4

Invoke-RestMethod -Uri http://localhost:3000/wagering/transactions `
  -Method Post `
  -Headers @{ 'Idempotency-Key' = 'provider-a:transaction-123' } `
  -ContentType 'application/json' `
  -Body $body
```

## Autenticação

Autenticação não foi implementada neste timebox. A decisão e o ponto de extensão estão descritos em [ARCHITECTURE.md](ARCHITECTURE.md); em produção, a identidade do provedor deve vir de um Identity Provider/guard NestJS, sem armazenar senhas próprias.
