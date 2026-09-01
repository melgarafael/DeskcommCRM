---
title: Sub-PRD 06 — Integração Nuvemshop + Webhooks LGPD
parent: 00-prd-master.md
depends_on: 01-prd-platform-base.md, 02-prd-customer-360.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
---

# Sub-PRD 06 — Integração Nuvemshop + Webhooks LGPD

> Camada que conecta o SonghaiCRM ao backend de e-commerce do tenant. No MVP, o único provedor é a Nuvemshop. Toda a integração foi pensada por trás de um adapter abstrato (`EcommercePlatformAdapter`) pra que VTEX e Shopify entrem em fases posteriores sem alterar a camada de domínio (`crm_leads`, `contacts`, `orders`). Aqui também moram os 3 webhooks LGPD obrigatórios (`customer/redact`, `customer/data_request`, `store/redact`) — contrato regulatório de primeira classe, não afterthought.

---

## 1. Contexto & Posicionamento

A Nuvemshop é a fonte canônica de pedidos, clientes e catálogo do tenant. Sem essa integração, o SonghaiCRM vira inbox WhatsApp sem contexto de pedido — o que os concorrentes B2B genéricos já entregam. **A integração é o que transforma "atendimento" em "atendimento e-commerce-native"**: cada conversa carrega visibilidade do último pedido, status de pagamento, rastreio e carrinho abandonado.

Três responsabilidades acopladas justificam viver no mesmo sub-PRD: (a) **sincronização operacional** (pedidos viram leads no pipeline "Pedidos"; transições de status movem o card); (b) **hidratação de identity resolution** (Sub-PRD 02 §3.3): clientes Nuvemshop alimentam `contacts`; conflitos com contacts vindos do WhatsApp caem em `merge_queue`; (c) **conformidade LGPD reativa**: quando a Nuvemshop emite `customer/redact`, `customer/data_request` ou `store/redact`, o SonghaiCRM **deve** responder dentro de SLA (D+7 / D+15) com audit denso e cascade correto.

A camada precisa ser **plugável** (Nuvemshop é a primeira impl) e **resiliente** (webhook que não chega = perda silenciosa de pedido). É uma das três superfícies do produto onde defeito vira incidente regulatório direto (junto com Plataforma Base e WhatsApp WAHA).

---

## 2. Escopo

### Dentro do escopo deste sub-PRD

1. Interface abstrata `EcommercePlatformAdapter` e a primeira implementação `NuvemshopAdapter`
2. Fluxo OAuth de conexão de tenant à Nuvemshop (com tokens encrypted-at-rest)
3. Receiver de 8 webhooks Nuvemshop obrigatórios no MVP (5 de pedido/carrinho + 3 de LGPD)
4. Validação HMAC, idempotência e logging de webhook
5. Pipeline canônico de processamento (validar → log → resolver tenant → idempotência → resolver/criar contact → aplicar mudança no domínio → emitir evento canônico → 200 imediato)
6. Sync inicial pós-conexão (produtos, clientes, pedidos dos últimos 90 dias) e re-sync manual
7. Modelo lógico da tabela `orders` linkada a `crm_leads` via `crm_lead_links` polimórfico
8. Endpoints LGPD-específicos da Nuvemshop e SLAs regulatórios
9. UI de configuração Nuvemshop no admin do tenant (status, re-sync, logs, mapeamento de stage)
10. Tratamento de quota/rate limit da Nuvemshop API
11. Resilência: retry, dead-letter, re-processamento manual

### Fora do escopo deste sub-PRD

- Modelagem genérica de `contacts` e `crm_leads` → Sub-PRD 02
- Framework LGPD genérico (consentimento, endpoints `/api/v1/lgpd/*`) → Sub-PRD 01 §3.6
- Catálogo Nuvemshop como fonte de RAG do chatbot → Sub-PRD 05 (este sub-PRD apenas entrega o feed de produtos)
- Integração com VTEX e Shopify (Fase 5 do roadmap)
- UI Kanban onde o lead movido pelo webhook aparece → Sub-PRD 04

