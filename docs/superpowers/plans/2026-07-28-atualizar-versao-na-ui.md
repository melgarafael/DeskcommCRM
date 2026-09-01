# Atualizar Versão pela UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O dono de uma instalação self-host atualiza o SonghaiCRM clicando num botão na própria tela, sem abrir terminal nem SSH.

**Architecture:** O app roda em container sem acesso ao host, então ele não executa a atualização — ele **publica uma intenção** em duas tabelas de instância. Um agente no host (`agent.sh`, cron a cada 5 min, mesmo mecanismo do cron do `event-log-drain` que já existe) faz `POST` de heartbeat para o app, lê na resposta se alguém pediu atualização e, se sim, roda `bash update.sh --to <tag>` sob `flock`, reportando cada passo. O que atravessa a fronteira é um booleano, nunca um comando.

**Tech Stack:** Next.js 16 App Router · React 19 · TypeScript estrito · Supabase (Postgres + RLS) · TanStack Query · Vitest · Playwright · Bash (kit HostGator) · Docker Compose.

**Spec:** `docs/superpowers/specs/2026-07-28-atualizar-versao-na-ui-design.md` — leia antes de começar.

## Global Constraints

- **Worktree:** `~/SonghaiCRM-update`, branch `feat/atualizar-pela-ui` (já criada a partir de `origin/main`). Não trabalhe no clone principal — ele está sujo com trabalho de outra sessão.
- **Idioma:** toda cópia de tela, mensagem de erro e comentário em **pt-BR**, para pessoa que não programa. Sem jargão de container/deploy na UI.
- **Wrappers obrigatórios:** toda rota `/api/v1/*` usa `ok()` / `fail()` de `lib/api/wrappers.ts`. `ok()` já envelopa em `{data}` — nunca `ok({data: x})`. A assinatura de `fail` é **posicional no status**: `fail(code, message, status, opts?)`, onde `opts` aceita `{ details, requestId, headers }`.
- **Auth:** sempre `loadAuthUser()` (que usa `supabase.auth.getUser()`); **nunca** `getSession()`.
- **Autorização desta feature:** `user.is_platform_admin === true`. Não é role de organização.
- **Zod em todo input externo**, incluindo o corpo vindo do agente.
- **Schema:** toda mudança sai como migration versionada **e** apêndice idempotente em `supabase/baseline.sql` **e** linha em `supabase/migrations/MANIFEST.md`. Os três andam juntos.
- **Sem `console.log`** em código commitado; use `logger` de `lib/logger`.
- **Commits:** um por task, mensagem em pt-BR no formato `tipo(escopo): assunto`, assunto em minúsculas sem ponto final. Rodapé obrigatório:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ng41aCYobTn37KrN2V7BZf
  ```
- **Nomes canônicos** (não invente variantes): tabelas `system_version` e `system_update_runs`; rotas `/api/v1/system/agent`, `/api/v1/system/version`, `/api/v1/system/update`; módulos `lib/system/changelog.ts` e `lib/system/update-run.ts`.
- **Vocabulário fechado:** `RunStatus = "dispatched" | "success" | "failed" | "failed_rolled_back"`; `RunStep = "backup" | "codigo" | "banco"`. Esses valores aparecem em CHECK no banco **e** em union type no TypeScript — mantenha idênticos, o invariante compara os dois.

---

## Mapa de arquivos

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `supabase/migrations/20260728120000_0085_system_self_update.sql` | Cria as duas tabelas de instância | 1 |
| `supabase/baseline.sql` (apêndice) | Mesma coisa, idempotente, para o self-hoster | 1 |
| `supabase/migrations/MANIFEST.md` | Registro da migration | 1 |
| `tests/invariants/system-self-update.test.ts` | Prova que `authenticated` não lê as tabelas | 1 |
| `lib/system/changelog.ts` | Extrai a seção de uma versão do CHANGELOG.md | 2 |
| `lib/system/changelog.test.ts` | Testes do extrator | 2 |
| `lib/system/update-run.ts` | Vocabulário do run + transições + staleness | 3 |
| `lib/system/update-run.test.ts` | Testes da máquina de estados | 3 |
| `app/api/v1/system/agent/route.ts` | Endpoint único do agente do host | 4 |
| `app/api/v1/system/agent/route.test.ts` | Testes da rota do agente | 4 |
| `app/api/v1/system/version/route.ts` | Estado para a UI | 5 |
| `app/api/v1/system/update/route.ts` | Clique do dono | 5 |
| `app/api/v1/system/version/route.test.ts` | Testes das duas rotas de UI | 5 |
| `lib/audit/actions.ts` | +2 ações no union | 5 |
| `hooks/system/useSystemVersion.ts` | Fetch + polling do estado | 6 |
| `components/shell/VersionFooter.tsx` | Rodapé da sidebar | 6 |
| `components/shell/Sidebar.tsx` | Monta o rodapé | 6 |
| `app/app/settings/atualizacao/page.tsx` | Página (server, guarda) | 7 |
| `app/app/settings/atualizacao/_components/UpdatePanel.tsx` | Os 4 estados (client) | 7 |
| `hostgator-setup-kit/agent.sh` | Agente do host | 8 |
| `hostgator-setup-kit/update.sh` | `--to <tag>`, checkout de tag, imagem versionada, rollback | 8 |
| `hostgator-setup-kit/_common.sh` | Instala o cron do agente | 8 |
| `hostgator-setup-kit/install.sh` | Chama a instalação do cron | 8 |
| `tests/e2e/system-update.spec.ts` | Prova pela tela | 9 |
| `docs/architecture/*`, `CHANGELOG.md`, `hostgator-setup-kit/CLAUDE.md` | Mapa vivo e docs | 9 |

---

### Task 1: Tabelas de instância (migration + baseline + invariante)

**Files:**
- Create: `supabase/migrations/20260728120000_0085_system_self_update.sql`
- Create: `tests/invariants/system-self-update.test.ts`
- Modify: `supabase/baseline.sql` (acrescentar apêndice no **fim** do arquivo)
- Modify: `supabase/migrations/MANIFEST.md` (linha na tabela "Applied")

**Interfaces:**
- Consumes: nada.
- Produces: tabelas `public.system_version` (singleton, `id = 1`) e `public.system_update_runs`, consumidas pelas tasks 4 e 5.

- [ ] **Step 1: Escrever a migration**

Crie `supabase/migrations/20260728120000_0085_system_self_update.sql`:

```sql
-- 0085 — Atualização self-service pela UI.
--
-- Duas tabelas de INSTÂNCIA (sem organization_id): descrevem o servidor, não o
-- inquilino. Sem policy de RLS de propósito — com RLS habilitada e zero policy,
-- `anon` e `authenticated` não leem nada pelo PostgREST; o acesso passa só pelas
-- rotas /api/v1/system/*, que usam service role e checam is_platform_admin.

create table if not exists public.system_version (
  id                  smallint primary key default 1 check (id = 1),
  current_version     text not null default '',
  current_sha         text not null default '',
  off_release         boolean not null default false,
  latest_version      text not null default '',
  changelog_raw       text not null default '',
  agent_last_seen_at  timestamptz,
  update_requested_at timestamptz,
  update_requested_by uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);

comment on table public.system_version is
  'Singleton: versão instalada e disponível desta instância. Escrito pelo agente do host.';

insert into public.system_version (id) values (1) on conflict (id) do nothing;

create table if not exists public.system_update_runs (
  id            uuid primary key default gen_random_uuid(),
  from_version  text not null default '',
  to_version    text not null default '',
  status        text not null default 'dispatched'
                check (status in ('dispatched','success','failed','failed_rolled_back')),
  last_step     text check (last_step in ('backup','codigo','banco')),
  requested_by  uuid references auth.users(id) on delete set null,
  dispatched_at timestamptz not null default now(),
  finished_at   timestamptz,
  log_tail      text not null default ''
);

comment on table public.system_update_runs is
  'Histórico append de atualizações disparadas pela UI. status/last_step espelham RunStatus/RunStep em lib/system/update-run.ts.';

create index if not exists idx_system_update_runs_dispatched
  on public.system_update_runs (dispatched_at desc);

alter table public.system_version    enable row level security;
alter table public.system_update_runs enable row level security;
```

- [ ] **Step 2: Copiar o mesmo bloco para o fim do `baseline.sql`**

Acrescente ao **final** de `supabase/baseline.sql`, seguindo o padrão dos apêndices existentes:

```sql
-- ---- atualização self-service pela UI (migration 0085) ----
```

seguido do **conteúdo idêntico** da migration acima (ele já é inteiramente idempotente: `create table if not exists`, `insert ... on conflict do nothing`, `create index if not exists`, `enable row level security` — este último é idempotente no Postgres).

- [ ] **Step 3: Registrar no MANIFEST**

Em `supabase/migrations/MANIFEST.md`, na tabela "Applied", acrescente a linha seguindo o formato das vizinhas:

```
| 20260728120000 | 0085_system_self_update | Tabelas `system_version` (singleton) e `system_update_runs`: estado da atualização self-service disparada pela UI. Sem `organization_id` (instância, não inquilino) e sem policy de RLS — acesso só via service role nas rotas `/api/v1/system/*`. |
```

- [ ] **Step 4: Escrever o invariante que falha antes de existir a tabela**

Crie `tests/invariants/system-self-update.test.ts`, seguindo o formato dos invariantes vizinhos (importe `sql` de `./gov-helpers`, como em `tests/invariants/vocabulario-banco-x-typescript.test.ts`):

```ts
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * As tabelas de instância não vazam para o inquilino.
 *
 * `system_version` e `system_update_runs` descrevem o SERVIDOR. Um usuário
 * comum autenticado não tem por que saber que existe uma atualização pendente,
 * e um atacante com um JWT válido não pode ler o log de atualização. A defesa
 * é estrutural: RLS habilitada com ZERO policy nega tudo por construção —
 * não depende de a rota lembrar de checar.
 */
