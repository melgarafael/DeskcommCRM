# Onda 5.3 — Snooze/Lembrete por conversa Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O vendedor define "me avise se o lead não responder em X horas" numa conversa; quando o prazo vence sem resposta do lead, a conversa reabre no topo da fila do vendedor e um aviso interno é criado — nada é enviado ao cliente.

**Architecture:** 3 colunas em `conversations` (`snooze_until`, `snoozed_by_user_id`, `snoozed_at` — doutrina DIRC, mesmo padrão do `bot_silenced_until` já existente; sem tabela nova). Um botão "Lembrar" no `ConversationHeader` (dropdown 1h/3h/24h) chama `POST /api/v1/conversations/[id]/snooze`. Um cron `snooze-watcher` (padrão de `cron/lgpd-sla-watcher`, autenticado por Bearer) varre `snooze_until <= now()` sem resposta do lead → bump `last_message_at` + `status='open'` + limpa o snooze + cria `agent_inbox_items(kind='snooze_expired')`. "Reabrir no topo" = `last_message_at = now()` (a aba "Minhas" ordena por `last_message_at DESC`). "Sem resposta" = `last_inbound_at <= snoozed_at` (coluna denormalizada, sem JOIN em messages).

**Tech Stack:** Postgres (migration + RLS já herdada de conversations), Next.js Route Handlers, admin client no cron, React 19 + Tailwind, React Query.

## Global Constraints