---

## 3. Capacidades Funcionais

### 3.1 Adapter pattern `EcommercePlatformAdapter`

**O que provê.** Interface abstrata que isola a camada de domínio (`crm_leads`, `orders`, `contacts`) de qualquer provedor de e-commerce. Nuvemshop é a primeira impl no MVP; VTEX e Shopify entram em Fases 5+ implementando a mesma interface sem reescrita do CRM.

**Métodos canônicos.** `fetchOrders(since)`, `fetchCustomers(since)`, `fetchProducts()`, `subscribeWebhooks(events[], url, secret)`, `redactCustomer(customer_id)`, `exportCustomerData(customer_id)`.

**Princípios.**
- Adapter é **stateless** (estado mora em `nuvemshop_connections`, `webhook_events_log`, `event_log`)
- Toda chamada saínte respeita rate limit do provedor (vide §3.11)
- Erros do provedor normalizados pra catálogo interno (`platform_token_expired`, `platform_rate_limited`, `platform_not_found`); quem chama não precisa saber se veio da Nuvemshop ou VTEX
- **YAGNI**: nenhuma capacidade que VTEX/Shopify precisariam mas Nuvemshop não — entra quando o segundo adapter for implementado (vide Master §6.6)

**ACs principais.**
- `NuvemshopAdapter implements EcommercePlatformAdapter` cobre 100% dos métodos
- Camada de domínio **não importa** `NuvemshopAdapter` diretamente; só recebe dados via eventos canônicos em `event_log`
- Adicionar um segundo adapter (mock pra testes) não exige tocar em código de domínio

### 3.2 OAuth Nuvemshop

**O que provê.** Fluxo OAuth 2.0 padrão da Nuvemshop pra autorizar o SonghaiCRM a operar a loja. App embedded vs External **deferido pra Spec**.

**Princípios.**
- Tokens encrypted-at-rest via `pgcrypto`, chave **separada** (`NUVEMSHOP_OAUTH_ENCRYPTION_KEY`) pra reduzir blast radius
- Refresh token rotation (cada refresh invalida o anterior)
- Estado da conexão (`saudável | token_expirado | sem_permissão | desconectado`) visível no admin
- Token expirado dispara refresh transparente; se falhar, conexão vira `token_expirado` e admin é notificado
- Plaintext de tokens nunca em log nem em response de API
- Scopes mínimos exibidos ao admin antes do consent

**ACs principais.**
- Token é ilegível por SQL puro (bytea criptografado)
- Desconexão pelo lojista no painel Nuvemshop detectada em <1h via healthcheck
- Re-conexão preserva `connection_id` (não cria duplicado)

### 3.3 Conexão de tenant à Nuvemshop

**O que provê.** Fluxo de UI no admin pro lojista (ou super-admin em nome dele) plugar a Nuvemshop.

**Sequência canônica.** Admin clica "Conectar Nuvemshop" → redirect pro consent screen Nuvemshop com scopes mínimos → callback OAuth recebe `code` → adapter troca por tokens → persiste encrypted (§3.2) → healthcheck (`/store/info`) confirma conexão viva → registra webhooks da §3.4 + dispara sync inicial (§3.7). Falha mostra erro acionável ("token inválido", "scopes insuficientes") + log.

**Princípios.**
- Reconexão é caso de primeira classe (não erro), com fluxo idêntico
- Avisos visuais quando scopes mínimos faltam
- 1 tenant = 1 conexão Nuvemshop ativa no MVP (multi-loja deferido)

**ACs principais.**
- Lojista conecta em ≤4 cliques
- Healthcheck periódico detecta token expirado em <1h e atualiza status
- Conexão exibe `last_synced_at`, `webhook_count_received_24h`, `last_webhook_at`

### 3.4 Webhooks Nuvemshop (8 obrigatórios no MVP)

**O que provê.** Receiver HTTP em `/api/v1/webhooks/nuvemshop/...` que recebe eventos do provedor e os converte em mudanças no domínio.