describe("tabelas de instância da atualização self-service", () => {
  it("têm RLS habilitada", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }>(`
      select relname, relrowsecurity
        from pg_class
       where relname in ('system_version', 'system_update_runs')
    `);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} sem RLS`).toBe(true);
    }
  });

  it("não têm nenhuma policy — negar é o default", async () => {
    const rows = await sql<{ tablename: string }>(`
      select tablename from pg_policies
       where tablename in ('system_version', 'system_update_runs')
    `);
    expect(rows).toEqual([]);
  });

  it("system_version é singleton", async () => {
    await expect(
      sql(`insert into public.system_version (id) values (2)`),
    ).rejects.toThrow();
    const rows = await sql<{ n: string }>(`select count(*) as n from public.system_version`);
    expect(rows[0]?.n).toBe("1");
  });
});
```

- [ ] **Step 5: Rodar o invariante e ver falhar**

Run: `pnpm test:db 2>&1 | tail -40`
Expected: FAIL — `system-self-update.test.ts` acusa `toHaveLength(2)` recebendo `0` (as tabelas ainda não existem no baseline aplicado). Se **passar** aqui, algo está errado: você já aplicou o schema antes de rodar, ou o teste não está sendo coletado.

> ⚠️ Não valide com `pnpm test:db | tail` sozinho num `&&` encadeado — o exit code vira o do `tail`. Rode o comando e leia a saída; confirme o veredito pela última linha de sumário do Vitest.

- [ ] **Step 6: Aplicar o baseline e ver passar**

O `pnpm test:db` (via `scripts/test-db.sh`) já sobe um Postgres descartável e aplica `supabase/baseline.sql` em modo install **e** update. Com o apêndice do Step 2 no lugar, rode de novo:

Run: `pnpm test:db 2>&1 | tail -40`
Expected: PASS — os 3 casos novos verdes e nenhuma regressão nos demais invariantes. O modo update (re-aplicar sobre base existente) precisa passar também: é o que o `update.sh` do self-hoster faz.

- [ ] **Step 7: Commit**

```bash
cd ~/SonghaiCRM-update
git add supabase/migrations/20260728120000_0085_system_self_update.sql \
        supabase/baseline.sql supabase/migrations/MANIFEST.md \
        tests/invariants/system-self-update.test.ts
git commit -m "$(cat <<'EOF'
feat(update): tabelas de instancia da atualizacao self-service

system_version (singleton) e system_update_runs descrevem o servidor, nao o
inquilino — sem organization_id. RLS habilitada com ZERO policy: negar e o
default estrutural, nao depende de a rota lembrar de checar.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ng41aCYobTn37KrN2V7BZf
EOF
)"
```

---

### Task 2: Extrator da seção do CHANGELOG

**Files:**
- Create: `lib/system/changelog.ts`
- Test: `lib/system/changelog.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  ```ts
  export interface ChangelogSection {
    version: string;                    // "1.1.0" (sem o "v")
    body: string;                       // markdown da seção, sem o heading, trim
    requiresAttention: string | null;   // conteúdo sob "⚠️ Requer atenção", se houver
  }
  export const CHANGELOG_MAX_BYTES = 64_000;
  export function extractChangelogSection(raw: string, version: string): ChangelogSection | null;
  ```
  Usado pela task 5 (`GET /api/v1/system/version`).

**Contexto:** o `CHANGELOG.md` do repo segue Keep a Changelog em pt-BR. Os headings de versão têm a forma `## [1.0.0] — 2026-07-27` (travessão em, não hífen) e existe também `## [Não lançado]`. Dentro de uma versão há `### Seções` e pode haver um bloco `**⚠️ Requer atenção**`.

- [ ] **Step 1: Escrever os testes que falham**

Crie `lib/system/changelog.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { extractChangelogSection } from "./changelog";

const CHANGELOG = `# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

## [Não lançado]

## [1.1.0] — 2026-08-02

**⚠️ Requer atenção**

Se você usa número próprio no WhatsApp, reconecte depois de atualizar.

### Adicionado

- Botão de atualizar pela própria tela.

## [1.0.0] — 2026-07-27

Primeira versão marcada do SonghaiCRM.
`;

describe("extractChangelogSection", () => {
  it("acha a versão pedida e devolve só o corpo dela", () => {
    const section = extractChangelogSection(CHANGELOG, "1.1.0");
    expect(section?.version).toBe("1.1.0");
    expect(section?.body).toContain("Botão de atualizar pela própria tela.");
    expect(section?.body).not.toContain("Primeira versão marcada");
    expect(section?.body).not.toContain("## [1.1.0]");
  });

  it("aceita a versão com o prefixo v da tag", () => {
    expect(extractChangelogSection(CHANGELOG, "v1.1.0")?.version).toBe("1.1.0");
  });

  it("extrai o bloco de atenção separado do corpo", () => {
    const section = extractChangelogSection(CHANGELOG, "1.1.0");
    expect(section?.requiresAttention).toContain("reconecte depois de atualizar");
  });

  it("devolve null no bloco de atenção quando a versão não tem um", () => {
    expect(extractChangelogSection(CHANGELOG, "1.0.0")?.requiresAttention).toBeNull();
  });

  it("para no próximo heading de versão, não engole o resto do arquivo", () => {
    const section = extractChangelogSection(CHANGELOG, "1.0.0");
    expect(section?.body).toContain("Primeira versão marcada");
    expect(section?.body).not.toContain("[Não lançado]");
  });

  it("devolve null para versão ausente", () => {
    expect(extractChangelogSection(CHANGELOG, "9.9.9")).toBeNull();
  });

  it("devolve null para entrada vazia ou lixo", () => {
    expect(extractChangelogSection("", "1.0.0")).toBeNull();
    expect(extractChangelogSection("qualquer coisa sem headings", "1.0.0")).toBeNull();
  });

  it("não confunde 1.1.0 com 1.1.0-beta", () => {
    const raw = "## [1.1.0-beta] — 2026-08-01\n\nbeta\n\n## [1.1.0] — 2026-08-02\n\nfinal\n";
    expect(extractChangelogSection(raw, "1.1.0")?.body.trim()).toBe("final");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run lib/system/changelog.test.ts`
Expected: FAIL — `Failed to resolve import "./changelog"`.

- [ ] **Step 3: Implementar**

Crie `lib/system/changelog.ts`:

```ts
/**
 * Extrai a seção de UMA versão do CHANGELOG.md (Keep a Changelog, pt-BR).
 *
 * Mora no app, e não em `awk` dentro do agente do host, por um motivo só:
 * aqui é função pura e testável. O agente manda o arquivo cru; quem interpreta
 * é quem exibe.
 */

export interface ChangelogSection {
  version: string;
  body: string;
  requiresAttention: string | null;
}

/** Teto do que o agente pode mandar. O CHANGELOG real tem ~4 KB. */
export const CHANGELOG_MAX_BYTES = 64_000;

/** `## [1.1.0] — 2026-08-02` e também `## [Não lançado]`. */
const VERSION_HEADING = /^##\s+\[([^\]]+)\]/;
const ATTENTION_HEADING = /^\*{0,2}⚠️?\s*Requer atenção\*{0,2}\s*$/i;

function normalize(version: string): string {
  return version.trim().replace(/^v/i, "");
}

export function extractChangelogSection(raw: string, version: string): ChangelogSection | null {
  const wanted = normalize(version);
  if (!raw || !wanted) return null;

  const lines = raw.split("\n");
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const match = VERSION_HEADING.exec(lines[i] ?? "");
    if (!match) continue;
    if (start === -1) {
      if (normalize(match[1] ?? "") === wanted) start = i + 1;
    } else {
      end = i;
      break;
    }
  }

  if (start === -1) return null;

  const bodyLines = lines.slice(start, end);
  return {
    version: wanted,
    body: bodyLines.join("\n").trim(),
    requiresAttention: extractAttention(bodyLines),
  };
}

/**
 * O bloco de atenção vai do heading até o próximo heading de qualquer nível.
 * Separado do corpo porque a tela o mostra ACIMA do botão — quem precisa agir
 * à mão não pode descobrir isso rolando a página depois de já ter clicado.
 */
