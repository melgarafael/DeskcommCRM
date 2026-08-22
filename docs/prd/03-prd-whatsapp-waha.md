---
title: Sub-PRD 03 — Canal WhatsApp via WAHA Plus
parent: 00-prd-master.md
depends_on: 01-prd-platform-base.md, 02-prd-customer-360.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
---

# Sub-PRD 03 — Canal WhatsApp via WAHA Plus

> Define como o SonghaiCRM se conecta ao WhatsApp via WAHA Plus (API não-oficial) — desde a conexão de número via QR code, recebimento e envio de mensagens, suporte a mídia, multi-número e multi-atendente, até as defesas anti-banimento que sustentam a operação. É o canal primário do produto; sem ele, o CRM não opera. Profundidade de schema, payloads exatos e código de handlers ficam pra `docs/specs/03-spec-whatsapp-waha.md`.

---

## 1. Contexto & Posicionamento

WhatsApp é o canal **dominante** no e-commerce brasileiro PME — onde 80%+ das interações cliente↔loja acontecem. A API oficial Meta (Cloud API) é restritiva (template aprovado pra mensagem proativa fora da janela de 24h, custo por conversa, latência de aprovação), inadequada pra operação BPO de alto volume com tráfego majoritariamente reativo.

O SonghaiCRM adota **WAHA Plus** (não Core) como solução de canal: API não-oficial baseada em engenharia reversa do WhatsApp Web, **multi-tenant nativo** (1 instância suporta N sessões), com auth via SHA512 hash em `WAHA_API_KEY`. Trade-off explícito: WAHA não tem SLA contratual com Meta — números podem ser banidos a qualquer momento se o tráfego destoar de comportamento humano. **Toda a engenharia deste sub-PRD é, em última análise, defesa contra banimento.**

A arquitetura aqui definida governa: (a) sessões (1 sessão = 1 número WhatsApp por tenant); (b) ingestão de inbound via webhook HMAC-protegido com idempotência forte; (c) envio com persistência otimista; (d) anti-banimento por throttle + warm-up + spinning + STOP detection; (e) crons de auto-recovery; (f) suporte a multi-número e multi-atendente desde o dia 1.

A janela de 24h da Meta (envio proativo só com template aprovado fora da janela) **não se aplica diretamente ao WAHA Plus** porque WAHA não usa Cloud API; mas é mantida como **boa prática operacional** porque o WhatsApp detecta padrões e pune. Templates aprovados via API oficial são **fora do escopo do MVP**.

---

## 2. Escopo

### Dentro do escopo deste sub-PRD

1. Modelo de **`channel_sessions`** (1 sessão = 1 número WhatsApp por tenant) e seu ciclo de vida (STARTING → SCAN_QR_CODE → WORKING → STOPPED → FAILED)
2. Conexão de número via **QR code** pela UI (frontend faz polling em endpoint `/qr`)
3. Recebimento de mensagens via **webhook HMAC-SHA512** com idempotência por `(organization_id, external_id)`
4. **Envio de mensagens** com optimistic UI (status `sending` antes de despachar pra WAHA)
5. **Tipos de mensagem suportados**: text, image, video, audio, document, sticker, location, contact, reaction, system
6. **Mídia via Supabase Storage** (NUNCA inline base64), com URL assinada passada pra WAHA
7. **Anti-banimento**: throttle, jitter, warm-up, spinning de copy, STOP detection, limites diários, janela de horário
8. **Multi-número por tenant** (1-2 números no MVP-B), com health check próprio
9. **Multi-atendente**: assinar `message.any` pra capturar mensagens enviadas por outros devices vinculados; tratamento de `fromMe=true`
10. **Crons obrigatórios**: `sync-sessions`, `recover-stuck-messages`, `process-pending-webhooks`
11. **Hospedagem WAHA** (Railway no MVP, VPS própria com Docker em produção; BYO documentado como Fase 2)
12. Tratamento de **edge cases** críticos (sessão cai, QR expira, número banido, mensagem fora de ordem, mensagem duplicada, mídia grande, áudio Safari, texto >4096, grupos)

### Fora do escopo deste sub-PRD (referências cruzadas)

- Modelo de Contact e identity resolution a partir de telefone E.164 → vide Sub-PRD 02 §3.1 e §3.3
- Modelo de Lead, timeline polimórfica `crm_lead_activities` (`whatsapp_inbound`, `whatsapp_outbound`) → vide Sub-PRD 02 §3.5
- Auth, RLS, audit log, `event_log` consumido por workers, convenções API → vide Sub-PRD 01 §3.2, §3.5, §3.8
- Pipeline Kanban, atribuição de conversas a atendentes, roteamento → vide Sub-PRD 04
- IA respondendo automaticamente, sentiment detection, handoff → vide Sub-PRD 05
- Janela de 24h Meta com templates aprovados via Cloud API oficial → Fase 2, fora do MVP
- Webhooks Nuvemshop e LGPD → vide Sub-PRD 06