**Eventos cobertos no MVP.**

| Evento Nuvemshop | Ação no SonghaiCRM |
|---|---|
| `order/created` | Cria lead em pipeline "Pedidos", stage "Aguardando pagamento"; cria/resolve contact via §3.6; activity `nuvemshop_order_created` |
| `order/paid` | Move lead pra stage "Pago" (default; configurável §3.10); activity `nuvemshop_order_paid`; transição automática de `status` segue Sub-PRD 02 §3.8 |
| `order/cancelled` | Move lead pra stage "Cancelado"; status `lost`; `lost_reason='cancelled_by_customer'` ou `'cancelled_by_store'` (mapeamento Nuvemshop → CRM deferido pra Spec) |
| `order/fulfilled` | Move lead pra stage "Enviado" ou "Entregue" conforme payload; activity `nuvemshop_order_fulfilled` |
| `cart/abandoned` | Cria lead em pipeline "Pedidos", stage "Carrinho abandonado" (target de recovery do chatbot e do operador) |
| `customer/redact` | LGPD: anonimiza contact + cascade (vide §3.9) |
| `customer/data_request` | LGPD: gera export estruturado (delegado pro fluxo do Sub-PRD 01 §3.6) |
| `store/redact` | LGPD: lojista cancelou conta Nuvemshop; redact em massa do tenant inteiro com flag `emergency=true` (vide §3.9) |

**Princípios.**
- Nuvemshop assina cada webhook; nós verificamos HMAC com secret próprio do tenant (gerado no onboarding, vide Sub-PRD 01 §3.7)
- 200 retornado **imediato** após validação + log (processamento downstream é assíncrono via `event_log`)
- Mapeamento "Nuvemshop status → stage CRM" tem default canônico mas é **customizável** por tenant (§3.10)

**ACs principais.**
- 8 eventos listados são processados sem perda em janela de 24h sob carga normal (5k pedidos/mês = ~7 webhooks/h pico)
- Webhook com HMAC inválido retorna 401 mas é logado em `webhook_events_log` com `valid_signature=false`
- Webhook duplicado (mesmo `external_event_id`) retorna 200 sem processar 2x (vide §3.5)

### 3.5 Validação de webhooks

**O que provê.** Garantia de que toda requisição é autêntica, única, e auditável — independente de processamento ter sucesso.

**Princípios.**
- HMAC validation com secret próprio por tenant; secret rotacionável via UI
- **Audit log de cada receipt** (mesmo inválido) com flag `valid_signature=false` — vital pra detectar spoof
- Idempotência via `unique (provider='nuvemshop', external_event_id)` em `webhook_events_log`
- Sanitização de logs: nunca HMAC signature, tokens OAuth, CPF, dados de pagamento
- Replay protection: timestamp >5min de skew rejeitado (`error.code='webhook_timestamp_skew'`)

**ACs principais.**
- Replay de webhook 1h depois retorna 200 (idempotência) sem reprocessar
- Webhook com signature errada é logado mas não processado; alerta operacional se taxa >1%/h
- Logs em `webhook_events_log` não contêm tokens nem CPF

### 3.6 Pipeline canônico de processamento

**O que provê.** Sequência fixa que **todo** webhook Nuvemshop atravessa, garantindo invariantes de auditoria e idempotência antes de qualquer mudança no domínio.

**Sequência.** (1) validar HMAC — 401 se inválido mas loga; (2) log raw em `webhook_events_log` (payload + headers sanitizados + timestamp); (3) resolver tenant via `webhook_path_token` ou subdomain (decisão Spec); (4) idempotência check (se `(provider, external_event_id)` já processado, retorna 200); (5) resolver/criar contact via identity resolution determinística (Sub-PRD 02 §3.3); conflito → `merge_queue` (Sub-PRD 02 §3.4); (6) aplicar mudança no domínio (criar lead, mover stage, atualizar `orders`); (7) emitir evento canônico em `event_log` (`nuvemshop.order_paid`, etc.) pra workers downstream; (8) retornar 200 imediato.

