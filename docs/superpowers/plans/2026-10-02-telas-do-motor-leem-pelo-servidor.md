# Telas do motor do agente leem pelo servidor — Plano de implementação

> **Para agentes que forem executar:** SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** as telas que leem tabelas do motor do agente (Execuções de IA, Uso de IA, aba Execuções do agente, Jev, fila de follow-ups, aviso de retenção, próxima ação, reativação, quadro do funil, resumo do contato, propostas, agendamento) passam a funcionar em instalação por VPS.

**Arquitetura:** na instalação por VPS (só o `supabase/baseline.sql`), as tabelas do motor são **server-only**: o papel `authenticated` não tem privilégio nenhum nelas e não há policy de leitura (medido em produção, 2026-10-02). Rotas que as leem com o client de **sessão** (`createClient()`) recebem sempre vazio. A correção troca **só o receptor** dessas consultas para o client de **serviço** (`createAdminClient()`), mantendo o filtro por `organization_id` que todas já têm — o padrão que o próprio repo usa nas outras 34 leituras dessas tabelas. Um teste-catraca impede regressão e cobra o filtro de organização.

**Stack:** TypeScript, Next.js (route handlers), Supabase JS, Vitest.

## Por que (medido em produção, 2026-10-02)

- `llm_calls` tinha 548 linhas da Escale IA nos últimos 7 dias; a tela Execuções de IA mostrava "0 execuções".
- Em produção, 10 tabelas do motor têm RLS ligada, **nenhuma policy de SELECT** e **nenhum privilégio** para `authenticated`: `llm_calls`, `agent_inbox_items`, `job_queue`, `lead_checkpoints`, `lead_notes`, `lead_state`, `before_send_traces`, `channel_knobs`, `cron_jobs`, `flywheel_distiller_proposals`.
- Varredura de `app/api` (v1.69.0): 51 leituras dessas tabelas; **17 em 12 arquivos** usam o client de sessão; as outras 34 já usam o de serviço e filtram `organization_id`.

## Restrições globais

- Branch a partir de `escale/main` (a linha do fork `rgisjr`, = v1.69.0 + correção do id do negócio). Nunca `reset --hard` nem force.
- **Nenhum commit, push ou tag sem OK explícito do usuário.** Push, tag e release são feitos PELO USUÁRIO (o classificador bloqueia publicação pelo agente).
- **Não mexer no banco** (nada de policy, grant ou migration). A correção é só de código.
- Trocar **apenas o receptor** das consultas às 10 tabelas server-only. As demais consultas de cada rota continuam no client de sessão (é ele que aplica a RLS das tabelas normais).
- Toda leitura/atualização com o client de serviço mantém `.eq("organization_id", …)` vindo de fonte confiável (org ativa do `requireRole`, ou linha já lida sob RLS). Nunca do body.
- Receptor aceito pela catraca: a variável `admin` ou a chamada `createAdminClient()` imediatamente antes de `.from(…)`.
- Comentários em português, explicando o PORQUÊ. Sem `console.log`. Imports com `@/`.
- Destino (DoD 18): **núcleo**.

## Arquivos