---

## 3. Capacidades Funcionais

### 3.1 Modelo de `channel_sessions` e ciclo de vida

**O que provê.** Representação canônica no DB de cada número WhatsApp conectado a um tenant. 1 sessão = 1 número = 1 instância WAHA com nome único (ex: `tenant_<org_id>_<seq>`). Todo inbound/outbound é amarrado a uma sessão.

**Princípios.**
- Tabela `channel_sessions` (tenant-aware, RLS via `fn_user_org_ids()`); colunas-chave: `organization_id`, `session_name` (único), `phone_number` (E.164, populado após pareamento), `status` enum-text, `engine` (`NOWEB` default, `WEBJS` opcional), `webhook_secret` (gerado por sessão), `last_health_check_at`, `metadata` jsonb
- Estados canônicos: `STARTING`, `SCAN_QR_CODE`, `WORKING`, `STOPPED`, `FAILED`
- **Engine NOWEB por default** (mais leve, sem Chromium); **WEBJS apenas pra features específicas** (stickers animados, listas/botões interativos) — decisão por feature, não por sessão inteira; revisitar na Spec
- `webhook_secret` é **único por sessão** (não global) — facilita revogação e rotação
- 1 tenant pode ter N sessões (MVP-B: 1-2 por tenant; arquitetura suporta mais)
- Auth WAHA: `WAHA_API_KEY` armazenada como **SHA512 do plaintext** no servidor WAHA; o backend SonghaiCRM guarda o plaintext em variável de ambiente segura (Vercel Encrypted Env Var)
- Mudança de status é evento de timeline + audit (`channel_session.status_changed`)

**ACs principais.**
- Super-admin ou admin do tenant cria sessão via UI/API; backend cria registro em `channel_sessions` com status `STARTING` e dispara `POST /api/sessions` na WAHA
- Sessão recém-criada transita pra `SCAN_QR_CODE` em ≤10s (ou retorna `FAILED` com `metadata.error_code`)
- Listagem de sessões mostra: número, status, último health check, contagem de mensagens nas últimas 24h
- Tentativa de criar sessão duplicada (mesmo `session_name`) retorna 409 `session_already_exists`
- Mudança de status registra atividade `channel_session.status_changed` com `metadata.from` e `metadata.to`

### 3.2 Conexão de número via QR code

**O que provê.** Fluxo de pareamento WhatsApp pelo usuário (admin do tenant ou super-admin) escaneando QR code com o app WhatsApp do telefone.

**Princípios.**
- Frontend abre tela "Conectar número"; backend cria sessão (se ainda não existir) e expõe endpoint proxy `/api/v1/channel-sessions/:id/qr`
- Frontend faz **polling** a cada 5s no proxy enquanto status = `SCAN_QR_CODE`; backend faz fetch interno pra `GET /api/sessions/<name>/auth/qr` da WAHA
- QR code expira em **~60s** (regra do WhatsApp); frontend força **auto-refresh a cada 30s** mesmo sem mudança de estado
- Conclusão do scan dispara webhook `session.status` da WAHA → backend atualiza status pra `WORKING` e extrai `phone_number` do `me.id` no payload
- UI mostra estados: "Gerando QR…", "Escaneie agora" (com QR + countdown), "Conectado!" (com phone_number), "Falhou" (com retry)
- Polling termina automaticamente quando status muda pra `WORKING` ou `FAILED`

**ACs principais.**
- Usuário inicia conexão; vê QR em tela em ≤15s
- QR não escaneado em 60s é substituído por novo QR sem reload manual
- Após escanear, status muda pra `WORKING` em ≤5s e UI mostra confirmação com número conectado
- Tentativa de obter QR de sessão já `WORKING` retorna 409 `session_already_connected`
- Webhook `session.status=FAILED` (ex: usuário fechou WhatsApp Web no telefone) transita sessão pra `FAILED` e UI sinaliza

### 3.3 Recebimento de mensagens via webhook

**O que provê.** Endpoint receptor do SonghaiCRM que valida HMAC, persiste mensagem inbound com idempotência forte, e dispara o pipeline de processamento (Customer 360, IA, automações).

