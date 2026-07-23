# Onda 5.2 — Notas internas de conversa Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O time escreve anotações numa conversa (visíveis só internamente, nunca vão ao cliente) que aparecem inline no thread junto com as mensagens, com destaque visual e o nome de quem escreveu.

**Architecture:** Tabela própria `conversation_notes` (não polui `messages`, que são trocas reais com o cliente) com `created_by_name` denormalizado no insert. Rota `GET/POST /api/v1/conversations/[id]/notes` + `DELETE .../notes/[noteId]`. No front: 2ª query `useConversationNotes` (realtime próprio na tabela) + merge por timestamp no `ChatThread` (union `ThreadItem = message | note`), renderizando `<NoteCard>` ou `<MessageBubble>`. No `Composer`: toggle "Responder | Nota interna" que bifurca o submit (cria nota em vez de enviar) e desabilita anexo/áudio/rascunho no modo nota. **Merge no cliente** (não no backend): reaproveita o realtime existente, não força a rota de mensagens a conhecer notas, paginações independentes.

**Tech Stack:** Postgres (migration + RLS), Next.js Route Handlers, React 19 + Tailwind, React Query (useInfiniteQuery/useQuery + Supabase realtime).

## Global Constraints

- Spec mestre: `docs/superpowers/specs/2026-07-21-inbox-multimodal-design.md` (Onda 5, "Notas internas: anotações na conversa visíveis só pro time"). Handoff `HANDOFF-inbox-multimodal.md` (prova visível em conta REAL; "funcionou BEM").
- **Nota NUNCA vai ao cliente** — é registro interno. Não toca WAHA, não tem external_id/ack/direction. Tabela separada de `messages`.
- **Nota é imutável** (padrão Intercom): sem edição/`updated_at`. Deletável pelo AUTOR ou manager+ (evita disputa). Se pedirem edição depois, `updated_at`+policy viram triviais.
- **Merge no cliente**: `ChatThread` faz 2ª query + merge por timestamp; NÃO alterar a rota/paginação de `messages`. Cada realtime invalida só a própria queryKey.
- Migration doctrine: versionada + apêndice idempotente no `baseline.sql` + MANIFEST + `database.types.ts`. Próximo nº: confirmar com `ls supabase/migrations/` (provável **0063**; a sessão irmã `feat/followup-flows` pode ter reivindicado números — se o pre-commit hook reclamar, renumere em TODOS os artefatos, como aconteceu na 0062). Idempotente.
- RLS: `conversation_notes_select` (membro da org OU platform admin) + `conversation_notes_write` (`fn_role_at_least(org,'agent')`), helpers reais `fn_user_org_ids()`/`fn_role_at_least()`/`fn_is_platform_admin()`.
- Auth: `requireRole("agent", ...)`; org SEMPRE de `authz`. `user.full_name` (de `lib/auth/types.ts`, já resolvido pelo requireRole) → `created_by_name` denormalizado. Zod no input. Audit em mutação. Sem `console.log`. typecheck/lint/testes verdes por task (sem pipe-tail).
- Prova: modo nota no composer → nota criada → aparece inline no thread com destaque + nome do autor → NÃO some pro cliente (SQL: nada em `messages`, nada no WAHA); realtime (aparece sem reload); delete pelo autor.

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/..._00NN_conversation_notes.sql` + baseline + MANIFEST + types | tabela `conversation_notes` + RLS |
| `lib/schemas/notes.ts` (novo) | Zod create |
| `app/api/v1/conversations/[id]/notes/route.ts` (novo) | GET (lista) + POST (cria) |
| `app/api/v1/conversations/[id]/notes/[noteId]/route.ts` (novo) | DELETE (autor ou manager+) |
| `hooks/inbox/useConversationNotes.ts` (novo) | query + realtime das notas |
| `hooks/inbox/useCreateNote.ts` (novo) | mutation de criar nota |
| `components/inbox/NoteCard.tsx` (novo) | render da nota no thread (destaque + autor) |
| `components/inbox/ChatThread.tsx` (mod) | merge por timestamp (ThreadItem union) |
| `components/inbox/Composer.tsx` (mod) | toggle Responder/Nota + bifurca submit |

---

### Task 1: Migration — tabela `conversation_notes`

**Files:**
- Create: `supabase/migrations/<timestamp>_00NN_conversation_notes.sql` (confirmar NN livre)
- Modify: `supabase/baseline.sql` (apêndice), `supabase/migrations/MANIFEST.md`, `lib/database.types.ts`

**Interfaces:**
- Produces: tabela `conversation_notes` (`id`, `organization_id`, `conversation_id`, `body`, `created_by_user_id`, `created_by_name`, `created_at`) + RLS.

- [ ] **Step 1: Migration** (idempotente):
```sql
-- 00NN: notas internas de conversa (Onda 5.2). Visíveis só ao time, nunca vão
-- ao cliente. Tabela separada de messages (não são trocas com o cliente).
create table if not exists conversation_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  body text not null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists idx_conversation_notes_conversation
  on conversation_notes (conversation_id, created_at);