| Arquivo | Ação | O que muda |
|---|---|---|
| `tests/unit/tabelas-do-motor-nao-se-leem-pelo-login.test.ts` | Criar | Catraca estática: nenhuma rota lê as 10 tabelas pelo login; leitura pelo serviço filtra organização |
| `tests/unit/execucoes-de-ia-leem-pelo-servidor.test.ts` | Criar | Prova de comportamento da tela Execuções de IA |
| `app/api/v1/ai/runs/route.ts` | Alterar | `llm_calls` pelo serviço |
| `app/api/v1/ai/agents/[id]/runs/route.ts` | Alterar | `llm_calls` pelo serviço |
| `app/api/v1/ai/usage/route.ts` | Alterar | `llm_calls` pelo serviço |
| `app/api/v1/ai/jev/route.ts` | Alterar | `llm_calls` (GET) pelo serviço |
| `app/api/v1/leads/[id]/next-action/route.ts` | Alterar | `lead_state` (leitura e update) pelo serviço |
| `app/api/v1/leads/[id]/reactivation/route.ts` | Alterar | `cron_jobs` (leitura e insert) pelo serviço |
| `app/api/v1/pipelines/[id]/board/route.ts` | Alterar | `withNextActions`/`avisaAmbiguas` recebem o client de serviço |
| `app/api/v1/leads/proposals/route.ts` | Alterar | `lead_state` pelo serviço |
| `app/api/v1/contacts/[id]/crm-summary/route.ts` | Alterar | `lead_notes` pelo serviço |
| `app/api/v1/ai/followups/queue/route.ts` | Alterar | `cron_jobs` pelo serviço |
| `app/api/v1/conversations/[id]/retention/route.ts` | Alterar | `before_send_traces` e `channel_knobs` pelo serviço |
| `app/api/v1/agenda/agendamentos/[id]/route.ts` | Alterar | `job_queue` pelo serviço |
| `.changes/telas-do-motor-leem-pelo-servidor.md` | Criar | Fragmento de release |

---

### Tarefa 1: A catraca (teste que lista o defeito)

**Arquivos:**
- Criar: `tests/unit/tabelas-do-motor-nao-se-leem-pelo-login.test.ts`

**Interfaces:**
- Produz: o teste que as Tarefas 2–4 deixam verde.

- [ ] **Passo 0: Branch**

```bash
cd repo
git status --short            # só o docs/superpowers/plans/... pode aparecer como ??
git checkout -b fix/telas-do-motor-leem-pelo-servidor escale/main
```

- [ ] **Passo 1: Escrever o teste**

`tests/unit/tabelas-do-motor-nao-se-leem-pelo-login.test.ts`:

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TABELAS DO MOTOR SÓ SE LEEM PELO SERVIDOR.
 *
 * Na instalação por VPS (só o baseline), estas tabelas são server-only: o papel
 * `authenticated` não tem privilégio nem policy de leitura nelas. Medido em
 * produção em 2026-10-02: `llm_calls` com 548 linhas e a tela Execuções de IA
 * dizendo "0 execuções", porque a rota lia com o client de SESSÃO.
 *
 * Duas regras, para toda rota em `app/api`:
 *  1. o receptor de `.from(<tabela do motor>)` é `admin` ou `createAdminClient()`;
 *  2. em rota de usuário (requireRole/loadAuthUser/requireAuth), leitura,
 *     update ou delete por esse client filtra `organization_id` — o client de
 *     serviço ignora a RLS, então o filtro é a única cerca de tenancy.
 */
const SO_DO_SERVIDOR = [
  "llm_calls",
  "agent_inbox_items",
  "job_queue",
  "lead_checkpoints",
  "lead_notes",
  "lead_state",
  "before_send_traces",
  "channel_knobs",
  "cron_jobs",
  "flywheel_distiller_proposals",
] as const;

const RAIZ = join(__dirname, "../..");
const API = join(RAIZ, "app/api");

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return arquivos(caminho);
    return caminho.endsWith(".ts") && !caminho.includes(".test.") ? [caminho] : [];
  });
}

