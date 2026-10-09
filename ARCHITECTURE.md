# Decisões de arquitetura

## Dinheiro e persistência

`Money` guarda centavos em `bigint`; JSON e SQL trafegam decimais como texto/`NUMERIC`, nunca como `number` para cálculo financeiro. Wallet, transação, ledger, inbox e outbox têm migrations versionadas. Constraints e triggers no PostgreSQL protegem valores, unicidade, imutabilidade e consistência no commit.

O MikroORM executa SQL parametrizado dentro de `EntityManager.transactional()`. O domínio permanece independente do ORM. Repositórios traduzem linhas para objetos e vice-versa.

## Concorrência e idempotência

O use case adquire `SELECT ... FOR UPDATE` somente na wallet da operação. Wallets diferentes continuam processando em paralelo. A atualização também compara a versão lida, e o banco exige que saldo e ledger terminem na mesma versão.

`Idempotency-Key` é única no PostgreSQL. A API calcula SHA-256 sobre os campos de negócio numa ordem estável; header e metadados de transporte ficam fora do hash. Repetição com o mesmo hash retorna o resultado salvo; chave com payload diferente vira conflito. O replay usa o saldo observado da operação original.

O consumidor SQS grava `(consumer_name, message_id)` na inbox dentro da mesma transação financeira. A mensagem só é apagada da fila depois do commit. Redelivery não reaplica a movimentação.

## Referências fora de ordem

Operação que depende de referência ausente fica em `PENDING_REFERENCE`; o evento correspondente entra na outbox. Um worker reserva linhas com `FOR UPDATE SKIP LOCKED` e lease curto, sem bloquear a mesma linha em duas instâncias. O intervalo cresce exponencialmente de 1, 2, 4, 8 até 16 segundos. Na quinta tentativa sem resolução, a operação termina como `REJECTED / REFERENCE_NOT_FOUND`.

## Eventos e recuperação

O status financeiro, saldo, ledger, inbox (quando aplicável) e envelope de evento são gravados em uma única transação. Um publisher usa `FOR UPDATE SKIP LOCKED`, envia à fila FIFO `integration-events.fifo` e marca `published_at` no banco. Se o processo cair depois do envio e antes do commit, a mensagem pode ser enviada novamente; `eventId` e deduplicação FIFO tornam esse retry seguro. Falhas usam backoff exponencial limitado a cinco minutos.

Comandos de aposta entram em `wager-transactions.fifo`; após cinco recebimentos sem ack, a política de redrive leva a mensagem à DLQ. Eventos publicados saem por outra fila para impedir que o consumidor leia os próprios eventos como comandos.

## Eventos publicados

- `WagerTransactionProcessed` para transação processada, inclusive `LOSS`.
- `WagerTransactionRejected` para rejeição de negócio.
- `WagerTransactionPendingReference` quando a referência ainda não existe.
- `WalletBalanceChanged` somente quando uma movimentação altera o saldo.

Os envelopes têm versão e carregam valores de `Money` como `{ amount, currency }`.

## Autenticação e limites conhecidos

Autenticação ficou fora da implementação para priorizar as garantias financeiras do challenge. A API está sem guard por enquanto; o ponto de extensão é um `AuthGuard` NestJS ou `ProviderIdentityPort` alimentado por OIDC/IdP externo. Não deve ser criada autenticação artesanal com tabela de senha.

`/metrics` expõe contadores locais do processo em formato Prometheus. Em múltiplas instâncias, cada processo precisa ser coletado; os valores não são uma fonte compartilhada de consistência. Logs de retry e reconciliação omitem payload e valores financeiros. A suíte usa PostgreSQL e LocalStack reais, mas recuperação após reinicialização com três processos externos ainda precisa de um cenário automatizado dedicado.