function extractAttention(bodyLines: string[]): string | null {
  const start = bodyLines.findIndex((line) => ATTENTION_HEADING.test(line.trim()));
  if (start === -1) return null;

  const rest = bodyLines.slice(start + 1);
  const nextHeading = rest.findIndex((line) => /^#{2,4}\s/.test(line) || /^\*\*/.test(line.trim()));
  const block = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const text = block.join("\n").trim();
  return text || null;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run lib/system/changelog.test.ts`
Expected: PASS — 8 casos verdes.

- [ ] **Step 5: Sabotar para provar que o teste morde**

Troque temporariamente `end = i; break;` por `end = lines.length; break;` e rode de novo. Expected: FAIL no caso "para no próximo heading". Desfaça a sabotagem e confirme verde de novo. Um teste que não fica vermelho quando o defeito existe não prova nada.

- [ ] **Step 6: Commit**

```bash
git add lib/system/changelog.ts lib/system/changelog.test.ts
git commit -m "$(cat <<'EOF'
feat(update): extrator da secao do CHANGELOG

O agente do host manda o arquivo cru; quem interpreta e o app, em TypeScript,
porque aqui vira funcao pura testavel em vez de awk dentro do bash.

O bloco "Requer atencao" sai separado do corpo: a tela o mostra ACIMA do botao,
senao quem precisa agir a mao descobre rolando a pagina depois de ja ter clicado.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ng41aCYobTn37KrN2V7BZf
EOF
)"
```

---

### Task 3: Vocabulário e máquina de estados do run

**Files:**
- Create: `lib/system/update-run.ts`
- Test: `lib/system/update-run.test.ts`
- Modify: `tests/invariants/vocabulario-banco-x-typescript.test.ts` (duas entradas no array `PARES`)

**Interfaces:**
- Consumes: nada.
- Produces:
  ```ts
  export type RunStatus = "dispatched" | "success" | "failed" | "failed_rolled_back";
  export type RunStep = "backup" | "codigo" | "banco";
  export const RUN_STALE_AFTER_MS: number;             // 15 min
  export function canTransition(from: RunStatus, to: RunStatus): boolean;
  export function isRunStale(dispatchedAt: string, now: Date): boolean;
  ```
  Usado pelas tasks 4, 5 e 7.

- [ ] **Step 1: Escrever os testes que falham**

Crie `lib/system/update-run.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { canTransition, isRunStale, RUN_STALE_AFTER_MS } from "./update-run";

describe("canTransition", () => {
  it("aceita o desfecho reportado pelo agente", () => {
    expect(canTransition("dispatched", "success")).toBe(true);
    expect(canTransition("dispatched", "failed")).toBe(true);
    expect(canTransition("dispatched", "failed_rolled_back")).toBe(true);
  });

  it("recusa mexer num run que já terminou", () => {
    expect(canTransition("success", "failed")).toBe(false);
    expect(canTransition("failed", "success")).toBe(false);
    expect(canTransition("failed_rolled_back", "success")).toBe(false);
  });

  it("recusa voltar para dispatched", () => {
    expect(canTransition("success", "dispatched")).toBe(false);
    expect(canTransition("dispatched", "dispatched")).toBe(false);
  });
});

describe("isRunStale", () => {
  const dispatched = "2026-07-28T12:00:00.000Z";

  it("não é velho antes do teto", () => {
    const now = new Date(Date.parse(dispatched) + RUN_STALE_AFTER_MS - 1000);
    expect(isRunStale(dispatched, now)).toBe(false);
  });

  it("é velho depois do teto", () => {
    const now = new Date(Date.parse(dispatched) + RUN_STALE_AFTER_MS + 1000);
    expect(isRunStale(dispatched, now)).toBe(true);
  });

  it("data inválida conta como velho — o que não dá para afirmar, não se afirma", () => {
    expect(isRunStale("isso não é data", new Date())).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run lib/system/update-run.test.ts`
Expected: FAIL — `Failed to resolve import "./update-run"`.

- [ ] **Step 3: Implementar**

Crie `lib/system/update-run.ts`:

```ts
/**
 * Vocabulário e transições de uma atualização disparada pela UI.
 *
 * Os valores de RunStatus e RunStep são os MESMOS do CHECK em
 * `system_update_runs` (migration 0085). O invariante
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` compara os dois —
 * mudar um lado sem o outro fica vermelho.
 */

export type RunStatus = "dispatched" | "success" | "failed" | "failed_rolled_back";
export type RunStep = "backup" | "codigo" | "banco";

/**
 * Depois disso sem notícia, a UI trata o run como desfecho desconhecido.
 * 15 min é folgado: uma atualização real leva ~2 min, e o agente ainda tenta
 * reportar por ~2 min após o reinício do app.
 */
export const RUN_STALE_AFTER_MS = 15 * 60 * 1000;

const TERMINAL: readonly RunStatus[] = ["success", "failed", "failed_rolled_back"];

/**
 * Só existe uma transição legítima: de `dispatched` para um desfecho. Um run
 * que já terminou é imutável — se o agente reportar duas vezes (retry após o
 * reinício do app), a segunda é recusada em vez de reescrever a história.
 */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return from === "dispatched" && TERMINAL.includes(to);
}

/**
 * `unknown` é DERIVADO na leitura, nunca gravado: um agente morto não consegue
 * anunciar a própria morte.
 */
export function isRunStale(dispatchedAt: string, now: Date): boolean {
  const started = Date.parse(dispatchedAt);
  if (Number.isNaN(started)) return true;
  return now.getTime() - started > RUN_STALE_AFTER_MS;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run lib/system/update-run.test.ts`
Expected: PASS — 6 casos verdes.

- [ ] **Step 5: Registrar os pares no invariante de vocabulário**

Em `tests/invariants/vocabulario-banco-x-typescript.test.ts`, acrescente ao array `PARES` (siga exatamente a forma das entradas existentes — o par aponta para **arquivo e símbolo**, nunca transcreve os valores):

```ts
  {
    tabela: "system_update_runs",
    coluna: "status",
    // lib/system/update-run.ts → RunStatus
    arquivo: "lib/system/update-run.ts",
    simbolo: "RunStatus",
  },
  {
    tabela: "system_update_runs",
    coluna: "last_step",
    // lib/system/update-run.ts → RunStep
    arquivo: "lib/system/update-run.ts",
    simbolo: "RunStep",
  },
```

- [ ] **Step 6: Rodar o invariante**

Run: `pnpm test:db 2>&1 | tail -40`
Expected: PASS. Se falhar dizendo que o símbolo não foi encontrado, leia como as entradas vizinhas declaram o union type e ajuste a forma da declaração em `update-run.ts` para casar (o invariante lê o arquivo e extrai o union).

- [ ] **Step 7: Sabotar para provar que o invariante morde**

Remova temporariamente `"failed_rolled_back"` do union `RunStatus` e rode `pnpm test:db` de novo. Expected: FAIL no par `system_update_runs.status`. Restaure e confirme verde.

- [ ] **Step 8: Commit**

```bash
git add lib/system/update-run.ts lib/system/update-run.test.ts \
        tests/invariants/vocabulario-banco-x-typescript.test.ts
git commit -m "$(cat <<'EOF'
feat(update): vocabulario e transicoes do run de atualizacao

Run que ja terminou e imutavel: o agente tenta reportar de novo apos o reinicio
do app, e a segunda tentativa e recusada em vez de reescrever a historia.

`unknown` nao existe como estado gravado — e derivado na leitura, porque um
agente morto nao consegue anunciar a propria morte.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ng41aCYobTn37KrN2V7BZf
EOF
)"
```

---

### Task 4: Rota do agente do host

**Files:**
- Create: `app/api/v1/system/agent/route.ts`
- Test: `app/api/v1/system/agent/route.test.ts`
- Modify: `lib/audit/actions.ts` (duas ações novas no union `AuditAction`)

**Interfaces:**
- Consumes: `RunStatus`, `RunStep`, `canTransition` de `lib/system/update-run.ts`; `CHANGELOG_MAX_BYTES` de `lib/system/changelog.ts`; tabelas da task 1.
- Produces: contrato HTTP consumido pelo `agent.sh` (task 8):
  - `POST /api/v1/system/agent`, header `Authorization: Bearer <INTERNAL_SECRET>`
  - resposta sempre `{ data: { update_requested: boolean, run_id: string | null } }`

**Padrão a seguir:** copie a estrutura de autenticação de `app/api/v1/cron/event-log-drain/route.ts` (bearer + fallback `X-Cron-Secret`, aceitando `INTERNAL_CRON_SECRET` ou `INTERNAL_SECRET`). Use `createAdminClient()` de `lib/supabase/admin` — service role, porque as tabelas negam tudo por RLS.

- [ ] **Step 0: Acrescentar as ações de auditoria**

Em `lib/audit/actions.ts`, acrescente ao final do union `AuditAction` (mantendo o `;` só na última entrada):

```ts
  | "system.update_requested"
  | "system.update_finished";
```

`system.update_finished` é emitido nesta task (no `run_result`); `system.update_requested`, na task 5. As duas entram juntas porque um union parcial não compila no meio do caminho.

- [ ] **Step 1: Escrever os testes que falham**

Crie `app/api/v1/system/agent/route.test.ts`. Espelhe o estilo de `app/api/v1/ai/memory/route.test.ts` (mock de `@/lib/supabase/admin`):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo-de-teste", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const RUN_ID = "33333333-3333-4333-8333-333333333333";

function req(body: unknown, secret = "segredo-de-teste") {
  return new NextRequest("http://localhost/api/v1/system/agent", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

const HEARTBEAT = {
  kind: "heartbeat",
  current_version: "1.0.0",
  current_sha: "abc1234",
  off_release: false,
  latest_version: "1.1.0",
  changelog: "## [1.1.0] — 2026-08-02\n\nnovidade\n",
};

/** Estado do banco simulado, controlado por caso. */
let versionRow: Record<string, unknown>;
let runRow: Record<string, unknown> | null;
let updated: Record<string, unknown> | null;

beforeEach(() => {
  versionRow = { id: 1, update_requested_at: null, update_requested_by: null };
  runRow = null;
  updated = null;

  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: table === "system_version" ? versionRow : runRow, error: null }) }),
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: runRow, error: null }) }) }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async () => { updated = { table, ...patch }; return { error: null }; },
      }),
    }),
  } as never);
});

describe("POST /api/v1/system/agent", () => {
  it("recusa sem o segredo", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT, "segredo-errado"));
    expect(res.status).toBe(401);
    expect(updated).toBeNull();
  });

  it("heartbeat grava versão, changelog e o carimbo de vida do agente", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT));
    expect(res.status).toBe(200);
    expect(updated).toMatchObject({
      table: "system_version",
      current_version: "1.0.0",
      latest_version: "1.1.0",
    });
    expect(updated?.agent_last_seen_at).toBeTruthy();
  });

  it("heartbeat responde update_requested=false quando ninguém pediu", async () => {
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.update_requested).toBe(false);
    expect(body.data.run_id).toBeNull();
  });

  it("heartbeat responde a ordem pendente e devolve o run", async () => {
    versionRow = { id: 1, update_requested_at: new Date().toISOString(), update_requested_by: null };
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.update_requested).toBe(true);
    expect(body.data.run_id).toBe(RUN_ID);
  });

  it("recusa changelog acima do teto", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ ...HEARTBEAT, changelog: "x".repeat(70_000) }));
    expect(res.status).toBe(422);
  });

  it("run_progress grava o passo sem encerrar o run", async () => {
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_progress", run_id: RUN_ID, step: "banco" }));
    expect(res.status).toBe(200);
    expect(updated).toMatchObject({ table: "system_update_runs", last_step: "banco" });
    expect(updated?.status).toBeUndefined();
  });

  it("run_result encerra o run, limpa o pedido e audita o desfecho", async () => {
    const { audit } = await import("@/lib/audit");
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_result", run_id: RUN_ID, status: "success", log_tail: "ok" }));
    expect(res.status).toBe(200);
    expect(updated).toMatchObject({ table: "system_update_runs", status: "success" });
    expect(updated?.finished_at).toBeTruthy();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "system.update_finished", resourceId: RUN_ID }),
    );
  });

  it("recusa reescrever um run que já terminou", async () => {
    runRow = { id: RUN_ID, status: "success", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_result", run_id: RUN_ID, status: "failed", log_tail: "" }));
    expect(res.status).toBe(409);
  });

  it("recusa corpo com kind desconhecido", async () => {
    const { POST } = await import("./route");
    expect((await POST(req({ kind: "sei-la" }))).status).toBe(422);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run app/api/v1/system/agent/route.test.ts`
Expected: FAIL — módulo `./route` não existe.

- [ ] **Step 3: Implementar a rota**

Crie `app/api/v1/system/agent/route.ts`:

```ts
/**
 * POST /api/v1/system/agent — endpoint ÚNICO do agente do host.
 *
 * O app não alcança o host: quem puxa é o `agent.sh`, por cron. Ele anuncia a
 * versão instalada e lê, na resposta, se alguém clicou em "Atualizar agora".
 * O que atravessa a fronteira é um booleano, nunca um comando — mesmo com o app
 * comprometido, o atacante não escolhe O QUE roda no host.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET|INTERNAL_SECRET>`, mesmo
 * esquema das demais rotas de cron. Nunca em query string.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { CHANGELOG_MAX_BYTES } from "@/lib/system/changelog";
import { canTransition, type RunStatus } from "@/lib/system/update-run";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const heartbeat = z.object({
  kind: z.literal("heartbeat"),
  current_version: z.string().max(64),
  current_sha: z.string().max(64),
  off_release: z.boolean(),
  latest_version: z.string().max(64),
  changelog: z.string().max(CHANGELOG_MAX_BYTES),
});

const runProgress = z.object({
  kind: z.literal("run_progress"),
  run_id: z.string().uuid(),
  step: z.enum(["backup", "codigo", "banco"]),
});

const runResult = z.object({
  kind: z.literal("run_result"),
  run_id: z.string().uuid(),
  status: z.enum(["success", "failed", "failed_rolled_back"]),
  log_tail: z.string().max(16_000),
});

const body = z.discriminatedUnion("kind", [heartbeat, runProgress, runResult]);

function secretMatches(provided: string): boolean {
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  return accepted.some((expected) => {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const provided = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  if (!provided || !secretMatches(provided)) {
    return fail("unauthorized", "Credencial inválida.", 401);
  }

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Corpo inválido.", 422, { details: parsed.error.flatten() });
  }

  const db = createAdminClient();
  const payload = parsed.data;

  if (payload.kind === "heartbeat") {
    const { error } = await db
      .from("system_version")
      .update({
        current_version: payload.current_version,
        current_sha: payload.current_sha,
        off_release: payload.off_release,
        latest_version: payload.latest_version,
        changelog_raw: payload.changelog,
        agent_last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) {
      logger.error("[system/agent] heartbeat falhou", { error: error.message });
      return fail("internal_error", "Não consegui gravar o estado.", 500);
    }

    const { data: version } = await db
      .from("system_version")
      .select("update_requested_at")
      .eq("id", 1)
      .maybeSingle();

    if (!version?.update_requested_at) return ok({ update_requested: false, run_id: null });

    const { data: run } = await db
      .from("system_update_runs")
      .select("id, status")
      .eq("status", "dispatched")
      .order("dispatched_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return ok({ update_requested: Boolean(run), run_id: run?.id ?? null });
  }

  const { data: run } = await db
    .from("system_update_runs")
    .select("id, status")
    .eq("id", payload.run_id)
    .maybeSingle();

  if (!run) return fail("not_found", "Atualização não encontrada.", 404);

  if (payload.kind === "run_progress") {
    if (run.status !== "dispatched") {
      return fail("state_conflict", "Esta atualização já terminou.", 409);
    }
    await db.from("system_update_runs").update({ last_step: payload.step }).eq("id", payload.run_id);
    return ok({ update_requested: false, run_id: payload.run_id });
  }

  if (!canTransition(run.status as RunStatus, payload.status)) {
    return fail("invalid_state_transition", "Esta atualização já terminou.", 409);
  }

  await db
    .from("system_update_runs")
    .update({ status: payload.status, log_tail: payload.log_tail, finished_at: new Date().toISOString() })
    .eq("id", payload.run_id);

  // A ordem foi cumprida (bem ou mal): some com o pedido para o botão voltar.
  await db
    .from("system_version")
    .update({ update_requested_at: null, update_requested_by: null })
    .eq("id", 1);

  await audit({
    action: "system.update_finished",
    resourceType: "system_update_run",
    resourceId: payload.run_id,
    metadata: { status: payload.status },
    actingAsPlatformAdmin: true,
  });

  return ok({ update_requested: false, run_id: payload.run_id });
}
```

> Confirme que `invalid_state_transition`, `state_conflict`, `not_found`, `validation_failed`, `unauthorized` e `internal_error` existem em `lib/api/errors.ts`. Se algum faltar, acrescente ao catálogo em vez de inventar um código solto na rota.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run app/api/v1/system/agent/route.test.ts`
Expected: PASS — 9 casos verdes.

- [ ] **Step 5: Typecheck e lint**

Run: `pnpm typecheck` e depois `pnpm lint`
Expected: ambos zerados. Rode cada um sozinho, **sem** encanar em `| tail` — o exit code viraria o do `tail`.

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/system/agent/ lib/audit/actions.ts
git commit -m "$(cat <<'EOF'
feat(update): endpoint unico do agente do host

heartbeat / run_progress / run_result numa uniao discriminada. A resposta do
heartbeat carrega um booleano — nunca um comando: mesmo com o app comprometido,
o atacante nao escolhe O QUE roda no host, so quando o update.sh assinado roda.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ng41aCYobTn37KrN2V7BZf
EOF
)"
```

---

### Task 5: Rotas da UI (`version` e `update`)

**Files:**
- Create: `app/api/v1/system/version/route.ts`
- Create: `app/api/v1/system/update/route.ts`
- Test: `app/api/v1/system/version/route.test.ts` (cobre as duas)

**Interfaces:**
- Consumes: `extractChangelogSection` (task 2), `isRunStale` (task 3), tabelas (task 1), `loadAuthUser` de `lib/auth/server`, `AuditAction` já estendido na task 4.
- Produces: o corpo do `GET`, que a task 6 tipa como `SystemVersion`:
  ```ts
  // GET /api/v1/system/version → { data: SystemVersion }
  interface SystemVersion {
    current_version: string;
    is_owner: boolean;              // is_platform_admin
    // os campos abaixo só vêm quando is_owner === true:
    latest_version?: string;
    update_available?: boolean;
    off_release?: boolean;
    agent_online?: boolean;         // heartbeat < 24h
    notes?: { body: string; requires_attention: string | null } | null;
    run?: { id: string; status: RunStatus | "unknown"; last_step: RunStep | null } | null;
  }
  ```
  Consumido pelo hook da task 6.

**Decisão de contrato:** o `GET` responde 200 para **qualquer** usuário autenticado, mas só entrega `current_version` e `is_owner: false` para quem não é dono. Assim o rodapé da sidebar mostra a versão para todo mundo (informação inofensiva e útil no suporte) sem vazar estado operacional nem oferecer ação a quem não pode agir.

- [ ] **Step 1: Escrever os testes que falham**

Crie `app/api/v1/system/version/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "dono@x.com", is_platform_admin: true };
const MEMBRO = { ...OWNER, id: "22222222-2222-4222-8222-222222222222", is_platform_admin: false };

let versionRow: Record<string, unknown>;
let runRow: Record<string, unknown> | null;
let inserted: Record<string, unknown> | null;

beforeEach(() => {
  vi.clearAllMocks();
  inserted = null;
  runRow = null;
  versionRow = {
    id: 1,
    current_version: "1.0.0",
    latest_version: "1.1.0",
    off_release: false,
    changelog_raw: "## [1.1.0] — 2026-08-02\n\n**⚠️ Requer atenção**\n\nreconecte o número.\n\n### Adicionado\n\n- botão.\n",
    agent_last_seen_at: new Date().toISOString(),
    update_requested_at: null,
  };

  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: table === "system_version" ? versionRow : runRow, error: null }) }),
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: runRow, error: null }) }) }),
      }),
      insert: (row: Record<string, unknown>) => ({
        select: () => ({ single: async () => { inserted = row; return { data: { id: "44444444-4444-4444-8444-444444444444", ...row }, error: null }; } }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  } as never);
});