const CONSULTA = new RegExp(`\\.from\\(["'](${SO_DO_SERVIDOR.join("|")})["']\\)`, "g");
const RECEPTOR_DO_SERVIDOR = /(createAdminClient\(\)|\badmin)\s*$/;
const ROTA_DE_USUARIO = /requireRole\(|loadAuthUser\(|requireAuth\(/;

interface Achado {
  arquivo: string;
  linha: number;
  tabela: string;
}

function varrer(): { pelaSessao: Achado[]; semOrganizacao: Achado[]; total: number } {
  const pelaSessao: Achado[] = [];
  const semOrganizacao: Achado[] = [];
  let total = 0;
  for (const caminho of arquivos(API)) {
    const fonte = readFileSync(caminho, "utf8");
    const deUsuario = ROTA_DE_USUARIO.test(fonte);
    for (const m of fonte.matchAll(CONSULTA)) {
      total++;
      const inicio = m.index ?? 0;
      const achado: Achado = {
        arquivo: relative(RAIZ, caminho).replace(/\\/g, "/"),
        linha: fonte.slice(0, inicio).split("\n").length,
        tabela: m[1]!,
      };
      const antes = fonte.slice(Math.max(0, inicio - 200), inicio);
      if (!RECEPTOR_DO_SERVIDOR.test(antes)) {
        pelaSessao.push(achado);
        continue;
      }
      // A cadeia vai até o `;` ou o próximo `.from(` (Promise.all de várias consultas).
      const fimPontoVirgula = fonte.indexOf(";", inicio);
      const proximoFrom = fonte.indexOf(".from(", inicio + 6);
      const fim = Math.min(
        fimPontoVirgula < 0 ? fonte.length : fimPontoVirgula,
        proximoFrom < 0 ? fonte.length : proximoFrom,
        inicio + 800,
      );
      const cadeia = fonte.slice(inicio, fim);
      const lêOuMuda = /\.(select|update|delete)\(/.test(cadeia);
      if (deUsuario && lêOuMuda && !cadeia.includes("organization_id")) semOrganizacao.push(achado);
    }
  }
  return { pelaSessao, semOrganizacao, total };
}

describe("tabelas do motor só se leem pelo servidor", () => {
  const { pelaSessao, semOrganizacao, total } = varrer();

  it("a varredura encontra as tabelas (guarda de vacuidade)", () => {
    // Medido na v1.69.0: 51 consultas. Se cair a quase zero, o regex quebrou.
    expect(total).toBeGreaterThan(40);
  });

  it("nenhuma rota lê tabela do motor com o client de sessão", () => {
    expect(
      pelaSessao.map((a) => `${a.arquivo}:${a.linha} ${a.tabela}`),
      "na VPS, `authenticated` não tem leitura nessas tabelas — a consulta volta vazia. " +
        "Use `createAdminClient()` (ou a variável `admin`) e mantenha o filtro de organization_id.",
    ).toEqual([]);
  });

  it("toda leitura pelo serviço em rota de usuário filtra organization_id", () => {
    expect(
      semOrganizacao.map((a) => `${a.arquivo}:${a.linha} ${a.tabela}`),
      "o client de serviço ignora a RLS: sem `organization_id`, a rota lê dados de outra empresa",
    ).toEqual([]);
  });
});
```

- [ ] **Passo 2: Rodar e ver falhar**

Rodar: `npx vitest run tests/unit/tabelas-do-motor-nao-se-leem-pelo-login.test.ts`
Esperado: FALHA em "nenhuma rota lê…", listando exatamente estas 17 entradas (linhas da v1.69.0):

```
app/api/v1/agenda/agendamentos/[id]/route.ts:65 job_queue
app/api/v1/ai/agents/[id]/runs/route.ts:176 llm_calls
app/api/v1/ai/followups/queue/route.ts:215 cron_jobs
app/api/v1/ai/jev/route.ts:317 llm_calls
app/api/v1/ai/runs/route.ts:111 llm_calls
app/api/v1/ai/usage/route.ts:96 llm_calls
app/api/v1/contacts/[id]/crm-summary/route.ts:153 lead_notes
app/api/v1/conversations/[id]/retention/route.ts:62 before_send_traces
app/api/v1/conversations/[id]/retention/route.ts:78 channel_knobs
app/api/v1/leads/proposals/route.ts:77 lead_state
app/api/v1/leads/[id]/next-action/route.ts:94 lead_state
app/api/v1/leads/[id]/next-action/route.ts:141 lead_state
app/api/v1/leads/[id]/reactivation/route.ts:126 cron_jobs
app/api/v1/leads/[id]/reactivation/route.ts:136 cron_jobs
app/api/v1/pipelines/[id]/board/route.ts:147 agent_inbox_items
app/api/v1/pipelines/[id]/board/route.ts:172 agent_inbox_items
app/api/v1/pipelines/[id]/board/route.ts:391 lead_state
```

Os outros dois casos passam (a varredura prévia não achou leitura pelo serviço sem filtro de organização).

- [ ] **Passo 3: Commit (só com OK do usuário)**

```bash
git add tests/unit/tabelas-do-motor-nao-se-leem-pelo-login.test.ts
git commit -m "test: catraca — tabelas do motor só se leem pelo servidor"
```

---

### Tarefa 2: As telas de IA (llm_calls)

**Arquivos:**
- Alterar: `app/api/v1/ai/runs/route.ts`, `app/api/v1/ai/agents/[id]/runs/route.ts`, `app/api/v1/ai/usage/route.ts`, `app/api/v1/ai/jev/route.ts`
- Criar: `tests/unit/execucoes-de-ia-leem-pelo-servidor.test.ts`

**Interfaces:**
- Consome: a catraca da Tarefa 1.
- Produz: `GET /api/v1/ai/runs` devolve as linhas lidas pelo client de serviço.

- [ ] **Passo 1: Teste de comportamento que falha**

`tests/unit/execucoes-de-ia-leem-pelo-servidor.test.ts`:

```ts
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";

/**
 * A tela Execuções de IA dizia "0 execuções" com 548 linhas no banco: lia
 * `llm_calls` com o client de SESSÃO, que na VPS não enxerga essa tabela. Aqui o
 * client de sessão devolve vazio (como na VPS) e o de serviço devolve a linha —
 * a rota tem de mostrar a linha, filtrada pela organização ativa.
 */
const { LINHA, filtros } = vi.hoisted(() => ({
  LINHA: {
    id: "call-1",
    purpose: "agent_turn",
    provider: "openai",
    model: "gpt-5.6-terra",
    status: "ok",
    error_code: null,
    error_message: null,
    http_status: null,
    origem_da_escolha: null,
    input_tokens: 10,
    output_tokens: 5,
    cost_cents: 1,
    latency_ms: 100,
    created_at: "2026-10-02T18:43:33Z",
  },
  filtros: [] as Array<[string, unknown]>,
}));

function cadeia(linhas: unknown[]) {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.eq = (coluna: string, valor: unknown) => {
    filtros.push([coluna, valor]);
    return c;
  };
  c.order = () => c;
  c.limit = () => c;
  c.then = (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
    Promise.resolve({ data: linhas, error: null }).then(ok, erro);
  return c;
}

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: () => cadeia([]) })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ from: () => cadeia([LINHA]) })),
}));