**Princípios.**
- Nenhum trigger Postgres faz HTTP (regra herdada — `event_log` é o ponto de fan-out)
- Falha **após** log raw vai pra retry interno (§3.12), não devolve erro pra Nuvemshop (evita retry duplicado)
- Erro **antes** do log raw (HMAC inválido, payload corrompido) sim retorna erro

**ACs principais.**
- p95 do receiver (validação + log + 200) <300ms
- 200 retornado antes de workers terminarem; admin vê "pendente" nos logs (§3.10)
- Falha em criar lead após log raw NÃO devolve erro pra Nuvemshop

### 3.7 Sync inicial após conexão

**O que provê.** Quando o tenant conecta (ou solicita re-sync), o SonghaiCRM puxa estado relevante da Nuvemshop pra hidratar o CRM.

**Domínios sincronizados.**
- **Produtos** — feed pro RAG (Sub-PRD 05); paginação cursor; throttle pra rate limit
- **Customers** — alimenta identity resolution; conflito com contacts WhatsApp gera `merge_queue`
- **Pedidos históricos (últimos 90 dias)** — cria leads + activities retroativas; **idempotente**

**Princípios.**
- Sync pode demorar horas em loja grande (50k pedidos); roda em worker background
- UI mostra progresso: % concluído, ETA, contadores parciais por domínio
- Idempotência via `unique (provider, external_id)` em `orders` e `(organization_id, email)` em `contacts`
- Re-sync manual com 4 modos: **tudo / só clientes / só produtos / só pedidos dos últimos 7 dias** (último é o caso "webhook caiu no fim de semana, quero recuperar")

**ACs principais.**
- 5k pedidos: sync ≤30min; 50k pedidos: ≤6h sem bloquear admin
- Re-sync "últimos 7 dias" em loja ativa não duplica leads
- Sync interrompido (deploy, rede) retoma do cursor onde parou

### 3.8 Tabela `orders` (modelo lógico)

**O que provê.** Snapshot estruturado do pedido como ele veio da Nuvemshop. Não substitui o lead correspondente — coexiste com ele.

**Princípios DIRC aplicados.**
- Linkado a `crm_leads` via `crm_lead_links` polimórfico (`target_kind='order'`, `target_id=<order.id>`) — caminho **R**eferenciar
- Mantém `external_id`, `external_provider='nuvemshop'`, `payload jsonb` com snapshot completo da Nuvemshop
- **NÃO duplica** `value_cents`, `currency`, `status` que já vivem nativamente em `crm_leads` — esses são acessados via FK quando precisos (DIRC: usar Referenciar quando Calcular não basta)
- Campos próprios da `orders`: items (linha de produtos), shipping_address, payment_method, tracking_code, fulfillment_status — coisas que **não** fazem sentido em `crm_leads` (lead é genérico cross-pipeline; orders é específico de e-commerce)

**Princípios operacionais.**
- 1 pedido Nuvemshop = 1 row em `orders` + 1 lead em `crm_leads` linkados via `crm_lead_links`
- Update de pedido (ex: `order/fulfilled`) atualiza `orders.payload` (snapshot novo) **e** dispara mudança no `crm_leads.stage_id` correspondente
- Estrutura completa do schema fica deferida pra Spec

**ACs principais.**
- Lead criado por `order/created` está linkado a uma row em `orders` via `crm_lead_links`
- Atualização do pedido (paid → fulfilled) atualiza `orders.payload` e move o lead, **sem criar lead duplicado**
- Query "todos os pedidos do contact X com seu status de pipeline" usa join via `crm_lead_links` + `crm_leads` + `orders` (decisão final na Spec)

### 3.9 LGPD-specific deste sub-PRD

**O que provê.** Os 3 webhooks LGPD da Nuvemshop são contrato regulatório de primeira classe. O framework genérico (consentimento, audit, endpoints `/api/v1/lgpd/*`) está no Sub-PRD 01 §3.6 — aqui descrevemos só o específico do receiver Nuvemshop.

