# Onda 5 — Templates de Script do Vendedor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O vendedor cria e salva templates de script (pessoais ou compartilhados na org), e os usa na conversa digitando `/` — o corpo é inserido no cursor com as variáveis (`{{primeiro_nome}}` etc.) já preenchidas do contato.

**Architecture:** Tabela `message_templates` (RLS por org; `owner_user_id` preenchido = pessoal do vendedor, `null` = compartilhado da org). CRUD REST `/api/v1/message-templates` (padrão `webhook-sources`: requireRole, Zod, ok/fail, audit, RLS). No composer, digitar `/` abre um menu de busca; escolher insere o corpo interpolado no cursor (padrão de inserção do `EmojiButton` da Onda 2). CRUD completo numa página de settings.

**Tech Stack:** Next.js Route Handlers, Supabase (Postgres + RLS), React 19 + Tailwind + shadcn, React Query, Vitest + @testing-library.

## Global Constraints

- Spec mestre (Onda 5): `docs/superpowers/specs/2026-07-21-inbox-multimodal-design.md`. Handoff `HANDOFF-inbox-multimodal.md` (protocolo de prova visível — teste real em conta/conversa REAL, não sintética; "funcionou BEM" é o critério).
- **ESCOPO desta onda = SÓ templates.** Notas internas de conversa, snooze/lembrete de lead e rascunho da IA no composer ficam como sub-ondas seguintes (5.1/5.2/5.3) — greenfield, cada uma seu plano. Não implementar nesta onda.
- Template pessoal = `owner_user_id = user.id`; compartilhado = `owner_user_id = null` (só manager+ cria/edita compartilhado). RLS: todo membro da org LÊ (compartilhados + os próprios); ESCREVE o próprio (agent+) ou compartilhado (manager+).
- Migration: arquivo versionado + apêndice idempotente no `baseline.sql` (bloco rotulado) + linha no MANIFEST + `database.types.ts`. Próximo nº: **0060** (o pre-commit hook pode forçar renumeração — seguir o que ele aceitar em TODOS os artefatos).
- Auth: `requireRole` de `lib/auth/require-role.ts` (`getUser`, nunca `getSession`); `created_by_user_id: user.id`. Audit fire-and-forget em toda mutação. Zod em todo input externo.
- Variáveis suportadas: `{{nome}}`, `{{primeiro_nome}}` (do contato da conversa). Variável desconhecida → mantém o literal `{{x}}` (não quebra).
- Ícones só via `@/lib/ui/icons`; inserção no cursor reusa o padrão do `EmojiButton` (selectionStart/End + setText + requestAnimationFrame). Sem `console.log`; typecheck/lint/testes verdes por task (sem pipe-tail).
- Prova: criar template na UI de settings, usar `/` numa conversa REAL, inserir com variáveis preenchidas, enviar pro WhatsApp real (external_id + ack).

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/..._0060_...` + baseline + MANIFEST + types | tabela `message_templates` + RLS |
| `lib/schemas/templates.ts` (novo) | Zod create/update |
| `app/api/v1/message-templates/route.ts` (novo) | GET (lista) + POST (cria) |
| `app/api/v1/message-templates/[id]/route.ts` (novo) | PATCH + DELETE |
| `lib/inbox/template-vars.ts` (novo) | `interpolateTemplate(body, contact)` puro |
| `hooks/inbox/useMessageTemplates.ts` (novo) | React Query list + mutations |
| `components/inbox/composer/TemplateMenu.tsx` (novo) | slash-menu de busca no composer |
| `components/inbox/Composer.tsx` (mod) | detecta `/`, insere corpo no cursor |
| `app/app/templates/page.tsx` + `_components/*` (novo) | CRUD de settings |

---

### Task 1: Migration 0060 — tabela `message_templates`

**Files:**
- Create: `supabase/migrations/20260722140000_0060_message_templates.sql`
- Modify: `supabase/baseline.sql` (apêndice), `supabase/migrations/MANIFEST.md`, `lib/database.types.ts`

**Interfaces:**
- Produces: tabela `message_templates` (`id uuid pk`, `organization_id uuid not null`, `owner_user_id uuid null`, `title text not null`, `body text not null`, `shortcut text null`, `created_by_user_id uuid null`, `created_at`, `updated_at`) + RLS.

- [ ] **Step 1: Criar a migration**

```sql
-- 0060: templates de script do vendedor (Onda 5). owner_user_id preenchido =
-- pessoal do vendedor; null = compartilhado da org. RLS: todo membro LÊ
-- (compartilhados + próprios); escreve o próprio (agent+) ou compartilhado (manager+).
create table if not exists message_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  body text not null,
  shortcut text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_message_templates_org on message_templates (organization_id);

alter table message_templates enable row level security;

-- Helpers canônicos do repo (confirmados no baseline): fn_user_org_ids() SETOF uuid,
-- fn_role_at_least(org uuid, min text) boolean, fn_is_platform_admin() boolean.
drop policy if exists "message_templates_select" on message_templates;
create policy "message_templates_select" on message_templates
  for select using (
    (
      organization_id in (select fn_user_org_ids())
      and (owner_user_id is null or owner_user_id = auth.uid())
    )
    or fn_is_platform_admin()
  );

drop policy if exists "message_templates_write" on message_templates;
create policy "message_templates_write" on message_templates
  for all using (
    organization_id in (select fn_user_org_ids())
    and (
      (owner_user_id = auth.uid() and fn_role_at_least(organization_id, 'agent'))
      or (owner_user_id is null and fn_role_at_least(organization_id, 'manager'))
    )
  )
  with check (
    organization_id in (select fn_user_org_ids())
    and (
      (owner_user_id = auth.uid() and fn_role_at_least(organization_id, 'agent'))
      or (owner_user_id is null and fn_role_at_least(organization_id, 'manager'))
    )
  );
```

> **Nomes confirmados no baseline** (`supabase/baseline.sql`): `fn_user_org_ids()` (linha 780), `fn_role_at_least(org, min)` (656), `fn_is_platform_admin()`. NÃO use subquery de `organization_members` (não existe como tabela pública) — use `fn_user_org_ids()` como as policies vizinhas.

- [ ] **Step 2: Apêndice idempotente no `supabase/baseline.sql`** — o MESMO SQL da migration (create table if not exists + enable RLS + drop/create policies), num bloco rotulado ao fim:

```sql
-- ---- templates de script do vendedor (migration 0060) ----
<< repetir exatamente o SQL do Step 1 >>
```

- [ ] **Step 3: Linha no MANIFEST**

```markdown
| 0060 | 20260722140000_0060_message_templates | Tabela `message_templates` (templates de script do vendedor, pessoal/compartilhado, RLS) — Onda 5. |
```

- [ ] **Step 4: Aplicar e provar** — via `supabase db query --linked`. Prova:

```sql
select tablename from pg_tables where tablename='message_templates';
select policyname from pg_policies where tablename='message_templates' order by policyname;
```

Expected: 1 tabela, 2 policies (select + write). Teste rápido de isolamento: inserir um template pessoal de um user e confirmar que outro user da org não o lê (via SQL com `set local role`/`request.jwt.claims` se disponível, ou anotar como coberto pelo teste de RLS do CI).

- [ ] **Step 5: Refletir em `lib/database.types.ts`** — adicionar a tabela `message_templates` (Row/Insert/Update) seguindo o shape das colunas (nullable onde aplicável). Se `supabase gen types --linked` estiver disponível e limpo, regenerar; senão editar à mão no lugar alfabético.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add supabase/migrations/20260722140000_0060_message_templates.sql supabase/baseline.sql supabase/migrations/MANIFEST.md lib/database.types.ts
git commit -m "feat(templates): migration 0060 — tabela message_templates (pessoal/compartilhado, RLS)"
```

---

### Task 2: Interpolação de variáveis (`template-vars.ts`)

**Files:**
- Create: `lib/inbox/template-vars.ts`
- Test: `tests/unit/template-vars.test.ts`

**Interfaces:**
- Produces: `interpolateTemplate(body: string, contact: { name?: string | null }): string`. Substitui `{{nome}}` pelo nome completo e `{{primeiro_nome}}` pela primeira palavra do nome; variável sem valor ou desconhecida → mantém o literal `{{x}}`. Case-insensitive nas chaves conhecidas; tolera espaços (`{{ primeiro_nome }}`).

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/template-vars.test.ts
import { describe, expect, it } from "vitest";

import { interpolateTemplate } from "@/lib/inbox/template-vars";

describe("interpolateTemplate", () => {
  it("substitui nome e primeiro_nome", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}, tudo bem?", { name: "Rafael Melgaço" })).toBe(
      "Oi Rafael, tudo bem?",
    );
    expect(interpolateTemplate("Falo com {{nome}}?", { name: "Rafael Melgaço" })).toBe(
      "Falo com Rafael Melgaço?",
    );
  });
  it("tolera espaços e case nas chaves", () => {
    expect(interpolateTemplate("Oi {{ Primeiro_Nome }}!", { name: "Ana Paula" })).toBe("Oi Ana!");
  });
  it("sem nome → mantém o literal (não quebra)", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}", { name: null })).toBe("Oi {{primeiro_nome}}");
  });
  it("variável desconhecida → mantém o literal", () => {
    expect(interpolateTemplate("Cupom {{codigo}}", { name: "X" })).toBe("Cupom {{codigo}}");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run tests/unit/template-vars.test.ts` → FAIL.

- [ ] **Step 3: Implementar**

```ts
// lib/inbox/template-vars.ts
/**
 * Interpola variáveis de template com dados do contato da conversa (Onda 5).
 * Suporta {{nome}} e {{primeiro_nome}}. Variável sem valor ou desconhecida
 * mantém o literal `{{x}}` — nunca gera texto quebrado que iria pro cliente.
 */