const { GET } = await import("@/app/api/v1/ai/runs/route");

beforeEach(() => {
  filtros.length = 0;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { idioma: "pt-BR" } as never,
    org: { orgId: "org-escale", name: "Escale IA", role: "admin" } as never,
  });
});

describe("GET /api/v1/ai/runs", () => {
  it("mostra as execuções lidas pelo servidor, filtradas pela organização ativa", async () => {
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/runs"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { execucoes: Array<{ id: string }> } };
    expect(corpo.data.execucoes.map((e) => e.id)).toEqual(["call-1"]);
    expect(filtros).toContainEqual(["organization_id", "org-escale"]);
  });
});
```

- [ ] **Passo 2: Rodar e ver falhar**

Rodar: `npx vitest run tests/unit/execucoes-de-ia-leem-pelo-servidor.test.ts`
Esperado: FALHA — `expected [] to deeply equal [ 'call-1' ]` (a rota ainda usa o client de sessão).

- [ ] **Passo 3: `app/api/v1/ai/runs/route.ts`**

Trocar o import

```ts
import { createClient } from "@/lib/supabase/server";
```

por

```ts
import { createAdminClient } from "@/lib/supabase/admin";
```

e trocar

```ts
  const db = await createClient();
  let q = db
    .from("llm_calls")
