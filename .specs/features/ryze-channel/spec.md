# Spec: Provider RyzeAPI (`ryze-channel`)

## 1. Problem Statement
O DeskcommCRM utiliza atualmente o WAHA (WhatsApp Web API / NOWEB) como motor local primário de WhatsApp, o que exige a execução de navegadores headless em containers Docker, consumindo quantidade significativa de RAM (200MB-500MB por sessão) e CPU. A integração da **Ryze API** permite descentralizar a execução da conexão para uma API REST leve ou SaaS, zerando o impacto de infraestrutura local de navegadores mantendo total isolamento multi-tenant e segurança P0.

## 2. Goals
- Adicionar o provedor `ryze` na arquitetura de canais do DeskcommCRM sem alterar comportamento de `waha`, `meta_cloud` ou `zernio`.
- Manter a rota de webhook inbound canônica e neutra: `POST /api/v1/webhooks/channel/[token]`.
- Garantir segurança P0: sanitizar o payload do webhook removendo `instanceData.token` antes do arquivamento em banco e prevenir SSRF bloqueando o uso de `instanceData.baseUrl`.
- Garantir que apenas `data.message.direction === "incoming"` possa gerar turnos de conversa e acionar agentes de IA.

## 3. Out of Scope
- Alterações em frontend, UI de conexão multi-provider, IA, automações comerciais, follow-up, billing ou auth/RBAC.
- Modificação dos provedores legados `waha`, `meta_cloud` e `zernio`.
- Criação de rotas dedicadas como `/api/v1/webhooks/ryze`.

## 4. User Stories & Requirement Traceability

| ID | Descrição | Status |
|---|---|---|
| **RYZE-001** | Vocabulário do provider `ryze` registrado em `ChannelProvider` e lint. | CONFIRMED |
| **RYZE-002** | Credenciais criptografadas por tenant (`organization_id` + `ryze_instance_name`). | CONFIRMED |
| **RYZE-003** | Resolução de sessão via `session-ref` sem vazamento entre provedores. | CONFIRMED |
| **RYZE-004** | Matriz de capabilities registrada (`freeformOutsideWindow: true`, `minIntervalMs: null`, `banRisk: true`, `voiceNote: opus-only`). | CONFIRMED |
| **RYZE-005** | Envio de mensagens de texto de saída via `POST /api/message/text/:instance` com header `token: TokenInstance`. | CONFIRMED |
| **RYZE-006** | Envio de mensagens de mídia de saída via `POST /api/message/media/:instance`. | CONFIRMED |
| **RYZE-007** | Autenticação do webhook inbound via header `Authorization: Bearer <webhook_secret>` em tempo constante. | CONFIRMED |
| **RYZE-008** | Validação estrita do contrato de webhook de entrada para `message.exchange`. | CONFIRMED |
| **RYZE-009** | Gate de direção: apenas `direction === "incoming"` gera turno inbound. `direction === "outgoing"` apenas reconcilia status/eco. | CONFIRMED |
| **RYZE-010** | Sanitização P0 do webhook antes de salvar em `webhook_events_log`: remoção de `instanceData.token` e `Authorization`. | CONFIRMED |
| **RYZE-011** | Idempotência de mensagens via `data.id` / `data.message.id`. | CONFIRMED |
| **RYZE-012** | Reconciliação de status de leitura/entrega via evento `message.status`. | CONFIRMED |
| **RYZE-013** | Isolamento total multi-tenant no lookup de sessão e credenciais. | CONFIRMED |
| **RYZE-014** | Mapeamento de erros operacionais HTTP/JSON da Ryze API sem vazamento de tokens nos logs. | CONFIRMED |
| **RYZE-015** | Testes de integração E2E com rota real de webhook e envio outbound. | CONFIRMED |
| **RYZE-016** | Validação sintética e em ambiente real controlado (shadow webhook). | CONFIRMED |
| **RYZE-017** | Estratégia de rollout paralelo mantendo webhooks legados operacionais. | CONFIRMED |
| **RYZE-018** | Regressão zero nos provedores existentes (`waha`, `meta_cloud`, `zernio`). | CONFIRMED |
| **RYZE-019** | Automação e publicação de evidências em gates no Linear com marcação `READY_FOR_REVIEW`. | CONFIRMED |
| **RYZE-020** | Procedimento de cutover limpo e plano de rollback documentado. | CONFIRMED |

## 5. Acceptance Criteria
- `pnpm gov:verify` (typecheck, lint, lint:channels, lint:role-rank, test:unit) 100% verde.
- `pnpm test:db` e `pnpm test:e2e` executados e aprovados.
- Nenhuma ocorrência de `instanceData.token` ou `Authorization` gravada em banco ou logs.
- Rota de webhook `/api/v1/webhooks/channel/[token]` neutra e sanitizada antes do arquivamento.

## 6. Edge Cases & Risks
- **JSON Inválido no Webhook:** O sanitizador deve tratar payload corrompido sem expor tokens.
- **SSRF via `instanceData.baseUrl`:** O sistema jamais usará o parâmetro `baseUrl` vindo da requisição externa; as chamadas de saída usarão exclusivamente a URL configurada internamente.
- **Mensagem Inbound com `direction: "outgoing"` (Eco):** Deve ser ignorada para criação de turnos/IA e utilizada apenas para reconciliar o `external_id`.