function get() {
  return new NextRequest("http://localhost/api/v1/system/version");
}
function post() {
  return new NextRequest("http://localhost/api/v1/system/update", { method: "POST" });
}

describe("GET /api/v1/system/version", () => {
  it("exige sessão", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null as never);
    const { GET } = await import("../version/route");
    expect((await GET(get())).status).toBe(401);
  });

  it("entrega só a versão para quem não é dono do servidor", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(MEMBRO as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.current_version).toBe("1.0.0");
    expect(body.data.is_owner).toBe(false);
    expect(body.data.update_available).toBeUndefined();
    expect(body.data.notes).toBeUndefined();
  });

  it("entrega o estado completo e a seção do CHANGELOG para o dono", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.update_available).toBe(true);
    expect(body.data.notes.body).toContain("botão");
    expect(body.data.notes.requires_attention).toContain("reconecte o número");
  });

  it("marca o agente como offline quando o heartbeat é velho", async () => {
    versionRow.agent_last_seen_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.agent_online).toBe(false);
  });

  it("deriva unknown num run parado há muito tempo", async () => {
    runRow = { id: "55555555-5555-4555-8555-555555555555", status: "dispatched", last_step: "banco",
               dispatched_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.run.status).toBe("unknown");
  });
});

describe("POST /api/v1/system/update", () => {
  it("nega para quem não é dono do servidor", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(MEMBRO as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(403);
    expect(inserted).toBeNull();
  });

  it("cria o run, marca o pedido e audita", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(200);
    expect(inserted).toMatchObject({ from_version: "1.0.0", to_version: "1.1.0", status: "dispatched" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "system.update_requested" }));
  });

  it("recusa um segundo pedido enquanto há run em andamento", async () => {
    runRow = { id: "55555555-5555-4555-8555-555555555555", status: "dispatched",
               dispatched_at: new Date().toISOString() };
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(409);
  });

  it("recusa quando já está na última versão", async () => {
    versionRow.latest_version = "1.0.0";
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(409);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run app/api/v1/system/version/route.test.ts`
Expected: FAIL — módulos não existem.

- [ ] **Step 3: Implementar `GET /api/v1/system/version`**

Crie `app/api/v1/system/version/route.ts`:

```ts
/**
 * GET /api/v1/system/version — estado da atualização para a tela.
 *
 * Responde 200 para qualquer sessão, mas só entrega o estado operacional a
 * quem é dono do servidor (`is_platform_admin`). Quem não pode agir vê apenas
 * a versão instalada: aviso sem ação disponível é só ansiedade.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractChangelogSection } from "@/lib/system/changelog";
import { isRunStale, type RunStatus, type RunStep } from "@/lib/system/update-run";

export const dynamic = "force-dynamic";

/** Sem notícia do agente por 24h, a tela ensina o caminho manual. */
const AGENT_OFFLINE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await loadAuthUser();
  if (!user) return fail("unauthorized", "Faça login para continuar.", 401);

  const db = createAdminClient();
  const { data: version } = await db
    .from("system_version")
    .select("current_version, latest_version, off_release, changelog_raw, agent_last_seen_at")
    .eq("id", 1)
    .maybeSingle();

  const current = version?.current_version ?? "";

  if (!user.is_platform_admin) {
    return ok({ current_version: current, is_owner: false });
  }

  const latest = version?.latest_version ?? "";
  const section = latest ? extractChangelogSection(version?.changelog_raw ?? "", latest) : null;

  const { data: run } = await db
    .from("system_update_runs")
    .select("id, status, last_step, dispatched_at")
    .order("dispatched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const now = new Date();
  const lastSeen = version?.agent_last_seen_at ? Date.parse(version.agent_last_seen_at) : NaN;

  return ok({
    current_version: current,
    is_owner: true,
    latest_version: latest,
    update_available: Boolean(latest) && latest !== current,
    off_release: version?.off_release ?? false,
    agent_online: !Number.isNaN(lastSeen) && now.getTime() - lastSeen < AGENT_OFFLINE_AFTER_MS,
    notes: section ? { body: section.body, requires_attention: section.requiresAttention } : null,
    run: run
      ? {
          id: run.id,
          // `unknown` é derivado aqui, não gravado: um agente morto não
          // consegue anunciar a própria morte.
          status:
            run.status === "dispatched" && isRunStale(run.dispatched_at, now)
              ? ("unknown" as const)
              : (run.status as RunStatus),
          last_step: (run.last_step as RunStep | null) ?? null,
        }
      : null,
  });
}
```

- [ ] **Step 4: Implementar `POST /api/v1/system/update`**

Crie `app/api/v1/system/update/route.ts`:

```ts
/**
 * POST /api/v1/system/update — o clique do dono.
 *
 * Não executa nada: cria o run em `dispatched` e marca o pedido. Quem executa é
 * o agente do host, no próximo heartbeat. O app escreve APENAS esta transição —
 * é o único instante em que ele sabe com certeza que a ordem saiu.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const user = await loadAuthUser();
  if (!user) return fail("unauthorized", "Faça login para continuar.", 401);
  if (!user.is_platform_admin) {
    return fail("forbidden", "Só o dono do servidor pode atualizar o sistema.", 403);
  }

  const db = createAdminClient();
  const { data: version } = await db
    .from("system_version")
    .select("current_version, latest_version")
    .eq("id", 1)
    .maybeSingle();

  const current = version?.current_version ?? "";
  const latest = version?.latest_version ?? "";

  if (!latest || latest === current) {
    return fail("state_conflict", "Você já está na versão mais recente.", 409);
  }

  const { data: running } = await db
    .from("system_update_runs")
    .select("id, status")
    .eq("status", "dispatched")
    .order("dispatched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (running) {
    return fail("state_conflict", "Já existe uma atualização em andamento.", 409);
  }

  const { data: run, error } = await db
    .from("system_update_runs")
    .insert({ from_version: current, to_version: latest, status: "dispatched", requested_by: user.id })
    .select()
    .single();

  if (error || !run) {
    return fail("internal_error", "Não consegui registrar o pedido de atualização.", 500);
  }

  await db
    .from("system_version")
    .update({ update_requested_at: new Date().toISOString(), update_requested_by: user.id })
    .eq("id", 1);

  await audit({
    action: "system.update_requested",
    actorUserId: user.id,
    resourceType: "system_update_run",
    resourceId: run.id,
    metadata: { from_version: current, to_version: latest },
    actingAsPlatformAdmin: true,
  });

  return ok({ run_id: run.id, to_version: latest });
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run app/api/v1/system/version/route.test.ts`
Expected: PASS — 9 casos verdes.

- [ ] **Step 6: Typecheck e lint**

Run: `pnpm typecheck`, depois `pnpm lint`
Expected: zerados.

- [ ] **Step 7: Commit**

```bash
git add app/api/v1/system/version/ app/api/v1/system/update/
git commit -m "$(cat <<'EOF'
feat(update): rotas de estado e de pedido de atualizacao

Quem nao e dono do servidor recebe 200 com a versao instalada e nada mais —
aviso sem acao disponivel e so ansiedade, e estado operacional nao e assunto
de inquilino.

O POST nao executa nada: cria o run em `dispatched` e marca o pedido. Essa e a
UNICA transicao que o app escreve, porque e o unico instante em que ele sabe
com certeza que a ordem saiu.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ng41aCYobTn37KrN2V7BZf
EOF
)"
```

---

### Task 6: Rodapé da sidebar

**Files:**
- Create: `hooks/system/useSystemVersion.ts`
- Create: `components/shell/VersionFooter.tsx`
- Modify: `components/shell/Sidebar.tsx:121-135` (o bloco `<div className="border-t p-2">` do botão Recolher)

**Interfaces:**
- Consumes: `GET /api/v1/system/version` (task 5).
- Produces:
  ```ts
  export interface SystemVersion { current_version: string; is_owner: boolean; update_available?: boolean;
    latest_version?: string; off_release?: boolean; agent_online?: boolean;
    notes?: { body: string; requires_attention: string | null } | null;
    run?: { id: string; status: string; last_step: string | null } | null; }
  export function useSystemVersion(opts?: { refetchInterval?: number }): UseQueryResult<SystemVersion>;
  export function VersionFooter({ collapsed }: { collapsed: boolean }): JSX.Element;
  ```

**Padrão a seguir:** copie a forma de `hooks/channels/useChannelSessions.ts` (TanStack Query + `apiClient`) e de `components/connections/ConnectionHealthDot.tsx`.

- [ ] **Step 1: Criar o hook**

Crie `hooks/system/useSystemVersion.ts`:

```ts
"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface SystemVersion {
  current_version: string;
  is_owner: boolean;
  latest_version?: string;
  update_available?: boolean;
  off_release?: boolean;
  agent_online?: boolean;
  notes?: { body: string; requires_attention: string | null } | null;
  run?: { id: string; status: string; last_step: string | null } | null;
}

/**
 * Estado da versão desta instalação. Fonte única do rodapé da sidebar e da
 * tela de atualização. Poll folgado (5 min) porque o agente do host só reporta
 * a cada 5 min — bater mais rápido não traria informação nova.
 */
export function useSystemVersion(opts?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: ["system-version"],
    queryFn: async () => {
      const res = await apiClient.get<{ data: SystemVersion }>("/api/v1/system/version");
      return res.data;
    },
    staleTime: 60_000,
    refetchInterval: opts?.refetchInterval ?? 5 * 60_000,
  });
}
```

> Confira em `lib/api/client.ts` se `apiClient.get` devolve `{data}` ou já desembrulha — `useChannelSessions` retorna `res.data`; siga o mesmo comportamento observado, não este plano.

- [ ] **Step 2: Criar o rodapé**

Crie `components/shell/VersionFooter.tsx`:

```tsx
"use client";
import Link from "next/link";