```

por

```ts
  // Pelo SERVIÇO, e não pela sessão: na VPS `authenticated` não tem leitura em
  // `llm_calls` (tabela server-only do baseline), e a tela mostrava "0 execuções"
  // com centenas no banco. O filtro de organização abaixo é a cerca de tenancy.
  const admin = createAdminClient();
  let q = admin
    .from("llm_calls")
```

- [ ] **Passo 4: `app/api/v1/ai/agents/[id]/runs/route.ts`**

Trocar o import `import { createClient } from "@/lib/supabase/server";` por `import { createAdminClient } from "@/lib/supabase/admin";` e trocar

```ts
  const supabase = await createClient();
  let query = supabase
    .from("llm_calls")
```

por

```ts
  // Pelo serviço: `llm_calls` é server-only na VPS (ver app/api/v1/ai/runs/route.ts).
  const admin = createAdminClient();
  let query = admin
    .from("llm_calls")
```

Se `supabase` for usado em outro ponto do arquivo, manter `const supabase = await createClient();` e o import dele, e só acrescentar o `admin`.

- [ ] **Passo 5: `app/api/v1/ai/usage/route.ts`**

Acrescentar `import { createAdminClient } from "@/lib/supabase/admin";` junto dos imports. Logo depois de `const supabase = await createClient();` acrescentar:

```ts
  // `llm_calls` é server-only na VPS: a leitura de uso vai pelo serviço. As
  // demais consultas desta rota continuam na sessão.
  const admin = createAdminClient();
```

e trocar `let invQ = supabase` por `let invQ = admin`.

- [ ] **Passo 6: `app/api/v1/ai/jev/route.ts`**

O arquivo já importa `createAdminClient`. Na função que tem `const db = await createClient();` (~linha 310), logo depois dela acrescentar:

```ts
  // `llm_calls` é server-only na VPS: os números do Jev leem pelo serviço.
  const admin = createAdminClient();
```

e, no laço de páginas (~linha 316), trocar `const { data, error } = await db` (a cadeia que segue com `.from("llm_calls")`) por `const { data, error } = await admin`.

- [ ] **Passo 7: Rodar e ver passar**

Rodar: `npx vitest run tests/unit/execucoes-de-ia-leem-pelo-servidor.test.ts tests/unit/tabelas-do-motor-nao-se-leem-pelo-login.test.ts`
Esperado: o teste de comportamento PASSA; a catraca ainda FALHA, mas sem as 4 linhas de `llm_calls` (sobram 13).

Rodar também: `npx eslint app/api/v1/ai/runs/route.ts "app/api/v1/ai/agents/[id]/runs/route.ts" app/api/v1/ai/usage/route.ts app/api/v1/ai/jev/route.ts`
Esperado: zerado. Se acusar variável/import sem uso (`db`, `supabase`, `createClient`), remover.

- [ ] **Passo 8: Commit (só com OK do usuário)**

```bash
git add app/api/v1/ai/runs/route.ts "app/api/v1/ai/agents/[id]/runs/route.ts" app/api/v1/ai/usage/route.ts app/api/v1/ai/jev/route.ts tests/unit/execucoes-de-ia-leem-pelo-servidor.test.ts
git commit -m "fix(ia): execuções, uso e Jev leem llm_calls pelo servidor"
```

---

### Tarefa 3: Funil e lead (lead_state, cron_jobs, agent_inbox_items, lead_notes)

**Arquivos:**
- Alterar: `app/api/v1/leads/[id]/next-action/route.ts`, `app/api/v1/leads/[id]/reactivation/route.ts`, `app/api/v1/pipelines/[id]/board/route.ts`, `app/api/v1/leads/proposals/route.ts`, `app/api/v1/contacts/[id]/crm-summary/route.ts`

**Interfaces:**
- Consome: a catraca da Tarefa 1.
- Produz: `withNextActions(admin: SupabaseClient, …)` e `avisaAmbiguas(admin: SupabaseClient, …)` no board.

- [ ] **Passo 1: `app/api/v1/leads/[id]/next-action/route.ts`**

Acrescentar `import { createAdminClient } from "@/lib/supabase/admin";`. Logo depois de `const supabase = await createClient();` (~linha 58):

```ts
  // `lead_state` é server-only na VPS: leitura e limpeza da próxima ação vão
  // pelo serviço. `row` foi lida sob RLS acima, então a organização é confiável.
  const admin = createAdminClient();