**Endpoints.** `POST /api/v1/webhooks/nuvemshop/customer-redact`, `.../customer-data-request`, `.../store-redact`.

**Pipeline LGPD.** Validar HMAC → log raw com flag `is_lgpd=true` → resolver tenant → executar redact/export (cascade conforme tipo) → confirmar com Nuvemshop via callback → audit denso.

**SLAs e alarmes.**
- `customer/data_request` entregue em **D+7 dias úteis**, alarme em **D+5**
- `customer/redact` aplicado em **D+15 dias úteis**, alarme em **D+10**
- `store/redact` é operação grande (todo o tenant); SLA D+15 com flag `emergency=true` no audit e notificação imediata ao super-admin

**Audit denso obrigatório.** `who_initiated`, `which_customer`, `mode` (anonymize/delete/export), `cascaded_to` (`[contacts:1, conversations:N, messages:M, activities:K, orders:O]`), `confirmed_at`.

**Cascade de anonimização (`customer/redact`).** `contact` → `is_anonymized=true`, PII vira "Cliente Anonimizado #N"; `conversations` → preserva timestamps; nome anonimizado; metadata limpa; `messages` → conteúdo de texto preservado se tenant configurou retenção; **mídia removida do storage sempre**; `activities` → tipos preservados, payload sensível redacted.

**Imutabilidade.** Dados anonimizados **não podem ser revertidos** (decisão definitiva, Sub-PRD 01 §3.6). Tentativa retorna 405.

**ACs principais.**
- `customer/redact` → audit registra início; cascade aplicado em ≤D+15; confirmação à Nuvemshop com timestamp
- `customer/data_request` → export gerado via fluxo do Sub-PRD 01; SLA D+7 cumprido em ≥99% dos casos
- `store/redact` → super-admin notificado; redact massivo agendado; `emergency=true` no audit
- Alarme em D+5/D+10 dispara notificação operacional se job ainda não executou

### 3.10 Configuração Nuvemshop no admin do tenant

**Capacidades.**
- **Status da conexão** (saudável / token_expirado / sem_permissão / desconectado)
- **Re-sync manual** com 4 opções (tudo / clientes / produtos / pedidos últimos 7 dias)
- **Logs de webhooks recentes** (últimos 50, status processado/pendente/falhou, link pra detalhe sanitizado)
- **Mapeamento de stages** customizável (default: `order/paid` → "Pago"; `order/cancelled` → "Cancelado")
- **Mapping de `payment_method`** Nuvemshop → tag/custom_field do lead

**Princípios.**
- Mudança de mapeamento é auditada e aplica-se **a partir da mudança** (eventos passados não são reprocessados retroativamente)
- Re-sync manual é idempotente (§3.7)

**ACs principais.**
- Re-mapear `order/paid` pra stage "Faturado" → próximo evento vai pra "Faturado"
- Admin pode reprocessar manualmente webhook em estado `failed`
- Status da conexão atualiza em ≤1min após mudança real

### 3.11 Quota / rate limit Nuvemshop

**Princípios.**
- Backoff exponencial em chamadas saintes (parâmetros exatos deferidos pra Spec)
- Worker respeita headers `X-RateLimit-Remaining` e `Retry-After`
- Alarme operacional se rate limit estourado >3x em 1h
- Healthcheck em frequência baixa (cada 30min) pra não consumir quota

**ACs principais.**
- Sync de 50k pedidos não estoura rate limit (workers respeitam `Retry-After`)
- Alarme dispara se 3+ chamadas em 1h retornarem 429

### 3.12 Resilência

**Princípios.**
- Worker de re-tentativa pra webhooks que falharam no processamento (separado do retry da Nuvemshop)
- **Dead-letter queue após 8 tentativas** com backoff exponencial; evento fica `dead_letter` em `webhook_events_log`
- Re-processamento manual via UI admin (§3.10): admin opta por "tentar de novo" → roda pipeline §3.6 do step 5 em diante (log raw já existe, idempotência protege)
- Política exata de backoff deferida pra Spec