alter table conversation_notes enable row level security;

drop policy if exists "conversation_notes_select" on conversation_notes;
create policy "conversation_notes_select" on conversation_notes
  for select using (
    organization_id in (select fn_user_org_ids()) or fn_is_platform_admin()
  );

drop policy if exists "conversation_notes_write" on conversation_notes;
create policy "conversation_notes_write" on conversation_notes
  for all using (
    organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, 'agent')
  )
  with check (
    organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, 'agent')
  );
```
> Confirme os helpers no baseline (`fn_user_org_ids`, `fn_role_at_least`, `fn_is_platform_admin`) — idênticos aos usados na migration 0060 (message_templates). NÃO invente nomes.

- [ ] **Step 2: Apêndice idempotente no `baseline.sql`** — bloco rotulado `-- ---- notas internas de conversa (migration 00NN) ----` com o MESMO SQL.
- [ ] **Step 3: MANIFEST** — linha descrevendo a tabela.
- [ ] **Step 4: Aplicar e provar** (via `supabase db push --linked`; se o histórico reclamar, ver o workaround no relatório da 0062 em scratchpad). Prova:
```sql
select tablename from pg_tables where tablename='conversation_notes';               -- 1
select policyname from pg_policies where tablename='conversation_notes' order by 1;  -- 2 (select, write)
```
- [ ] **Step 5: `database.types.ts`** — adicionar `conversation_notes` (Row/Insert/Update) à mão, nullable onde aplicável (`created_by_user_id`, `created_by_name`).
- [ ] **Step 6: typecheck + commit**
```bash
npm run typecheck
git add supabase/migrations/*_conversation_notes.sql supabase/baseline.sql supabase/migrations/MANIFEST.md lib/database.types.ts
git commit -m "feat(notes): migration — tabela conversation_notes (interna, RLS)"
```

---

### Task 2: Schema Zod + rota GET/POST + DELETE

**Files:**
- Create: `lib/schemas/notes.ts`, `app/api/v1/conversations/[id]/notes/route.ts`, `app/api/v1/conversations/[id]/notes/[noteId]/route.ts`
- Test: `tests/unit/notes-schema.test.ts`

**Interfaces:**
- Consumes: `requireRole`, `ok`/`fail`/`noContent`, `audit`, `createClient`, `env`.
- Produces:
  - `createNoteSchema = z.object({ body: z.string().trim().min(1).max(4096) })`.
  - GET `/api/v1/conversations/[id]/notes` → `{ data: Note[] }` (RLS filtra; ordena por created_at asc).
  - POST cria (grava `created_by_user_id: user.id`, `created_by_name: user.full_name ?? null`).
  - DELETE `/notes/[noteId]` — autor OU manager+.

- [ ] **Step 1: Teste do schema (falhando)** — aceita `{body:"oi"}`, rejeita body vazio e >4096.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: `lib/schemas/notes.ts`**
```ts
import { z } from "zod";
export const createNoteSchema = z.object({ body: z.string().trim().min(1).max(4096) });
export type CreateNoteInput = z.infer<typeof createNoteSchema>;
```
- [ ] **Step 4: `notes/route.ts` (GET+POST)** — espelha `snooze/route.ts` e `message-templates/route.ts`:
  - Ambos validam que a conversa pertence à org (`select id from conversations where id=convId and organization_id=org.orgId` → 404 se não).
  - GET: `select id, body, created_by_user_id, created_by_name, created_at from conversation_notes where conversation_id=$ and organization_id=$ order by created_at asc`. `ok(data ?? [])`.
  - POST: valida `createNoteSchema`, `insert({ organization_id: org.orgId, conversation_id, body, created_by_user_id: user.id, created_by_name: user.full_name ?? null }).select(COLS).single()`. Audit `conversation.note_added` (adicionar ao AuditAction). `ok(data, { status: 201 })`.
- [ ] **Step 5: `notes/[noteId]/route.ts` (DELETE)** — requireRole("agent"); busca a nota (`created_by_user_id`) escopada por org; permite deletar se `note.created_by_user_id === user.id` OU `ROLE_RANK[org.role] >= ROLE_RANK.manager` (senão 403); `delete().eq("id", noteId).eq("organization_id", org.orgId).select("id").maybeSingle()` → 404 se nada. Audit `conversation.note_deleted`. `noContent`.
- [ ] **Step 6: typecheck + testes + lint + commit**
```bash
npm run typecheck && npx vitest run tests/unit/notes-schema.test.ts && npm run lint
git add lib/schemas/notes.ts "app/api/v1/conversations/[id]/notes/" lib/audit/actions.ts tests/unit/notes-schema.test.ts
git commit -m "feat(notes): CRUD /conversations/[id]/notes (Zod, RLS, audit, delete autor/manager)"
```

---

### Task 3: Hooks + merge no thread + NoteCard

**Files:**
- Create: `hooks/inbox/useConversationNotes.ts`, `hooks/inbox/useCreateNote.ts`, `components/inbox/NoteCard.tsx`
- Modify: `components/inbox/ChatThread.tsx`
- Test: `tests/unit/thread-merge.test.ts` (a função pura de merge)

**Interfaces:**
- Consumes: GET/POST notes (Task 2), `useRealtimeChannel` (padrão de `useMessagesRealtime.ts`).
- Produces:
  - `useConversationNotes(conversationId)` → `Note[]` (query `["notes", id]` + canal realtime na tabela `conversation_notes` filtrado por `conversation_id`, invalida a própria key).
  - `useCreateNote()` → mutation (POST) invalida `["notes", id]`.
  - `mergeThreadItems(messages, notes): ThreadItem[]` puro, ordenado por timestamp (`sent_at`/`created_at`).
  - `<NoteCard note={...} onDelete? />`.

- [ ] **Step 1: Teste do merge (falhando)** — `mergeThreadItems` intercala message e note por timestamp asc; empate resolve estável; array vazio ok.
```ts
// tests/unit/thread-merge.test.ts
import { describe, expect, it } from "vitest";
import { mergeThreadItems } from "@/components/inbox/ChatThread";

describe("mergeThreadItems", () => {
  it("intercala mensagens e notas por tempo", () => {
    const msgs = [{ id: "m1", sent_at: "2026-07-23T10:00:00Z" }, { id: "m2", sent_at: "2026-07-23T10:02:00Z" }] as never;
    const notes = [{ id: "n1", created_at: "2026-07-23T10:01:00Z" }] as never;
    const out = mergeThreadItems(msgs, notes);
    expect(out.map((i) => i.data.id)).toEqual(["m1", "n1", "m2"]);
    expect(out[1]!.kind).toBe("note");
  });
  it("sem notas → só mensagens", () => {
    const msgs = [{ id: "m1", sent_at: "2026-07-23T10:00:00Z" }] as never;
    expect(mergeThreadItems(msgs, []).every((i) => i.kind === "message")).toBe(true);
  });
});
```
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: `useConversationNotes` + `useCreateNote`** — espelhar `useMessagesRealtime.ts` (query + `useRealtimeChannel` postgresChanges na tabela `conversation_notes`, `filter: conversation_id=eq.${id}`, onChange → `qc.invalidateQueries(["notes", id])`). `useConversationNotes` pode ser `useQuery` simples (notas são poucas; sem paginação infinita).
- [ ] **Step 4: `NoteCard.tsx`** — cartão com destaque (fundo âmbar/warning suave, borda), ícone de nota, `created_by_name ?? "Alguém"`, corpo, horário, e um selo "Nota interna · só o time vê". Botão excluir (chama onDelete) só se fornecido. Usar tokens do design system (não hardcode de cor fora da paleta); ícone via `@/lib/ui/icons` (ex.: `NotePencil`/`Note`).
- [ ] **Step 5: Integrar no `ChatThread.tsx`** — exportar `mergeThreadItems` (puro) e o tipo `ThreadItem`. Buscar `notes = useConversationNotes(conversationId)`. Trocar o `flatMap` de mensagens por `mergeThreadItems(messages, notes)` ANTES do agrupamento por dia (o agrupamento usa o timestamp do item — usar `sent_at` p/ message, `created_at` p/ note). No `.map`, renderizar `item.kind === "note" ? <NoteCard .../> : <MessageBubble message={item.data} />`. O `dayLabel` deve usar o timestamp correto de cada item.
- [ ] **Step 6: typecheck + testes + lint + commit**
```bash
npm run typecheck && npx vitest run tests/unit/thread-merge.test.ts && npx vitest run && npm run lint
git add hooks/inbox/useConversationNotes.ts hooks/inbox/useCreateNote.ts components/inbox/NoteCard.tsx components/inbox/ChatThread.tsx tests/unit/thread-merge.test.ts
git commit -m "feat(notes): notas inline no thread (merge por tempo + NoteCard) com realtime"
```

---

### Task 4: Modo "Nota interna" no composer

**Files:**
- Modify: `components/inbox/Composer.tsx`
- Test: `tests/unit/composer-note-mode.test.tsx`

**Interfaces:**
- Consumes: `useCreateNote` (Task 3).
- Produces: toggle `mode: "reply" | "note"` no composer; em modo nota o submit cria nota (não envia), anexo/áudio/rascunho ficam ocultos, placeholder muda.

- [ ] **Step 1: Teste (falhando)** — extrair a decisão do submit numa forma testável OU testar via render: em modo "note", digitar + enviar chama `useCreateNote` (mock) e NÃO `useSendMessage`; anexo/rascunho/áudio somem; placeholder contém "nota interna". (Mockar os hooks; QueryClientProvider + polyfill como nos outros testes de componente.)
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** — `const [mode, setMode] = useState<"reply"|"note">("reply")`. Um segmented control (2 botões "Responder" / "Nota interna") acima do textarea. No `handleSubmit`: se `mode === "note"`, `createNote.mutate({ conversation_id: conversationId, body }, { onSuccess: () => { setText(""); requestAnimationFrame(autoresize); } })` e `return` antes do fluxo de send. Condicionar `AttachMenu`/`DraftReplyButton`/`AudioRecorder` a `mode === "reply"` (em modo nota, o botão de enviar aparece sempre, mesmo com áudio-recorder oculto). `placeholder = mode === "note" ? "Escreva uma nota interna… (só o time vê)" : <atual>`. Visual do modo nota: uma dica sutil (ex.: borda/fundo âmbar no container) pra deixar claro que não vai ao cliente. Enter continua enviando (nota).
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: typecheck + testes + lint + commit**
```bash
npm run typecheck && npx vitest run tests/unit/composer-note-mode.test.tsx && npx vitest run && npm run lint
git add components/inbox/Composer.tsx tests/unit/composer-note-mode.test.tsx
git commit -m "feat(notes): modo 'Nota interna' no composer (toggle, submit bifurcado)"
```

---

### Task 5: Prova E2E real + HANDOFF

**Files:**
- Modify: `HANDOFF-inbox-multimodal.md`
- Evidência: `inbox-multimodal-onda52-*.png`

- [ ] **Step 1: Ambiente** — dev server + login como agente; conversa REAL (bcb64692).
- [ ] **Step 2:** no composer, alternar pra "Nota interna" → digitar "Cliente pediu desconto — validar com gerente antes" → enviar. Confirmar: aparece INLINE no thread com destaque + nome do autor + selo "só o time vê"; e por SQL que foi pra `conversation_notes` (NÃO pra `messages`, NÃO tem external_id, NADA no WAHA). Screenshot.
- [ ] **Step 3: realtime** — confirmar que a nota apareceu sem reload (ou recarregar e ver persistida na posição temporal certa, intercalada com as mensagens).
- [ ] **Step 4: isolamento/segurança** — a nota tem `organization_id` da org; confirmar (SQL) que não vaza cross-org (RLS). Deletar a nota pelo autor → some do thread.
- [ ] **Step 5:** garantir que o modo "Responder" continua enviando ao WhatsApp normalmente (não quebrou o envio) — enviar uma mensagem real e ver ack.
- [ ] **Step 6:** `typecheck`+`lint`+`vitest` verdes; atualizar HANDOFF (Onda 5.2 → status + provas) e commitar.

---

## Self-review (na escrita)

- **Cobertura do spec:** anotação na conversa (T2/T4) visível só ao time (RLS T1 + nunca toca messages/WAHA, provado em T5) + inline no thread com autor (T3). ✅
- **Sem placeholders:** SQL, hooks, merge e toggle concretos; os "confirmar" (helpers de RLS; nº de migration; nome de ícone) mandam LER o real. `mergeThreadItems` tem teste puro pinado.
- **Riscos nomeados:** merge no cliente (não toca rota de messages); nota imutável (sem edição); delete autor-ou-manager (sem disputa); realtime por canal próprio (não acopla queries); nota nunca ao cliente (tabela separada + prova SQL de ausência em messages). DELETE/UPDATE com 404 honesto (lição 0060).
- **Tipos consistentes:** `Note` (T2) consumido por `useConversationNotes` (T3) e `NoteCard` (T3); `ThreadItem` union (T3) no ChatThread; `createNoteSchema` (T2) no POST e no `useCreateNote` (T3/T4).