export interface TemplateContact {
  name?: string | null;
}

export function interpolateTemplate(body: string, contact: TemplateContact): string {
  const full = (contact.name ?? "").trim();
  const first = full.split(/\s+/)[0] ?? "";
  return body.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (literal, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (key === "nome") return full !== "" ? full : literal;
    if (key === "primeiro_nome") return first !== "" ? first : literal;
    return literal; // desconhecida: mantém
  });
}
```

- [ ] **Step 4: Rodar e ver passar** — PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/inbox/template-vars.ts tests/unit/template-vars.test.ts
git commit -m "feat(templates): interpolateTemplate — {{nome}}/{{primeiro_nome}} com fallback literal"
```

---

### Task 3: Schema Zod + CRUD API

**Files:**
- Create: `lib/schemas/templates.ts`, `app/api/v1/message-templates/route.ts`, `app/api/v1/message-templates/[id]/route.ts`
- Test: `tests/unit/templates-schema.test.ts`

**Interfaces:**
- Consumes: `requireRole` (`lib/auth/require-role.ts`), `ok`/`fail` (`lib/api/wrappers.ts`), `audit` (`lib/audit`), `createClient` de sessão.
- Produces:
  - `createTemplateSchema` = `{ title: string(1..80), body: string(1..4096), shortcut?: string(1..40), shared?: boolean }` (shared=true → owner_user_id null; default false = pessoal).
  - `updateTemplateSchema` = `createTemplateSchema.partial()` (sem `shared`).
  - GET `/api/v1/message-templates` → `{ data: Template[] }` (a RLS já filtra visíveis). POST cria. PATCH/DELETE por id.