**ACs principais.**
- Falha temporária (DB indisponível 30s) absorvida sem perda
- Falha persistente (bug de mapeamento) deixa webhook em DLQ após 8 tentativas; admin notificado
- Webhook em DLQ reprocessado após fix aplica mudança normalmente

---

## 4. Requisitos Não-Funcionais

### 4.1 Performance
- p95 do receiver de webhook (validação + log raw + 200): <300ms
- p95 do pipeline downstream (resolver contact + criar lead + emitir evento): <2s
- Sync inicial: 5k pedidos em ≤30min; 50k pedidos em ≤6h
- Healthcheck Nuvemshop a cada 30min por tenant conectado

### 4.2 Segurança
- Tokens OAuth encrypted-at-rest com chave separada (`NUVEMSHOP_OAUTH_ENCRYPTION_KEY`)
- HMAC obrigatório em **todo** webhook (nunca aceitar inseguro mesmo em dev de tenant)
- Sanitização de logs: nunca CPF, nunca token, nunca dados de pagamento em log
- Webhook secret rotacionável por UI sem perder histórico
- DNS rebinding protection no receiver

### 4.3 Compliance
- SLA `data_request` D+7; `redact` D+15; `store/redact` D+15 com `emergency=true`
- Alarme operacional em D+5 e D+10 respectivamente
- Audit denso de cada execução LGPD com `who/which/mode/cascaded_to/confirmed_at`
- Anonimização imutável (irreversível por design)

### 4.4 Observabilidade
- Métricas: webhook_count_received_24h, webhook_count_failed_24h, webhook_processing_lag_p95, sync_progress_pct, oauth_health_status, lgpd_pending_jobs
- Sentry pra erros do adapter e do receiver
- Audit log de cada webhook receipt (mesmo inválidos)

### 4.5 Resilência
- Retry exponencial (8 tentativas) antes de DLQ
- Idempotência forte via `unique (provider, external_event_id)`
- Re-sync manual idempotente
- Dead-letter visível e re-processável via UI

---

## 5. Acceptance Criteria do sub-PRD

A integração Nuvemshop + LGPD é considerada **MVP-completa** quando:

1. ✅ Tenant conecta Nuvemshop em ≤4 cliques; status fica "saudável"; webhooks são auto-registrados; sync inicial dispara
2. ✅ Sync inicial de loja com 5k pedidos completa em ≤30min, populando `contacts`, `orders`, `crm_leads` e feed do RAG sem duplicação
3. ✅ Os 8 webhooks (5 operacionais + 3 LGPD) são recebidos, validados, idempotentes e processados sem perda em janela de 24h sob carga normal
4. ✅ `order/paid` recebido move o lead correspondente pra stage "Pago" (ou customizada) e gera activity `nuvemshop_order_paid` em <2s p95
5. ✅ `cart/abandoned` cria lead em "Carrinho abandonado" pronto pra recovery do chatbot/operador
6. ✅ Conflito de identity resolution (customer Nuvemshop vs contact WhatsApp) gera entrada em `merge_queue` em vez de duplicar ou mesclar errado
7. ✅ Webhook com HMAC inválido retorna 401 e é logado com `valid_signature=false`
8. ✅ `customer/redact` aplica cascade (contact + conversations + messages mídia + activities) com audit denso e confirmação à Nuvemshop em ≤D+15
9. ✅ `customer/data_request` dispara fluxo do Sub-PRD 01 §3.6 e entrega export em ≤D+7
10. ✅ `store/redact` notifica super-admin imediato e roda redact massivo do tenant com flag `emergency=true`
11. ✅ Re-sync manual ("últimos 7 dias") em loja ativa não duplica leads
12. ✅ Webhook que falhou 8x cai em DLQ visível na UI e pode ser re-processado manualmente
13. ✅ Token OAuth expirado é detectado em <1h, status do tenant atualiza, admin notificado
14. ✅ Alarmes em D+5 (data_request) e D+10 (redact) disparam se SLA não foi cumprido