import { ArrowCircleUp } from "@/lib/ui/icons";
import { useSystemVersion } from "@/hooks/system/useSystemVersion";
import { cn } from "@/lib/utils";

/**
 * Versão instalada no rodapé da sidebar. Vira um aviso clicável só para quem
 * é dono do servidor E tem versão nova — quem não pode atualizar não é
 * alertado sobre algo que não pode resolver.
 */
export function VersionFooter({ collapsed }: { collapsed: boolean }) {
  const { data } = useSystemVersion();
  if (!data?.current_version) return null;

  const label = data.current_version.replace(/^v/i, "");
  const alerta = data.is_owner && (data.update_available || data.off_release);

  if (!alerta) {
    return (
      <p
        className={cn("px-3 py-1 text-[11px] text-muted-foreground/70", collapsed && "px-0 text-center")}
        title={`Versão ${label}`}
      >
        {collapsed ? label.split(".").slice(0, 2).join(".") : `versão ${label}`}
      </p>
    );
  }

  const novo = data.latest_version?.replace(/^v/i, "") ?? "";
  return (
    <Link
      href="/app/settings/atualizacao"
      title={`Nova versão ${novo} disponível`}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-xs text-foreground hover:bg-accent/50",
        collapsed && "justify-center px-2",
      )}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
      </span>
      {!collapsed && (
        <span className="truncate">
          Nova versão{novo ? ` · ${novo}` : ""}
        </span>
      )}
      {collapsed && <ArrowCircleUp size={16} aria-hidden />}
    </Link>
  );
}
```

Confirme que `ArrowCircleUp` existe em `lib/ui/icons`; se não, acrescente o re-export seguindo o padrão dos ícones vizinhos (Phosphor).

- [ ] **Step 3: Montar no Sidebar**

Em `components/shell/Sidebar.tsx`, importe o componente e insira **acima** do botão "Recolher", dentro do `<div className="border-t p-2">`:

```tsx
      <div className="border-t p-2">
        <VersionFooter collapsed={collapsed} />
        <button
          type="button"
          onClick={() => startTransition(() => toggleSidebar(collapsed))}