- Spec mestre: `docs/superpowers/specs/2026-07-21-inbox-multimodal-design.md` (Onda 5, "Lembrete/snooze"). Handoff `HANDOFF-inbox-multimodal.md` (prova visível em conta REAL; "funcionou BEM").
- **Decisão travada pelo Rafael:** ao vencer, **reabre na fila do vendedor + aviso interno; NÃO manda nada ao cliente.** Granularidade = **por conversa**.
- **NÃO confundir com o reentry do agente** (`reentry_knob_versions/pointers`, migration 0050) — aquilo é follow-up AUTOMÁTICO do bot AO cliente, por org/segmento. Este snooze é interno, por conversa, humano. Sistemas paralelos, zero overlap de tabela/fluxo.
- **Trigger Postgres NUNCA faz HTTP** — o disparo é um cron que varre por deadline (não `event_log`, pois é a AUSÊNCIA de resposta que dispara). Template: `app/api/v1/cron/lgpd-sla-watcher/route.ts` (admin client, Bearer `INTERNAL_CRON_SECRET`/`INTERNAL_SECRET`, fail-closed, dedup, `audit()` no fim).
- **Migration doctrine:** migration versionada (próximo nº **0061** — confirmar com `ls supabase/migrations/`; se o hook renumerar, seguir em todos os artefatos) + apêndice idempotente no `baseline.sql` + linha no MANIFEST + `database.types.ts`. Idempotente (`add column if not exists`; para o CHECK novo do `agent_inbox_items.kind`, **dropar e recriar** o constraint de forma auto-curativa).
- Auth: `requireRole("agent", ...)` na rota de snooze; org SEMPRE de `authz`. Zod no input (as opções de duração). Audit em toda mutação (`conversation.snoozed`). Cron autenticado por Bearer secret (não requireRole). Sem `console.log`. typecheck/lint/testes verdes por task (sem pipe-tail).
- Aviso interno via `insertInboxItem` (`lib/agent-engine/db/repository.ts:45`); adicionar `kind='snooze_expired'` ao CHECK de `agent_inbox_items`, ao `InboxKind` (`repository.ts:15`) e ao `KIND_LABEL` (`lib/ai/agent-inbox-copy.ts:9`).
- Prova: snooze curto numa conversa REAL → sem responder o lead → rodar o cron → conversa reabre no topo de "Minhas" + aviso na central; e o caso "lead respondeu → NÃO reabre".

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/..._0061_conversation_snooze.sql` + baseline + MANIFEST + types | 3 colunas em conversations + kind snooze_expired |
| `lib/schemas/snooze.ts` (novo) | Zod da duração |
| `app/api/v1/conversations/[id]/snooze/route.ts` (novo) | POST (define snooze) + DELETE (cancela) |
| `lib/agent-engine/db/repository.ts` (mod) | `InboxKind` += `snooze_expired` |
| `lib/ai/agent-inbox-copy.ts` (mod) | label de `snooze_expired` |
| `app/api/v1/cron/snooze-watcher/route.ts` (novo) | varre deadline → reabre + aviso |
| `hooks/inbox/useSnoozeConversation.ts` (novo) | React Query mutation |
| `components/inbox/SnoozeButton.tsx` (novo) | botão "Lembrar" + dropdown de duração |
| `components/inbox/ConversationHeader.tsx` (mod) | monta o botão |

---

### Task 1: Migration 0061 — colunas de snooze + kind

**Files:**
- Create: `supabase/migrations/20260722150000_0061_conversation_snooze.sql`
- Modify: `supabase/baseline.sql` (apêndice), `supabase/migrations/MANIFEST.md`, `lib/database.types.ts`

**Interfaces:**
- Produces: `conversations.snooze_until timestamptz`, `.snoozed_by_user_id uuid`, `.snoozed_at timestamptz`; `agent_inbox_items.kind` aceita `'snooze_expired'`.

- [ ] **Step 1: Migration** (idempotente + auto-curativa no CHECK):
  ```sql
  -- 0061: snooze por conversa (Onda 5.3). Vendedor pede "me avise se o lead não
  -- responder em X h"; cron reabre a conversa + cria aviso interno. Nada ao cliente.
  alter table conversations
    add column if not exists snooze_until timestamptz,
    add column if not exists snoozed_by_user_id uuid references auth.users(id) on delete set null,
    add column if not exists snoozed_at timestamptz;

  -- índice parcial p/ o cron varrer só o que tem snooze ativo
  create index if not exists idx_conversations_snooze_until
    on conversations (snooze_until) where snooze_until is not null;

  -- agent_inbox_items.kind += 'snooze_expired' (recria o CHECK de forma auto-curativa)
  alter table agent_inbox_items drop constraint if exists agent_inbox_items_kind_check;
  alter table agent_inbox_items add constraint agent_inbox_items_kind_check
    check (kind in ('qr_rescan','job_dead','event_dead','budget_exceeded','handoff',
                    'promotion_review','judge_unaligned','snooze_expired','other'));
  ```
  > Confirmar a lista EXATA de kinds atuais em `supabase/baseline.sql` (o CHECK de `agent_inbox_items`) e apenas ADICIONAR `snooze_expired` — não remover nenhum existente.

- [ ] **Step 2: Apêndice idempotente no `baseline.sql`** — bloco rotulado `-- ---- snooze por conversa (migration 0061) ----` com o MESMO SQL.

- [ ] **Step 3: MANIFEST** — `| 0061 | ..._0061_conversation_snooze | Colunas snooze_* em conversations + kind snooze_expired em agent_inbox_items (Onda 5.3). |`

- [ ] **Step 4: Aplicar e provar** (via CLI Supabase linkada — `supabase db push` como na 0060):
  ```sql
  select column_name from information_schema.columns where table_name='conversations' and column_name like 'snooze%';  -- 3 linhas
  select pg_get_constraintdef(oid) from pg_constraint where conname='agent_inbox_items_kind_check';  -- contém snooze_expired
  ```

- [ ] **Step 5: `database.types.ts`** — adicionar `snooze_until`/`snoozed_by_user_id`/`snoozed_at` (nullable) em `conversations` Row/Insert/Update. À mão (gen types puxa drift de branches concorrentes).

- [ ] **Step 6: typecheck + commit**
  ```bash
  npm run typecheck
  git add supabase/migrations/20260722150000_0061_conversation_snooze.sql supabase/baseline.sql supabase/migrations/MANIFEST.md lib/database.types.ts
  git commit -m "feat(snooze): migration 0061 — colunas snooze_* + kind snooze_expired"
  ```

---

### Task 2: Rota POST/DELETE snooze

**Files:**
- Create: `lib/schemas/snooze.ts`, `app/api/v1/conversations/[id]/snooze/route.ts`
- Test: `tests/unit/snooze-schema.test.ts`

**Interfaces:**
- Consumes: `requireRole`, `ok`/`fail`/`noContent`, `audit`, `createClient`.
- Produces: `snoozeSchema` = `{ duration_hours: 1 | 3 | 24 }` (enum fechado — só as opções da UI). POST define `snooze_until = now()+duration`, `snoozed_at = now()`, `snoozed_by_user_id = user.id`. DELETE cancela (zera as 3 colunas).

- [ ] **Step 1: Teste do schema (falhando)** — aceita `{duration_hours:1|3|24}`, rejeita 0, 5, negativo, string.

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: `lib/schemas/snooze.ts`**
  ```ts
  import { z } from "zod";
  export const snoozeSchema = z.object({ duration_hours: z.union([z.literal(1), z.literal(3), z.literal(24)]) });
  export type SnoozeInput = z.infer<typeof snoozeSchema>;
  ```

- [ ] **Step 4: rota** — POST valida, computa `snooze_until` (usar SQL `now() + make_interval(hours => $1)` OU calcular no Node com `new Date(Date.now()+h*3600e3).toISOString()`), `update conversations set ... where id=$id and organization_id=org.orgId` com `.select("id").maybeSingle()` → 404 se nada (mesma lição do DELETE de templates: RLS-barrado ≠ 204 falso). Audit `conversation.snoozed` (metadata: duration_hours). DELETE zera as 3 colunas, audit `conversation.snooze_cancelled`. Adicionar as 2 actions em `lib/audit/actions.ts`. Confirmar que a RLS de `conversations` já cobre o UPDATE por membro da org (herdada — `conversations_tenant_isolation_all`).

- [ ] **Step 5: typecheck + testes + lint + commit**
  ```bash
  npm run typecheck && npx vitest run tests/unit/snooze-schema.test.ts && npm run lint
  git add lib/schemas/snooze.ts "app/api/v1/conversations/[id]/snooze/" lib/audit/actions.ts tests/unit/snooze-schema.test.ts
  git commit -m "feat(snooze): rota POST/DELETE /conversations/[id]/snooze (Zod, audit, 404 honesto)"
  ```

---

### Task 3: kind `snooze_expired` no inbox interno

**Files:**
- Modify: `lib/agent-engine/db/repository.ts` (`InboxKind`), `lib/ai/agent-inbox-copy.ts` (`KIND_LABEL`)
- Test: `tests/unit/agent-inbox-copy.test.ts` (se existir; senão asserção mínima no teste do cron da Task 4)

**Interfaces:**
- Produces: `InboxKind` inclui `"snooze_expired"`; `KIND_LABEL["snooze_expired"]` = copy humana.

- [ ] **Step 1:** adicionar `"snooze_expired"` ao union `InboxKind` (`repository.ts:15-22`) — só append.
- [ ] **Step 2:** adicionar em `KIND_LABEL` (`agent-inbox-copy.ts:9-18`): `snooze_expired: "O lead não respondeu no prazo que você definiu"` (conferir o shape real do objeto — label/título/severidade).
- [ ] **Step 3: typecheck + commit**
  ```bash
  npm run typecheck
  git add lib/agent-engine/db/repository.ts lib/ai/agent-inbox-copy.ts
  git commit -m "feat(snooze): kind snooze_expired na central de avisos interna"
  ```

---

### Task 4: Cron `snooze-watcher`

**Files:**
- Create: `app/api/v1/cron/snooze-watcher/route.ts`
- Test: `tests/unit/snooze-watcher.test.ts` (lógica de decisão pura, se extraível) OU cobrir na prova E2E da Task 6

**Interfaces:**
- Consumes: admin client, `insertInboxItem`, o pool (para `insertInboxItem` que usa pg — reusar `getRequestPool` da Onda 5.1 se já existir, senão criar; OU usar o admin Supabase client se `insertInboxItem` tiver variante — confirmar a assinatura de `insertInboxItem`).
- Produces: `POST`/`GET` handler autenticado por Bearer que reabre conversas vencidas.

- [ ] **Step 1: Ler o template** `app/api/v1/cron/lgpd-sla-watcher/route.ts` (auth Bearer, admin client, loop, dedup, audit) e `app/api/v1/cron/routing-worker/route.ts`. Copiar o esqueleto de auth (fail-closed se secret ausente/errado).

- [ ] **Step 2: Implementar a varredura**:
  ```ts
  const nowIso = new Date().toISOString();
  const { data: due } = await admin.from("conversations")
    .select("id, organization_id, snoozed_at, last_inbound_at, status")
    .not("snooze_until", "is", null)
    .lte("snooze_until", nowIso)
    .limit(SCAN_LIMIT);
  let reopened = 0;
  for (const c of due ?? []) {
    const leadReplied = c.last_inbound_at && c.snoozed_at && c.last_inbound_at > c.snoozed_at;
    // limpa o snooze SEMPRE (evita reprocessar); só reabre + avisa se o lead NÃO respondeu
    const patch = { snooze_until: null, snoozed_at: null, snoozed_by_user_id: null };
    if (!leadReplied && c.status !== "closed" && c.status !== "archived") {
      await admin.from("conversations").update({ ...patch, status: "open", last_message_at: nowIso }).eq("id", c.id);
      await insertInboxItem(/* pool/db */, c.organization_id, {
        kind: "snooze_expired", severity: "warn",
        title: "Lead não respondeu no prazo",
        refKind: "conversation", refId: c.id,
      });
      reopened++;
    } else {
      await admin.from("conversations").update(patch).eq("id", c.id);
    }
  }
  // audit resumo + return ok({ scanned: due?.length ?? 0, reopened })
  ```
  > Confirmar a assinatura EXATA de `insertInboxItem` (recebe pg.Pool ou Supabase client? quais campos — `refKind`/`ref_kind`?). Espelhar um caller real: `lib/agent-engine/agent/human-handoff.ts:180` ou `lib/agent-engine/cron/scheduler.ts:177`.

- [ ] **Step 3: registrar o cron** — deixar uma NOTA no HANDOFF + no MANIFEST de que o self-host precisa agendar `GET /api/v1/cron/snooze-watcher` no container `scheduler` (ex.: a cada 5 min) com o Bearer secret. Sem `vercel.json` no repo (self-host) — é config de deploy, fora do código. `log()` explícito de que não há agendamento automático no código.

- [ ] **Step 4: typecheck + lint + commit**
  ```bash
  npm run typecheck && npx eslint app/api/v1/cron/snooze-watcher/route.ts
  git add "app/api/v1/cron/snooze-watcher/"
  git commit -m "feat(snooze): cron snooze-watcher — reabre conversa vencida + aviso interno (nada ao cliente)"
  ```

---

### Task 5: Botão "Lembrar" no header

**Files:**
- Create: `hooks/inbox/useSnoozeConversation.ts`, `components/inbox/SnoozeButton.tsx`
- Modify: `components/inbox/ConversationHeader.tsx`
- Test: `tests/unit/snooze-button.test.tsx`

**Interfaces:**
- Consumes: rota da Task 2, `apiClient`, `showApiError`.
- Produces: `useSnoozeConversation()` (mutation `{conversationId, duration_hours}` + invalidate `["conversations"]`, `["conversation", id]`); `<SnoozeButton conversationId snoozeUntil disabled />` — dropdown 1h/3h/24h; se já snoozed, mostra estado ativo + opção "Cancelar lembrete".

- [ ] **Step 1: Teste (falhando)** — render: abre dropdown, escolher "3 horas" chama a mutation com `duration_hours:3`; se `snoozeUntil` setado, mostra o estado ativo + "Cancelar".

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: `useSnoozeConversation`** — `useMutation` com `apiClient.post`/`apiClient.delete`, `onSuccess` invalida as duas queries. `onError: showApiError`.

- [ ] **Step 4: `SnoozeButton`** — `DropdownMenu` (padrão do `ReassignDialog`/menus existentes no header) com itens "Em 1 hora / 3 horas / 24 horas"; ícone `Clock`/`BellRinging` de `@/lib/ui/icons` (grep pelo que existe). Se `snoozeUntil` no futuro: botão mostra "Lembrete ativo" + item "Cancelar lembrete" (DELETE). `disabled` quando pendente.

- [ ] **Step 5: Integrar no `ConversationHeader`** — ao lado de "Fechar" (linha ~87), passar `conversationId`, `snoozeUntil={conversation.snooze_until}`, `disabled` conforme status. Seguir o padrão visual dos botões `size="sm" variant="outline"`.

- [ ] **Step 6: typecheck + testes + lint + commit**
  ```bash
  npm run typecheck && npx vitest run tests/unit/snooze-button.test.tsx && npx vitest run && npm run lint
  git add hooks/inbox/useSnoozeConversation.ts components/inbox/SnoozeButton.tsx components/inbox/ConversationHeader.tsx tests/unit/snooze-button.test.tsx
  git commit -m "feat(snooze): botão Lembrar no header da conversa (1h/3h/24h + cancelar)"
  ```

---

### Task 6: Prova E2E real + HANDOFF

**Files:**
- Modify: `HANDOFF-inbox-multimodal.md`
- Evidência: `inbox-multimodal-onda53-*.png`

- [ ] **Step 1: Ambiente** — dev server + login como agente; conversa REAL na aba "Minhas" (assumir uma). Definir `INTERNAL_CRON_SECRET` no `.env.local` se ainda não houver (confirmar o nome real do secret no template do cron).
- [ ] **Step 2:** clicar "Lembrar" → "Em 1 hora"; confirmar no SQL que `snooze_until`/`snoozed_at`/`snoozed_by_user_id` foram setados. Screenshot do estado "Lembrete ativo".
- [ ] **Step 3: forçar o vencimento** — via SQL, `update conversations set snooze_until = now() - interval '1 min', snoozed_at = now() - interval '2 h'` (sem inbound novo do lead) e chamar o cron: `curl -H "Authorization: Bearer $INTERNAL_CRON_SECRET" http://localhost:PORT/api/v1/cron/snooze-watcher`. Provar: conversa voltou (status open, `last_message_at` bumpado → topo de "Minhas") + `agent_inbox_items` ganhou 1 linha `kind='snooze_expired'` `ref_id=<conv>` + o sino "Central de avisos" incrementou. Screenshots (fila + central de avisos).
- [ ] **Step 4: caso "lead respondeu"** — outra conversa snoozed onde `last_inbound_at > snoozed_at` → rodar o cron → NÃO reabre, NÃO cria aviso, snooze limpo. Provar por SQL.
- [ ] **Step 5:** `typecheck`+`lint`+`vitest` verdes; atualizar HANDOFF (Onda 5.3 → status + provas + a NOTA de que o self-host precisa agendar o cron) e commitar.

---

## Self-review (na escrita)

- **Cobertura do spec:** define prazo por conversa (T2/T5) + dispara no vencimento (T4) + reabre na fila + aviso interno, nada ao cliente (T4) + prova real incl. o caso "lead respondeu não reabre" (T6). ✅
- **DIRC:** coluna em conversations (não tabela) — justificado (1 snooze ativo, precedente `bot_silenced_until`). Detecção "sem resposta" reusa `last_inbound_at` (não JOIN em messages). ✅
- **Sem placeholders:** SQL, handlers e varredura concretos; os "confirmar" (lista de kinds atual; assinatura de `insertInboxItem`; nome do Bearer secret) mandam LER o arquivo real citado com linha — não deixam lógica aberta.
- **Riscos nomeados:** cron limpa o snooze SEMPRE (evita reprocesso); RLS-barrado retorna 404 honesto (lição da 0060); cron precisa de agendamento no deploy (NOTA explícita, não silenciar). Migration auto-curativa no CHECK (dropa+recria sem remover kinds existentes).
- **Sem colisão com reentry** do agente (tabelas/fluxos distintos, documentado nas Global Constraints). ✅