---

## 6. Dependências

### Internas
- **Sub-PRD 01 (Plataforma Base)** — auth, RLS, audit log, event_log, framework LGPD genérico, convenções de API, onboarding (gera webhook_secret). Bloqueante.
- **Sub-PRD 02 (Customer 360)** — `contacts`, `crm_leads`, identity resolution, `merge_queue`, `crm_lead_activities`, `crm_lead_links`. Bloqueante.

### Externas
- **Conta Nuvemshop developer** + app registrado (production) com scopes mínimos definidos
- **Acesso aos endpoints OAuth da Nuvemshop** (production e sandbox)
- **`pgcrypto` ativo** no Postgres (Supabase) — vide Sub-PRD 01 §4.1
- **Worker runtime** pra background jobs (Vercel Functions / serviço externo — decisão Spec)

### Decisões deferidas pra Spec
- App embedded vs External da Nuvemshop
- Schema de `orders` e `webhook_events_log` (incluindo particionamento)
- Lib oficial Nuvemshop (Node SDK) vs wrapper próprio
- Formato exato do export LGPD (estrutura JSON, layout PDF)
- Política exata de retry de webhooks (intervalos de backoff, jitter, número final de tentativas)
- Particionamento de `webhook_events_log` (por mês? por tenant?)
- Mapeamento canônico de status Nuvemshop → stage CRM (especialmente nuance de `order/paid` chegar antes de `order/created` em casos raros)
- Suporte a `cancellation_reason` Nuvemshop → `lost_reason` CRM (mapping table)
- Roteamento do receiver (`webhook_path_token` vs subdomain) — herdada da Spec do Sub-PRD 01

---

## 7. Riscos Específicos do sub-PRD

| # | Risco | Mitigação |
|---|---|---|
| N1 | **Token OAuth expirado e tenant não reconecta** (perde sync silenciosamente) | Healthcheck a cada 30min; status visível no admin; notificação ao admin via email/in-app; alarme operacional após 24h sem reconexão |
| N2 | **Mudança contratual da Nuvemshop** (deprecação de webhook, mudança de auth, novo formato de payload) | Adapter pattern isola; assinar feed de release notes da Nuvemshop; testes de contrato no CI; versão do payload registrada em `webhook_events_log` pra ajudar em migrations |
| N3 | **Webhook Nuvemshop não chega** (rede, configuração, deploy) — perda silenciosa | Re-sync manual "últimos 7 dias" cobre lacunas; alarme se taxa de webhooks cair >50% versus média móvel; healthcheck periódico |
| N4 | **LGPD redact aplicado errado** (cliente errado anonimizado por bug em identity resolution) | Identity resolution conservadora (preferir `merge_queue` que merge automático errado); audit denso permite forense; processo de revisão pós-redact na primeira semana de cada tenant em produção |
| N5 | **LGPD data_request não entregue em D+7** → multa ANPD | Job assíncrono com fila própria + alarme em D+5; runbook de escalação pra super-admin; SLA monitorado no dashboard de plataforma |
| N6 | **Sync inicial demora dias e bloqueia admin** | Worker em background; UI mostra progresso e ETA; chunking + cursor para resume após interrupção; throttle pra respeitar rate limit Nuvemshop |
| N7 | **Conflito identity resolution gera `merge_queue` enorme** (loja com 50k clientes histórico vs WhatsApp existente) | UI de merge em batch; opção de "auto-aceitar" merges com confiança alta após review humano dos primeiros 100; documentação clara pro lojista no onboarding |
| N8 | **Re-sync corrompe estado** (idempotência falha por bug) | Idempotência testada com fixture de produção (re-rodar sync 3x deve resultar em zero linhas novas); rollback procedure documentado |
| N9 | **`pgcrypto` encryption key vazada** → todos os tokens OAuth expostos | Chave separada (`NUVEMSHOP_OAUTH_ENCRYPTION_KEY`) das demais; rotação trimestral planejada; processo de re-encrypt em background; secret manager (Vercel Encrypted env) com audit de acesso |
| N10 | **Rate limit Nuvemshop estourado** durante incident bloqueia outros tenants | Worker pool por tenant (não global); circuit breaker se 429 persistente; alarme em 3+ tentativas em 1h |