```

- [ ] **Step 4: Provar na tela**

Suba o app (`pnpm dev` ou o ambiente que você já usa), entre com uma conta que seja dono do servidor e confirme:
1. sem versão nova → texto cinza `versão 1.0.0` no rodapé;
2. simule versão nova com um heartbeat assinado:
   ```bash
   curl -sS -X POST http://localhost:3000/api/v1/system/agent \
     -H "Authorization: Bearer $INTERNAL_SECRET" -H 'content-type: application/json' \
     -d '{"kind":"heartbeat","current_version":"1.0.0","current_sha":"abc1234","off_release":false,"latest_version":"1.1.0","changelog":"## [1.1.0] — 2026-08-02\n\n### Adicionado\n\n- botão de atualizar pela tela.\n"}'
   ```
3. recarregue e confirme o item com ponto pulsando;
4. recolha a sidebar e confirme que o ponto e o ícone continuam visíveis.

Tire screenshot dos estados e guarde em `.superpowers/evidence/`.

- [ ] **Step 5: Typecheck, lint e commit**

Run: `pnpm typecheck`, depois `pnpm lint`
Expected: zerados.

```bash
git add hooks/system/ components/shell/VersionFooter.tsx components/shell/Sidebar.tsx
git commit -m "$(cat <<'EOF'
feat(update): versao instalada no rodape da sidebar

Vira aviso clicavel so para quem e dono do servidor E tem versao nova. Quem nao
pode atualizar ve apenas o numero em cinza — alertar quem nao pode agir e so
ansiedade.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ng41aCYobTn37KrN2V7BZf
EOF
)"
```

---

### Task 7: Tela de atualização

**Files:**
- Create: `app/app/settings/atualizacao/page.tsx`
- Create: `app/app/settings/atualizacao/_components/UpdatePanel.tsx`

**Interfaces:**
- Consumes: `useSystemVersion` (task 6), `POST /api/v1/system/update` (task 5).
- Produces: rota `/app/settings/atualizacao`, alvo do link do rodapé.

**Os quatro estados** (spec §5.2): em dia · tem novidade · atualizando · sem agente.

- [ ] **Step 1: Página com a guarda**

Crie `app/app/settings/atualizacao/page.tsx`:

```tsx
import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { UpdatePanel } from "./_components/UpdatePanel";

export const metadata = { title: "Atualização do sistema" };

/**
 * Só o dono do servidor. Um `notFound()` em vez de uma tela de "sem permissão"
 * porque, para quem não é dono, esta página simplesmente não faz parte do
 * produto.
 */
export default async function Page() {
  const user = await loadAuthUser();
  if (!user?.is_platform_admin) notFound();
  return <UpdatePanel />;
}
```

- [ ] **Step 2: O painel com os quatro estados**

Crie `app/app/settings/atualizacao/_components/UpdatePanel.tsx`:

```tsx
"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { apiClient } from "@/lib/api/client";
import { useSystemVersion } from "@/hooks/system/useSystemVersion";
import { Button } from "@/components/ui/button";

const COMANDO_MANUAL = "cd SonghaiCRM && bash hostgator-setup-kit/update.sh";

const PASSOS = [
  { chave: "backup", texto: "Guardando uma cópia de segurança dos seus dados" },
  { chave: "codigo", texto: "Baixando a versão nova" },
  { chave: "banco", texto: "Atualizando o banco de dados" },
  { chave: "app", texto: "Reiniciando o sistema" },
] as const;

export function UpdatePanel() {
  const { data, isError } = useSystemVersion({ refetchInterval: 5_000 });
  const queryClient = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);

  const atualizar = useMutation({
    mutationFn: async () => apiClient.post("/api/v1/system/update", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["system-version"] }),
    onError: () => setErro("Não consegui iniciar a atualização. Tente de novo em instantes."),
  });

  // O app reinicia no meio da atualização: a requisição falhar aqui é
  // ESPERADO, não é erro. Só é erro se nunca houve run.
  const rodando = data?.run?.status === "dispatched";
  if (isError && rodando) return <Reiniciando />;
  if (!data) return <p className="p-6 text-sm text-muted-foreground">Carregando…</p>;

  const versao = data.current_version.replace(/^v/i, "");
  const nova = data.latest_version?.replace(/^v/i, "") ?? "";

  if (rodando) {
    return (
      <Secao titulo={`Atualizando para a versão ${nova}`}>
        <ol className="space-y-2 text-sm">
          {PASSOS.map((passo) => {
            const indice = PASSOS.findIndex((p) => p.chave === data.run?.last_step);
            const atual = PASSOS.findIndex((p) => p.chave === passo.chave);
            const feito = indice >= 0 && atual <= indice;
            return (
              <li key={passo.chave} className={feito ? "text-foreground" : "text-muted-foreground"}>
                {feito ? "✓" : "○"} {passo.texto}
              </li>
            );
          })}
        </ol>
        <p className="mt-4 text-sm text-muted-foreground">
          O sistema sai do ar por alguns instantes e volta sozinho. Pode deixar esta página aberta.
        </p>
      </Secao>
    );
  }

  if (data.run?.status === "failed" || data.run?.status === "failed_rolled_back") {
    return (
      <Secao titulo="A atualização não deu certo">
        <p className="text-sm">
          Voltei para a versão anterior ({versao}) e os seus dados estão intactos. O banco de dados
          já tinha sido atualizado e permanece assim — isso é seguro, a versão anterior funciona com
          ele. Se quiser desfazer também o banco, use a cópia de segurança feita antes da tentativa
          (<code>bash hostgator-setup-kit/restore.sh</code>).
        </p>
      </Secao>
    );
  }

  if (data.run?.status === "unknown") {
    return (
      <Secao titulo="Não sei dizer como terminou">
        <p className="text-sm">
          Comecei a atualização mas perdi contato com o servidor antes do fim. Confira se o sistema
          está funcionando normalmente. Se estiver, provavelmente deu certo — a versão instalada
          aparece aqui: <strong>{versao}</strong>.
        </p>
      </Secao>
    );
  }

  if (!data.agent_online) {
    return (
      <Secao titulo="Atualização automática indisponível">
        <p className="text-sm">
          Não estou conseguindo falar com o servidor onde o sistema está instalado, então não posso
          atualizar sozinho. Quem tem acesso ao servidor pode rodar este comando uma vez — depois
          disso o botão passa a funcionar:
        </p>
        <Comando />
        <p className="mt-3 text-sm text-muted-foreground">Versão instalada: {versao}.</p>
      </Secao>
    );
  }

  if (!data.update_available && !data.off_release) {
    return (
      <Secao titulo={`Você está na versão ${versao}`}>
        <p className="text-sm text-muted-foreground">É a mais recente. Não há nada a fazer.</p>
      </Secao>
    );
  }

  return (
    <Secao titulo={`Versão ${nova} disponível`}>
      {data.off_release && (
        <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          Sua instalação está numa versão de desenvolvimento. Atualizar vai levá-la para a versão
          publicada {nova}.
        </p>
      )}

      {data.notes?.requires_attention && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <p className="mb-1 font-medium">⚠️ Requer atenção</p>
          <p className="whitespace-pre-line">{data.notes.requires_attention}</p>
        </div>
      )}

      {data.notes?.body && (
        <div className="mb-6">
          <p className="mb-2 text-sm font-medium">O que muda</p>
          <pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground">
            {data.notes.body}
          </pre>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => atualizar.mutate()} disabled={atualizar.isPending}>
          {atualizar.isPending ? "Iniciando…" : "Atualizar agora"}
        </Button>
        <span className="text-sm text-muted-foreground">
          O sistema sai do ar por cerca de 2 minutos e volta sozinho. Faço uma cópia de segurança
          dos seus dados antes.
        </span>
      </div>
      {erro && <p className="mt-3 text-sm text-error">{erro}</p>}
    </Secao>
  );
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-4 text-lg font-semibold tracking-tight">{titulo}</h1>
      {children}
    </div>
  );
}

function Reiniciando() {
  return (
    <Secao titulo="Reiniciando…">
      <p className="text-sm text-muted-foreground">
        O sistema está voltando. Esta página se atualiza sozinha em alguns instantes.
      </p>
    </Secao>
  );
}

