# Webhooks universais + mini motor de regras — Design

**Data:** 2026-07-17 · **Status:** aprovado por Rafael (brainstorming em 3 blocos) · **Escopo:** v1

## 1. Problema

O SonghaiCRM é um sistema fechado: leads só nascem por ação interna (atendente ou mensagem WhatsApp via WAHA). Não há porta de entrada para sistemas externos (landing page, formulário de newsletter, Zapier) criarem leads, nem mecanismo para o sistema **agir** a partir desses eventos (ex.: novo lead → iniciar conversa). E quando sistemas têm isso, ninguém acha nem sabe configurar. Três requisitos:

1. **Funcionalidade**: receber dados de fora (inbound) e notificar sistemas externos (outbound).
2. **Reação**: mini motor de regras gatilho → condições → ações.
3. **Descobribilidade**: item "Webhooks" no sidebar, UI leigo-friendly com snippets prontos, teste embutido e feedback visível de que funcionou.

**Restrição de infra**: projeto open-source; público majoritário self-hosta em VPS HostGator. Sem dependência obrigatória de Upstash/Vercel; URLs a partir de `APP_URL`; schema via migration versionada + apêndice no `baseline.sql`.

## 2. Decisões de produto (travadas)

- **Direção v1**: Inbound + Outbound.
- **Gatilhos v1**: `lead.created` (via webhook), `lead.stage_changed`, `message.received`, tag adicionada (`lead.tag_added` / `contact.tag_added`).
- **Ações v1**: `create_or_move_lead`, `send_whatsapp_message` (template com variáveis, anti-banimento), `add_tag`, `assign_owner`, `call_webhook` (outbound).
- **Condições**: filtros simples — `[{field, op: eq|neq|contains, value}]` combinados com E. Sem OU/grupos no v1.
- **Captação combinada**: mesma URL aceita `application/json` e `application/x-www-form-urlencoded` (form HTML puro, zero JS). Formulário hospedado pelo Deskcomm fica para v2.
- **Naming/local**: "Webhooks" no sidebar (universal, não só captação).

## 3. Arquitetura (Abordagem A — tudo sobre o event_log)

O repo já tem `event_log` (status/attempts/next_attempt_at), RPC `emit_event`, e registry de handlers (`lib/event-log/dispatcher.ts` — `registerHandler`/`dispatchEvent`). O `createLeadHandler` já emite `lead.created`. Falta o **cron drain genérico** que o próprio `dispatcher.ts:8-12` promete e nunca foi construído.

Fluxo:

```
Landing page ──POST──▶ /api/v1/webhooks/in/[token]
                           │ valida token/HMAC/rate-limit, loga em webhook_events_log,
                           │ cria lead via createLeadHandler → emit_event('lead.created')
                           ▼
                       event_log (pending)
                           ▼  (cron event-log-drain, a cada 1min)
                       dispatchEvent() ──▶ automation-rules handler
                           │ carrega automation_rules ativas do tenant p/ o trigger_event
                           │ avalia condições → executa ações em ordem
                           │ grava automation_rule_runs (1 por regra executada)
                           ▼
        ações: create_or_move_lead · send_whatsapp_message · add_tag ·
               assign_owner · call_webhook (outbound)
```

- **Outbound não tem subsistema próprio**: uma "assinatura outbound" é uma regra `gatilho → call_webhook` (sem condições = assinatura pura do evento).
- Ações são assíncronas (latência de segundos até o drain) — aceitável para automação; resposta do inbound é rápida e sem side effects síncronos (doutrina do repo: trigger nunca faz HTTP; side effect vai pro event_log).

## 4. Modelo de dados (migration `0038` + apêndice baseline + MANIFEST)

