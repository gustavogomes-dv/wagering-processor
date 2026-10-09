# Decisões de arquitetura

## Objetivo

Este serviço recebe operações de apostas de provedores diferentes e altera o saldo de uma carteira. O ponto mais importante é manter o dinheiro correto mesmo quando a mesma mensagem chega várias vezes, quando duas operações disputam a mesma carteira ou quando um processo cai no meio do trabalho.

A aplicação separa as regras do negócio dos detalhes de banco, HTTP e filas. Isso deixa o código mais fácil de testar e torna cada responsabilidade mais clara.

## Dinheiro

A classe Money guarda o valor em centavos e a moeda. O código não usa number para fazer contas financeiras, porque números de ponto flutuante podem criar diferenças de centavos.

Exemplo: em JavaScript, 0.1 + 0.2 pode resultar em 0.30000000000000004. Em um sistema de apostas isso não é aceitável. Por isso o valor entra e sai como string decimal, por exemplo { amount: "25.00", currency: "BRL" }.

Money é imutável. Somar ou subtrair devolve outro objeto e nunca altera o valor original. Operações entre moedas diferentes são rejeitadas.

## Domínio e pastas

- src/domain: regras puras de carteira, dinheiro, transação e ledger.
- src/application: casos de uso e interfaces que eles precisam.
- src/infra/database: configuração e migrations do PostgreSQL.
- src/infra/persistence: repositórios que transformam objetos em SQL.
- src/infra/http: controllers e endpoints.
- src/infra/messaging: consumidor SQS e publisher da outbox.
- src/infra/observability: métricas e logs.
- test: testes unitários e de integração.

O domínio não importa NestJS, MikroORM ou AWS. A aplicação depende de interfaces, e a infraestrutura fornece as implementações. Essa separação evita que uma decisão de banco ou mensageria se espalhe por todas as regras.

## Wallet e ledger

A wallet guarda o saldo atual para que a consulta seja rápida. O ledger guarda todos os lançamentos, com saldo antes, saldo depois, direção e transação relacionada.

O saldo é uma visão materializada do ledger. A reconciliação soma os lançamentos e compara o resultado com o saldo guardado. Uma divergência é retornada ao cliente, registrada em log e não é corrigida silenciosamente.

O ledger é somente de inclusão. Seus registros não podem ser alterados ou apagados. Constraints e triggers no PostgreSQL reforçam saldo não negativo, aritmética correta, moeda compatível e imutabilidade.

## Concorrência

A unidade de concorrência é a walletId. Antes de alterar uma carteira, o caso de uso executa SELECT FOR UPDATE naquela linha. Assim, duas operações para a mesma carteira são serializadas no banco, mas carteiras diferentes continuam podendo ser processadas em paralelo.

O saldo é atualizado com a versão que foi lida. Se outra transação já tiver alterado a carteira, a atualização não afeta nenhuma linha e o processamento não aceita um estado desatualizado.

Essa proteção fica no banco, e não apenas no código. Isso é necessário porque podem existir várias instâncias da aplicação.

## Idempotência

O provedor envia Idempotency-Key. Essa chave tem uma restrição única no PostgreSQL. O sistema também calcula um SHA-256 dos campos de negócio, em ordem fixa.

Quando a mesma chave chega com o mesmo conteúdo, a aplicação devolve o resultado já gravado e não movimenta o saldo novamente. Quando a chave chega com outro conteúdo, a resposta é conflito. A chave não depende de cache em memória nem somente do FIFO do SQS.

## Transação financeira

O caso de uso processa cada operação dentro de uma transação SQL. Nela são gravados:

1. a transação da aposta;
2. o novo saldo da wallet;
3. o lançamento do ledger;
4. a inbox, quando a entrada veio do SQS;
5. o evento da outbox.

Ou todas essas mudanças são confirmadas, ou nenhuma é. Isso impede que o saldo mude sem histórico ou que o evento seja perdido depois de uma operação confirmada.

## Inbox e consumidor SQS

O SQS trabalha com entrega pelo menos uma vez. Portanto, receber a mesma mensagem novamente é normal.

A inbox guarda consumerName e messageId com uma chave primária composta. O consumidor grava essa informação na mesma transação da operação financeira. O DeleteMessage só acontece depois do commit.

Erros de negócio são finais e recebem acknowledge. Erros temporários não são apagados, então voltam após o tempo de visibilidade. Mensagens inválidas ou incompatíveis com o contrato são encaminhadas para a DLQ. O consumidor reutiliza o mesmo caso de uso da API.

## Outbox e publicação de eventos