- [ ] **Step 1: Teste do schema (falhando)**

```ts
// tests/unit/templates-schema.test.ts
import { describe, expect, it } from "vitest";

import { createTemplateSchema } from "@/lib/schemas/templates";

describe("createTemplateSchema", () => {
  it("aceita template válido pessoal", () => {
    const r = createTemplateSchema.safeParse({ title: "Saudação", body: "Oi {{primeiro_nome}}!" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.shared).toBe(false);
  });
  it("aceita shared + shortcut", () => {
    const r = createTemplateSchema.safeParse({ title: "Fechamento", body: "Fechado!", shortcut: "fech", shared: true });
    expect(r.success).toBe(true);
  });
  it("rejeita title vazio e body vazio", () => {
    expect(createTemplateSchema.safeParse({ title: "", body: "x" }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ title: "x", body: "" }).success).toBe(false);
  });
  it("rejeita body gigante (>4096)", () => {
    expect(createTemplateSchema.safeParse({ title: "x", body: "a".repeat(5000) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar o schema**

```ts
// lib/schemas/templates.ts
import { z } from "zod";

export const createTemplateSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4096),
  shortcut: z.string().trim().min(1).max(40).optional(),
  /** true = compartilhado da org (owner null, exige manager+); false = pessoal. */
  shared: z.boolean().default(false),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(4096),
    shortcut: z.string().trim().min(1).max(40).nullable(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "Informe ao menos um campo." });
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
```

- [ ] **Step 4: Implementar `route.ts` (GET+POST)** — copiar a forma de `app/api/v1/webhook-sources/route.ts`:

```ts
// app/api/v1/message-templates/route.ts
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createTemplateSchema } from "@/lib/schemas/templates";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const COLS = "id, organization_id, owner_user_id, title, body, shortcut, created_by_user_id, created_at, updated_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const supabase = await createClient();
  // RLS já limita a compartilhados + próprios da org ativa.
  const { data, error } = await supabase
    .from("message_templates")
    .select(COLS)
    .eq("organization_id", authz.org.orgId)
    .order("updated_at", { ascending: false });
  if (error) return fail("internal_error", "Erro ao listar templates.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const raw = await req.json().catch(() => null);
  const parsed = createTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { title, body, shortcut, shared } = parsed.data;
  // Compartilhado exige manager+; a RLS with_check também barra, mas damos erro claro antes.
  if (shared && !(await isManagerPlus(org.orgId, user.id))) {
    return fail("forbidden", "Só manager+ cria template compartilhado.", 403, { requestId });
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("message_templates")
    .insert({
      organization_id: org.orgId,
      owner_user_id: shared ? null : user.id,
      title,
      body,
      shortcut: shortcut ?? null,
      created_by_user_id: user.id,
    })
    .select(COLS)
    .single();
  if (error || !data) return fail("internal_error", "Erro ao criar template.", 500, { requestId });

  void audit({
    action: "template.created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "message_template",
    resourceId: data.id,
    requestId,
    metadata: { shared, title },
  });
  return ok(data, { requestId });
}

// helper mínimo de role — reusa a resolução do requireRole se ele expõe o rank;
// senão, uma checagem simples via RPC fn_role_at_least (padrão do repo).
async function isManagerPlus(orgId: string, userId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("fn_role_at_least", { p_org: orgId, p_min: "manager" } as never);
  return data === true;
}
```

> **Nota:** confira a assinatura real de `fn_role_at_least` (nomes de parâmetros) no baseline e ajuste o `.rpc(...)`. Se `requireRole("manager", ...)` for mais simples que um helper próprio, faça uma segunda chamada `requireRole` só na branch `shared` — o que for mais limpo no padrão do repo. NÃO invente a assinatura da RPC.

- [ ] **Step 5: Implementar `[id]/route.ts` (PATCH+DELETE)** — mesma forma, `requireRole("agent")`, valida `updateTemplateSchema`, `update(...).eq("id", id).eq("organization_id", org.orgId)` (a RLS de write barra o que não é do user/manager), audit `template.updated`/`template.deleted`. DELETE: `.delete().eq("id", id).eq("organization_id", org.orgId)`.

- [ ] **Step 6: Rodar tudo + commit**

```bash
npm run typecheck
npx vitest run tests/unit/templates-schema.test.ts
git add lib/schemas/templates.ts app/api/v1/message-templates/ tests/unit/templates-schema.test.ts
git commit -m "feat(templates): CRUD /api/v1/message-templates (Zod, RLS, audit, owner/shared)"
```

---

### Task 4: Slash-menu no composer

**Files:**
- Create: `components/inbox/composer/TemplateMenu.tsx`, `hooks/inbox/useMessageTemplates.ts`
- Modify: `components/inbox/Composer.tsx`
- Test: `tests/unit/composer-template-menu.test.tsx`

**Interfaces:**
- Consumes: `interpolateTemplate` (Task 2), GET da Task 3.
- Produces: `useMessageTemplates()` (React Query list); `<TemplateMenu open query onPick(template) onClose />` (lista filtrada por título/shortcut); no `Composer`, digitar `/` no INÍCIO do texto abre o menu, filtra pelo que vem após `/`, e escolher insere `interpolateTemplate(body, contact)` no lugar do `/query` (padrão de inserção do EmojiButton).

- [ ] **Step 1: Teste (falhando)** — cobre a lógica de detecção do `/` + inserção. Extrair um helper puro `resolveSlash(text): { open: boolean; query: string }` (o texto começa com `/` e não tem espaço → open, query = resto) para testar sem o DOM completo, e testar o TemplateMenu render/filter com dados mockados.

```tsx
// tests/unit/composer-template-menu.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { resolveSlash } from "@/components/inbox/composer/TemplateMenu";
import { TemplateMenu } from "@/components/inbox/composer/TemplateMenu";

describe("resolveSlash", () => {
  it("abre com / no início e captura o query", () => {
    expect(resolveSlash("/fech")).toEqual({ open: true, query: "fech" });
    expect(resolveSlash("/")).toEqual({ open: true, query: "" });
  });
  it("não abre se tem espaço ou não começa com /", () => {
    expect(resolveSlash("/fech agora").open).toBe(false);
    expect(resolveSlash("oi")).toEqual({ open: false, query: "" });
  });
});

describe("TemplateMenu", () => {
  const templates = [
    { id: "1", title: "Saudação", body: "Oi {{primeiro_nome}}", shortcut: "oi" },
    { id: "2", title: "Fechamento", body: "Fechado!", shortcut: "fech" },
  ];
  it("filtra por título/shortcut e devolve o escolhido", () => {
    const onPick = vi.fn();
    render(<TemplateMenu open query="fech" templates={templates as never} onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Fechamento"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar `useMessageTemplates`**

```ts
// hooks/inbox/useMessageTemplates.ts
"use client";
import { useQuery } from "@tanstack/react-query";

export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  owner_user_id: string | null;
}

export function useMessageTemplates() {
  return useQuery({
    queryKey: ["message-templates"],
    queryFn: async (): Promise<MessageTemplate[]> => {
      const res = await fetch("/api/v1/message-templates");
      const j = (await res.json()) as { data?: MessageTemplate[] };
      return j.data ?? [];
    },
    staleTime: 60_000,
  });
}
```

- [ ] **Step 4: Implementar `TemplateMenu` (+ `resolveSlash`)**

```tsx
// components/inbox/composer/TemplateMenu.tsx
"use client";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

/** Estado do slash-menu a partir do texto do composer. Puro (testável). */
export function resolveSlash(text: string): { open: boolean; query: string } {
  if (!text.startsWith("/")) return { open: false, query: "" };
  const rest = text.slice(1);
  if (/\s/.test(rest)) return { open: false, query: "" };
  return { open: true, query: rest };
}

interface Props {
  open: boolean;
  query: string;
  templates: MessageTemplate[];
  onPick: (t: MessageTemplate) => void;
  onClose: () => void;
}

export function TemplateMenu({ open, query, templates, onPick, onClose }: Props) {
  if (!open) return null;
  const q = query.toLowerCase();
  const filtered = templates.filter(
    (t) => t.title.toLowerCase().includes(q) || (t.shortcut ?? "").toLowerCase().includes(q),
  );
  return (
    <div
      className="absolute bottom-14 left-3 z-20 max-h-64 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
      role="listbox"
      aria-label="Templates de script"
    >
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">Nenhum template. Crie em Configurações.</div>
      ) : (
        filtered.map((t) => (
          <button
            key={t.id}
            type="button"
            className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left hover:bg-muted"
            onClick={() => onPick(t)}
          >
            <span className="text-sm font-medium">{t.title}</span>
            <span className="line-clamp-1 text-xs text-muted-foreground">{t.body}</span>
          </button>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 5: Integrar no `Composer.tsx`** — o composer já recebe `conversationId`; precisa também do contato (nome) para interpolar. Passar o nome do contato via prop nova `contactName?: string | null` (o `InboxLayout`/`ConversationHeader` já tem o contato — encadear a prop). Lógica:
  - `const templates = useMessageTemplates();`
  - `const slash = resolveSlash(text);`
  - Render `<TemplateMenu open={slash.open} query={slash.query} templates={templates.data ?? []} onPick={applyTemplate} onClose={...} />` dentro do container `relative` do composer.
  - `applyTemplate(t)`: `const filled = interpolateTemplate(t.body, { name: contactName ?? null }); setText(filled);` (substitui o `/query` inteiro pelo corpo interpolado; foca o textarea e move o cursor ao fim via requestAnimationFrame — padrão do EmojiButton).
  - Enter fecha o menu se aberto sem selecionar? Manter simples: Escape fecha (`setText("")` ou só esconde via um state `menuDismissed`). Mínimo: clicar num item aplica; clicar fora/digitar espaço fecha (o `resolveSlash` já fecha com espaço).

- [ ] **Step 6: Rodar tudo + commit**

```bash
npm run typecheck
npx vitest run tests/unit/composer-template-menu.test.tsx
npx vitest run
git add components/inbox/composer/TemplateMenu.tsx hooks/inbox/useMessageTemplates.ts components/inbox/Composer.tsx tests/unit/composer-template-menu.test.tsx
git commit -m "feat(templates): slash-menu no composer — / abre busca e insere corpo interpolado"
```

---

### Task 5: Página de settings (CRUD)

**Files:**
- Create: `app/app/templates/page.tsx`, `app/app/templates/_components/TemplatesClient.tsx`, `.../TemplateFormDialog.tsx`
- Modify: sidebar de navegação (adicionar link "Templates") — localizar o componente de nav (`components/**/Sidebar*` ou o nav do `InboxLayout`/dashboard) e seguir o padrão dos links existentes.
- Test: `tests/unit/templates-client.test.tsx` (render da lista + abrir form; mutations mockadas)

**Interfaces:**
- Consumes: `useMessageTemplates` (Task 4) + mutations novas (create/update/delete via fetch).
- Produces: página autenticada listando templates (pessoais + compartilhados, com badge), botão "Novo template", dialog de criar/editar (title, body com dica de variáveis, shortcut, toggle compartilhado só p/ manager+), excluir com confirmação.

- [ ] **Step 1: Teste do client (falhando)** — render da lista com templates mockados; clicar "Novo template" abre o dialog; salvar chama a mutation. (Mockar o hook + as mutations.)

```tsx
// tests/unit/templates-client.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({
    data: [{ id: "1", title: "Saudação", body: "Oi {{primeiro_nome}}", shortcut: "oi", owner_user_id: "u1" }],
    isLoading: false,
  }),
}));

import { TemplatesClient } from "@/app/app/templates/_components/TemplatesClient";

function wrap(ui: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

describe("TemplatesClient", () => {
  it("lista templates e abre o form de novo", () => {
    render(wrap(<TemplatesClient canShare={true} />));
    expect(screen.getByText("Saudação")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /novo template/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar `TemplatesClient` + `TemplateFormDialog`** — client component: lista (título, prévia do corpo, badge "Pessoal"/"Compartilhado", ações editar/excluir), `<TemplateFormDialog>` (form com title, body — textarea com hint "Use {{primeiro_nome}} e {{nome}}" —, shortcut, checkbox "Compartilhar com a equipe" só se `canShare`). Mutations via `fetch` + `queryClient.invalidateQueries(["message-templates"])`. Erros via `showApiError`.

- [ ] **Step 4: Implementar `page.tsx`** — Server Component: resolve auth/org (padrão de outras páginas em `app/app/*/page.tsx`), calcula `canShare` (manager+), renderiza `<TemplatesClient canShare={canShare} />`. Adicionar o link "Templates" na navegação lateral seguindo o padrão dos itens existentes (ícone via wrapper).

- [ ] **Step 5: Rodar tudo + commit**

```bash
npm run typecheck
npx vitest run tests/unit/templates-client.test.tsx
npm run lint
git add app/app/templates/ components/ tests/unit/templates-client.test.tsx
git commit -m "feat(templates): página de settings — CRUD de templates (pessoal/compartilhado)"
```

---

### Task 6: Prova E2E real + HANDOFF

**Files:**
- Modify: `HANDOFF-inbox-multimodal.md`
- Evidência: `.superpowers/evidence/inbox-multimodal-onda5-*.png`

- [ ] **Step 1: Ambiente** — dev server + WAHA + sessão WORKING; login admin E2E.

- [ ] **Step 2: Criar template na UI** — em `/app/templates`, criar um template pessoal (ex.: título "Saudação", corpo "Oi {{primeiro_nome}}! Aqui é da Deskcomm 👋", shortcut "oi") e um compartilhado. Screenshot da lista.

- [ ] **Step 3: Usar `/` na conversa REAL** — abrir a conversa REAL (contato com nome, ex.: "Rafael Melgaço", na sessão conectada), digitar `/` no composer → menu abre → escolher "Saudação" → confirmar que o corpo entra no textarea com `{{primeiro_nome}}` já substituído por "Rafael". Screenshot do menu aberto + do texto inserido.

- [ ] **Step 4: Enviar e provar no WhatsApp real** — enviar a mensagem inserida; confirmar por SQL que a outbound tem `external_id` do WAHA e `ack>=2` (entregue), e o corpo é o interpolado (sem `{{}}` residual). Screenshot da bolha enviada.

- [ ] **Step 5: Isolamento** — confirmar (SQL ou 2º usuário) que um template PESSOAL de um vendedor não aparece para outro; o compartilhado aparece para todos.

- [ ] **Step 6: Suíte + HANDOFF + commit** — `npm run typecheck` + `npm run lint` + `npx vitest run` verdes. Atualizar `HANDOFF-inbox-multimodal.md` (Onda 5 → status + provas; notas/snooze/rascunho IA como sub-ondas pendentes) e commitar.

---

## Self-review (feito na escrita)

- **Cobertura do spec (Onda 5 — templates):** tabela por vendedor pessoal/compartilhado com RLS (T1), variáveis (T2), CRUD com owner/role (T3), acesso via `/` na conversa com inserção no cursor (T4), CRUD de settings (T5), prova real com envio ao WhatsApp + isolamento (T6). Notas internas / snooze / rascunho da IA explicitamente FORA desta onda (sub-ondas 5.1-5.3) — decisão de escopo registrada nas Global Constraints.
- **Sem placeholders:** código/comandos/expected concretos. As duas notas (nome real da tabela de membros/helper de role; assinatura de `fn_role_at_least`) mandam CONFERIR o padrão vizinho de `webhook-sources`, não deixam lógica em aberto.
- **Consistência de tipos:** `MessageTemplate` (T4) espelha as colunas (T1); `interpolateTemplate` (T2) consumido em T4; `createTemplateSchema` (T3) usado no POST; `resolveSlash`/`TemplateMenu` (T4) consumidos no Composer.