**Princípios.**
- Endpoint canônico `/api/v1/webhooks/waha/:session_name` (ou path-token equivalente — decisão na Spec)
- **Validação HMAC-SHA512** com timing-safe compare; ler `req.text()` **cru** (antes de qualquer parse) pra que o hash bata; chave = `webhook_secret` da sessão
- **Idempotência** via constraint `unique (organization_id, external_id)` em `messages`; em colisão Postgres retorna `code === '23505'` que é capturado e tratado como **no-op com 200 OK** (não 4xx, pra não acionar retry do WAHA)
- **Toda mensagem inbound é logada CRUA em `webhook_events_log`** (append-only) **antes** do parse — fonte de verdade pra debug e replay
- Sequência canônica do handler:
  1. Validar HMAC; falha → 401 sem corpo
  2. `INSERT INTO webhook_events_log (...)` raw
  3. Parse do payload; resolver tenant via `session_name`
  4. **Upsert contact** via Sub-PRD 02 §3.3 (telefone E.164 derivado de `from`)
  5. **Upsert conversation** (1 conversation por `(org, contact, channel_session)`)
  6. **INSERT message** (capturando `code === '23505'` em duplicata)
  7. INSERT atividade `whatsapp_inbound` em `crm_lead_activities`
  8. Emit `event_log` (`whatsapp.message_received`) — workers consomem pra disparar IA, automações, sentiment (Sub-PRDs 04 e 05)
  9. Responder 200
- **Trigger Postgres NUNCA faz HTTP** (regra herdada): toda integração externa passa por worker que lê `event_log`
- Ordenação por `sent_at` (vinda do payload WAHA), **não** por `created_at` do DB — mensagens podem chegar fora de ordem (vide Riscos §7)
- Mensagens em **grupos** (`chatId.endsWith('@g.us')`) são persistidas mas **NÃO** disparam binding de lead/deal (evita "deal infinito" em grupos)

**ACs principais.**
- Webhook com HMAC inválido retorna 401 e nada é gravado em `webhook_events_log`
- Webhook com HMAC válido grava raw em `webhook_events_log` mesmo se o parse falhar depois
- Mensagem com `external_id` já existente retorna 200 sem inserir duplicata (idempotência)
- Mensagem inbound de telefone novo cria contact + conversation + message + activity em <2s p95
- Mensagem em grupo (`@g.us`) é gravada em `messages` com `is_group=true`, sem criar/atualizar lead
- Carga de 100 webhooks/s sustentada por 1min sem perda nem duplicação

### 3.4 Envio de mensagens (outbound)

**O que provê.** Atendente (ou worker da IA) dispara mensagem; sistema persiste imediatamente com `status='sending'`, despacha pra WAHA, e atualiza status conforme acks (`sent`, `delivered`, `read`, `failed`).

**Princípios.**
- **Optimistic UI**: backend faz `INSERT INTO messages (..., status='sending')` **antes** de chamar WAHA; UI mostra a mensagem imediatamente com indicador de envio
- Endpoints WAHA usados: `POST /api/sendText`, `/api/sendImage`, `/api/sendFile`, `/api/sendVoice`, `/api/sendLocation` (lista canônica MVP)
- `chatId` formato `<phone_e164_sem_+>@c.us` (ex: `5511999998888@c.us`)
- Resposta WAHA com sucesso → backend atualiza `external_id` e `status='sent'`
- Resposta WAHA com erro → `status='failed'` + `metadata.error_code` + atividade na timeline
- Acks subsequentes (delivered/read) chegam via webhook `message.ack` e atualizam `status` + `delivered_at` / `read_at`
- Respeita **anti-banimento** (vide §3.7): toda chamada de send passa por fila com throttle por sessão
- **Janela de 24h**: UI alerta atendente quando última inbound do contato foi há >23h (badge vermelho); envio não é bloqueado (WAHA não exige template), mas é desencorajado fora da janela

**ACs principais.**
- Atendente clica "Enviar"; mensagem aparece na thread em <200ms com indicador "enviando"
- Despacho bem-sucedido pra WAHA atualiza status pra `sent` em <2s p95
- Falha de despacho marca `status='failed'`, mostra retry na UI, e cria atividade `whatsapp_send_failed`
- Texto >4096 chars é **chunkado** em N mensagens preservando ordem (algoritmo na Spec)
- Send pra `chatId` em formato inválido retorna 422 `invalid_chat_id`
- Envio fora da janela 24h NÃO é bloqueado mas UI mostra warning "última interação há Xh"

### 3.5 Tipos de mensagem suportados

**O que provê.** Suporte multi-tipo no MVP, cobrindo o uso real de e-commerce.

