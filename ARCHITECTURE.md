# Como o sistema foi organizado

## Visão geral

O sistema recebe comandos de aposta pela fila `wager-transactions.fifo` ou pela API HTTP. O caso de uso valida a operação, trava a carteira durante a alteração e grava em PostgreSQL a transação, o novo saldo, o lançamento do ledger, a inbox (quando veio do SQS) e o evento da outbox. Tudo acontece na mesma transação. Se uma etapa falhar, o banco desfaz todas.

## Domínio e aplicação

As regras de dinheiro ficam em `src/domain`. A classe `Money` trabalha com centavos e não usa `number` para calcular valores financeiros. `Wallet`, `WagerTransaction` e `WalletLedgerEntry` validam as regras do negócio.

A aplicação conversa com interfaces chamadas portas. Os adaptadores em `src/infra/persistence/postgres` transformam essas interfaces em SQL. Assim, as regras não ficam presas ao PostgreSQL ou ao ORM.

## Concorrência

Duas apostas podem chegar ao mesmo tempo. O processamento usa `SELECT FOR UPDATE` na carteira, então apenas uma operação altera aquela carteira por vez. Carteiras diferentes continuam processando em paralelo. A coluna de versão e as constraints do PostgreSQL também impedem saldo negativo, lançamentos inválidos, moedas incompatíveis e alterações no ledger.

## Idempotência

A chave de idempotência é única no banco. O sistema calcula um SHA-256 dos dados da operação. A mesma chave com o mesmo conteúdo devolve o resultado salvo sem debitar novamente. A mesma chave com conteúdo diferente gera conflito.

## Inbox, outbox e filas

Inbox evita que a mesma mensagem SQS seja processada duas vezes. A mensagem só é removida depois que a transação financeira termina.

Outbox salva o evento junto com a operação. Um worker busca eventos pendentes, envia para a fila de eventos e marca o registro como publicado. Se o processo cair no meio, o evento pode ser tentado novamente com segurança. Mensagens que falham repetidamente vão para a DLQ.

Operações que dependem de uma referência ainda ausente ficam como `PENDING_REFERENCE`. O worker tenta novamente com intervalos crescentes e rejeita depois do limite.

## Pastas principais

- `src/domain`: regras puras do negócio.
- `src/application`: casos de uso e interfaces.
- `src/infra/database`: migrations e configuração do banco.
- `src/infra/persistence`: adaptadores SQL.
- `src/infra/http`: controllers e endpoints.
- `src/infra/messaging`: consumidor SQS e publisher da outbox.
- `src/infra/observability`: métricas e logs.
- `test`: testes de integração e concorrência.

## Limites conhecidos

Autenticação não foi implementada neste desafio. O ponto correto para adicioná-la é um `AuthGuard` do NestJS ligado a um Identity Provider externo. As métricas são locais ao processo e devem ser coletadas por um Prometheus em produção.