---

## 8. Fora de Escopo (deste sub-PRD)

- Integração com VTEX, Shopify, ou outras plataformas — Fase 5 do roadmap
- Multi-loja por tenant (1 tenant conectando a N lojas Nuvemshop) — pós-MVP
- Webhooks Nuvemshop além dos 8 listados (ex: `category/created`, `coupon/used`) — adicionar quando demanda real surgir
- Dashboard analítico de pedidos (top produtos, conversion rate, etc.) — pós-MVP, possivelmente Sub-PRD futuro
- Sincronização bidirecional (SonghaiCRM atualizando pedidos na Nuvemshop) — pós-MVP
- Suporte a sandbox Nuvemshop em produção (cada tenant prod usa só prod) — sandbox restrito a CI/dev
- Autoria de campanhas de recovery a partir de `cart/abandoned` — Sub-PRD 05 cobre handoff IA; campanha estruturada é pós-MVP
- Métricas avançadas LGPD (dashboard de jobs pendentes por tenant, SLA tracking detalhado) — pós-MVP
- BYO Nuvemshop credentials (lojista traz tokens próprios sem OAuth) — pós-MVP

---

## 9. Decisões deferidas pra Spec

A serem decididas no spec correspondente (`docs/specs/06-spec-nuvemshop-lgpd.md`):

1. **App embedded vs External** da Nuvemshop (impacto em UX de onboarding e em scopes disponíveis)
2. **Schema SQL completo** de `nuvemshop_connections`, `orders`, `webhook_events_log` (incluindo particionamento)
3. **Lib Nuvemshop**: SDK oficial vs wrapper próprio (avaliar maturidade do SDK em PT-BR)
4. **Formato exato do export LGPD**: estrutura JSON e layout do PDF assinado
5. **Política de retry**: intervalos exatos de backoff, jitter, número final de tentativas antes de DLQ
6. **Particionamento de `webhook_events_log`**: por mês, por tenant, ou ambos
7. **Roteamento do receiver**: `webhook_path_token` vs subdomain (decisão alinhada com Sub-PRD 01)
8. **Mapeamento status Nuvemshop → stage CRM**: tabela canônica + nuance de `order/paid` chegar antes de `order/created` (race condition rara)
9. **`cancellation_reason` Nuvemshop → `lost_reason` CRM**: tabela de mapping (extensível por tenant?)
10. **Backoff específico do rate limit Nuvemshop**: parâmetros exatos baseados em testes
11. **Política de retenção de `webhook_events_log`**: hot 90 dias, cold após (S3?)
12. **Estrutura de notificação ao admin** sobre token expirado, store/redact, DLQ (in-app, email, ambos)
13. **Worker runtime**: Vercel Functions (timeout 5min na Hobby, 15min Pro), serviço externo (Render, Railway), ou fila gerenciada (Inngest, Trigger.dev)
14. **Estratégia de teste de contrato** com sandbox Nuvemshop no CI

---

## Anexos

- `docs/research/reference-synthesis.md` — pontos herdados (especialmente §6 webhooks, §11 LGPD, §13 anti-patterns de trigger HTTP)
- `docs/prd/00-prd-master.md` (especialmente §6.1 Adapter pattern, §6.6 LGPD, §7 Conformidade)
- `docs/prd/01-prd-platform-base.md` (especialmente §3.6 LGPD framework, §3.8 API conventions)
- `docs/prd/02-prd-customer-360.md` (especialmente §3.1 Contact, §3.2 Lead, §3.3 Identity resolution, §3.4 Merge)
- `tasks/todo.md`