| Tipo | Inbound | Outbound | Notas |
|---|---|---|---|
| `text` | sim | sim | UTF-8; chunking em >4096 chars no outbound |
| `image` | sim | sim | jpeg/png/webp; max 16MB no outbound |
| `video` | sim | sim | mp4 preferido; max 16MB |
| `audio` | sim | sim | OGG inbound (padrão WhatsApp); ver §3.6 sobre Safari |
| `document` | sim | sim | PDF, DOCX, XLSX; max 16MB |
| `sticker` | sim | sim | requer engine WEBJS pra animados |
| `location` | sim | sim | lat/lng + label opcional |
| `contact` | sim | sim | vCard |
| `reaction` | sim | sim | emoji em mensagem específica |
| `system` | sim | não | eventos do WhatsApp (revogação, edit) — registra na timeline |

**Princípios.**
- Cada tipo tem `messages.type` enum-text canônico
- `payload` jsonb por tipo (estrutura definida na Spec)
- Mensagens **editadas** ou **revogadas** (deletadas pelo cliente) chegam como `system` e atualizam o registro original (mantendo histórico em `metadata.previous_text`)

**ACs principais.**
- Recebimento de cada um dos 10 tipos é persistido com `type` correto e payload parseado
- Outbound de imagem com upload + URL assinada passa por WAHA e chega no cliente em <10s p95
- Mensagem revogada pelo cliente é marcada `is_revoked=true` na thread, com timestamp original preservado

### 3.6 Mídia via Supabase Storage

**O que provê.** Pipeline de mídia que **NUNCA** trafega base64 inline pra WAHA (evita timeouts, OOM, custos de banda); usa Supabase Storage como CDN intermediário.

**Princípios.**
- **Outbound**: atendente faz upload pelo frontend → Supabase Storage (bucket por tenant) → backend gera **URL assinada** com TTL curto (≤30min) → URL passada pra WAHA via campo `file.url`
- **Inbound**: WAHA entrega URL temporária da própria WAHA OU base64 (depende da config); backend faz fetch e **persiste em Supabase Storage** com path canônico `<org>/<conversation>/<message_id>.<ext>`; URL pública assinada usada na UI
- **Limite de tamanho**: UI rejeita arquivos >**16MB** no outbound (limite WhatsApp); arquivos >**50MB** no inbound usam estratégia alternativa (S3 do WAHA Plus ou stream em chunks — Spec)
- **Áudio OGG no Safari**: re-encode server-side pra MP4/AAC OU UI usa `<audio preload="none">` com fallback de download (decisão na Spec)
- Mídia anonimizada via LGPD (Sub-PRD 01 §3.6) é deletada do Storage; metadado fica como tombstone

**ACs principais.**
- Upload de imagem 5MB pelo frontend persiste em Storage e gera URL assinada em <3s
- WAHA recebe URL (não base64) e envia ao cliente com sucesso
- Tentativa de upload de arquivo >16MB no outbound é rejeitada na UI com mensagem clara
- Inbound de áudio OGG é tocável em Chrome/Firefox/Safari (algum dos paths funciona)
- Mídia inbound persistida não vaza cross-tenant (path inclui `organization_id` + RLS no bucket)

### 3.7 Anti-banimento (CRÍTICO)

**O que provê.** Conjunto de defesas que reduz probabilidade de WhatsApp banir o número. **Esta é a capacidade mais importante do sub-PRD** — a perda de número é o pior incidente operacional possível e não tem fix técnico (vide Riscos §7).

**Princípios obrigatórios pro MVP:**

1. **Throttle de envio**:
   - Conversa 1:1: **1 mensagem a cada 1.2s** + jitter aleatório de até **800ms** por sessão
   - Campanha (envio em lote): **1 mensagem a cada 5s** + jitter
   - Implementação via fila por sessão (Inngest, Trigger.dev, ou pg_boss — decisão na Spec)

2. **Warm-up de número novo**:
   - Número recém-conectado tem **período de warm-up de 7-14 dias** com tráfego "humano" (volume baixo, conversas reais com clientes existentes) **antes** de entrar em campanha ou alto volume
   - Limites diários durante warm-up: 50 → 100 → 200 mensagens/dia (escalada gradual)
   - UI/runbook documenta o protocolo

3. **Limites diários pós-warm-up**:
   - Número novo (warm-up concluído): **200-500 msgs/dia**
   - Número maduro (>3 meses ativo, baixa taxa de bloqueio): **1000+/dia**
   - Soft-cap configurável por tenant; hard-cap no produto (block com erro `daily_limit_exceeded`)

4. **Spinning de copy** (pra envios em lote):
   - Mín **5 variações** de copy por campanha
   - Suporte a placeholders `{{var}}` (substituição de variáveis: nome, pedido, etc.)
   - Suporte a alternâncias inline `{opt1|opt2|opt3}` (escolha aleatória)
   - Validação na criação de campanha: rejeita campanha com <5 variações

