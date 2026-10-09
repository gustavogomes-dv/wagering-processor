# Guia rápido para apresentar o projeto

Este é um roteiro de estudo. A melhor forma de explicar o projeto é começar pelo problema: receber operações de apostas sem duplicar débitos e sem perder o histórico.

## Por onde comecei

Comecei pelo domínio: dinheiro, carteira, transação e ledger. Primeiro defini as regras que não poderiam ser quebradas, como saldo não negativo, moeda igual e histórico imutável. Depois criei as migrations do PostgreSQL e só então liguei essas regras aos casos de uso, API e filas.

Essa ordem evita construir infraestrutura em cima de uma regra financeira ainda indefinida.

## Tecnologias

- **TypeScript**: tipos ajudam a encontrar erros antes da execução.
- **Bun**: instala dependências e executa a aplicação e os testes.
- **NestJS**: organiza controllers, injeção de dependências e workers.
- **PostgreSQL**: fornece transações, locks, constraints e histórico confiável.
- **MikroORM**: executa migrations e SQL sem colocar detalhes do banco no domínio.
- **SQS e LocalStack**: SQS representa as filas; LocalStack permite testá-las localmente.
- **Docker Compose**: inicia banco e filas com uma configuração repetível.

## A decisão mais importante: Money

Não usei `number` para dinheiro porque ponto flutuante pode gerar erros de centavos. `Money` guarda o valor em centavos e a moeda junto. O banco recebe decimal como texto ou `NUMERIC`.

Frase para usar: “Dinheiro não passa por cálculo de ponto flutuante. Assim evitamos centavos surgindo ou desaparecendo.”

## Carteira e ledger

A carteira guarda o saldo atual para consulta rápida. O ledger guarda cada entrada e saída com saldo anterior e posterior. A reconciliação refaz a conta e confirma se o saldo atual bate com o histórico.

## Fluxo de uma aposta

O caso de uso `ProcessWagerTransaction` valida a operação, procura uma repetição pela chave de idempotência, trava a carteira, aplica débito ou crédito e grava todos os registros na mesma transação. Se algo falhar, nada fica pela metade.

## Como evitei débito duplicado

A chave de idempotência tem restrição única no banco. A primeira chamada grava o resultado. As seguintes encontram o mesmo resultado e o devolvem. Se o conteúdo da operação mudar, o sistema retorna conflito.

Testei 50 chamadas paralelas com a mesma chave e três processos disputando a mesma carteira. Em ambos os casos houve apenas um débito.

## Inbox e outbox

Inbox protege a entrada: uma mensagem SQS repetida não reaplica a operação. Outbox protege a saída: o evento é salvo junto com a operação e só depois enviado por um worker. `SKIP LOCKED` permite que várias instâncias trabalhem sem pegar a mesma linha.

## Referências fora de ordem

Refund e rollback podem depender de uma transação anterior. Se ela ainda não chegou, a operação fica `PENDING_REFERENCE`. O worker tenta novamente com intervalos crescentes. Depois de cinco tentativas, o resultado vira `REJECTED / REFERENCE_NOT_FOUND`.

## Estrutura de pastas

- `src/domain`: regras do negócio.
- `src/application`: casos de uso e portas.
- `src/infra/database`: migrations.
- `src/infra/persistence`: repositórios PostgreSQL.
- `src/infra/http`: API.
- `src/infra/messaging`: SQS, outbox e retries.
- `test`: testes de integração e concorrência.

## Dificuldades

As partes mais trabalhosas foram concorrência, idempotência e testes com serviços externos. Resolvi isso colocando garantias importantes no banco, usando transações curtas e testando chamadas repetidas no mesmo processo e em processos independentes.

O CI também falhou inicialmente porque não iniciava o LocalStack. Adicionei o serviço ao workflow e criei as filas antes dos testes.

## Como encerrar

“O objetivo foi garantir que uma aposta nunca altere o saldo de forma parcial ou duplicada. Para isso usei regras no domínio, proteção no PostgreSQL, idempotência, locks, inbox, outbox e testes de concorrência. A autenticação ficou documentada como próximo ponto de produção porque não fazia parte do timebox.”

## Arquivos para mostrar

- `src/domain/shared/money.ts`
- `src/domain/wallet/wallet.ts`
- `src/application/use-cases/process-wager-transaction.ts`
- `src/infra/database/migrations`
- `src/infra/messaging`
- `test/integration/schema.integration.spec.ts`