O evento não é enviado diretamente durante a alteração da wallet. Primeiro ele é salvo na outbox, na mesma transação financeira. Um worker separado busca os eventos pendentes e os envia para a fila de eventos.

O worker usa FOR UPDATE SKIP LOCKED, permitindo que vários publishers trabalhem ao mesmo tempo sem escolher a mesma linha. Depois de receber a confirmação do SQS, ele marca o evento como publicado.

Se o processo cair depois do envio e antes de marcar o banco, o evento pode ser enviado novamente. O eventId é usado como deduplication id da fila FIFO, e o envelope do evento permanece estável. Essa é uma consequência normal do modelo at-least-once e é tratada como retry seguro.

## Operações fora de ordem

REFUND e ROLLBACK dependem de uma transação anterior. Se a referência ainda não existe, a operação é salva como PENDING_REFERENCE, o evento correspondente vai para a outbox e um worker agenda novas tentativas.

O intervalo aumenta entre as tentativas. Depois de cinco tentativas sem encontrar a referência, a operação é rejeitada com REFERENCE_NOT_FOUND. O registro continua no banco para auditoria.

## Eventos

Os eventos possuem tipo, versão, identificador, agregado, correlação, causa, data e dados. O payload usa { amount, currency }, nunca uma instância interna de Money.

Os eventos publicados são:

- WagerTransactionProcessed para uma operação processada, inclusive LOSS;
- WagerTransactionRejected para uma rejeição de negócio;
- WagerTransactionPendingReference enquanto a referência não foi encontrada;
- WalletBalanceChanged quando o saldo realmente muda.

Separar a fila de comandos da fila de eventos evita que o próprio consumidor leia seus eventos como novas apostas.

## PostgreSQL, MikroORM e migrations

O PostgreSQL é a fonte de verdade das garantias financeiras. As migrations são versionadas e reversíveis. O MikroORM fornece conexão, transação e execução das migrations, enquanto os repositórios mantêm o SQL fora do domínio.

As principais proteções do schema são:

- unicidade de wallet por jogador e moeda;
- unicidade de idempotency key;
- unicidade da referência externa por provedor;
- saldo e valores monetários não negativos;
- ledger imutável;
- uma entrada de ledger por transação e wallet;
- consistência entre wallet, transação e ledger no commit.

## API e health checks

A API expõe criação e consulta de wallets, consulta do ledger, reconciliação, submissão e consulta de transações. A submissão exige Idempotency-Key.

Os códigos HTTP diferenciam payload inválido, conflito de idempotência, rejeição de negócio, processamento pendente e wallet inexistente. GET /health/live verifica se o processo está vivo. GET /health/ready verifica PostgreSQL e as filas SQS.

## Observabilidade

Os logs são JSON e carregam identificadores úteis para seguir uma operação: correlationId, messageId, transactionId, walletId e providerId. Eles não imprimem o payload financeiro completo.

GET /metrics expõe transações por status, duplicatas, retries, mensagens na DLQ, conflitos de lock, latência e atraso da outbox. As métricas são locais ao processo; em produção, cada instância deve ser coletada por Prometheus ou ferramenta equivalente.

## Autenticação

A autenticação não foi implementada neste timebox porque o próprio desafio informa que ela não vale pontos e que a prioridade deve ser correção financeira, concorrência e idempotência.

O próximo passo de produção é ligar os endpoints a um Identity Provider externo, como Keycloak ou Zitadel, usando um AuthGuard do NestJS ou uma ProviderIdentityPort. Não foi criada uma tabela artesanal de usuários e senhas.

Health checks permanecem abertos. Mensagens da fila são tratadas como canal interno, mas seus dados ainda passam pelas validações de domínio.

## Testes

Os testes unitários cobrem Money, Wallet, transições, reversões, códigos de falha e métricas. Os testes de integração usam PostgreSQL e LocalStack reais para verificar migrations, constraints, inbox, outbox, retries, concorrência e múltiplos processos.

Os cenários mais importantes são:

- 50 entregas da mesma aposta em paralelo geram um único débito;
- duas apostas disputam o mesmo saldo sem saldo negativo;
- três processos disputam a mesma wallet;
- publishers usam SKIP LOCKED;
- eventos falham e recebem retry;
- referências chegam fora de ordem;
- o saldo final pode ser reconstruído pelo ledger.

## Limitações conhecidas

Autenticação precisa ser conectada a um Identity Provider antes de uma implantação pública. As métricas precisam de coleta externa em múltiplas instâncias. O desafio usa LocalStack para simular AWS SQS; em produção, as URLs e permissões devem ser configuradas para a conta AWS real.