function Comando() {
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="mt-3 flex items-center gap-2">
      <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
        {COMANDO_MANUAL}
      </code>
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(COMANDO_MANUAL);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        }}
      >
        {copiado ? "Copiado" : "Copiar"}
      </Button>
    </div>
  );
}
```

Ajuste imports de `Button` e classes de cor (`text-error`, `border-warning`) para os tokens reais do design system deste repo — confira num componente vizinho, por exemplo em `app/app/settings/security/`.

- [ ] **Step 3: Provar os quatro estados pela tela**

Com o app rodando e logado como dono, exercite cada estado via `curl` no endpoint do agente (mesmo comando do Step 4 da task 6) e via SQL direto quando necessário:

1. **em dia:** heartbeat com `current_version == latest_version` → "Você está na versão X".
2. **tem novidade:** heartbeat com `latest_version` maior e changelog com bloco de atenção → o bloco aparece **acima** do botão.
3. **atualizando:** clique em "Atualizar agora", depois `POST` com `kind: "run_progress", step: "banco"` → os dois primeiros passos marcados.
4. **sem agente:** `update public.system_version set agent_last_seen_at = now() - interval '2 days';` → tela com o comando e o botão de copiar.

Screenshot de cada um em `.superpowers/evidence/`.

- [ ] **Step 4: Typecheck, lint e commit**

Run: `pnpm typecheck`, depois `pnpm lint`
Expected: zerados.

```bash
git add app/app/settings/atualizacao/
git commit -m "$(cat <<'EOF'
feat(update): tela de atualizacao com os quatro estados

Pagina em vez de modal: um progresso de dois minutos com o servidor
reiniciando no meio nao cabe num modal.

Requisicao falhando enquanto ha run em andamento nao e erro — e o app
reiniciando; a tela mostra "reiniciando" e reconecta sozinha.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ng41aCYobTn37KrN2V7BZf
EOF
)"
```

---

### Task 8: O agente do host e o `update.sh` por tag

**Files:**
- Create: `hostgator-setup-kit/agent.sh`
- Modify: `hostgator-setup-kit/update.sh` (`--to`, checkout de tag, imagem versionada, rollback)
- Modify: `hostgator-setup-kit/_common.sh` (nova função `setup_update_agent_cron`)
- Modify: `hostgator-setup-kit/install.sh` (chamar a nova função)

**Interfaces:**
- Consumes: `POST /api/v1/system/agent` (task 4).
- Produces: cron no host; `update.sh --to <tag>`.

- [ ] **Step 1: Escrever o `agent.sh`**

Crie `hostgator-setup-kit/agent.sh`:

```bash
#!/usr/bin/env bash
# Agente de atualização: roda por cron a cada 5 minutos no HOST.
#
# Ele NÃO recebe comandos do app — recebe um booleano. Anuncia a versão
# instalada, lê na resposta se alguém clicou em "Atualizar agora" na tela e, se
# sim, roda o update.sh da tag publicada. É o que mantém o CRM em container sem
# nenhum acesso ao Docker do host.
source "$(dirname "$0")/_common.sh"
enter_project

SECRET="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
[ -n "$SECRET" ] || exit 0
[ -n "${NEXT_PUBLIC_APP_URL:-}" ] || exit 0

API="${NEXT_PUBLIC_APP_URL}/api/v1/system/agent"
LOCK="${PROJECT_DIR}/.update.lock"
LOG="${PROJECT_DIR}/.update.log"

post() {  # post <json> → corpo da resposta
  curl -fsS -X POST "$API" \
    -H "Authorization: Bearer ${SECRET}" \
    -H 'Content-Type: application/json' \
    --max-time 20 -d "$1" 2>/dev/null || true
}

json_field() {  # json_field <corpo> <campo> — sem jq, que pode não existir no VPS
  printf '%s' "$1" | tr ',' '\n' | grep -o "\"$2\":[^,}]*" | head -1 | cut -d: -f2- | tr -d '" '
}

# ── 1. Que versão está instalada e qual é a última publicada? ────────────────
git fetch --tags --quiet origin 2>/dev/null || true

CURRENT_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
CURRENT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
LATEST_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"

if [ -n "$CURRENT_TAG" ]; then
  CURRENT="$CURRENT_TAG"; OFF_RELEASE=false
else
  CURRENT="$CURRENT_SHA";  OFF_RELEASE=true
fi

CHANGELOG=""
if [ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "$CURRENT" ]; then
  CHANGELOG="$(git show "${LATEST_TAG}:CHANGELOG.md" 2>/dev/null | head -c 60000 || true)"
fi

# Escapa para JSON sem depender de jq: barras, aspas e quebras de linha.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'BEGIN{ORS="\\n"}{print}'; }

BODY="{\"kind\":\"heartbeat\",\"current_version\":\"${CURRENT}\",\"current_sha\":\"${CURRENT_SHA}\",\"off_release\":${OFF_RELEASE},\"latest_version\":\"${LATEST_TAG}\",\"changelog\":\"$(esc "$CHANGELOG")\"}"
RESP="$(post "$BODY")"

[ "$(json_field "$RESP" update_requested)" = "true" ] || exit 0
RUN_ID="$(json_field "$RESP" run_id)"
[ -n "$RUN_ID" ] || exit 0

# ── 2. Alguém pediu. Uma atualização por vez. ────────────────────────────────
exec 9>"$LOCK"
flock -n 9 || exit 0

report() { post "{\"kind\":\"run_progress\",\"run_id\":\"${RUN_ID}\",\"step\":\"$1\"}" >/dev/null; }

# Guarda a imagem em execução ANTES de puxar a nova: é por onde a gente volta
# se o app novo não subir.
PREV_IMAGE="$(docker compose -f "$COMPOSE" images -q app 2>/dev/null | head -1)"

set +e
DESKCOMM_AGENT_REPORT=1 \
DESKCOMM_AGENT_PREV_IMAGE="$PREV_IMAGE" \
DESKCOMM_AGENT_REPORT_CMD="$(declare -f report); report" \
  bash "$(dirname "$0")/update.sh" --to "$LATEST_TAG" >"$LOG" 2>&1
RC=$?
set -e

# ── 3. O app voltou? Se não, volta a imagem anterior. ───────────────────────
STATUS="success"
if [ $RC -ne 0 ]; then
  STATUS="failed"
  if [ -n "$PREV_IMAGE" ]; then
    APP_IMAGE="$PREV_IMAGE" APP_PULL_POLICY=missing \
      docker compose -f "$COMPOSE" up -d app >>"$LOG" 2>&1 && STATUS="failed_rolled_back"
  fi
fi

TAIL="$(tail -40 "$LOG" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'BEGIN{ORS="\\n"}{print}')"

# O app acabou de reiniciar: insiste por ~2 min antes de desistir.
for _ in $(seq 1 12); do
  OUT="$(post "{\"kind\":\"run_result\",\"run_id\":\"${RUN_ID}\",\"status\":\"${STATUS}\",\"log_tail\":\"${TAIL}\"}")"
  [ -n "$OUT" ] && break
  sleep 10
done
```

- [ ] **Step 2: Provar o `agent.sh` contra o app local, sem tocar no host**

Com o app rodando local e o `.env` carregado:

Run: `bash hostgator-setup-kit/agent.sh` (com `update_requested=false` no banco)
Expected: sai em silêncio, código 0, e `system_version.agent_last_seen_at` atualiza. Confirme com:
```sql
select current_version, latest_version, agent_last_seen_at from public.system_version;
```
Se `agent_last_seen_at` não mudou, o heartbeat não chegou — investigue o `curl` antes de seguir.

- [ ] **Step 3: Ensinar o `update.sh` a receber `--to`**

Em `hostgator-setup-kit/update.sh`:

1. No laço de flags (linhas 14-19), acrescente:
```bash
    --to) shift; TARGET_TAG="$1" ;;
```
   e declare `TARGET_TAG=""` junto de `FORCE`/`SKIP_BACKUP`.

2. Substitua o bloco 1 ("Tem atualização mesmo?") para comparar contra a tag:
```bash
step "Procurando atualizações"
git fetch --tags --quiet origin 2>/dev/null || c_ylw "⚠ não consegui falar com o GitHub — sigo com o código que já está aqui."
[ -n "$TARGET_TAG" ] || TARGET_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"
[ -n "$TARGET_TAG" ] || die "Não encontrei nenhuma versão publicada para instalar."
CURRENT_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
if [ "$CURRENT_TAG" = "$TARGET_TAG" ] && [ -z "$FORCE" ]; then
  c_grn "✓ Você já está na versão mais recente ($TARGET_TAG). Nada a atualizar."
  exit 0
fi
c_ylw "Vou atualizar para a versão $TARGET_TAG com segurança."
```

3. No bloco 3, troque `git pull --ff-only` por checkout da tag:
```bash
step "Baixando o código novo"
if ! git checkout --quiet "$TARGET_TAG" 2>&1; then
  die "Não consegui trocar para a versão $TARGET_TAG (parece haver mudanças locais que divergem).
     Rode 'git status' pra ver, ou peça ajuda. NÃO mexi no banco — está tudo como estava."