5. **Janela de horário**:
   - Envio automático/campanha **somente entre 7h e 22h** (timezone do tenant)
   - **Domingo evitado** por default (configurável)
   - Atendente humano pode enviar fora da janela (com warning)

6. **Detecção STOP automática**:
   - Inbound matchando regex `/STOP|PARAR|SAIR|UNSUBSCRIBE|CANCELAR/i` (palavra isolada) → marca `contacts.is_blocked=true` automaticamente + bloqueia envios automáticos (campanhas, IA) pra esse contato
   - Atendente humano ainda pode responder (decisão consciente de tirar do block é manual)
   - Atividade `whatsapp_stop_detected` na timeline

7. **Health monitoring**: cron `sync-sessions` (vide §3.10) detecta sessão fora de `WORKING` e alerta antes que escale

**ACs principais.**
- Envio em lote de 100 mensagens leva no mínimo `100 × (1.2s + jitter médio 0.4s)` ≈ 160s, não menos
- Tentativa de criar campanha com 3 variações de copy retorna 422 `min_5_variations_required`
- Inbound "PARAR" marca contato como bloqueado em <2s e bloqueia próximas tentativas de envio automático
- Envio automático fora de janela (ex: domingo 23h) é enfileirado pra próxima janela válida, não enviado
- Número novo bloqueado de campanha durante 7 dias após conexão (configurável até 14)

### 3.8 Multi-número por tenant

**O que provê.** Tenant pode operar **2+ números** simultâneos (ex: 1 vendas, 1 suporte). MVP-B suporta 1-2 por tenant; arquitetura escala.

**Princípios.**
- Cada número = 1 row em `channel_sessions` com `phone_number` distinto
- Conversation amarra `channel_session_id` (não só `organization_id`) — sabemos por qual número o cliente falou
- UI mostra dropdown de seleção de "número de saída" no envio (default = mesmo número que recebeu última inbound)
- Cada sessão tem **health check próprio** (cron §3.10)
- Roteamento automático de inbound pra atendente (Sub-PRD 04) considera o número receptor
- Limites diários, warm-up status, e métricas são **por sessão**

**ACs principais.**
- Tenant com 2 números recebe inbound em cada um e os mantém separados por `channel_session_id` na conversation
- Atendente envia resposta pelo mesmo número que recebeu (default); pode escolher outro via dropdown
- Health check falha em 1 sessão sem afetar a outra; alerta operacional dispara apenas pra sessão afetada

### 3.9 Multi-atendente (assinatura `message.any`)

**O que provê.** Suporte a múltiplos atendentes humanos respondendo pelo mesmo número, incluindo casos onde a mensagem foi enviada por um device vinculado (celular do gerente, WhatsApp Web aberto em outra máquina) e não pelo CRM.

**Princípios.**
- WAHA permite assinar evento `message` (apenas inbound) ou `message.any` (inbound + outbound de qualquer device, incluindo `fromMe=true`)
- SonghaiCRM **assina `message.any`** pra não perder contexto quando atendente responde fora do CRM
- Mensagens com `fromMe=true` são tratadas como outbound:
  - Se `external_id` corresponde a uma mensagem que o CRM mesmo enviou → no-op (já temos)
  - Se `external_id` é novo → INSERT como outbound com `metadata.sent_via='external_device'`
- Evita **duplicação** via `unique (organization_id, external_id)`
- Atribuição da conversation a um atendente humano (Sub-PRD 04) é feita por roteamento, não por quem responde fora do CRM

**ACs principais.**
- Gerente envia mensagem pelo celular → CRM recebe via `message.any` e exibe na thread em <2s, marcada como `sent_via='external_device'`
- CRM envia mensagem → webhook `message.any` chega de volta com `fromMe=true` mesmo `external_id` → no-op (idempotência)
- Conversation com mensagens enviadas via CRM e via celular mostra histórico unificado em ordem cronológica

### 3.10 Crons obrigatórios

**O que provê.** Tarefas agendadas (Vercel Cron) que sustentam consistência e auto-recovery.

| Cron | Frequência | Responsabilidade |
|---|---|---|
| `sync-sessions` | a cada 1 min | Health check de todas sessões; faz `GET /api/sessions/<name>` na WAHA; sincroniza status DB ↔ WAHA; alerta se >5min em status não-`WORKING` |
| `recover-stuck-messages` | a cada 1 min | Marca mensagens com `status='sending'` há >5min como `failed` + atividade na timeline; permite retry manual |
| `process-pending-webhooks` | a cada 1 min | Re-processa webhooks que entraram em `webhook_events_log` mas não foram fully processados (fallback caso WAHA Plus tenha falha de retry) |