```

Trocar as duas cadeias de `lead_state`:
- `const { data: estado, error: estadoErr } = await supabase` → `const { data: estado, error: estadoErr } = await admin`
- `const { error: limpaErr } = await supabase` → `const { error: limpaErr } = await admin`

- [ ] **Passo 2: `app/api/v1/leads/[id]/reactivation/route.ts`**

Acrescentar `import { createAdminClient } from "@/lib/supabase/admin";`. Logo depois de `const supabase = await createClient();` (~linha 61):

```ts
  // `cron_jobs` é server-only na VPS: conferir e agendar o retorno vai pelo serviço.
  const admin = createAdminClient();
```

Trocar:
- `const { data: pendente } = await supabase` (a cadeia de `cron_jobs`) → `const { data: pendente } = await admin`
- `const { error: cronErr } = await supabase.from("cron_jobs").insert({` → `const { error: cronErr } = await admin.from("cron_jobs").insert({`

- [ ] **Passo 3: `app/api/v1/pipelines/[id]/board/route.ts`**

Acrescentar os imports:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
```

Em `avisaAmbiguas`, trocar o parâmetro `supabase: Awaited<ReturnType<typeof createClient>>,` por `admin: SupabaseClient,` e, no corpo, as duas ocorrências de `supabase` (a leitura em `buscaEmLotes(... supabase.from("agent_inbox_items") ...)` e o `await supabase.from("agent_inbox_items").insert(novos);`) por `admin`.

Em `withNextActions`, trocar o parâmetro `supabase: Awaited<ReturnType<typeof createClient>>,` por `admin: SupabaseClient,` e, no corpo, as três ocorrências de `supabase` (leitura de `lead_state`, leitura de `crm_leads`, e `await avisaAmbiguas(supabase, organizationId, ambiguas);`) por `admin`.

Acima de `async function withNextActions(` acrescentar:

```ts
/**
 * Recebe o client de SERVIÇO: `lead_state` e `agent_inbox_items` são server-only
 * na VPS, e pela sessão a próxima ação nunca aparecia no quadro. A organização
 * vem do pipeline lido sob RLS no GET, então é confiável.
 */
```

No `GET`, na chamada `const leadsComAcao = await withNextActions(`, trocar o primeiro argumento `supabase,` por `createAdminClient(),`.

- [ ] **Passo 4: `app/api/v1/leads/proposals/route.ts`**

O arquivo já importa `createAdminClient`. No `Promise.all` (~linha 76), trocar

```ts
      supabase
        .from("lead_state")
```

por

```ts
      // `lead_state` é server-only na VPS: lido pelo serviço, filtrado pela org.
      createAdminClient()
        .from("lead_state")
```

- [ ] **Passo 5: `app/api/v1/contacts/[id]/crm-summary/route.ts`**

O arquivo já importa `createAdminClient`. Trocar (~linha 153)

```ts
    supabase.from("lead_notes").select("id, headline, body")
```

por

```ts
    // `lead_notes` é server-only na VPS: a memória do lead vem pelo serviço.
    createAdminClient().from("lead_notes").select("id, headline, body")
```

(o resto da cadeia — `.eq("contact_id", …).eq("organization_id", …)…` — fica igual).

- [ ] **Passo 6: Rodar**

Rodar: `npx vitest run tests/unit/tabelas-do-motor-nao-se-leem-pelo-login.test.ts`
Esperado: a catraca ainda FALHA, mas só com as 4 linhas da Tarefa 4 (`agenda`, `followups/queue`, `retention` ×2).

Rodar: `npx eslint "app/api/v1/leads/[id]/next-action/route.ts" "app/api/v1/leads/[id]/reactivation/route.ts" "app/api/v1/pipelines/[id]/board/route.ts" app/api/v1/leads/proposals/route.ts "app/api/v1/contacts/[id]/crm-summary/route.ts"`
Esperado: zerado (remover `createClient`/variável que tenha ficado sem uso).

- [ ] **Passo 7: Commit (só com OK do usuário)**

```bash
git add "app/api/v1/leads/[id]/next-action/route.ts" "app/api/v1/leads/[id]/reactivation/route.ts" "app/api/v1/pipelines/[id]/board/route.ts" app/api/v1/leads/proposals/route.ts "app/api/v1/contacts/[id]/crm-summary/route.ts"
git commit -m "fix(funil): próxima ação, reativação, propostas e notas leem pelo servidor"
```

---

### Tarefa 4: Conversa, follow-ups e agenda (before_send_traces, channel_knobs, cron_jobs, job_queue)

**Arquivos:**
- Alterar: `app/api/v1/conversations/[id]/retention/route.ts`, `app/api/v1/ai/followups/queue/route.ts`, `app/api/v1/agenda/agendamentos/[id]/route.ts`

- [ ] **Passo 1: `app/api/v1/conversations/[id]/retention/route.ts`**

Acrescentar `import { createAdminClient } from "@/lib/supabase/admin";`. Trocar (~linha 61)

```ts
  const { data: traces, error: traceErr } = await supabase
    .from("before_send_traces")
```

por

```ts
  // `before_send_traces` e `channel_knobs` são server-only na VPS: o aviso de
  // "mensagem retida" nunca aparecia pela sessão. Filtrados pela org ativa.
  const { data: traces, error: traceErr } = await createAdminClient()
    .from("before_send_traces")
```

e, no `Promise.all` (~linha 77), trocar

```ts
    supabase
      .from("channel_knobs")
```

por

```ts
    createAdminClient()
      .from("channel_knobs")
```

- [ ] **Passo 2: `app/api/v1/ai/followups/queue/route.ts`**

Acrescentar `import { createAdminClient } from "@/lib/supabase/admin";`. Trocar (~linha 214)

```ts
  let promiseQuery = supabase
    .from("cron_jobs")
```

por

```ts
  // `cron_jobs` é server-only na VPS: as promessas da fila vêm pelo serviço.
  let promiseQuery = createAdminClient()
    .from("cron_jobs")
```

- [ ] **Passo 3: `app/api/v1/agenda/agendamentos/[id]/route.ts`**

O arquivo já importa `createAdminClient`. Trocar (~linha 65)

```ts
    ? await db.from("job_queue").select("status")
```

por

```ts
    ? await createAdminClient().from("job_queue").select("status")
```

(o resto da linha — `.eq("organization_id",org).eq("id",…).maybeSingle()` — fica igual).

- [ ] **Passo 4: Rodar e ver passar**

Rodar: `npx vitest run tests/unit/tabelas-do-motor-nao-se-leem-pelo-login.test.ts`
Esperado: os 3 casos PASSAM.

Rodar: `npx eslint "app/api/v1/conversations/[id]/retention/route.ts" app/api/v1/ai/followups/queue/route.ts "app/api/v1/agenda/agendamentos/[id]/route.ts"`
Esperado: zerado.

- [ ] **Passo 5: Commit (só com OK do usuário)**

```bash
git add "app/api/v1/conversations/[id]/retention/route.ts" app/api/v1/ai/followups/queue/route.ts "app/api/v1/agenda/agendamentos/[id]/route.ts"
git commit -m "fix: retenção, fila de follow-ups e agenda leem as tabelas do motor pelo servidor"
```

---

### Tarefa 5: Fragmento, validação, sabotagem e a versão escale.2

- [ ] **Passo 1: Fragmento**

`.changes/telas-do-motor-leem-pelo-servidor.md`:

```markdown
---
impacto: nada_mudou
secao: corrigido
titulo: Execuções de IA, uso de IA e outras telas do agente voltam a mostrar dados na instalação por VPS
---

Na instalação por VPS, as telas que leem dados do motor do agente apareciam
vazias mesmo com dados no banco: Execuções de IA, Uso de IA, a aba Execuções
de cada agente, os números do Jev, a fila de follow-ups, o aviso de mensagem
retida na conversa, a próxima ação sugerida, a reativação, as propostas, as
notas do lead e o estado do envio do link de reunião. Essas telas passam a ler
esses dados pelo servidor, sempre limitadas à empresa de quem está acessando.
```

- [ ] **Passo 2: Validação completa**

```bash
npm run typecheck
npm run lint
npx vitest run tests/unit/tabelas-do-motor-nao-se-leem-pelo-login.test.ts \
  tests/unit/execucoes-de-ia-leem-pelo-servidor.test.ts \
  tests/unit/negocio-do-contato.test.ts \
  tests/unit/contexto-do-agente-traz-o-negocio.test.ts \
  tests/unit/abertura-ensina-o-id-do-negocio.test.ts
npx tsx scripts/cortar-release.ts      # conferência, não escreve
```

Esperado: tudo verde; a conferência lista o fragmento novo.

- [ ] **Passo 3: Sabotagem (uma de cada vez, desfazendo depois)**

1. Em `app/api/v1/ai/runs/route.ts`, voltar `let q = admin` para uma sessão (`let q = (await (await import("@/lib/supabase/server")).createClient())`) → catraca e teste de comportamento VERMELHOS.
2. Em `app/api/v1/leads/[id]/next-action/route.ts`, apagar `.eq("organization_id", row.organization_id)` da leitura de `lead_state` → catraca VERMELHA em "filtra organization_id".

Conferir com `git diff` que as sabotagens foram desfeitas.

- [ ] **Passo 4: Revisão**

`/code-review` nas mudanças + agente `security-reviewer` (foco: toda consulta pelo serviço filtra organização de fonte confiável).

- [ ] **Passo 5: Commit do fragmento e merge na linha do fork (só com OK do usuário)**

```bash
git add .changes/telas-do-motor-leem-pelo-servidor.md
git commit -m "docs(release): fragmento das telas do motor lendo pelo servidor"
git checkout escale/main
git merge --ff-only fix/telas-do-motor-leem-pelo-servidor
git tag -a v1.69.0-escale.2 -m "Escale IA: v1.69.0 + id do negócio + telas do motor pelo servidor"
```

- [ ] **Passo 6: Publicar (PELO USUÁRIO, no PowerShell)**

```powershell
cd "C:\Documentos\projetos claude\Deskcom CRM\repo"
git push fork escale/main:main
git push fork v1.69.0-escale.2
```

Acompanhar a geração das imagens (`gh run list -R rgisjr/DeskcommCRM`), ~15 min. Depois:

```powershell
gh release create v1.69.0-escale.2 -R rgisjr/DeskcommCRM --title "v1.69.0-escale.2" --latest --notes "v1.69.0 + o agente recebe o ID do negócio + as telas do motor do agente (Execuções de IA e outras) leem pelo servidor."
```

- [ ] **Passo 7: Atualizar a VPS (PELO USUÁRIO, Bitvise, servidor serverx)**

```bash
tmux new -s atualizacao
cd /root/DeskcommCRM && bash hostgator-setup-kit/update.sh --to v1.69.0-escale.2
```

Sem mudança de banco nesta versão: só troca as imagens. Conferir depois: `docker ps --format '{{.Names}}  {{.Image}}' | grep deskcommcrm-` mostra `1.69.0-escale.2`, e a tela **IA → Execuções** mostra as execuções.

## Fora deste plano

- Avisar o mantenedor do projeto original (defeito atinge toda instalação por VPS).
- Consultas a essas tabelas fora de `app/api` (helpers em `lib/` que recebem o client por parâmetro) não entram na catraca; a varredura de 2026-10-02 não achou leitura pela sessão vinda de `app/app`.