Três tabelas, todas com `organization_id uuid not null references organizations(id) on delete cascade` + RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()` (padrão do repo).

### `webhook_sources` — fontes de captação inbound
| Coluna | Tipo/nota |
|---|---|
| `id` | uuid pk |
| `organization_id` | fk org |
| `name` | text not null ("Landing Black Friday") |
| `path_token` | text unique not null — gerado (32 bytes url-safe), vai na URL |
| `secret` | text null — HMAC opcional (SHA-256 do raw body, header `X-Deskcomm-Signature`) |
| `kind` | text check, v1 só `'lead_capture'` (text+check, não enum — doutrina) |
| `default_pipeline_id` / `default_stage_id` | fk `crm_pipelines`/`crm_stages`, not null |
| `field_map` | jsonb — mapeia payload→lead; default entende `nome/name`, `telefone/phone/whatsapp`, `email`; campos extras → `custom_fields` + UTMs → `source_metadata` |
| `redirect_to` | text null — URL de "obrigado" p/ resposta a form-post |
| `is_active` | boolean default true |
| `last_received_at` | timestamptz null — feedback "fonte viva" na UI |
| `created_by_user_id`, `created_at`, `updated_at` | padrão |

### `automation_rules` — regras do motor
| Coluna | Tipo/nota |
|---|---|
| `id`, `organization_id` | padrão |
| `name` | text not null |
| `trigger_event` | text not null, check regex `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` (mesmo formato de `event_log.event_type`) |
| `conditions` | jsonb default `'[]'` — array `{field, op, value}`, AND |
| `actions` | jsonb not null — array ordenado `{type, config}`; `type` ∈ {`create_or_move_lead`,`send_whatsapp_message`,`add_tag`,`assign_owner`,`call_webhook`} (validado por Zod na API, não por constraint) |
| `is_active` | boolean **default false** — regra nasce pausada |
| `last_run_at`, `run_count` | observabilidade barata |
| `created_by_user_id`, `created_at`, `updated_at` | padrão |

### `automation_rule_runs` — 1 linha por execução de regra
| Coluna | Tipo/nota |
|---|---|
| `id`, `organization_id` | padrão |
| `rule_id` | fk `automation_rules` on delete cascade |
| `event_id` | fk `event_log` null (set null on delete) |
| `status` | text check `'success'|'partial'|'failed'` |
| `actions_result` | jsonb — por ação: `{type, status, error?, detail?}`; p/ `call_webhook` inclui `response_status` e body truncado |
| `error` | text null (erro fora das ações, ex. condição malformada) |
| `created_at` | timestamptz |

Sem tabela separada de deliveries: o resultado do outbound vive em `actions_result`. Reenvio manual (UI) re-executa só a ação `call_webhook` do run e grava run novo.

**Inbound log**: reusa `webhook_events_log` existente com `provider = 'lead_capture'` (idempotência + feed da UI). Nada novo.

## 5. Endpoint inbound

`POST /api/v1/webhooks/in/[token]` (rota pública, sem cookie/bearer):

1. Resolve `webhook_sources` por `path_token` (fonte confiável do `organization_id` — **nunca do body**). Token inexistente ou fonte inativa → `404` genérico (não vaza existência).
2. Rate limit: `checkRateLimit('webhook_in:'+token, 60, 60)` — lib existente (`lib/ai/dispatcher/rate-limit.ts`), com fallback in-memory quando Upstash ausente (VPS).
3. Parse por content-type: JSON ou form-urlencoded → objeto plano.
4. HMAC: se a fonte tem `secret`, valida `X-Deskcomm-Signature` (SHA-256, `crypto.timingSafeEqual`); inválida → audit + `401`.
5. Loga em `webhook_events_log` (raw body, headers, valid_signature).
6. Aplica `field_map` → normaliza telefone p/ E.164 → cria lead via `createLeadHandler` existente com `ctx.actor` tipo `webhook_source` (`source='webhook'`, `source_metadata` com token da fonte + UTMs + payload extra). `lead.created` é emitido pelo próprio handler.
7. Resposta: JSON `ok()` com `{lead_id}`; se request veio de form (`Accept: text/html` ou content-type form) e a fonte tem `redirect_to` → `303` para lá.
8. `audit()` com action nova `webhook.lead_received`.

Payload inválido (sem nenhum campo mapeável) → `400` `fail()` padrão. Duplicata (mesmo external_id se fornecido) → `200` idempotente.

## 6. Cron drain genérico

`app/api/v1/cron/event-log-drain/route.ts` (protegido por `CRON_SECRET`, padrão dos crons existentes):

- Lote: `status='pending' and next_attempt_at <= now()` (limit ~50), marca `processing`, chama `dispatchEvent(row)` do dispatcher existente.
- Sucesso → `done` (+`consumed_by`). Falha → `attempts+1`, backoff exponencial em `next_attempt_at`, `dead` após 5 tentativas com `last_error`.
- Não colide com os crons específicos existentes (`agent-dispatcher` etc.): o drain só despacha event_types que têm handler registrado e ainda não consumido (`consumed_by`), comportamento já implementado no `dispatchEvent`.
- **Self-host**: kit HostGator adiciona crontab `* * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" $APP_URL/api/v1/cron/event-log-drain` (documentado no install/update do kit). Vercel: entrada em crons.