**Princípios.**
- Crons são autenticados via `INTERNAL_SECRET` (header) — distinto de `SUPABASE_SERVICE_ROLE_KEY` (Sub-PRD 01 §4.1)
- Cada execução é logada em `cron_runs` (started_at, finished_at, items_processed, errors)
- Falha em cron individual não derruba os outros (isolamento)
- Idempotência forte: re-rodar 2x não duplica efeito

**ACs principais.**
- Sessão derrubada manualmente (stop no WAHA) é detectada pelo cron e marcada como `STOPPED` em <2min
- Mensagem em `sending` há 6min é marcada como `failed` na próxima rodada do cron
- Webhook que falhou processamento é re-tentado até 3x; após isso vai pra dead-letter `webhook_events_log.status='dead'` com alerta

---

## 4. Requisitos Não-Funcionais

### 4.1 Performance
- p95 de processamento de webhook inbound (do receipt até event_log emitido): <1s
- p95 de envio de mensagem text simples (do clique até `status='sent'`): <2s
- p95 de listagem de últimas 50 mensagens de uma conversation: <300ms
- Throughput sustentado por sessão: 1 msg/1.2s ± jitter (anti-banimento; piso técnico do produto)
- Throughput agregado por tenant (com 2 sessões): ~50-100 msgs/min

### 4.2 Confiabilidade
- Idempotência forte de inbound: zero duplicatas observáveis em 30 dias de operação
- Recovery automático de sessão `STOPPED` por crash WAHA: <5min via cron
- Zero perda de mensagem: toda inbound vai pra `webhook_events_log` raw antes de qualquer processamento
- SLA WAHA upstream: 99% (Railway/VPS própria não dão SLA forte; aceito como tradeoff)

### 4.3 Segurança
- `WAHA_API_KEY` plaintext armazenada apenas em Vercel Encrypted Env Vars; SHA512 no servidor WAHA
- `webhook_secret` por sessão (não global); rotação suportada
- HMAC-SHA512 com timing-safe compare; nunca comparação ingênua de strings
- Mídia em Supabase Storage com RLS por bucket; URLs assinadas com TTL ≤30min
- Logs sanitizam `webhook_secret`, `WAHA_API_KEY`, e payloads de mídia binária (vide Sub-PRD 01 §4.1)

### 4.4 Compliance
- Anti-banimento como requisito não-funcional crítico (vide §3.7) — métrica de banimento em KPIs do produto (PRD-Mestre §8)
- Detecção STOP é **obrigatória** pra adequação à LGPD (consentimento revogável; Sub-PRD 01 §3.6)
- Audit log captura: criação/deleção de sessão, reconexão de QR, mudança de status, envio em lote (campanha), STOP detection

### 4.5 Observabilidade
- Métricas custom por sessão: msgs enviadas/dia, msgs recebidas/dia, taxa de erro, latência de envio, status atual
- Dashboard de saúde por tenant + cross-tenant (super-admin) — definição visual na Spec
- Alertas (Sentry/PagerDuty): sessão `FAILED`, sessão >5min sem health, dead-letter de webhooks, dead-letter de mensagens stuck

---

## 5. Acceptance Criteria do sub-PRD

O canal WhatsApp é considerado **MVP-completo** quando:

1. ✅ Tenant cria sessão, escaneia QR, e número fica `WORKING` em ≤2min, com `phone_number` extraído corretamente
2. ✅ Inbound de telefone novo cria contact + conversation + message + activity `whatsapp_inbound` em <2s p95, com HMAC validado
3. ✅ Inbound duplicado (mesmo `external_id`) não duplica registro; webhook responde 200
4. ✅ Webhook com HMAC inválido retorna 401 e nada é gravado em `messages`; `webhook_events_log` registra apenas se HMAC válido
5. ✅ Atendente envia text, image, audio, document; cada um aparece com `status='sending'` imediatamente e atualiza pra `sent` após despacho
6. ✅ Mídia outbound passa por Supabase Storage (não base64 inline); upload >16MB é rejeitado na UI
7. ✅ Throttle de 1 msg/1.2s + jitter é respeitado em envio em lote (mensurável: 100 msgs levam ≥160s)
8. ✅ Inbound "PARAR" marca contato como `is_blocked=true` automaticamente e bloqueia envios automáticos posteriores
9. ✅ Tenant com 2 números recebe e responde por cada um separadamente, com `channel_session_id` correto na conversation
10. ✅ Mensagem enviada pelo celular do gerente (fora do CRM) aparece na thread via `message.any` em <2s, sem duplicar
11. ✅ Cron `sync-sessions` detecta sessão derrubada manualmente em <2min e atualiza status no DB
12. ✅ Cron `recover-stuck-messages` marca mensagens `sending` há >5min como `failed`
13. ✅ Mensagem em grupo (`@g.us`) é gravada mas NÃO cria/atualiza lead (sem "deal infinito")
14. ✅ Audit log captura: criação/deleção de sessão, mudança de status, STOP detection, criação de campanha
15. ✅ Runbook de troca-de-número (banimento) documentado e validado em dry-run

