# Decisões da nossa camada

Registro curto, antes de código. Uma decisão nova entra aqui antes de virar migration ou rota.

## DEC-001 — A apostila corrige o prompt-mestre

Data: 2026-10-02.

O prompt-mestre descreve o produto. A apostila de implementação, escrita contra o repositório em 2026-10-01, diz o que já existe. Quando os dois divergem, a apostila manda: não recriar tenant, fila, marca, API nem runtime de IA.

## DEC-002 — O barramento inicial é o `event_log`

Data: 2026-10-02.

Não adicionar Kafka, RabbitMQ, NATS nem Redis como segunda fila do CRM. Workers, retry, backoff, DLQ e idempotência já estão na spec de eventos do upstream. Outra fila só entra com métrica de gargalo.

## DEC-003 — Módulo oficial não é extensão declarativa

Data: 2026-10-02.

ERP, estoque, financeiro e ordens de serviço serão módulos oficiais compilados na imagem, ligados por entitlement por organização. O framework de extensões declarativas continua para contribuição leve, sem execução de código. Desativar um módulo não apaga os dados dele.

Tabelas de módulo opcional seguem a ADR-0002 do upstream: mesmo banco, schema `public`, criação por função provisionadora quando o módulo é instalado. O SQL concreto espera a leitura de `docs/specs/01-spec-platform-base.md` e do padrão de migrations. Não copiar DDL de rascunho.

## DEC-004 — Control plane fica fora deste fork

Data: 2026-10-02.

Licenciamento, billing da plataforma, metering e Integration Hub serão um repositório separado. Este fork não recebe Fastify, BullMQ nem gateway de pagamento no core. A escolha de stack do control plane continua proposta, não requisito do DeskcommCRM.

## DEC-005 — Piloto é ordens de serviço, depois do baseline

Data: 2026-10-02.

O primeiro módulo oficial é `service_orders`, para provar install, entitlement, menu, rota, banco, evento e disable. O MVP de ERP (produto, estoque, pedido, recebível) vem depois. Nada disso começa antes da linha de base de testes.

## DEC-006 — Grace period não tem número mágico

Data: 2026-10-02.

Se o servidor de licença ficar fora, a instalação não bloqueia na hora. A duração do período de tolerância, o que fica somente leitura e quando a licença termina são decisão comercial. Não codificar 24h, 48h ou 72h antes do contrato.

## DEC-007 — Documentação nossa mora em `docs/our-product/`

Data: 2026-10-02.

Não criar na raiz os arquivos soltos pedidos pelo prompt-mestre (`ARCHITECTURE_TARGET.md` e vizinhos). A doutrina do upstream já ocupa a raiz. A camada nossa fica nesta pasta para reduzir conflito no sync.

## DEC-008 — Ambiente deste M0 é Windows, não a VM Ubuntu

Data: 2026-10-02.

A apostila recomenda uma VM Ubuntu para o laboratório. Nesta máquina o trabalho do M0 foi feito no Windows, com Node acima do `.nvmrc`, sem daemon Docker e sem WSL utilizável. Isso fica registrado em [BASELINE.md](BASELINE.md). A VM continua sendo o ambiente alvo antes de webhook externo e de `test:db` confiável. Não tratar o verde parcial do Windows como o verde do CI.