## 7. Motor de regras (handler `automation-rules`)

Registrado em `lib/event-log/register-handlers.ts`; `events`: os 4 gatilhos. Por evento:

1. Carrega `automation_rules` ativas do tenant com `trigger_event` igual (admin client, filtro `organization_id` manual — doutrina service-role).
2. **Anti-loop**: se `event.metadata.caused_by_rule` presente, pula (profundidade 1 no v1; teto documentado — cadeias regra→regra ficam pra v2).
3. Avalia condições: resolução de campo por path com pontos sobre o payload do evento (`lead.custom_fields.utm_source`); `eq`/`neq` com coerção pra string, `contains` para string e array (tags). Condição referenciando campo ausente = falsa (não erro).
4. Executa ações **em ordem**; erro em uma ação registra no `actions_result` e **continua** as demais (status final `partial`). Toda emissão causada por ação carrega `metadata.caused_by_rule = rule_id`.
5. Grava `automation_rule_runs`, atualiza `last_run_at`/`run_count`.

**Emissões a garantir nos fluxos existentes** (adição pontual de `emit_event`, sem refactor):
- `lead.stage_changed` — no update handler de leads quando `stage_id` muda (payload: lead + from_stage + to_stage).
- `message.received` — na ingestão WAHA (`lib/waha/ingest.ts`), só inbound de contato (não grupo, não fromMe).
- `lead.tag_added` / `contact.tag_added` — nos handlers de update quando `tags` ganha item novo (payload inclui `added_tags`).

## 8. Ações

Executores em `lib/automation/actions/` (um arquivo por ação, interface comum `execute(ctx, config, eventPayload) → ActionResult`):

- **`create_or_move_lead`** — config `{pipeline_id, stage_id}`. Se o evento já referencia um lead, move (reusa update handler, recalcula `position_in_stage`); senão cria via `createLeadHandler` a partir do contato do evento.
- **`add_tag`** — config `{tags: string[]}`; merge idempotente no lead/contato do evento.
- **`assign_owner`** — config `{user_id}`; valida membership no tenant. Round-robin fica pra v2.
- **`call_webhook`** — config `{url, secret?}`. POST JSON, envelope `{event, occurred_at, data}` (sem `organization_id` no body p/ fora), header `X-Deskcomm-Signature` (HMAC SHA-256 do body com o secret, se houver) + `X-Deskcomm-Event`. Timeout 10s. 3 tentativas com backoff curto (1s/5s) dentro do worker; falha final → run `partial`/`failed` visível na UI com "Reenviar". URL validada: https obrigatório em produção, bloqueio de IPs privados/loopback (anti-SSRF).
- **`send_whatsapp_message`** — config `{channel_session_id, template}` com variáveis `{{nome}}`, `{{lead.campo}}`, `{{custom_fields.x}}`. Serviço novo `lib/automation/start-conversation.ts`: upsert de contato por telefone E.164 → cria/acha `conversation` (contato + sessão) → envia pelo caminho de produção existente (`sendMessageHandler`). Contato `is_blocked` (STOP) → ação pulada com motivo no run.

### Throttle anti-banimento (novo — hoje inexistente no repo)
Aplicado ao envio automatizado (`send_whatsapp_message`):
- Respeita `channel_sessions.daily_message_limit` (coluna existente) via contagem do dia em `channel_session_warmup`.
- Janela 7h-22h (horário do servidor; configurável na config da ação em v2).
- Espaçamento ≥1.2s + jitter ≤800ms entre envios automatizados por sessão dentro de um mesmo lote do drain.
- **Fora da janela/limite: não falha nem perde** — o evento volta a `pending` com `next_attempt_at` = próxima janela válida (o `event_log` é a fila; sem scheduler novo).

## 9. UI — `/app/webhooks`

**Sidebar**: item "Webhooks" (`WebhooksLogo` do Phosphor) em `NAV_ITEMS` (`components/shell/Sidebar.tsx`), visível para `manager+` (padrão de gate por `usePermission` existente). Design system travado (Sage + Atkinson Hyperlegible + Phosphor + estética aerada).