---

## 6. Dependências

### Internas (outros sub-PRDs)
- **Sub-PRD 01 (Plataforma Base)** — auth, RLS via `fn_user_org_ids()`, `event_log`, `webhook_events_log`, audit log, convenções de API. Bloqueante.
- **Sub-PRD 02 (Customer 360°)** — modelo de Contact, identity resolution por telefone E.164, timeline `crm_lead_activities`. Bloqueante.

### Consumidores deste sub-PRD
- **Sub-PRD 04 (Pipeline + Atendimento)** consome `event_log:whatsapp.message_received` pra roteamento e atribuição
- **Sub-PRD 05 (IA + RAG + Handoff)** consome o mesmo evento pra rodar sentiment + resposta automática

### Externas
- **WAHA Plus** — instância hospedada (Railway $5-10/mês no MVP; VPS própria ~R$140/mês em produção com Nginx + Let's Encrypt; datacenter São Paulo)
- **Supabase Storage** (bucket por tenant pra mídia)
- **Vercel Cron** (3 jobs: sync-sessions, recover-stuck-messages, process-pending-webhooks)
- **Fila de envio**: Inngest, Trigger.dev, ou pg_boss (decisão na Spec)

### Decisões deferidas pra Spec
1. Schema SQL completo de `channel_sessions`, `webhook_events_log`, `messages`, `conversations`
2. Fluxo exato de QR refresh (proxy de polling vs Server-Sent Events vs Realtime channel)
3. Payload exato de cada handler de tipo de mensagem (text, image, audio, etc.)
4. Fila escolhida pra outbound (Inngest? Trigger.dev? pg_boss?)
5. Algoritmo exato de chunking de texto >4096 chars (palavra-boundary? sentence-boundary?)
6. Estratégia de re-encode de áudio OGG pra Safari (ffmpeg server-side? `<audio preload="none">`?)
7. Estrutura de spinning de copy (DSL, parser, validação)
8. Roteamento (header vs path) do webhook receiver
9. Tabela auxiliar `channel_session_warmup` (track de dias + volumes acumulados) ou cálculo on-demand
10. Rotação de `webhook_secret` (procedimento manual vs automatizado)

---

## 7. Riscos Específicos do sub-PRD

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| W1 | **Banimento de número WhatsApp** (detectado como API não-oficial; tráfego destoa de humano) | Crítico | Anti-banimento §3.7 obrigatório (throttle, warm-up, spinning, STOP, janela horário, limites diários); número backup pré-aquecido por tenant; runbook de troca-de-número; **NÃO há fix técnico pós-banimento** — só prevenção |
| W2 | **Perda de sessão sem aviso** (WAHA crash, container reiniciado, volume `/app/.sessions` corrompido, `STARTING` indefinido) | Alto | Cron `sync-sessions` com alerta em >5min fora de `WORKING`; runbook de rebuild do volume `/app/.sessions`; backup periódico do estado da sessão (decisão na Spec) |
| W3 | **Falha de webhook** (WAHA down, network partition, handler crash) | Alto | `webhook_events_log` raw como fonte de verdade; cron `process-pending-webhooks` re-processa; WAHA Plus tem retry nativo (Core não); dead-letter com alerta após 3 tentativas |
| W4 | **Inconsistência multi-device** (mensagem enviada por celular não aparece no CRM, ou aparece duplicada) | Médio | Assinar `message.any` (não `message`); idempotência por `(org, external_id)`; teste de regressão simulando envio cross-device |
| W5 | **Abuso de envio em campanha** (atendente faz blast de 1000 msgs sem warm-up) | Alto | Hard-cap diário por sessão; validação de min 5 variações de copy; bloqueio de campanha durante warm-up; revisão manual de campanhas >500 msgs no MVP |
| W6 | **Vazamento de credentials WAHA** (`WAHA_API_KEY` em log, repo, ou env exposto) | Crítico | Plaintext apenas em Vercel Encrypted Env Vars; sanitização agressiva em logs; `gitleaks` pre-commit (Sub-PRD 01 §4.1); rotação trimestral; SHA512 no servidor WAHA garante que comprometimento do servidor não vaza o plaintext |
| W7 | **Dependência de upstream WAHA Plus** (mudança de política, deprecação, ban da WAHA pelo WhatsApp) | Alto | Variante BYO documentada (cliente roda WAHA próprio) como Fase 2; consideração futura de migração pra Cloud API oficial Meta como Fase 2.5; monitoramento de release notes WAHA; contrato de suporte explícito com mantenedor da WAHA Plus |
| W8 | **Mensagem fora de ordem** (webhook chega depois de mensagem mais nova) | Médio | Ordenar timeline por `sent_at` (do payload), não `created_at` do DB; UI re-renderiza ao receber out-of-order |
| W9 | **Mídia >50MB inviável** (WhatsApp aceita até 100MB pra alguns tipos, mas WAHA pode falhar) | Médio | UI rejeita >16MB no outbound (limite WhatsApp para a maioria dos tipos); inbound >50MB usa S3 do WAHA Plus ou stream em chunks; fallback de download |
| W10 | **Áudio OGG inbound não toca em Safari** | Baixo | Re-encode server-side pra MP4/AAC OU `<audio preload="none">` com download fallback; documentado na UX |
| W11 | **"Deal infinito" em grupos** (cada mensagem em grupo cria novo lead) | Médio | SKIP de binding CRM se `chatId.endsWith('@g.us')`; mensagem é gravada mas não vira atividade de lead |
| W12 | **Texto >4096 chars** (limite WhatsApp) | Baixo | Chunkar via função antes do envio; preserva ordem; UI mostra "Mensagem dividida em N partes" |

---

## 8. Fora de Escopo (deste sub-PRD)

- **Templates aprovados Cloud API oficial Meta** (mensagem proativa fora da janela de 24h via API oficial) — Fase 2
- **WhatsApp Business API oficial Meta** como canal alternativo — Fase 2.5 (consideração de migração se WAHA Plus deixar de ser viável)
- **Chamadas de voz/vídeo** WhatsApp — fora de escopo permanente do MVP
- **WhatsApp Pay / Carrinho** — fora do MVP
- **Variante BYO** (cliente roda WAHA próprio em infra dele) — documentada mas implementada na Fase 2
- **Multi-canal além de WhatsApp** (Instagram DM, email, web chat) — Fase 4 (PRD-Mestre §9)
- **Campanhas avançadas com segmentação por SQL/RAG** — pós-MVP; MVP só tem campanha simples com spinning + filtros básicos
- **Auto-resposta por palavra-chave** sem LLM — sub-feature da IA (Sub-PRD 05)
- **Encryption end-to-end de mensagens dentro do CRM** (além do TLS) — fora do MVP

---

## 9. Decisões deferidas pra Spec (Fase 3)

A serem decididas no spec correspondente (`docs/specs/03-spec-whatsapp-waha.md`):

1. **Schema SQL completo** de `channel_sessions`, `webhook_events_log`, `messages`, `conversations`, `cron_runs`
2. **Fila de outbound**: escolha entre Inngest, Trigger.dev, pg_boss (com prós/contras documentados)
3. **Roteamento do webhook receiver**: path com `:session_name` vs header vs path-token assinado
4. **Algoritmo de chunking** de texto >4096 chars (palavra-boundary preferido)
5. **Estratégia de áudio OGG no Safari**: ffmpeg server-side vs preload=none + download
6. **Estrutura DSL do spinning de copy** (formato de placeholders e alternâncias; parser; validação)
7. **Tabela `channel_session_warmup`** (track de dias + volumes) vs cálculo on-demand a partir de `messages`
8. **Engine WEBJS vs NOWEB**: política exata de quando subir uma sessão WEBJS (apenas se feature requer? ou sessão dedicada?)
9. **Health check granularidade**: além de status WAHA, validar pareamento (chamada test) vs apenas status?
10. **Rotação de `webhook_secret`**: procedimento manual com janela de overlap vs automatizado por cron
11. **Política de retenção de `webhook_events_log`** (raw): 30 dias hot + cold storage S3 vs 90 dias hot
12. **Estratégia de migração entre Railway (MVP) e VPS própria (produção)** sem downtime de sessão
13. **Limite exato do hard-cap diário** por status de warm-up (50/100/200/500/1000)
14. **Lista canônica de regex de STOP detection** (incluir variações regionais? português brasileiro)
15. **UI específica do super-admin pra gestão cross-tenant de sessões** (mockups)

---

## Anexos

- `docs/research/reference-synthesis.md` — pontos herdados (especialmente §5 WAHA, §8 Webhooks, §11 Anti-banimento)
- `docs/prd/00-prd-master.md` — visão geral
- `docs/prd/01-prd-platform-base.md` — auth, RLS, audit, event_log, convenções API
- `docs/prd/02-prd-customer-360.md` — Contact, identity resolution, timeline polimórfica
- `tasks/todo.md` — fluxo de construção
