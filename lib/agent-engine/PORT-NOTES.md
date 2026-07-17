# agent-engine — notas do porte Vendaval → DeskcommCRM (fusão)

> Doutrina do porte. TODO arquivo em `lib/agent-engine/` segue estas regras. Fonte original:
> `~/vendaval/daemon/src/` (referência histórica; este diretório é o canônico daqui em diante).

## Mapeamento de schema (determinístico — código E migration seguem a MESMA regra)

| Vendaval (antigo) | DeskcommCRM (canônico) |
|---|---|
| tabela `tenants` | **NÃO EXISTE** → `organizations` (tabela real do CRM) |
| coluna `tenant_id` | `organization_id uuid not null references organizations(id) on delete cascade` |
| `tenants.settings` | `organizations.settings` (jsonb, já existe) |
| tabela `leads` | **NÃO EXISTE** → `contacts` (tabela real do CRM) |
| coluna `lead_id` | `contact_id uuid not null references contacts(id) on delete cascade` |
| `leads.is_opted_out` (cache) | `contacts.is_blocked` (fonte direta — mesmo banco agora) |
| `leads.bot_silenced_until` | `conversations.bot_silenced_until` (já existe) |
| `leads.force_human` (via CRM) | `contacts.force_human` (já existe) |
| LGPD cache (`legal_basis` etc.) | `contacts.consent` jsonb + `contacts.is_anonymized` |
| `leads.crm_conversation_id` | `conversations.id` (lookup por contact/canal) |
| `leads.channel_session_id` | `conversations.channel_session_id` / `channel_sessions.id` |
| tabela `event_inbox` | **NÃO EXISTE** → drain lê `event_log` do CRM direto (mesmo banco) |
| tabela `inbox_items` | `agent_inbox_items` (nova; `organization_id` nullable = plataforma) |
| tabela `org_llm_credentials` | **NÃO EXISTE** → `ai_provider_credentials` (BYOK do CRM) + fallback `ANTHROPIC_API_KEY` |
| demais tabelas do harness | mantêm o nome; só as colunas acima mudam |

Identificadores TS (`leadId`, `tenantId`) podem permanecer nos nomes de variáveis quando o
rename for arriscado, mas TODO SQL usa os nomes canônicos. Novos códigos usam `contactId`/`organizationId`.

## Regras duras herdadas (continuam valendo)
- `organization_id` sempre de fonte confiável (closure do job / linha do evento), NUNCA de payload.
- Opt-out (`contacts.is_blocked`) / `force_human` irrevogáveis; nenhum caminho envia por cima.
- Anti-ban (janela, throttle+jitter, spinning, warm-up) roda ANTES de qualquer envio.
- Envio de mensagem é SEMPRE tool call e passa por `runBeforeSend` (cadeia com veto).
- Toda chamada de modelo passa por `edge/llm/run-model-call.ts`; budget checado ANTES.
- PII fora de logs (logger estruturado de `obs/`).

## Convenções técnicas do repo destino
- Imports relativos SEM extensão `.ts` (moduleResolution bundler).
- Sem `console.log` — usar `obs/logger`.
- AI SDK do repo: `ai` ^6 + `@ai-sdk/anthropic` ^3 (NÃO v7/v4 do Vendaval). Espelhar o uso de
  `generateText`/usage que `lib/ai/runtime/agent.ts` do Deskcomm já faz.
- Zod do repo é v3 (`z.object().passthrough()`, `z.string().uuid()`) — NUNCA APIs v4
  (`z.looseObject`, `z.uuid()`, `.loose()`, `z.iso.*`).
- DB runtime do worker: `pg` Pool via env `SUPABASE_DB_URL` (mesmo padrão do kit self-host);
  a role dedicada é `agent_worker` (login + bypassrls — criada fora de migration).
- `lib/agent-engine/` é auto-contido (sem imports de `@/lib/...` do app), EXCETO a borda
  `crm/` que pode importar handlers do app (ex.: `sendMessageHandler`) e `edge/llm/` que
  reusa `@/lib/crypto/aes_gcm` para o BYOK.
- Migrations: `supabase/migrations/<YYYYMMDDHHMMSS>_0038_agent_harness.sql`, idempotente,
  sem BEGIN/COMMIT, RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()` em toda tabela
  org-scoped, + apêndice em `supabase/baseline.sql` + linha no `MANIFEST.md`.

## Fora do porte (decisão registrada)
- Canvas/console do Vendaval: descartados (UI do Deskcomm substitui).
- `eval/` e `optimizer/` (GEPA): entram na Fase 3 (flywheel vivo), não na fusão física.
- `ops/backup.ts` e o watchdog de restart de sessão: Fase 4 (hardening VPS).
- `edge/crm/mcp-client.ts` transporte MCP HTTP: morto — o arquivo mantém o nome mas agora só
  carrega `CrmEdgeConfig` (admin Supabase client) + `CrmTransportError`.

## Estado aplicado (2026-07-17)
- Migration 0038 JÁ APLICADA no Supabase hospedado (junto com 0034–0037 que estavam
  pendentes) via `supabase db push`. Role `agent_worker` criada no banco; connection string
  em `.env.local` (`SUPABASE_DB_URL`).