**Aba 1 — Receber dados** (fontes):
- Empty-state didático: "Conecte sua landing page em 2 minutos" com 3 passos.
- Criar fonte = modal (nome + pipeline/estágio destino) → tela da fonte com: URL completa (de `APP_URL`) com copiar; snippet `<form>` HTML pronto; exemplo `curl` JSON; instruções por cenário (WordPress/Elementor, form próprio, Zapier/n8n).
- Botão **"Enviar lead de teste"** — POST real na própria URL, mostra o lead criado (fecha o loop de confiança).
- Feed de últimos recebimentos (de `webhook_events_log`) com status verde/vermelho.

**Aba 2 — Automações** (regras):
- Builder em linguagem natural, 3 blocos verticais: **QUANDO** (dropdown 4 gatilhos) → **SE** (linhas campo/operador/valor, opcional) → **ENTÃO** (ações ordenadas, mini-form por ação).
- Regra nasce **pausada**; switch ativa após revisão.

**Aba 3 — Atividade**:
- Timeline de `automation_rule_runs` + recebimentos: "Regra X rodou para o lead João — ✓ movido, ✓ mensagem enviada, ✗ webhook externo falhou (500) [Reenviar]".

**API de gestão** (`/api/v1/webhook-sources`, `/api/v1/automation-rules`, `/api/v1/automation-rules/[id]/runs`): CRUD padrão com `requireRole('manager')`, Zod em todo input, `ok()`/`fail()`, audit em toda mutação (actions novas: `webhook.source_created/updated/deleted`, `automation.rule_created/updated/deleted/toggled`, `webhook.lead_received`, `automation.rule_executed` — esta última só em falha, p/ não inflar audit).

## 10. Segurança (resumo)

- RLS nas 3 tabelas novas; teste de isolamento 2-tenants obrigatório (gate CI).
- `organization_id` do inbound resolvido só pelo `path_token`; handlers com admin client filtram org manualmente.
- Rate limit no inbound (fallback in-memory); HMAC opcional inbound e outbound; `timingSafeEqual` sempre.
- Anti-SSRF no `call_webhook` (https em prod, bloqueio de IP privado/loopback/link-local).
- `secret` de fonte mostrado uma vez e armazenado como hash? **Não** — precisa do plaintext p/ validar HMAC de inbound e assinar outbound; armazenado em coluna comum (mesma postura de `channel_sessions.webhook_secret_encrypted`: se cifrar, via `fn_encrypt_oauth`/`fn_decrypt_oauth` existentes — decisão: cifrar com as RPCs existentes, custo baixo).
- Regra nasce pausada; MFA/roles inalterados.

## 11. Testes

- **Invariantes** (`tests/invariants/`): isolamento RLS das 3 tabelas; token de fonte do tenant A não cria lead no tenant B; anti-loop (evento `caused_by_rule` não reprocessa); throttle adia (`next_attempt_at` futuro) em vez de perder/falhar.
- **Unit** (Vitest): avaliador de condições (eq/neq/contains, campo ausente, path aninhado); `field_map` com payloads sujos (form-urlencoded, aliases de campo, telefone BR em formatos variados → E.164); template de variáveis; validador anti-SSRF.
- **E2E** (Playwright): criar fonte na UI → POST no webhook → lead no Kanban → regra (pausada→ativa) roda no drain → run verde na aba Atividade; botão "lead de teste".

## 12. Fora de escopo v1 (explícito)

Formulário hospedado embedável; builder de condições com OU/grupos; round-robin de atribuição; cadeias regra→regra (profundidade >1); retry configurável de outbound; janela de envio configurável por regra; gatilhos além dos 4; fila outbound persistente dedicada.

## 13. Entregáveis de schema (doutrina open-source)

Migration `<timestamp-da-implementação>_0038_webhooks_automation.sql` (timestamp `YYYYMMDDHHMMSS` gerado no dia; idempotente, psql puro) + apêndice idempotente no fim de `supabase/baseline.sql` (blocos rotulados `-- ---- webhooks/automation (migration 0038) ----`, com grants no padrão do arquivo) + linha no `supabase/migrations/MANIFEST.md` + regenerar `lib/database.types.ts` + crontab do drain documentado no kit HostGator.