fi
```

4. No bloco 5, use a imagem versionada:
```bash
step "Baixando a versão nova do app e reiniciando"
export APP_IMAGE="ghcr.io/melgarafael/deskcommcrm:${TARGET_TAG#v}"
docker compose -f "$COMPOSE" pull
docker compose -f "$COMPOSE" up -d
```

5. Depois de cada um dos três passos, informe o agente quando ele estiver dirigindo:
```bash
[ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" backup   # após o backup
[ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" codigo   # após o checkout
[ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" banco    # após o baseline
```

6. No bloco 6, faça o script **sair com código diferente de zero** quando o app não voltar saudável — é o que dispara o rollback no agente:
```bash
if [ -n "$ok" ]; then
  c_grn "✓ Atualização concluída — app no ar e saudável."
else
  c_ylw "⚠ Atualizei, mas o app não respondeu 'ok'. Veja os logs:"
  c_ylw "  docker compose -f $COMPOSE logs --tail=50 app"
  exit 1
fi
```

- [ ] **Step 4: Instalar o cron do agente**

Em `hostgator-setup-kit/_common.sh`, acrescente logo após `setup_event_log_drain_cron()`:

```bash
setup_update_agent_cron() {
  command -v crontab >/dev/null 2>&1 || { c_ylw "⚠ 'crontab' não encontrado — o botão de atualizar pela tela não vai funcionar."; return 0; }
  local secret="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
  [ -n "$secret" ] || { c_ylw "⚠ falta INTERNAL_SECRET — não ativei o agente de atualização."; return 0; }
  [ -n "${NEXT_PUBLIC_APP_URL:-}" ] || { c_ylw "⚠ falta NEXT_PUBLIC_APP_URL — não ativei o agente de atualização."; return 0; }

  local cron_line="*/5 * * * * bash ${PROJECT_DIR}/hostgator-setup-kit/agent.sh >/dev/null 2>&1"
  # "|| true": com pipefail, grep -v sem match sai 1 e derrubaria o subshell.
  ( crontab -l 2>/dev/null | grep -v 'hostgator-setup-kit/agent.sh' || true; echo "$cron_line" ) | crontab -
  c_grn "✓ atualização pela tela ativa (agente a cada 5 minutos)"
}
```

Chame-a em **dois** lugares, ao lado de `setup_event_log_drain_cron`:
- `hostgator-setup-kit/install.sh` (no passo das automações);
- `hostgator-setup-kit/update.sh` (bloco 7) — é isso que faz o botão passar a existir para quem já tem o CRM instalado.

Torne o script executável: `chmod +x hostgator-setup-kit/agent.sh`.

- [ ] **Step 5: Provar o ciclo completo local**

1. Clique em "Atualizar agora" na tela.
2. Rode `bash hostgator-setup-kit/agent.sh` à mão (simulando o cron).
3. Confirme na tela: passos avançando e, no fim, "Você está na versão X".
4. Confirme que a segunda execução imediata do `agent.sh` não dispara nada (o pedido foi limpo).

- [ ] **Step 6: Commit**

```bash
git add hostgator-setup-kit/
git commit -m "$(cat <<'EOF'
feat(update): agente do host e update.sh por tag publicada

O agente puxa a ordem em vez de o app empurrar comando: nenhuma porta nova,
nenhum socket do Docker, nenhum volume no compose.

update.sh passa a instalar a TAG publicada (nao o topo da main) e a sair com
codigo != 0 quando o app nao volta saudavel — e esse codigo que dispara a volta
para a imagem anterior, guardada antes do pull.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ng41aCYobTn37KrN2V7BZf
EOF
)"
```

---

### Task 9: Prova pela tela e documentação

**Files:**
- Create: `tests/e2e/system-update.spec.ts`
- Modify: `CHANGELOG.md` (seção `[Não lançado]`)
- Modify: `hostgator-setup-kit/CLAUDE.md` (seção "Depois de instalado")
- Modify: `docs/architecture/` (mapa vivo — a peça e suas arestas)

**Interfaces:**
- Consumes: tudo das tasks anteriores.

- [ ] **Step 1: Escrever o E2E**

Crie `tests/e2e/system-update.spec.ts`. **Copie as funções `login(page, email)` e `loginWithTotp(page, email, secret)` e a leitura de `.e2e-creds.json` de `tests/e2e/rbac-roles.spec.ts`** (linhas 26-60) — o dono do servidor é o usuário `admin` do seed, que tem MFA, então ele entra por `loginWithTotp` com `creds.admin_totp.secret`; o usuário `agent` entra por `login`. As credenciais vêm de `scripts/seed-e2e-credentials.ts`; o spec deve pular sozinho (`test.skip`) se o arquivo estiver ausente, como os vizinhos fazem.

```ts
import { expect, test } from "@playwright/test";

/**
 * Prova pela TELA, como o dono faria (doutrina de QA visual, DoD 12).
 * O agente do host é simulado por requisições assinadas — o que se prova aqui
 * é a experiência, não o bash.
 */
const SECRET = process.env.INTERNAL_SECRET ?? "";

async function heartbeat(request: import("@playwright/test").APIRequestContext, latest: string) {
  const res = await request.post("/api/v1/system/agent", {
    headers: { Authorization: `Bearer ${SECRET}` },
    data: {
      kind: "heartbeat",
      current_version: "1.0.0",
      current_sha: "abc1234",
      off_release: false,
      latest_version: latest,
      changelog: `## [${latest}] — 2026-08-02\n\n**⚠️ Requer atenção**\n\nReconecte o número depois.\n\n### Adicionado\n\n- Botão de atualizar pela tela.\n`,
    },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

test("o dono vê a versão nova na sidebar e atualiza pela tela", async ({ page, request }) => {
  await loginWithTotp(page, creds.users.admin!.email, creds.admin_totp!.secret);
  await heartbeat(request, "1.1.0");
  await page.goto("/app/inbox");

  const aviso = page.getByRole("link", { name: /nova versão/i });
  await expect(aviso).toBeVisible();
  await aviso.click();

  await expect(page.getByRole("heading", { name: /versão 1\.1\.0 disponível/i })).toBeVisible();
  await expect(page.getByText(/Reconecte o número depois/)).toBeVisible();
  await expect(page.getByText(/Botão de atualizar pela tela/)).toBeVisible();

  // O bloco de atenção precisa vir ANTES do botão na ordem visual.
  const atencao = await page.getByText(/Reconecte o número depois/).boundingBox();
  const botao = await page.getByRole("button", { name: /atualizar agora/i }).boundingBox();
  expect(atencao!.y).toBeLessThan(botao!.y);

  await page.getByRole("button", { name: /atualizar agora/i }).click();
  await expect(page.getByText(/Guardando uma cópia de segurança/)).toBeVisible();

  // O agente reporta o desfecho.
  const { data } = await heartbeat(request, "1.1.0");
  await request.post("/api/v1/system/agent", {
    headers: { Authorization: `Bearer ${SECRET}` },
    data: { kind: "run_result", run_id: data.run_id, status: "success", log_tail: "ok" },
  });
  await heartbeat(request, "1.1.0");
  await page.reload();
  await expect(page.getByRole("heading", { name: /você está na versão/i })).toBeVisible();
});

test("quem não é dono do servidor não vê o botão", async ({ page }) => {
  await login(page, creds.users.agent!.email);
  await page.goto("/app/inbox");
  await expect(page.getByRole("link", { name: /nova versão/i })).toHaveCount(0);
  await page.goto("/app/settings/atualizacao");
  await expect(page.getByText(/404|não encontrada/i)).toBeVisible();
});
```

Nota sobre o segundo caso: `INTERNAL_SECRET` precisa estar no ambiente do Playwright. Se `SECRET` vier vazio, o `heartbeat` responde 401 e o teste falha por motivo errado — comece o arquivo com `test.skip(!SECRET, "INTERNAL_SECRET ausente")` para que a ausência de env apareça como skip explícito, nunca como falha enganosa.

- [ ] **Step 2: Rodar o E2E**

Run: `pnpm test:e2e tests/e2e/system-update.spec.ts`
Expected: PASS nos dois casos. Guarde trace/screenshot em `.superpowers/evidence/`.

- [ ] **Step 3: Documentar**

1. `CHANGELOG.md`, sob `## [Não lançado]`:
```markdown
### Adicionado

- **Atualização pela própria tela.** O dono da instalação vê a versão instalada no rodapé do menu
  e, quando há versão nova, atualiza com um clique — sem abrir terminal. A tela mostra o que muda,
  avisa quanto tempo o sistema fica fora do ar e faz uma cópia de segurança antes.

**⚠️ Requer atenção**

Quem já tem o CRM instalado precisa rodar `bash hostgator-setup-kit/update.sh` **uma vez** pelo
terminal para ativar o botão. A partir daí, nunca mais.
```

2. `hostgator-setup-kit/CLAUDE.md`, na seção "Depois de instalado": diga que atualizar agora é
   pelo próprio CRM (menu → rodapé → *Nova versão*), que o `update.sh` continua existindo para
   o caso de o agente estar fora do ar, e que o alvo agora é a última tag publicada.

3. `docs/architecture/`: acrescente a peça **atualização self-service** com no mínimo duas
   arestas — `agent.sh (host)` → `/api/v1/system/agent` → `system_update_runs`, e
   `system_version` → rodapé da sidebar. Siga o formato do arquivo de mapa existente.

- [ ] **Step 4: Verificação final**

Rode, **um comando por vez**, lendo a saída de cada um (nada de `| tail` num encadeamento — o exit code viraria o do `tail`):

```
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:db
```
Expected: todos verdes.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/system-update.spec.ts CHANGELOG.md hostgator-setup-kit/CLAUDE.md docs/architecture/
git commit -m "$(cat <<'EOF'
test(update): prova pela tela e documentacao da atualizacao self-service

O E2E mede a ordem visual por ferramenta (boundingBox), nao a olho: o bloco
"Requer atencao" tem que vir ANTES do botao, senao quem precisa agir a mao
descobre depois de ja ter clicado.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ng41aCYobTn37KrN2V7BZf
EOF
)"
```

---

## Prova final na VPS (fora do plano de código, obrigatória antes de declarar pronto)

O E2E prova a tela; ele **não** prova o host. Antes de considerar a feature entregue:

1. Publicar uma tag de teste e deixar a imagem correspondente no GHCR.
2. Na VPS (`ssh -p 22022 root@129.121.45.100`), rodar `bash hostgator-setup-kit/update.sh` uma vez
   pelo terminal — é o bootstrap que instala o agente.
3. Confirmar `crontab -l` com a linha do `agent.sh`.
4. Publicar a tag seguinte e esperar (ou forçar) um ciclo do agente.
5. Clicar em "Atualizar agora" **pela tela**, cronometrar o tempo fora do ar e confirmar que a
   página volta sozinha em "Você está na versão X".
6. Provar o caminho ruim: publicar uma imagem que não sobe, clicar, e confirmar que o sistema
   volta para a versão anterior e a tela explica o que aconteceu.

Sem o passo 6, a feature não tem rede de proteção provada — só declarada.
