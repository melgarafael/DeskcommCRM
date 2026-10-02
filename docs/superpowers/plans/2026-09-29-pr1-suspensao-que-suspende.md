# PR 1 — Suspensão que suspende de verdade — Plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para executar tarefa por tarefa. Passos com checkbox (`- [ ]`).

**Goal:** suspender uma organização passa a calar a IA, os envios, os crons, o token `dsk_`/MCP e a sessão dela (sem bloquear LGPD nem a entrada de mensagens); `support_readonly` deixa de escrever; reativar não solta rajada e abre um item de revisão na Central.

**Architecture:** uma régua única (`lib/organizacao/operante.ts` + `public.fn_org_operante(uuid)`: opera ⇔ `status = 'active'`, falha fechada). O estado da org só muda por duas funções `security definer` (`fn_suspender_organizacao`, `fn_reativar_organizacao`) e por service role; um gatilho fecha o PostgREST. Sessão: `orgAtivaSemPortao` (sem redirect) sob `resolveActiveOrg` (redirect para o hub `/account-suspended`); `requireRole` responde 403 `org_suspended`. Execução: veto no gate de elegibilidade, `naOrgParada` no barramento, filtros nos crons/workers, assert na porta de saída (`sendMessageHandler`). Duas cercas AST vigiam a régua e a escrita de platform admin.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6 estrito, Supabase (Postgres 15/17, PostgREST, RLS), `pg` no agent-engine, Vitest 4, Playwright, Zod 4.

**Spec:** `docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md` (§1.3, §2.1, §2.5, §2.6, §2.7, §3.1, §4, §9 "Suspenso", §11 PR 1, §12, §13, §14 PR 1, §15, §16).

**Base medida:** `origin/main` = `d03c2b2fd` (spec em `05eee792f`, sobre `c31d421c5`). A main andou 27 commits desde `c31d421c5`; dos arquivos que este plano toca, mudaram `lib/auth/server.ts` e `lib/auth/types.ts` (moeda e país da organização, #1945, inclusive a leitura por service role no ramo de acompanhamento de `resolveActiveOrg`), `lib/i18n/dicionario.ts` (+11 linhas antes de `"Solicitações LGPD"`), `tests/unit/auth-falha-alto.test.ts` e o novo `tests/unit/telas-falam-a-moeda-e-o-pais-da-organizacao.test.tsx` — a Task 8 foi reescrita sobre eles. Nenhuma migration nova (o teto segue `0491`), `baseline.sql` idêntico (VARREDURA em `:42990`, CHECK de kind em `:9997-10110`). Números de linha envelhecem: o **conteúdo** citado (âncora de Edit) é a autoridade. Antes de cada Edit, reconfirme a âncora com o `grep -n` do passo.

---

## Global Constraints

- Worktree `~/deskcomm-saas/pr1`, branch `feat/org-operante`, criada de `origin/main`; `node_modules` real via `pnpm install --frozen-lockfile`, **nunca** symlink nem emprestado; nunca em `/tmp`.
- Todo comando começa com `cd ~/deskcomm-saas/pr1 || exit 1`.
- Nunca `git reset --hard`, `--force`, `--no-verify`; para atualizar com a main: `git fetch origin && git merge origin/main`.
- Migration: `supabase/migrations/20260929180000_0492_org_operante_e_suspensao_tipada.sql` — `0492` é o próximo livre **no merge** (main vai até `20260929115848_0491`; o teto é a main MAIS todo PR aberto). Renumerar = trocar em todos os lugares (`grep -rn 0492 supabase lib tests`).
- Migration idempotente (`add column if not exists`, `drop constraint if exists` + backfill + `add`, `create or replace function`, `drop trigger if exists` + `create`), sem `BEGIN`/`COMMIT`, sem temp table.
- Apêndice no `supabase/baseline.sql` rotulado `-- ---- org operante e suspensão tipada (migration 0492) ----`, imediatamente ACIMA de `-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----` (hoje `:42990`); o kind `org_reativada` entra NO LUGAR, no bloco único de `agent_inbox_items_kind_check` (hoje `:9997-10110`).
- Toda função nova em `public`: `revoke execute on function public.fn_x(...) from public, anon, authenticated;` + `grant execute ... to service_role;` (a função de gatilho: só o revoke).
- Uma linha no fim da tabela "Applied" de `supabase/migrations/MANIFEST.md` (`merge=union`: conferir duplicata depois de cada merge).
- `lib/database.types.ts` é editado à mão no formato gerado (não há script de geração; precedente `9834a1e82`).
- Régua: operante ⇔ `organizations.status = 'active'`; `suspended`/`redacted`/`archived`/desconhecido/nulo = não operante. `suspended_kind` só significa algo com `status = 'suspended'`; tipo nulo vale como `administrativa`.
- `lib/organizacao/operante.ts` não importa `next/*` nem `server-only` (é carregado sob `tsx` no worker).
- Códigos de erro API: `org_suspended` (403), `forbidden_scope` (403), `suspensao_de_cobranca` (409); sempre `ok()`/`fail()` de `lib/api/wrappers.ts`.
- `OrgNaoOperanteError` estende `ApiError(403, "org_suspended")`, tem `terminal = true`, `organizationId` e `orgStatus` (nunca um campo `status` próprio: `status` é o HTTP herdado).
- LGPD nunca é bloqueada (`requireRole(..., { permiteOrgSuspensa: true })` só em `app/api/v1/lgpd/**` e `app/api/v1/cobranca/**`); webhooks de entrada, landings `anuncios/*`, `rastreio/[id]`, `recover-stuck-messages`, Google Agenda e `contact-avatars` NÃO são gatilhados.
- Sempre `getUser()`, nunca `getSession()`. Service role filtra `organization_id` de fonte confiável (sessão/JWT/path token), nunca do body/URL.
- Todo texto novo de tela tem entrada `es` em `lib/i18n/dicionario.ts`; antes de colar, `grep -c` da chave = `0` (chave duplicada é `TS1117` só na árvore mesclada).
- Sem `console.log` novo (exceção: `workers/voice-agent/index.ts`, que já loga por `console.*`).
- Commits: conventional em pt-br, via `git commit -F - <<'FIM'`, última linha `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Teste isolado: `pnpm exec vitest run <arquivo>`; invariantes só por `pnpm test:db [<arquivo>]`; suíte: `pnpm test:unit` SEM caminho, log redirecionado, rodapé é a autoridade.
- Sabotagem só depois do commit; ao restaurar, confira a PRESENÇA do conserto com `grep -c`, não o diff.
- Fragmento `.changes/suspensao-que-suspende.md` (`impacto: nada_mudou`, `secao: corrigido`).
- Evidência visual em `evidence/suspensao-administrativa/` citada em `docs/testing/user-journey-map.md`.

## Review Focus

Os 5 modos de falha mais prováveis que nenhuma tarefa dos rascunhos testava, e o teste que agora os pega:

1. **Colisão de `status` em `OrgNaoOperanteError`.** Um rascunho a fazia `extends Error` com `status` = status da org; outro a consumia como `ApiError` com `status: 403` e `terminal: true` (a rota `/messages` só traduz `ApiError`; o agent-worker só cancela sem retry quem tem `.terminal === true`). Se a forma errada vencer, o envio de org suspensa vira 500 e o job reagenda para sempre. **Teste:** Task 7, caso "org suspensa lança OrgNaoOperanteError: ApiError 403 org_suspended, terminal" (`toBeInstanceOf(ApiError)` + `toMatchObject({ status: 403, code, terminal: true, orgStatus })`).
2. **Laço de redirect `/app` ↔ `/account-suspended`.** O layout de `/app` manda para o hub por DUAS réguas: `resolveActiveOrg` (o `org_status` do embed da sessão, lido sob a RLS `orgs_select`) e a leitura por service role de `orgRow.status` (Task 16). Se o hub devolvesse para `/app` olhando só uma delas, uma divergência entre as duas (embed nulo, leitura em instantes diferentes) prenderia a pessoa num laço 307; e se layout e hub escolhessem orgs diferentes para o mesmo cookie, idem. **Teste:** Task 8, `it.each` "sem laço: resolveActiveOrg redireciona SÓ quando a org de orgAtivaSemPortao não opera" + "cookie de org sem vínculo cai na primeira OPERANTE"; Task 32, o hub só devolve para `/app` quando as DUAS réguas dizem que opera, com o caso "sessão diz parada, banco diz ativa → renderiza o hub".
3. **SQL real do agendador.** `fireOneDue` passa a chamar `public.fn_org_operante(organization_id)` dentro do `select ... for update skip locked`, pelo pool `pg`. O teste unitário usa dublê; nenhuma invariante exercitava `tickCron`. Um erro de SQL ou de `EXECUTE` do papel do pool pararia TODOS os follow-ups da instalação. **Teste:** Task 21, invariante `tests/invariants/cron-org-parada.test.ts` (Postgres real, papel `postgres` como o do worker).
4. **Embeds novos no PostgREST quebram tudo em falha fechada.** `organizations!inner(status)` em `resolveApiToken` e `organizations:organization_id(status)` em `consulta-supabase`/`silence-sweep` (alias = nome da tabela, a convenção que `tests/pg-como-supabase.ts` traduz): se o embed for ambíguo ou errado, TODO token vira 403 e TODA decisão de IA vira `org_nao_operante` — nos dois casos o dublê unitário passa. **Teste:** Task 34 (e2e contra PostgREST real): controle positivo do token (200 com B ativa) e `decidirElegibilidadeDaConversaViaSupabase` com B ativa ≠ `org_nao_operante`, e com B suspensa = `org_nao_operante`.
5. **Chave duplicada no dicionário / tipos só na árvore mesclada.** Esta PR acrescenta 6 chaves a `lib/i18n/dicionario.ts` e membros a `InboxKind`; outro PR aberto pode acrescentar as mesmas, e o `TS1117` só nasce na prévia do merge. **Teste:** Task 36, passo 1 (merge de `origin/main` ANTES da verificação final + `pnpm typecheck` na árvore mesclada + `grep -cF` de cada uma das 6 chaves = `1`, `'org_reativada'` dentro do bloco do CHECK = `1`, MANIFEST = `1`).

## Mapa de arquivos

- Banco: `supabase/migrations/…_0492_…sql` (novo), `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`, `lib/database.types.ts`, `tests/invariants/org-suspensa.test.ts` (novo), `tests/invariants/vocabulario-banco-x-typescript.test.ts`, `tests/invariants/cron-org-parada.test.ts` (novo).
- Régua: `lib/organizacao/operante.ts` (novo), `lib/organizacao/operante.test.ts` (novo).
- Central: `lib/agent-engine/db/repository.ts`, `lib/ai/agent-inbox-copy.ts`, `lib/ai/inbox-destino.ts` (+ teste), `lib/i18n/dicionario.ts`.
- Sessão/autorização: `lib/auth/{types,server,require-role,requirePlatformAdmin}.ts` (em `types.ts`, também `escreveComoPlatformAdmin`), `lib/legal/operador.ts`, `lib/api/errors.ts`, `app/app/layout.tsx`, `lib/mcp/auth.ts`, `lib/api/auth-dual.ts`, rotas `app/api/v1/lgpd/**`, `admin/**`, `system/update`, `marca/logo`, 10 server actions de instalação (Task 15) e 15 server actions com atalho de papel (Task 15b) em `app/actions`.
- Execução: `lib/ai/elegibilidade/*`, `lib/followup/silence-sweep.ts`, `lib/agenda/meet-delivery.ts`, `lib/event-log/{dispatcher,drain}.ts` + 23 handlers, `lib/agent-engine/edge/crm/{drain,session-reconciler,send-ledger}.ts`, `lib/agent-engine/cron/scheduler.ts`, `app/api/v1/messages/_handler.ts`, `lib/followup/enviar-texto-fixo.ts`, `lib/prospecting/worker.ts`, `lib/campanhas/rodada.ts`, `workers/voice-agent/index.ts`, `app/api/v1/cron/kb-conversations-batch/route.ts`, `app/api/v1/cron/agenda-reminder/route.ts`.
- Tela/prova: `app/app/lgpd/requests/{RequestsTable,[id]/_client}.tsx`, `app/account-suspended/page.tsx`, `docs/threat-model.md`, `docs/architecture/suspensao-de-organizacao.architecture.json`, `tests/e2e/suspensao-administrativa.spec.ts`, `.github/workflows/e2e.yml`, `docs/testing/user-journey-map.md`, `.changes/suspensao-que-suspende.md`.

---

### Task 0: Worktree da PR 1

**Files:** nenhum arquivo do repo.

**Interfaces** — Consumes: `origin/main`. Produces: worktree `~/deskcomm-saas/pr1` na branch `feat/org-operante`, com `node_modules` real.

- [ ] **Passo 1: criar o worktree**

```bash
cd ~/deskcomm-saas/spec || exit 1
git fetch origin main
git worktree list | grep -q "deskcomm-saas/pr1" || git worktree add -b feat/org-operante ~/deskcomm-saas/pr1 origin/main
cd ~/deskcomm-saas/pr1 || exit 1
git status --short | wc -l        # esperado: 0
pnpm install --frozen-lockfile    # node_modules REAL, nunca symlink
test -L node_modules && echo "ERRO: symlink" || echo "node_modules real"
```

Esperado: `0`; `pnpm install` termina com `Done`; `node_modules real`.

---

### Task 1: `suspended_kind`, `fn_org_operante` e o par de vocabulário

**Files:**
- Create: `supabase/migrations/20260929180000_0492_org_operante_e_suspensao_tipada.sql`
- Create: `lib/organizacao/operante.ts` (só o vocabulário; a Task 7 completa o arquivo)
- Create: `tests/invariants/org-suspensa.test.ts`
- Modify: `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`, `tests/invariants/vocabulario-banco-x-typescript.test.ts`, `lib/database.types.ts`

**Interfaces**
- Consumes: `public.organizations` (`status` text com CHECK `active|suspended|redacted|archived`); `sql`, `lastLine` de `tests/invariants/gov-helpers.ts` (`writeCountAs` só entra na Task 2, que é quem o usa).
- Produces: coluna `organizations.suspended_kind text` + `organizations_suspended_kind_check (suspended_kind in ('administrativa','cobranca'))`; `public.fn_org_operante(p_org uuid) returns boolean` (sql, stable, invoker, `search_path=''`, EXECUTE só `service_role`); TS `TIPOS_DE_SUSPENSAO = ["administrativa","cobranca"] as const`, `type TipoDeSuspensao`.

- [ ] **Passo 1: medir o número livre (main MAIS PRs abertos)**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git fetch origin main
git ls-tree --name-only origin/main supabase/migrations/ | grep -oE '[0-9]{14}_[0-9]{4}' | sort | tail -1
for n in $(gh pr list --state open --limit 200 --json number -q '.[].number'); do gh pr diff "$n" --name-only 2>/dev/null; done \
  | grep -oE 'supabase/migrations/[0-9]{14}_[0-9]{4}' | sort | tail -3
```

Esperado hoje: `20260929115848_0491` na main. Se algum PR aberto já usa `0492` ou um carimbo ≥ `20260929180000`, use o próximo livre (número E carimbo) em todos os lugares desta PR.

- [ ] **Passo 2: o invariante que falha — esqueleto de `tests/invariants/org-suspensa.test.ts`**

```ts
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * A SUSPENSÃO QUE SUSPENDE (migration 0492; spec cobrança do revendedor §2.1,
 * §3.1 e §12, invariantes 2 a 4).
 *
 * Antes: suspender só tirava a pessoa da tela. A rota fazia leitura, UPDATE e
 * `event_log` sem await em três passos soltos; nada parava jobs `pending` nem
 * mensagens `queued`; e `status` era gravável pelo PostgREST por qualquer
 * platform admin — `orgs_write_platform_admin` aceita `fn_is_platform_admin()`,
 * que ignora o scope, então um `support_readonly` reativava uma suspensa.
 *
 *   inv. 2 — status, tipo, campos de suspensão e `created_by` só mudam pelo
 *            servidor; INSERT de organização pela sessão é recusado;
 *   inv. 3 — com a org suspensa, o barramento e a LGPD continuam vivos;
 *   inv. 4 — fn_suspender/fn_reativar: anti-backlog, a administrativa
 *            prevalece, idempotência, evento na mesma transação, item
 *            `org_reativada` com a contagem, resíduo de `redacted` não quebra.
 *
 * Os casos com ⭐ são os que o banco de antes deixava passar.
 *
 * ⚠️ O gatilho e a RLS recusam com o MESMO SQLSTATE (42501). Por isso cada
 * recusa confere também a MENSAGEM do gatilho — sem ela, uma recusa de RLS
 * passaria por prova do gatilho.
 */

const ORG_A = "c0de0492-0000-4000-8000-00000000000a"; // a que é suspensa
const ORG_B = "c0de0492-0000-4000-8000-00000000000b"; // a vizinha, sempre ativa
const ORG_C = "c0de0492-0000-4000-8000-00000000000c"; // alvo do inv. 2
const ORG_R = "c0de0492-0000-4000-8000-00000000000d"; // redigida com tipo residual
const ORG_FORJADA = "c0de0492-0000-4000-8000-00000000000e"; // nunca pode nascer

const DONO = "c0de0492-1111-4000-8000-000000000001"; // platform admin `full`
const SUPORTE = "c0de0492-1111-4000-8000-000000000002"; // platform admin `support_readonly`
const ADMIN_A = "c0de0492-1111-4000-8000-000000000003"; // admin do tenant A

const SESSAO_A = "c0de0492-2222-4000-8000-00000000000a";
const SESSAO_B = "c0de0492-2222-4000-8000-00000000000b";
const CONTATO_A1 = "c0de0492-3333-4000-8000-0000000000a1";
const CONTATO_A2 = "c0de0492-3333-4000-8000-0000000000a2";
const CONTATO_B = "c0de0492-3333-4000-8000-0000000000b1";
const CONVERSA_A1 = "c0de0492-4444-4000-8000-0000000000a1";
const CONVERSA_A2 = "c0de0492-4444-4000-8000-0000000000a2";
const CONVERSA_B = "c0de0492-4444-4000-8000-0000000000b1";
const JOB_A = "c0de0492-5555-4000-8000-00000000000a";
const JOB_B = "c0de0492-5555-4000-8000-00000000000b";
const MSG_A = "c0de0492-6666-4000-8000-00000000000a";
const MSG_B = "c0de0492-6666-4000-8000-00000000000b";
const PEDIDO_LGPD = "c0de0492-7777-4000-8000-000000000001";

const MOTIVO = "motivo de teste do invariante 0492";

type Resultado = { changed: boolean; motivo?: string };

function valor(consulta: string): string {
  return lastLine(sql(consulta));
}

/** Chama uma função de estado como `service_role` (o único papel com EXECUTE). */
function servidor(chamada: string): Resultado {
  return JSON.parse(lastLine(sql(`set role service_role;\nselect ${chamada};`))) as Resultado;
}

function suspender(org: string, tipo: string): Resultado {
  return servidor(`public.fn_suspender_organizacao('${org}', '${tipo}', '${MOTIVO}', '${DONO}')`);
}

function reativar(org: string, tipo: string): Resultado {
  return servidor(`public.fn_reativar_organizacao('${org}', '${tipo}', '${DONO}')`);
}

function operante(org: string): string {
  return valor(`set role service_role;\nselect public.fn_org_operante('${org}')::text;`);
}

/** `status/tipo` numa linha só; `-` quando o tipo é nulo. */
function estado(org: string): string {
  return valor(
    `select status || '/' || coalesce(suspended_kind, '-') from public.organizations where id = '${org}';`,
  );
}

function eventos(org: string, tipo: string): number {
  return Number(
    valor(`select count(*) from public.event_log where organization_id = '${org}' and event_type = '${tipo}';`),
  );
}

/** Script que roda como `authenticated` com o JWT do usuário — o caminho do PostgREST. */
function comoUsuario(usuario: string, comando: string): string {
  return `set role authenticated;
select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
${comando};`;
}

/** stderr do psql com SQLSTATE (VERBOSITY verbose), ou "" se o script passou. */
function erroDe(script: string): string {
  try {
    sql(`\\set VERBOSITY verbose\n${script}`);
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

/** Cada teste parte do mesmo estado: A, B e C ativas, fila cheia, sem item de reativação. */
function reiniciar(): void {
  sql(`
    update public.organizations
       set status = 'active', suspended_kind = null, suspended_at = null,
           suspended_reason = null, suspended_by = null
     where id in ('${ORG_A}', '${ORG_B}', '${ORG_C}');
    update public.job_queue set status = 'pending', last_error = null where id in ('${JOB_A}', '${JOB_B}');
    update public.messages set status = 'queued', error_code = null where id in ('${MSG_A}', '${MSG_B}');
    update public.conversations set last_inbound_at = null where id in ('${CONVERSA_A1}', '${CONVERSA_A2}');
    delete from public.agent_inbox_items where organization_id = '${ORG_A}' and kind = 'org_reativada';
  `);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${DONO}', 'dono-0492@invariant.test'),
      ('${SUPORTE}', 'suporte-0492@invariant.test'),
      ('${ADMIN_A}', 'admin-a-0492@invariant.test')
      on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
      ('${DONO}', '${DONO}', 'full', false, 'fixture do invariante 0492'),
      ('${SUPORTE}', '${DONO}', 'support_readonly', false, 'fixture do invariante 0492')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'org-0492-a', 'Org 0492 A', 'Org 0492 A'),
      ('${ORG_B}', 'org-0492-b', 'Org 0492 B', 'Org 0492 B'),
      ('${ORG_C}', 'org-0492-c', 'Org 0492 C', 'Org 0492 C'),
      ('${ORG_R}', 'org-0492-r', 'Org 0492 R', 'Org 0492 R')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_A}', '${ORG_A}', 'admin', now()) on conflict do nothing;
    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
        ('${SESSAO_A}', '${ORG_A}', 'org-0492-a', '\\x00'::bytea),
        ('${SESSAO_B}', '${ORG_B}', 'org-0492-b', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A1}', '${ORG_A}', 'Contato 0492 A1'),
      ('${CONTATO_A2}', '${ORG_A}', 'Contato 0492 A2'),
      ('${CONTATO_B}', '${ORG_B}', 'Contato 0492 B')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_A1}', '${ORG_A}', '${CONTATO_A1}', '${SESSAO_A}', 'open'),
      ('${CONVERSA_A2}', '${ORG_A}', '${CONTATO_A2}', '${SESSAO_A}', 'open'),
      ('${CONVERSA_B}', '${ORG_B}', '${CONTATO_B}', '${SESSAO_B}', 'open')
      on conflict (id) do nothing;
    -- 'watchdog' não tem contato nem fronteira de atendimento (fn_job_service_boundary
    -- devolve cedo): é a forma mais barata de um job 'pending' de verdade.
    insert into public.job_queue (id, organization_id, kind, status) values
      ('${JOB_A}', '${ORG_A}', 'watchdog', 'pending'),
      ('${JOB_B}', '${ORG_B}', 'watchdog', 'pending')
      on conflict (id) do nothing;
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body) values
      ('${MSG_A}', '${ORG_A}', '${CONVERSA_A1}', '${SESSAO_A}', '${CONTATO_A1}', 'text', 'outbound', 'queued', 'user', 'resposta na fila'),
      ('${MSG_B}', '${ORG_B}', '${CONVERSA_B}', '${SESSAO_B}', '${CONTATO_B}', 'text', 'outbound', 'queued', 'user', 'resposta na fila')
      on conflict (id) do nothing;
  `);
});

beforeEach(reiniciar);

describe("fn_org_operante — a régua SQL do predicado", () => {
  it("só `active` opera; suspensa, arquivada, redigida e inexistente não operam", () => {
    sql(`
      update public.organizations set status = 'suspended', suspended_kind = 'administrativa', suspended_at = now() where id = '${ORG_A}';
      update public.organizations set status = 'archived' where id = '${ORG_C}';
      update public.organizations set status = 'redacted', suspended_kind = 'cobranca' where id = '${ORG_R}';
    `);
    expect(operante(ORG_B)).toBe("true");
    expect(operante(ORG_A)).toBe("false");
    expect(operante(ORG_C)).toBe("false");
    expect(operante(ORG_R)).toBe("false");
    expect(operante(ORG_FORJADA)).toBe("false");
  });

  it("⭐ o tipo da suspensão é vocabulário fechado", () => {
    const e = erroDe(`update public.organizations set suspended_kind = 'fraude' where id = '${ORG_A}';`);
    expect(e).toContain("23514");
    expect(e).toContain("organizations_suspended_kind_check");
  });

  it("a sessão não executa fn_org_operante (EXECUTE só do service_role)", () => {
    const e = erroDe(comoUsuario(ADMIN_A, `select public.fn_org_operante('${ORG_A}')`));
    expect(e).toContain("42501");
    expect(e).toContain("permission denied");
  });
});
```

- [ ] **Passo 3: o par de vocabulário que falha** — em `tests/invariants/vocabulario-banco-x-typescript.test.ts`, logo depois do par `team_invites.role` (o que termina em `simbolo: "ROLES",` + `},`), antes do `];`:

```ts
  {
    tabela: "organizations",
    coluna: "suspended_kind",
    // lib/organizacao/operante.ts → TIPOS_DE_SUSPENSAO (tupla `as const`). Nasce
    // no MESMO commit da migration 0492 — a lição desta lista. O tipo decide qual
    // porta reativa: `/reactivate` só a administrativa; a de cobrança só por
    // pagamento, prazo ou isenção. Um tipo só no CHECK deixaria a org presa numa
    // suspensão que nenhuma porta reconhece; só no TypeScript viraria `23514`
    // dentro de fn_suspender_organizacao.
    arquivo: "lib/organizacao/operante.ts",
    simbolo: "TIPOS_DE_SUSPENSAO",
  },
```

- [ ] **Passo 4: rodar e ver falhar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db tests/invariants/org-suspensa.test.ts tests/invariants/vocabulario-banco-x-typescript.test.ts > /tmp/t1-red.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t1-red.log | tail -2
grep -aE "fn_org_operante|suspended_kind|operante.ts" /tmp/t1-red.log | head -5
```

Esperado: `exit=1`; `Test Files  2 failed (2)`; no log, `column "suspended_kind" … does not exist` / `function public.fn_org_operante(unknown) does not exist` e a falha de leitura de `lib/organizacao/operante.ts`.

- [ ] **Passo 5: criar `lib/organizacao/operante.ts` (só o vocabulário)**

```ts
/**
 * A ORGANIZAÇÃO OPERA OU NÃO OPERA — a régua única do predicado (spec cobrança
 * do revendedor, §4). Espelho SQL: `public.fn_org_operante(uuid)` (migration 0492).
 * O predicado e o erro entram na Task 7 do plano da PR 1; aqui nasce só o
 * vocabulário que o invariante `vocabulario-banco-x-typescript` cobra.
 */

/** Por que a organização está suspensa. Par de `organizations_suspended_kind_check` (0492). */
export const TIPOS_DE_SUSPENSAO = ["administrativa", "cobranca"] as const;
export type TipoDeSuspensao = (typeof TIPOS_DE_SUSPENSAO)[number];
```

- [ ] **Passo 6: a migration, cabeçalho e seção A** — arquivo `supabase/migrations/20260929180000_0492_org_operante_e_suspensao_tipada.sql`:

```sql
-- 0492 — A SUSPENSÃO QUE SUSPENDE: org operante, suspensão tipada e estado só pelo servidor
--        (spec docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §2.1, §2.5, §2.6, §3.1)
--
-- ── A causa ───────────────────────────────────────────────────────────────────
-- Suspender uma organização só tirava a pessoa da tela. A rota fazia leitura,
-- UPDATE e `event_log` sem await em três passos soltos; nada parava os jobs
-- `pending` nem as mensagens `queued`; e `status` era gravável pelo PostgREST
-- por qualquer platform admin — `orgs_write_platform_admin` aceita
-- `fn_is_platform_admin()`, que ignora o scope, então um `support_readonly`
-- reativava uma suspensa com um PATCH.
--
-- ── O que muda ────────────────────────────────────────────────────────────────
-- A. `organizations.suspended_kind` ('administrativa' | 'cobranca'), backfill
--    ANTES do CHECK. Sem CHECK de coerência com `status`: o lgpd-redact-worker
--    troca para `redacted` sem limpar o tipo; a regra de leitura mora em
--    lib/organizacao/operante.ts. `fn_org_operante(uuid)` é a régua SQL do
--    predicado (`status = 'active'`, falha fechada).
-- B. Gatilho `trg_organizacao_estado_so_pelo_servidor` (molde: `fn_meet_stamp`):
--    a sessão (`authenticated`/`anon`) não cria organização nem muda status,
--    tipo, campos de suspensão ou `created_by`.
-- C. `fn_suspender_organizacao`: uma transação, lock na linha, anti-backlog
--    (jobs `pending` → `failed`/`org_nao_operante`; mensagens `queued` →
--    `failed`/`org_suspensa`) e `tenant.suspended` no `event_log` na MESMA
--    transação. A administrativa prevalece sobre a de cobrança.
-- D. `agent_inbox_items.kind` ganha 'org_reativada' (lista completa do baseline).
-- E. `fn_reativar_organizacao`: exige o tipo, zera a suspensão, falha jobs
--    `pending` que sobraram e abre UM item 'org_reativada' com a contagem de
--    conversas que receberam mensagem durante a suspensão. Nada é reprocessado.
--
-- Na PR 1 nenhuma das duas funções cita `cobranca_assinaturas` (nasce na PR 2;
-- plpgsql resolve a relação ao executar, e daria 42P01 em toda chamada).
-- Idempotente: `add column if not exists`, drop+add de constraint, `create or
-- replace`, `drop trigger if exists`. Toda função perde EXECUTE das duas
-- origens (public e anon) e de authenticated; só service_role executa.
-- Gate: tests/invariants/org-suspensa.test.ts.

-- ── A. suspended_kind + fn_org_operante ──────────────────────────────────────
alter table public.organizations add column if not exists suspended_kind text;

update public.organizations
   set suspended_kind = 'administrativa'
 where status = 'suspended'
   and suspended_kind is null;

alter table public.organizations
  drop constraint if exists organizations_suspended_kind_check;
alter table public.organizations
  add constraint organizations_suspended_kind_check check (suspended_kind in ('administrativa', 'cobranca'));

comment on column public.organizations.suspended_kind is
  'Por que a organização está suspensa: administrativa (platform admin) ou cobranca (régua de cobrança). Só significa algo com status = suspended: o lgpd-redact-worker troca para redacted sem limpar. Escrito só por fn_suspender_organizacao e fn_reativar_organizacao (migration 0492).';

create or replace function public.fn_org_operante(p_org uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((select o.status = 'active' from public.organizations o where o.id = p_org), false);
$$;

revoke execute on function public.fn_org_operante(uuid) from public, anon, authenticated;
grant execute on function public.fn_org_operante(uuid) to service_role;
```

- [ ] **Passo 7: o apêndice do baseline (rótulo + seção A)**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
grep -n "^-- ---- VARREDURA anon:" supabase/baseline.sql   # hoje: 42990
```

Edit com `old_string` = `-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----` e `new_string` = o bloco abaixo seguido da mesma linha:

```sql
-- ---- org operante e suspensão tipada (migration 0492) ----
-- A suspensão que suspende (spec cobrança do revendedor §2.1, §3.1). Corpo e
-- porquê: a migration 0492. Cópia byte a byte das seções A, B, C e E dela; a
-- seção D (kind 'org_reativada') entra NO LUGAR, no bloco único de
-- agent_inbox_items_kind_check. Entra ANTES da VARREDURA anon porque cria função.

-- ── A. suspended_kind + fn_org_operante ──────────────────────────────────────
alter table public.organizations add column if not exists suspended_kind text;

update public.organizations
   set suspended_kind = 'administrativa'
 where status = 'suspended'
   and suspended_kind is null;

alter table public.organizations
  drop constraint if exists organizations_suspended_kind_check;
alter table public.organizations
  add constraint organizations_suspended_kind_check check (suspended_kind in ('administrativa', 'cobranca'));

comment on column public.organizations.suspended_kind is
  'Por que a organização está suspensa: administrativa (platform admin) ou cobranca (régua de cobrança). Só significa algo com status = suspended: o lgpd-redact-worker troca para redacted sem limpar. Escrito só por fn_suspender_organizacao e fn_reativar_organizacao (migration 0492).';

create or replace function public.fn_org_operante(p_org uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((select o.status = 'active' from public.organizations o where o.id = p_org), false);
$$;

revoke execute on function public.fn_org_operante(uuid) from public, anon, authenticated;
grant execute on function public.fn_org_operante(uuid) to service_role;

```

- [ ] **Passo 8: linha no MANIFEST** — no FIM da tabela "Applied" de `supabase/migrations/MANIFEST.md` (uma linha):

```markdown
| `20260929180000` | `0492_org_operante_e_suspensao_tipada` | **A suspensão que suspende (spec cobrança do revendedor, PR 1).** Suspender só tirava a pessoa da tela: a rota fazia leitura, UPDATE e `event_log` sem await em três passos soltos, nada parava jobs `pending` nem mensagens `queued`, e `status` era gravável pelo PostgREST por qualquer platform admin (`orgs_write_platform_admin` aceita `fn_is_platform_admin()`, que ignora o scope — um `support_readonly` reativava uma suspensa). (A) `organizations.suspended_kind` (`administrativa`/`cobranca`), backfill antes do CHECK, SEM CHECK de coerência com `status` (o `lgpd-redact-worker` troca para `redacted` sem limpar o tipo; regra de leitura em `lib/organizacao/operante.ts`) e `fn_org_operante(uuid)`, a régua SQL do predicado. (B) Gatilho `trg_organizacao_estado_so_pelo_servidor` (invoker, molde `fn_meet_stamp`): `authenticated`/`anon` não inserem organização nem mudam `status`, `suspended_*` ou `created_by` (42501). (C) `fn_suspender_organizacao` (definer, uma transação, `for update`): jobs `pending` → `failed`/`org_nao_operante`, mensagens `queued` → `failed`/`org_suspensa`, `tenant.suspended` no `event_log` na mesma transação; a administrativa prevalece. (D) kind `org_reativada` no bloco único de `agent_inbox_items_kind_check` (lista completa do baseline, `kind-check-migration-x-baseline`). (E) `fn_reativar_organizacao` (definer): exige o tipo (suspensão nula vale como administrativa), zera a suspensão, falha `pending` remanescente e abre UM item `org_reativada` com a contagem de conversas com mensagem durante a suspensão — nada é reprocessado. Nenhuma das duas cita `cobranca_assinaturas` (PR 2). EXECUTE revogado de `public`, `anon` e `authenticated`; só `service_role`. Apêndice antes da VARREDURA anon (seção D editada no lugar). Gate: `tests/invariants/org-suspensa.test.ts` e o par `organizations.suspended_kind` × `TIPOS_DE_SUSPENSAO` em `tests/invariants/vocabulario-banco-x-typescript.test.ts`. |
```

- [ ] **Passo 9: rodar e ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db tests/invariants/org-suspensa.test.ts tests/invariants/vocabulario-banco-x-typescript.test.ts > /tmp/t1.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t1.log | tail -2
```

Esperado: `exit=0`; `Test Files  2 passed (2)`; `0 failed` (org-suspensa: 3 casos).

- [ ] **Passo 10: tipos** — em `lib/database.types.ts`, no bloco `organizations` (hoje `:8073`):
  - Row: depois de `          suspended_by: string | null` (única ocorrência) acrescente `          suspended_kind: string | null`.
  - Insert e Update: confira `grep -c "suspended_by?: string | null" lib/database.types.ts` → `2`; Edit com `replace_all: true`, `old_string` = `suspended_by?: string | null\n          suspended_reason?: string | null`, `new_string` = `suspended_by?: string | null\n          suspended_kind?: string | null\n          suspended_reason?: string | null`.
  - Functions: logo depois do bloco `fn_create_tenant_with_owner: { … }` (hoje `:10306-10309`):

```ts
      fn_org_operante: { Args: { p_org: string }; Returns: boolean }
```

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm typecheck; echo "exit=$?"   # esperado: exit=0
```

- [ ] **Passo 11: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add supabase/migrations/20260929180000_0492_org_operante_e_suspensao_tipada.sql supabase/baseline.sql \
  supabase/migrations/MANIFEST.md lib/organizacao/operante.ts lib/database.types.ts \
  tests/invariants/org-suspensa.test.ts tests/invariants/vocabulario-banco-x-typescript.test.ts
git commit -F - <<'FIM'
feat(org): suspended_kind e fn_org_operante, a régua única de org operante (0492)

A organização ganha o tipo da suspensão (administrativa ou cobranca), com
backfill antes do CHECK, e fn_org_operante(uuid) espelha em SQL o predicado
status = 'active' com falha fechada. O par suspended_kind x TIPOS_DE_SUSPENSAO
entra no invariante de vocabulário no mesmo commit.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---
### Task 2: Gatilho `trg_organizacao_estado_so_pelo_servidor` (invariante 2)

**Files:**
- Modify: migration 0492 (seção B no fim), `supabase/baseline.sql` (seção B no fim do bloco 0492, acima de `-- ---- VARREDURA anon:`), `tests/invariants/org-suspensa.test.ts` (describe no fim)

**Interfaces**
- Consumes: `organizations.suspended_kind` (Task 1); policy `orgs_write_platform_admin` (`baseline.sql:4195`); `writeCountAs` (gov-helpers; só engole erro com "row-level security").
- Produces: `public.fn_organizacao_estado_so_pelo_servidor() returns trigger` (invoker, `search_path=''`, sem EXECUTE para ninguém) e `trg_organizacao_estado_so_pelo_servidor BEFORE INSERT OR UPDATE ON public.organizations`. Erros `organizacao_nasce_so_pelo_servidor` (INSERT) e `estado_da_organizacao_so_pelo_servidor` (UPDATE), ambos `42501`. Escritores legítimos (service_role, funções definer, `lib/auth/provision.ts`, `bootstrap-owner.ts`, que usam o admin client) passam.

- [ ] **Passo 1: o teste que falha** — em `tests/invariants/org-suspensa.test.ts`, o import de `./gov-helpers` passa a `import { lastLine, sql, writeCountAs } from "./gov-helpers";` (o controle "a RLS deixa o dono escrever nome e fuso", abaixo, é o primeiro uso) e, no fim do arquivo:

```ts
describe("inv. 2 — status e suspensão só mudam pelo servidor", () => {
  for (const [scope, usuario] of [
    ["support_readonly", SUPORTE],
    ["full", DONO],
  ] as const) {
    it(`⭐ platform admin ${scope} não reativa uma suspensa pelo PostgREST`, () => {
      sql(`update public.organizations set status = 'suspended', suspended_kind = 'cobranca', suspended_at = now() where id = '${ORG_C}';`);
      const e = erroDe(comoUsuario(usuario, `update public.organizations set status = 'active' where id = '${ORG_C}'`));
      expect(e).toContain("42501");
      expect(e).toContain("estado_da_organizacao_so_pelo_servidor");
      expect(estado(ORG_C)).toBe("suspended/cobranca");
    });

    it(`⭐ platform admin ${scope} não troca o tipo da suspensão`, () => {
      sql(`update public.organizations set status = 'suspended', suspended_kind = 'administrativa', suspended_at = now() where id = '${ORG_C}';`);
      const e = erroDe(comoUsuario(usuario, `update public.organizations set suspended_kind = 'cobranca' where id = '${ORG_C}'`));
      expect(e).toContain("42501");
      expect(e).toContain("estado_da_organizacao_so_pelo_servidor");
      expect(estado(ORG_C)).toBe("suspended/administrativa");
    });

    it(`⭐ platform admin ${scope} não suspende nem reescreve autoria pelo PostgREST`, () => {
      for (const atribuicao of [
        `status = 'suspended'`,
        `suspended_at = now()`,
        `suspended_reason = 'forjado'`,
        `suspended_by = '${usuario}'`,
        `created_by = '${usuario}'`,
      ]) {
        const e = erroDe(comoUsuario(usuario, `update public.organizations set ${atribuicao} where id = '${ORG_C}'`));
        expect(e, atribuicao).toContain("estado_da_organizacao_so_pelo_servidor");
      }
      expect(estado(ORG_C)).toBe("active/-");
    });

    it(`⭐ platform admin ${scope} não cria organização pelo PostgREST`, () => {
      const e = erroDe(
        comoUsuario(
          usuario,
          `insert into public.organizations (id, slug, legal_name, display_name) values ('${ORG_FORJADA}', 'forjada-0492', 'Forjada', 'Forjada')`,
        ),
      );
      expect(e).toContain("42501");
      expect(e).toContain("organizacao_nasce_so_pelo_servidor");
      expect(valor(`select count(*) from public.organizations where id = '${ORG_FORJADA}';`)).toBe("0");
    });
  }

  it("controle: a RLS deixa o dono escrever nome e fuso pela sessão (o que o updateTenant grava)", () => {
    expect(
      writeCountAs(
        DONO,
        `update public.organizations set display_name = 'Org 0492 C renomeada', timezone = 'America/Manaus' where id = '${ORG_C}'`,
      ),
    ).toBe(1);
    expect(valor(`select display_name || '|' || timezone from public.organizations where id = '${ORG_C}';`)).toBe(
      "Org 0492 C renomeada|America/Manaus",
    );
  });

  it("controle: service_role (rota de servidor, worker de LGPD) escreve o status", () => {
    sql(`set role service_role;\nupdate public.organizations set status = 'redacted' where id = '${ORG_C}';`);
    expect(estado(ORG_C)).toBe("redacted/-");
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db tests/invariants/org-suspensa.test.ts > /tmp/t2-red.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t2-red.log | tail -2
```

Esperado: `exit=1`; `Tests  8 failed | 5 passed (13)` (os 8 ⭐ gravam pela RLS; 2 controles + 3 casos da Task 1 passam).

- [ ] **Passo 3: implementar** — cole byte a byte em DOIS lugares (fim da migration; fim do bloco 0492 do baseline, acima de `-- ---- VARREDURA anon:`):

```sql
-- ── B. o estado da organização só muda pelo servidor ─────────────────────────
-- `orgs_write_platform_admin` aceita qualquer `fn_is_platform_admin()`, que
-- ignora o scope, e `authenticated` tem GRANT ALL: sem isto um support_readonly
-- reativaria uma suspensa, trocaria o tipo da suspensão ou criaria org isenta
-- pelo PostgREST. Todo escritor legítimo é service_role ou função definer, onde
-- `current_user` é o dono da função. Molde: `fn_meet_stamp`.
create or replace function public.fn_organizacao_estado_so_pelo_servidor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'organizacao_nasce_so_pelo_servidor'
      using errcode = '42501',
            detail = 'Organização nasce por rota de servidor (service_role ou função definer), nunca pela sessão.';
  end if;
  if new.status is distinct from old.status
     or new.suspended_kind is distinct from old.suspended_kind
     or new.suspended_at is distinct from old.suspended_at
     or new.suspended_reason is distinct from old.suspended_reason
     or new.suspended_by is distinct from old.suspended_by
     or new.created_by is distinct from old.created_by then
    raise exception 'estado_da_organizacao_so_pelo_servidor'
      using errcode = '42501',
            detail = 'Status, suspensão e autoria mudam só por fn_suspender_organizacao, fn_reativar_organizacao ou rota de servidor.';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_organizacao_estado_so_pelo_servidor() from public, anon, authenticated;

drop trigger if exists trg_organizacao_estado_so_pelo_servidor on public.organizations;
create trigger trg_organizacao_estado_so_pelo_servidor
  before insert or update on public.organizations
  for each row execute function public.fn_organizacao_estado_so_pelo_servidor();

```

- [ ] **Passo 4: rodar e ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db tests/invariants/org-suspensa.test.ts > /tmp/t2.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t2.log | tail -2
```

Esperado: `exit=0`; `Tests  13 passed (13)`.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add supabase/migrations/20260929180000_0492_org_operante_e_suspensao_tipada.sql supabase/baseline.sql tests/invariants/org-suspensa.test.ts
git commit -F - <<'FIM'
fix(org): status e suspensão da organização só mudam pelo servidor (0492)

O gatilho trg_organizacao_estado_so_pelo_servidor recusa com 42501 o INSERT de
organização e a troca de status, tipo e campos de suspensão ou created_by vinda
de authenticated/anon. Antes, qualquer platform admin, support_readonly
inclusive, reativava uma org suspensa por um PATCH no PostgREST.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 3: `fn_suspender_organizacao` (invariantes 3 e 4, metade da suspensão)

**Files:**
- Modify: migration 0492 (seção C no fim), `supabase/baseline.sql` (seção C no fim do bloco 0492), `tests/invariants/org-suspensa.test.ts` (dois describes no fim), `lib/database.types.ts` (`Functions`)

**Interfaces**
- Consumes: `organizations.suspended_kind` (Task 1), gatilho (Task 2; a função escreve como dono, então passa), `public.event_log`, `public.job_queue`, `public.messages`, `public.emit_event`.
- Produces: `public.fn_suspender_organizacao(p_org uuid, p_kind text, p_motivo text, p_ator uuid) returns jsonb` → `{"changed": true}` ou `{"changed": false, "motivo": "ja_suspensa" | "administrativa_prevalece" | "org_encerrada"}`; erros `22023 tipo_de_suspensao_invalido`, `P0002 organization_not_found`. EXECUTE só `service_role`. Grava `job_queue.last_error='org_nao_operante'` e `messages.error_code='org_suspensa'` (consumidos pela Task 22 e pelo e2e).

- [ ] **Passo 1: os testes que falham** — no fim de `tests/invariants/org-suspensa.test.ts`:

```ts
describe("inv. 4 — fn_suspender_organizacao para a fila e escreve numa transação só", () => {
  it("⭐ suspende: tipo e autoria gravados, pending → failed, queued → failed; a vizinha fica intocada", () => {
    const antes = eventos(ORG_A, "tenant.suspended");
    expect(suspender(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(estado(ORG_A)).toBe("suspended/administrativa");
    expect(
      valor(
        `select suspended_reason || '|' || suspended_by || '|' || (suspended_at is not null)::text from public.organizations where id = '${ORG_A}';`,
      ),
    ).toBe(`${MOTIVO}|${DONO}|true`);
    expect(valor(`select status || '|' || last_error from public.job_queue where id = '${JOB_A}';`)).toBe(
      "failed|org_nao_operante",
    );
    expect(valor(`select status || '|' || error_code from public.messages where id = '${MSG_A}';`)).toBe(
      "failed|org_suspensa",
    );
    expect(eventos(ORG_A, "tenant.suspended")).toBe(antes + 1);
    expect(
      valor(
        `select payload->>'kind' || '|' || status from public.event_log where organization_id = '${ORG_A}' and event_type = 'tenant.suspended' order by created_at desc limit 1;`,
      ),
    ).toBe("administrativa|done");
    expect(estado(ORG_B)).toBe("active/-");
    expect(valor(`select status from public.job_queue where id = '${JOB_B}';`)).toBe("pending");
    expect(valor(`select status from public.messages where id = '${MSG_B}';`)).toBe("queued");
  });

  it("idempotente: suspender de novo pelo mesmo tipo não muda nada nem emite 2º evento", () => {
    suspender(ORG_A, "cobranca");
    const antes = eventos(ORG_A, "tenant.suspended");
    expect(suspender(ORG_A, "cobranca")).toEqual({ changed: false, motivo: "ja_suspensa" });
    expect(eventos(ORG_A, "tenant.suspended")).toBe(antes);
    expect(estado(ORG_A)).toBe("suspended/cobranca");
  });

  it("a administrativa prevalece nos dois sentidos, sem recomeçar o início da suspensão", () => {
    suspender(ORG_A, "administrativa");
    expect(suspender(ORG_A, "cobranca")).toEqual({ changed: false, motivo: "administrativa_prevalece" });
    expect(estado(ORG_A)).toBe("suspended/administrativa");

    reiniciar();
    suspender(ORG_A, "cobranca");
    const inicio = valor(`select suspended_at::text from public.organizations where id = '${ORG_A}';`);
    expect(suspender(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(estado(ORG_A)).toBe("suspended/administrativa");
    expect(valor(`select suspended_at::text from public.organizations where id = '${ORG_A}';`)).toBe(inicio);
  });

  it("o evento nasce na MESMA transação: visível antes do commit, some no rollback", () => {
    const antes = eventos(ORG_A, "tenant.suspended");
    const saida = sql(`
      begin;
      set local role service_role;
      select public.fn_suspender_organizacao('${ORG_A}', 'administrativa', '${MOTIVO}', '${DONO}');
      reset role;
      select 'dentro:' || count(*) from public.event_log where organization_id = '${ORG_A}' and event_type = 'tenant.suspended';
      rollback;
    `);
    expect(saida.split("\n")).toContain(`dentro:${antes + 1}`);
    expect(eventos(ORG_A, "tenant.suspended")).toBe(antes);
    expect(estado(ORG_A)).toBe("active/-");
    expect(valor(`select status from public.job_queue where id = '${JOB_A}';`)).toBe("pending");
  });

  it("tipo fora do vocabulário é 22023; organização inexistente é P0002", () => {
    expect(erroDe(`set role service_role;\nselect public.fn_suspender_organizacao('${ORG_A}', 'fraude', '${MOTIVO}', null);`)).toContain("22023");
    expect(erroDe(`set role service_role;\nselect public.fn_suspender_organizacao('${ORG_FORJADA}', 'administrativa', '${MOTIVO}', null);`)).toContain("P0002");
    expect(estado(ORG_A)).toBe("active/-");
  });

  it("⭐ nenhuma sessão executa a função de suspensão", () => {
    for (const usuario of [DONO, SUPORTE, ADMIN_A]) {
      const e = erroDe(
        comoUsuario(usuario, `select public.fn_suspender_organizacao('${ORG_A}', 'administrativa', '${MOTIVO}', '${usuario}')`),
      );
      expect(e, usuario).toContain("42501");
      expect(e, usuario).toContain("permission denied");
    }
    expect(estado(ORG_A)).toBe("active/-");
  });
});

describe("inv. 3 — com a org suspensa, o barramento e a LGPD seguem vivos", () => {
  beforeEach(() => {
    suspender(ORG_A, "administrativa");
  });

  it("emit_event pelo servidor (o que a aprovação de LGPD faz) grava para a org suspensa", () => {
    const antes = eventos(ORG_A, "lgpd.data_request_received");
    sql(`set role service_role;
      select public.emit_event('lgpd.data_request_received', 'lgpd_request', '${PEDIDO_LGPD}',
        jsonb_build_object('request_id', '${PEDIDO_LGPD}', 'manually_approved', true), '{}'::jsonb, '${ORG_A}');`);
    expect(eventos(ORG_A, "lgpd.data_request_received")).toBe(antes + 1);
  });

  it("emit_event pela sessão do admin da org suspensa continua funcionando", () => {
    const antes = eventos(ORG_A, "contact.updated");
    sql(comoUsuario(ADMIN_A, `select public.emit_event('contact.updated', 'contact', '${CONTATO_A1}', '{}'::jsonb, '{}'::jsonb, '${ORG_A}')`));
    expect(eventos(ORG_A, "contact.updated")).toBe(antes + 1);
  });

  it("a vizinha ativa segue normal: opera, fila intacta, barramento vivo", () => {
    expect(operante(ORG_A)).toBe("false");
    expect(operante(ORG_B)).toBe("true");
    expect(valor(`select status from public.job_queue where id = '${JOB_B}';`)).toBe("pending");
    expect(valor(`select status from public.messages where id = '${MSG_B}';`)).toBe("queued");
    const antes = eventos(ORG_B, "contact.updated");
    sql(`set role service_role;
      select public.emit_event('contact.updated', 'contact', '${CONTATO_B}', '{}'::jsonb, '{}'::jsonb, '${ORG_B}');`);
    expect(eventos(ORG_B, "contact.updated")).toBe(antes + 1);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db tests/invariants/org-suspensa.test.ts > /tmp/t3-red.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t3-red.log | tail -2
grep -a "fn_suspender_organizacao" /tmp/t3-red.log | head -3
```

Esperado: `exit=1`; os 9 casos novos falham (`function public.fn_suspender_organizacao(unknown, unknown, unknown, unknown) does not exist`); os 13 anteriores passam.

- [ ] **Passo 3: implementar** — cole byte a byte em DOIS lugares (fim da migration; fim do bloco 0492 do baseline, acima de `-- ---- VARREDURA anon:`):

```sql
-- ── C. fn_suspender_organizacao: uma transação, fila parada ──────────────────
-- Conserta a rota que lia, gravava e emitia o evento sem await em três passos.
-- `failed` e não `dead` nos jobs: é o terminal de veto (queue.ts); `dead` abre
-- aviso `job_dead`. A mensagem `queued` vira `failed` para o redrive não a
-- mandar quando alguém olhar de novo. Suspensão com tipo NULO (imagem anterior
-- à 0492, depois de rollback) vale como administrativa.
create or replace function public.fn_suspender_organizacao(
  p_org uuid, p_kind text, p_motivo text, p_ator uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_kind   text;
begin
  if p_kind is null or p_kind not in ('administrativa', 'cobranca') then
    raise exception 'tipo_de_suspensao_invalido' using errcode = '22023';
  end if;

  select o.status, coalesce(o.suspended_kind, 'administrativa')
    into v_status, v_kind
    from public.organizations o
   where o.id = p_org
     for update;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;

  if v_status = 'suspended' then
    if v_kind = p_kind then
      return jsonb_build_object('changed', false, 'motivo', 'ja_suspensa');
    end if;
    if p_kind = 'cobranca' then
      return jsonb_build_object('changed', false, 'motivo', 'administrativa_prevalece');
    end if;
    -- cobranca → administrativa: troca o tipo e mantém o início da suspensão.
    update public.organizations
       set suspended_kind = 'administrativa',
           suspended_reason = p_motivo,
           suspended_by = p_ator
     where id = p_org;
  elsif v_status = 'active' then
    update public.organizations
       set status = 'suspended',
           suspended_kind = p_kind,
           suspended_reason = p_motivo,
           suspended_at = now(),
           suspended_by = p_ator
     where id = p_org;
  else
    -- redacted / archived: inalterados, já não operam.
    return jsonb_build_object('changed', false, 'motivo', 'org_encerrada');
  end if;

  update public.job_queue
     set status = 'failed', last_error = 'org_nao_operante'
   where organization_id = p_org and status = 'pending';

  update public.messages
     set status = 'failed', error_code = 'org_suspensa'
   where organization_id = p_org and status = 'queued';

  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload)
  values (p_org, 'tenant.suspended', 'organization', p_org,
          jsonb_build_object('tenant_id', p_org, 'kind', p_kind,
                             'suspended_by', p_ator, 'reason', p_motivo));

  return jsonb_build_object('changed', true);
end;
$$;

revoke execute on function public.fn_suspender_organizacao(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_suspender_organizacao(uuid, text, text, uuid) to service_role;

```

- [ ] **Passo 4: tipo da função** — em `lib/database.types.ts`, logo abaixo da linha `fn_org_operante` da Task 1:

```ts
      fn_suspender_organizacao: {
        Args: { p_org: string; p_kind: string; p_motivo: string; p_ator: string }
        Returns: Json
      }
```

- [ ] **Passo 5: rodar e ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db tests/invariants/org-suspensa.test.ts tests/invariants/hardening-definer-varredura.test.ts tests/invariants/definer-membership-varredura.test.ts > /tmp/t3.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t3.log | tail -2
pnpm typecheck; echo "exit=$?"
```

Esperado: `exit=0`; `Test Files  3 passed (3)`; org-suspensa com `22 passed`; typecheck `exit=0`.

- [ ] **Passo 6: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add supabase/migrations/20260929180000_0492_org_operante_e_suspensao_tipada.sql supabase/baseline.sql tests/invariants/org-suspensa.test.ts lib/database.types.ts
git commit -F - <<'FIM'
fix(org): suspender para a fila e grava o evento na mesma transação (0492)

fn_suspender_organizacao trava a linha, grava tipo, motivo e autor, falha os
jobs pending (org_nao_operante) e as mensagens queued (org_suspensa) e insere
tenant.suspended no event_log na mesma transação. A suspensão administrativa
prevalece sobre a de cobrança; redacted/archived ficam intocadas.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 4: kind `org_reativada` (CHECK, InboxKind, rótulo, destino no Inbox, dicionário)

**Files:**
- Modify: `supabase/baseline.sql` — bloco ÚNICO de `agent_inbox_items_kind_check` (hoje `:9997-10110`), NO LUGAR
- Modify: migration 0492 (seção D no fim; NÃO vai para o apêndice)
- Modify: `lib/agent-engine/db/repository.ts` (`InboxKind`), `lib/ai/agent-inbox-copy.ts` (`KIND_LABEL`), `lib/ai/inbox-destino.ts` (`POLITICAS_DE_AVISO`), `lib/ai/inbox-destino.test.ts`, `lib/i18n/dicionario.ts`

**Interfaces**
- Consumes: `tests/unit/kind-check-migration-x-baseline.test.ts` (a última migration que reconstrói o CHECK bate com o baseline valor a valor); par `agent_inbox_items.kind` × `InboxKind` no invariante de vocabulário; `resolverDestinosDosAvisos` (`inbox-destino.ts:204-219`: destino "geral" só com `ref_kind` e `ref_id` nulos).
- Produces: `'org_reativada'` aceito pelo banco e pelo TS; `KIND_LABEL.org_reativada = "A conta foi reativada — há conversas para revisar"` (igual ao `title` que a Task 5 grava); `POLITICAS_DE_AVISO.org_reativada = { refs: [], orientacao, geral: { papel: "agent", href: "/app/inbox", rotulo: "Abrir o Inbox" } }`. **Contrato com a Task 5:** o item nasce com `ref_kind = NULL` e `ref_id = NULL` (com `ref_kind='organization'` ele não abre o Inbox).

- [ ] **Passo 1: o baseline primeiro** — confira `grep -n "^    'proposta_pronta_para_revisao',$" supabase/baseline.sql` → uma linha (hoje `10108`). Troque:

```sql
    'proposta_pronta_para_revisao',
    'other'
  ));
```

por:

```sql
    'proposta_pronta_para_revisao',
    -- (migration 0492) a organização voltou de uma suspensão e há conversas que
    -- receberam mensagem enquanto ela estava parada: a IA não respondeu nem vai
    -- responder sozinha. Um item por reativação, aberto por fn_reativar_organizacao.
    'org_reativada',
    'other'
  ));
```

- [ ] **Passo 2: o teste de destino que falha** — em `lib/ai/inbox-destino.test.ts`, dentro de `describe("destinos da Central", …)`, logo depois do caso `"envio preso representa uma conversa, não todas"`:

```ts
  it("reativação leva ao Inbox sem referência, e só para quem atende", async () => {
    const [agente] = await resolverDestinosDosAvisos(leitor().client, ORG, "agent", [aviso("org_reativada", null, null)]);
    expect(agente?.destination).toEqual({
      estado: "disponivel",
      href: "/app/inbox",
      rotulo: "Abrir o Inbox",
      orientacao: POLITICAS_DE_AVISO.org_reativada.orientacao,
    });
    const [leitura] = await resolverDestinosDosAvisos(leitor().client, ORG, "viewer", [aviso("org_reativada", null, null)]);
    expect(leitura?.destination.estado).toBe("sem_permissao");
    // O contrato com o SQL: o item nasce SEM referência. Com `organization`, ele não abre o Inbox.
    const [comRef] = await resolverDestinosDosAvisos(leitor().client, ORG, "agent", [aviso("org_reativada", "organization", ORG)]);
    expect(comRef?.destination.estado).toBe("indisponivel");
  });
```

- [ ] **Passo 3: rodar e ver falhar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run tests/unit/kind-check-migration-x-baseline.test.ts lib/ai/inbox-destino.test.ts > /tmp/t4-red.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t4-red.log | tail -2
grep -aE "Faltando nela|org_reativada" /tmp/t4-red.log | head -4
```

Esperado: `exit=1`; `Test Files  2 failed (2)`; `Faltando nela: org_reativada` (a 0475 ainda é a última reconstrutora) e o destino `sem_destino` em vez de `disponivel`.

- [ ] **Passo 4: seção D da migration** — no FIM da migration (só nela):

```sql
-- ── D. agent_inbox_items.kind ganha 'org_reativada' ──────────────────────────
-- Lista COMPLETA do bloco único do baseline (kind-check-migration-x-baseline):
-- esta passa a ser a última migration que reconstrói a constraint.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required','appointment_recovery_review','qr_rescan','routing_unassigned',
    'job_dead','event_dead','budget_exceeded','handoff','promotion_review','judge_unaligned',
    'followup_dead','snooze_expired','next_action_ambiguous','risk_backlog_seeded',
    'reactivation_expired','capabilities_missing','message_send_stuck','midia_nao_lida',
    'channel_template_review','channel_number_alert','promise_unfulfilled','contact_proposal_expired',
    'budget_warning','conhecimento_nao_indexado','voice_call_missed','case_stale',
    'aviso_de_caso_nao_entregue','followup_sem_agente','canal_mudo_sem_numero',
    'proposal_expired_notice','proposal_acceptance_rate_drop','proposal_promised_not_created',
    'proposta_travada',
    'proposta_pronta_para_revisao',
    -- a organização voltou de uma suspensão e há conversas para revisar.
    'org_reativada',
    'other'
  ));

```

Antes de colar, confira que a lista acima é a do baseline (35 valores + o novo): `awk '/agent_inbox_items_kind_check/,/\)\);/' supabase/baseline.sql | grep -oE "'[a-z_]+'" | sort | tr '\n' ' '` e compare com a da migration. Se a main andou e ganhou kind novo, copie a lista do baseline.

- [ ] **Passo 5: `InboxKind`** — em `lib/agent-engine/db/repository.ts`, troque

```ts
  | 'proposta_pronta_para_revisao'
  | 'other';
```

por

```ts
  | 'proposta_pronta_para_revisao'
  // (migration 0492) A organização voltou de uma suspensão e há conversas que
  // receberam mensagem enquanto ela estava parada. A IA não respondeu e não vai
  // responder sozinha, então quem abre o Inbox é uma pessoa. Nasce sem referência.
  | 'org_reativada'
  | 'other';
```

- [ ] **Passo 6: rótulo** — em `lib/ai/agent-inbox-copy.ts`, depois de `  proposta_pronta_para_revisao: "Uma proposta está pronta para revisão",`:

```ts
  // Igual ao `title` que fn_reativar_organizacao grava: diz o que a pessoa tem
  // de FAZER agora — as conversas que chegaram durante a suspensão ficaram sem resposta.
  org_reativada: "A conta foi reativada — há conversas para revisar",
```

- [ ] **Passo 7: política de destino** — em `lib/ai/inbox-destino.ts`, imediatamente ANTES da linha que começa com `  other: { refs: ["lead", "channel_session"` (hoje `:125`):

```ts
  // A revisão depois da reativação (`fn_reativar_organizacao`). Nasce SEM
  // referência: o aviso é sobre N conversas, não sobre uma, e com
  // `ref_kind='organization'` o resolvedor não chegaria ao Inbox. O Inbox não
  // tem parâmetro de aba na URL (`app/app/inbox/page.tsx` só lê `id` e
  // `rascunho`), por isso o botão leva ao Inbox e a orientação nomeia a aba.
  org_reativada: {
    refs: [],
    orientacao: "A IA não respondeu nem vai responder sozinha às conversas que chegaram durante a suspensão. Abra o Inbox e revise a aba Fila.",
    geral: { papel: "agent", href: "/app/inbox", rotulo: "Abrir o Inbox" },
  },
```

- [ ] **Passo 8: dicionário `es`** — confirme que nenhuma chave existe: `grep -c '"Abrir o Inbox"\|"A conta foi reativada — há\|"A IA não respondeu nem vai responder sozinha às' lib/i18n/dicionario.ts` → `0`. Logo depois de `  "Ligar de volta": { es: "Devolver la llamada" },` (`:9999` em `d03c2b2fd`, única):

```ts
  "A conta foi reativada — há conversas para revisar": {
    es: "La cuenta fue reactivada — hay conversaciones para revisar",
  },
  "A IA não respondeu nem vai responder sozinha às conversas que chegaram durante a suspensão. Abra o Inbox e revise a aba Fila.":
    {
      es: "La IA no respondió ni responderá sola a las conversaciones que llegaron durante la suspensión. Abre el Inbox y revisa la pestaña Cola.",
    },
  "Abrir o Inbox": { es: "Abrir el Inbox" },
```

- [ ] **Passo 9: rodar e ver passar (unidade + vocabulário)**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run tests/unit/kind-check-migration-x-baseline.test.ts tests/unit/check-do-baseline-nao-diverge-da-cadeia.test.ts \
  tests/unit/baseline-constraint-reconstruida.test.ts tests/unit/migrations-nao-encolhem-vocabulario.test.ts \
  tests/unit/midia-nao-lida.test.ts lib/ai/inbox-destino.test.ts lib/ai/agent-inbox-copy.test.ts > /tmp/t4.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t4.log | tail -2
pnpm typecheck; echo "exit=$?"
pnpm test:db tests/invariants/vocabulario-banco-x-typescript.test.ts > /tmp/t4-db.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t4-db.log | tail -2
```

Esperado: vitest `exit=0`, `Test Files  7 passed (7)` (inclusive "toda categoria possui política" e "textos dinâmicos … têm espanhol"); typecheck `exit=0`; test:db `exit=0`, `Test Files  1 passed (1)`.

- [ ] **Passo 10: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add supabase/baseline.sql supabase/migrations/20260929180000_0492_org_operante_e_suspensao_tipada.sql \
  lib/agent-engine/db/repository.ts lib/ai/agent-inbox-copy.ts lib/ai/inbox-destino.ts lib/ai/inbox-destino.test.ts lib/i18n/dicionario.ts
git commit -F - <<'FIM'
feat(central): aviso org_reativada leva ao Inbox depois de uma suspensão (0492)

O kind entra no bloco único de agent_inbox_items_kind_check (no lugar, no
baseline) e na lista completa da 0492, que passa a ser a última reconstrutora.
InboxKind, rótulo, política de destino (/app/inbox, agent+, sem referência) e
as três frases em espanhol vêm juntos.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 5: `fn_reativar_organizacao` (invariante 4, metade da reativação)

**Files:**
- Modify: migration 0492 (seção E no fim), `supabase/baseline.sql` (seção E no fim do bloco 0492), `tests/invariants/org-suspensa.test.ts`, `lib/database.types.ts`

**Interfaces**
- Consumes: `fn_suspender_organizacao` (Task 3), kind `org_reativada` (Task 4), `conversations.last_inbound_at` (movido por `fn_mark_conversation_message` em mensagem `inbound`), gatilho `trg_aviso_da_central_criado`.
- Produces: `public.fn_reativar_organizacao(p_org uuid, p_kind_exigido text, p_ator uuid) returns jsonb` → `{"changed": true}` ou `{"changed": false, "motivo": "nao_suspensa" | "suspensao_de_cobranca" | "suspensao_administrativa"}`; erros `22023`, `P0002`. EXECUTE só `service_role`. Item `agent_inbox_items` (`kind='org_reativada'`, `severity='warn'`, `title='A conta foi reativada — há conversas para revisar'`, `ref_kind`/`ref_id` nulos, corpo com "enquanto a conta estava suspensa"). A rota `/reactivate` (Task 13) mapeia a org de kind `cobranca` → 409 `suspensao_de_cobranca`.

- [ ] **Passo 1: os testes que falham** — no fim de `tests/invariants/org-suspensa.test.ts`:

```ts
describe("inv. 4 — fn_reativar_organizacao volta sem rajada e chama o humano", () => {
  const corpoDoItem = () =>
    valor(
      `select coalesce(string_agg(severity || '|' || coalesce(ref_kind, 'null') || '|' || body, ' ## '), '-') from public.agent_inbox_items where organization_id = '${ORG_A}' and kind = 'org_reativada';`,
    );

  it("⭐ reativa a administrativa, zera a suspensão, falha o pending remanescente e abre UM item com a contagem", () => {
    suspender(ORG_A, "administrativa");
    // Durante a suspensão: as duas conversas recebem mensagem e um job escapa para a fila.
    sql(`
      update public.conversations set last_inbound_at = clock_timestamp() where id in ('${CONVERSA_A1}', '${CONVERSA_A2}');
      insert into public.job_queue (organization_id, kind, status) values ('${ORG_A}', 'watchdog', 'pending');
    `);
    const antes = eventos(ORG_A, "tenant.reactivated");

    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: true });

    expect(estado(ORG_A)).toBe("active/-");
    expect(
      valor(
        `select (suspended_at is null and suspended_reason is null and suspended_by is null)::text from public.organizations where id = '${ORG_A}';`,
      ),
    ).toBe("true");
    expect(valor(`select count(*) from public.job_queue where organization_id = '${ORG_A}' and status = 'pending';`)).toBe("0");
    expect(corpoDoItem()).toBe(
      "warn|null|2 conversas receberam mensagem enquanto a conta estava suspensa. A IA não respondeu nem vai responder sozinha a elas. Revise na Fila.",
    );
    expect(eventos(ORG_A, "tenant.reactivated")).toBe(antes + 1);
    expect(
      valor(
        `select payload->>'conversas_com_mensagem' from public.event_log where organization_id = '${ORG_A}' and event_type = 'tenant.reactivated' order by created_at desc limit 1;`,
      ),
    ).toBe("2");
  });

  it("uma conversa só: frase no singular; mensagem de ANTES da suspensão não conta", () => {
    sql(`update public.conversations set last_inbound_at = now() - interval '1 day' where id = '${CONVERSA_A2}';`);
    suspender(ORG_A, "administrativa");
    sql(`update public.conversations set last_inbound_at = clock_timestamp() where id = '${CONVERSA_A1}';`);
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(corpoDoItem()).toBe(
      "warn|null|1 conversa recebeu mensagem enquanto a conta estava suspensa. A IA não respondeu nem vai responder sozinha a ela. Revise na Fila.",
    );
  });

  it("nenhuma conversa nova: reativa sem abrir item", () => {
    suspender(ORG_A, "administrativa");
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(corpoDoItem()).toBe("-");
  });

  it("⭐ o tipo é exigido: administrativa não desfaz cobrança, cobrança não desfaz administrativa", () => {
    suspender(ORG_A, "cobranca");
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: false, motivo: "suspensao_de_cobranca" });
    expect(estado(ORG_A)).toBe("suspended/cobranca");
    expect(reativar(ORG_A, "cobranca")).toEqual({ changed: true });
    expect(estado(ORG_A)).toBe("active/-");

    suspender(ORG_A, "administrativa");
    expect(reativar(ORG_A, "cobranca")).toEqual({ changed: false, motivo: "suspensao_administrativa" });
    expect(estado(ORG_A)).toBe("suspended/administrativa");
  });

  it("idempotente: reativar uma org ativa é no-op sem evento", () => {
    const antes = eventos(ORG_A, "tenant.reactivated");
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: false, motivo: "nao_suspensa" });
    expect(eventos(ORG_A, "tenant.reactivated")).toBe(antes);
  });

  it("redigida com tipo residual: nem suspende, nem reativa, nem quebra", () => {
    sql(`update public.organizations set status = 'redacted', suspended_kind = 'cobranca' where id = '${ORG_R}';`);
    expect(suspender(ORG_R, "administrativa")).toEqual({ changed: false, motivo: "org_encerrada" });
    expect(reativar(ORG_R, "cobranca")).toEqual({ changed: false, motivo: "nao_suspensa" });
    expect(estado(ORG_R)).toBe("redacted/cobranca");
    expect(operante(ORG_R)).toBe("false");
  });

  it("suspensão legada sem tipo (imagem anterior à 0492) vale como administrativa", () => {
    sql(`update public.organizations set status = 'suspended', suspended_at = now() where id = '${ORG_A}';`);
    expect(reativar(ORG_A, "cobranca")).toEqual({ changed: false, motivo: "suspensao_administrativa" });
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(estado(ORG_A)).toBe("active/-");
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db tests/invariants/org-suspensa.test.ts > /tmp/t5-red.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t5-red.log | tail -2
```

Esperado: `exit=1`; `Tests  7 failed | 22 passed (29)` (`function public.fn_reativar_organizacao(unknown, unknown, unknown) does not exist`).

- [ ] **Passo 3: implementar** — cole byte a byte em DOIS lugares (fim da migration, depois da seção D; fim do bloco 0492 do baseline, acima de `-- ---- VARREDURA anon:`):

```sql
-- ── E. fn_reativar_organizacao: volta sem rajada ─────────────────────────────
-- Exige o tipo: `/reactivate` desfaz só a administrativa; a de cobrança sai por
-- pagamento, prazo ou isenção (PR 2 em diante). Nada é reprocessado: jobs
-- `pending` que sobraram viram `failed`, e as conversas que receberam mensagem
-- durante a suspensão viram UM item na Central (sem referência) para uma
-- pessoa revisar.
create or replace function public.fn_reativar_organizacao(
  p_org uuid, p_kind_exigido text, p_ator uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status    text;
  v_kind      text;
  v_desde     timestamptz;
  v_conversas integer := 0;
begin
  if p_kind_exigido is null or p_kind_exigido not in ('administrativa', 'cobranca') then
    raise exception 'tipo_de_suspensao_invalido' using errcode = '22023';
  end if;

  select o.status, coalesce(o.suspended_kind, 'administrativa'), o.suspended_at
    into v_status, v_kind, v_desde
    from public.organizations o
   where o.id = p_org
     for update;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;

  if v_status <> 'suspended' then
    return jsonb_build_object('changed', false, 'motivo', 'nao_suspensa');
  end if;
  if v_kind <> p_kind_exigido then
    return jsonb_build_object('changed', false, 'motivo',
      case v_kind when 'cobranca' then 'suspensao_de_cobranca' else 'suspensao_administrativa' end);
  end if;

  update public.organizations
     set status = 'active',
         suspended_kind = null,
         suspended_at = null,
         suspended_reason = null,
         suspended_by = null
   where id = p_org;

  update public.job_queue
     set status = 'failed', last_error = 'org_nao_operante'
   where organization_id = p_org and status = 'pending';

  if v_desde is not null then
    select count(*) into v_conversas
      from public.conversations c
     where c.organization_id = p_org
       and c.last_inbound_at >= v_desde;
  end if;

  if v_conversas > 0 then
    insert into public.agent_inbox_items (organization_id, kind, severity, title, body)
    values (p_org, 'org_reativada', 'warn',
            'A conta foi reativada — há conversas para revisar',
            case when v_conversas = 1
              then '1 conversa recebeu mensagem enquanto a conta estava suspensa. A IA não respondeu nem vai responder sozinha a ela. Revise na Fila.'
              else format('%s conversas receberam mensagem enquanto a conta estava suspensa. A IA não respondeu nem vai responder sozinha a elas. Revise na Fila.', v_conversas)
            end);
  end if;

  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload)
  values (p_org, 'tenant.reactivated', 'organization', p_org,
          jsonb_build_object('tenant_id', p_org, 'kind', v_kind,
                             'reactivated_by', p_ator, 'conversas_com_mensagem', v_conversas));

  return jsonb_build_object('changed', true);
end;
$$;

revoke execute on function public.fn_reativar_organizacao(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_reativar_organizacao(uuid, text, uuid) to service_role;

```

- [ ] **Passo 4: tipo da função** — em `lib/database.types.ts`, logo abaixo do bloco `fn_suspender_organizacao`:

```ts
      fn_reativar_organizacao: {
        Args: { p_org: string; p_kind_exigido: string; p_ator: string }
        Returns: Json
      }
```

- [ ] **Passo 5: rodar e ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db tests/invariants/org-suspensa.test.ts > /tmp/t5.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t5.log | tail -2
pnpm typecheck; echo "exit=$?"
```

Esperado: `exit=0`; `Tests  29 passed (29)`; typecheck `exit=0`.

- [ ] **Passo 6: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add supabase/migrations/20260929180000_0492_org_operante_e_suspensao_tipada.sql supabase/baseline.sql tests/invariants/org-suspensa.test.ts lib/database.types.ts
git commit -F - <<'FIM'
fix(org): reativar exige o tipo e chama o humano em vez de reprocessar (0492)

fn_reativar_organizacao recusa desfazer uma suspensão de outro tipo, zera os
campos de suspensão, falha os jobs pending que sobraram e abre um único item
org_reativada (sem referência) com a contagem de conversas que receberam
mensagem durante a suspensão. Suspensão legada sem tipo vale como administrativa.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 6: Prova do banco (install + update inteiros, sabotagem do gatilho e do anti-backlog)

**Files:** nenhum (a sabotagem é descartada).

**Interfaces** — Consumes: Tasks 1–5. Produces: evidência (`/tmp/t6-*.log`) citada no corpo do PR com o SHA (`git rev-parse HEAD`).

- [ ] **Passo 1: o banco inteiro**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db > /tmp/t6-db.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t6-db.log | tail -2
grep -aE "ERROR|FATAL" /tmp/t6-db.log | head -5
```

Esperado: `exit=0`; `0 failed`; `hardening-definer-varredura`, `definer-membership-varredura`, `definer-nova-nasce-exposta`, `vocabulario-banco-x-typescript`, `travas-de-suporte-cobrem-toda-tabela-na-instalacao`, `update-nao-reabre-permissao` e `org-suspensa` verdes. Invariante que semeie organização como `authenticated` quebra com `organizacao_nasce_so_pelo_servidor`: é o gatilho funcionando — conserte a FIXTURE (semear como `postgres`), nunca o gatilho, e commite `test(fixture): <arquivo> semeia a organização pelo servidor`.

- [ ] **Passo 2: sabotagem do gatilho** (depois do commit)

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git status --short | wc -l   # esperado: 0
perl -0pi -e 's/create trigger trg_organizacao_estado_so_pelo_servidor\n  before insert or update on public.organizations\n  for each row execute function public.fn_organizacao_estado_so_pelo_servidor\(\);//' supabase/baseline.sql
grep -c "create trigger trg_organizacao_estado_so_pelo_servidor" supabase/baseline.sql   # esperado: 0
pnpm test:db tests/invariants/org-suspensa.test.ts > /tmp/t6-sab.log 2>&1; echo "exit=$?"
grep -aE "Tests " /tmp/t6-sab.log | tail -1          # esperado: 8 failed (os ⭐ do inv. 2)
git checkout -- supabase/baseline.sql
grep -c "create trigger trg_organizacao_estado_so_pelo_servidor" supabase/baseline.sql   # esperado: 1 — o conserto VOLTOU
git status --short | wc -l   # esperado: 0
```

- [ ] **Passo 3: sabotagem do anti-backlog**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
perl -0pi -e "s/(create or replace function public\.fn_suspender_organizacao.*?)update public\.job_queue\n     set status = 'failed', last_error = 'org_nao_operante'\n   where organization_id = p_org and status = 'pending';\n/\$1/s" supabase/baseline.sql
pnpm test:db tests/invariants/org-suspensa.test.ts > /tmp/t6-sab2.log 2>&1; echo "exit=$?"
grep -aE "Tests " /tmp/t6-sab2.log | tail -1          # esperado: ≥1 failed
git checkout -- supabase/baseline.sql
grep -c "last_error = 'org_nao_operante'" supabase/baseline.sql   # esperado: 2 (suspender e reativar)
git status --short | wc -l   # esperado: 0
```

Nada a commitar.

---

### Task 7: `lib/organizacao/operante.ts` completo — a régua e o erro terminal

**Files:** Modify (reescrever) `lib/organizacao/operante.ts`; Create `lib/organizacao/operante.test.ts`.

**Interfaces**
- Consumes: `TIPOS_DE_SUSPENSAO`/`TipoDeSuspensao` (Task 1, mantidos); `ApiError` de `lib/api/types.ts` (`constructor(status, code, details, requestId, message?)`, sem imports — seguro sob `tsx`).
- Produces: `STATUS_OPERANTE = "active"`; `ehOperante(status: string | null | undefined): boolean`; `idsDeOrgsParadas(admin: SupabaseClient): Promise<string[]>` (`.from("organizations").select("id").neq("status","active")`, lança em erro); `assertOrgOperante(db: SupabaseClient, orgId: string): Promise<void>` (lança `OrgNaoOperanteError` se não opera ou não aparece; erro comum se a leitura falha); `class OrgNaoOperanteError extends ApiError` com `status 403`, `code "org_suspended"`, `terminal = true`, `organizationId`, `orgStatus`, construtor `(organizationId: string, orgStatus: string | null = null)`.

- [ ] **Passo 1: o teste que falha** — `lib/organizacao/operante.test.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";

import {
  OrgNaoOperanteError,
  STATUS_OPERANTE,
  TIPOS_DE_SUSPENSAO,
  assertOrgOperante,
  ehOperante,
  idsDeOrgsParadas,
} from "./operante";

/** Dublê do PostgREST: registra a cadeia e resolve no resultado (thenable + maybeSingle). */
function banco(resultado: { data: unknown; error: { message: string } | null }) {
  const chamadas: unknown[][] = [];
  const cadeia: Record<string, unknown> = {
    then: (resolver: (v: unknown) => unknown) => Promise.resolve(resultado).then(resolver),
    maybeSingle: async () => resultado,
  };
  for (const metodo of ["select", "eq", "neq"]) {
    cadeia[metodo] = (...args: unknown[]) => {
      chamadas.push([metodo, ...args]);
      return cadeia;
    };
  }
  const db = {
    from: (tabela: string) => {
      chamadas.push(["from", tabela]);
      return cadeia;
    },
  } as unknown as SupabaseClient;
  return { db, chamadas };
}

describe("ehOperante — a régua única", () => {
  it("só 'active' opera", () => {
    expect(STATUS_OPERANTE).toBe("active");
    expect(ehOperante("active")).toBe(true);
  });
  it.each(["suspended", "redacted", "archived", "status_que_ainda_nao_existe", "ACTIVE", "", null, undefined])(
    "%s não opera (falha fechada)",
    (status) => expect(ehOperante(status as string | null | undefined)).toBe(false),
  );
  it("os tipos de suspensão são os do CHECK de organizations.suspended_kind", () => {
    expect([...TIPOS_DE_SUSPENSAO]).toEqual(["administrativa", "cobranca"]);
  });
});

describe("idsDeOrgsParadas", () => {
  it("pede as orgs com status diferente de 'active' e devolve só os ids", async () => {
    const { db, chamadas } = banco({ data: [{ id: "o1" }, { id: "o2" }], error: null });
    await expect(idsDeOrgsParadas(db)).resolves.toEqual(["o1", "o2"]);
    expect(chamadas).toEqual([["from", "organizations"], ["select", "id"], ["neq", "status", "active"]]);
  });
  it("erro de leitura LANÇA — nunca vira 'nenhuma org parada'", async () => {
    const { db } = banco({ data: null, error: { message: "timeout" } });
    await expect(idsDeOrgsParadas(db)).rejects.toThrow(/idsDeOrgsParadas: timeout/);
  });
});

describe("assertOrgOperante", () => {
  it("org ativa passa", async () => {
    const { db } = banco({ data: { status: "active" }, error: null });
    await expect(assertOrgOperante(db, "o1")).resolves.toBeUndefined();
  });
  it("org suspensa lança OrgNaoOperanteError: ApiError 403 org_suspended, terminal", async () => {
    const { db } = banco({ data: { status: "suspended" }, error: null });
    const erro = await assertOrgOperante(db, "o1").catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(OrgNaoOperanteError);
    // A rota /messages só traduz ApiError em resposta; o agent-worker só cancela
    // sem retry quem tem `terminal === true`. `status` é o HTTP, nunca o da org.
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({
      status: 403,
      code: "org_suspended",
      terminal: true,
      organizationId: "o1",
      orgStatus: "suspended",
    });
  });
  it("org que não aparece é não operante (falha fechada)", async () => {
    const { db } = banco({ data: null, error: null });
    await expect(assertOrgOperante(db, "o1")).rejects.toMatchObject({ code: "org_suspended", orgStatus: null });
  });
  it("erro de leitura lança erro COMUM, não OrgNaoOperanteError", async () => {
    const { db } = banco({ data: null, error: { message: "boom" } });
    const erro = await assertOrgOperante(db, "o1").catch((e: unknown) => e);
    expect(erro).not.toBeInstanceOf(OrgNaoOperanteError);
    expect(String(erro)).toMatch(/assertOrgOperante: boom/);
  });
});
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run lib/organizacao/operante.test.ts` → FAIL (`ehOperante is not a function`, `STATUS_OPERANTE` undefined; os exports ainda não existem).

- [ ] **Passo 3: implementar** — substitua `lib/organizacao/operante.ts` inteiro por:

```ts
/**
 * "ORG OPERANTE" — a régua ÚNICA de "esta empresa pode operar?"
 * (docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §4).
 *
 * operante ⇔ organizations.status = 'active'. Espelho SQL:
 * `public.fn_org_operante(uuid)` (migration 0492). Mesma régua dos porteiros SQL
 * que já existiam (fn_accept_team_invite, fn_reply_delivery_policy,
 * fn_meet_delivery_current). `suspended`, `redacted`, `archived` e qualquer
 * status futuro ficam NÃO operantes: falha fechada.
 *
 * ── Leitura de `suspended_kind` ──────────────────────────────────────────────
 * Só significa algo com status='suspended'. O lgpd-redact-worker troca o status
 * para 'redacted' sem limpar o tipo, e por isso o banco NÃO tem CHECK de
 * coerência entre as duas colunas: quem lê o tipo confere antes que a org está
 * parada. Suspensão com tipo NULO (gravada por uma imagem anterior à 0492,
 * depois de um rollback) vale como `administrativa`, como nas funções de estado.
 *
 * ── Deliberadamente NÃO gatilhados (spec §4, decisões D-11 e D-12) ───────────
 * - webhooks de entrada: waha, waha/[token], meta/[token], channel/[token],
 *   in/[token], channels/official/webhook, nuvemshop/[event] e
 *   lib/channels/inbound.ts — a mensagem que CHEGA continua gravada;
 * - landings anuncios/{google,meta}/[org] e rastreio/[id] (D-11);
 * - recover-stuck-messages; sync/push do Google Agenda; contact-avatars;
 * - leitura via RLS, Realtime e Storage;
 * - escrita de dados de negócio via PostgREST por membro de org suspensa (D-12);
 * - LGPD: nunca bloqueada (requireRole({ permiteOrgSuspensa: true })).
 *
 * Este módulo NÃO importa `next/*` nem `server-only`: o dreno do event_log e o
 * do agent-engine o carregam sob `tsx` no worker
 * (tests/unit/drain-loop-carrega-deps-sob-tsx.test.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";

export const STATUS_OPERANTE = "active" as const;

/** Por que a organização está suspensa. Par de `organizations_suspended_kind_check` (0492). */
export const TIPOS_DE_SUSPENSAO = ["administrativa", "cobranca"] as const;
export type TipoDeSuspensao = (typeof TIPOS_DE_SUSPENSAO)[number];

export function ehOperante(status: string | null | undefined): boolean {
  return status === STATUS_OPERANTE;
}

/**
 * A organização não opera. `ApiError` 403 `org_suspended`: a rota /messages o
 * traduz em resposta (app/api/v1/messages/route.ts) e o agent-worker cancela sem
 * retry quem tem `terminal === true` (workers/agent-worker/main.ts,
 * `ehVetoPermanenteDeNegocio`) — a org parada não volta a operar sozinha.
 * `orgStatus`, e não `status`: `status` é o HTTP herdado de `ApiError`.
 */
export class OrgNaoOperanteError extends ApiError {
  readonly terminal = true as const;
  constructor(
    readonly organizationId: string,
    readonly orgStatus: string | null = null,
  ) {
    super(403, "org_suspended", undefined, "", "A conta desta empresa está suspensa.");
    this.name = "OrgNaoOperanteError";
  }
}

/** Ids das orgs NÃO operantes, para excluir de varreduras (crons, workers). Erro de leitura lança. */
export async function idsDeOrgsParadas(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from("organizations").select("id").neq("status", STATUS_OPERANTE);
  if (error) throw new Error(`idsDeOrgsParadas: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((linha) => linha.id);
}

/** Lança `OrgNaoOperanteError` se a org não opera (inclusive se não aparece). Erro de leitura lança erro comum. */
export async function assertOrgOperante(db: SupabaseClient, orgId: string): Promise<void> {
  const { data, error } = await db.from("organizations").select("status").eq("id", orgId).maybeSingle();
  if (error) throw new Error(`assertOrgOperante: ${error.message}`);
  const status = (data as { status?: string } | null)?.status ?? null;
  if (!ehOperante(status)) throw new OrgNaoOperanteError(orgId, status);
}
```

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run lib/organizacao/operante.test.ts tests/unit/drain-loop-carrega-deps-sob-tsx.test.ts && pnpm typecheck` → `Tests  16 passed (16)` no primeiro arquivo; o segundo verde; `tsc` exit 0.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/organizacao/operante.ts lib/organizacao/operante.test.ts
git commit -F - <<'FIM'
feat(organizacao): régua única de org operante e o erro terminal org_suspended

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 8: Sessão — `loadAuthUser`, `escolherMembroAtivo`, `orgAtivaSemPortao`, `resolveActiveOrg`

**Files:** Modify `lib/auth/types.ts`, `lib/auth/server.ts`, `lib/legal/operador.ts`, `tests/unit/auth-falha-alto.test.ts`, `tests/unit/telas-falam-a-moeda-e-o-pais-da-organizacao.test.tsx`. Create `tests/unit/org-ativa-sem-portao.test.ts`.

**Interfaces**
- Consumes: `ehOperante`, `STATUS_OPERANTE` (Task 7); coluna `suspended_kind` (Task 1 — sem ela o embed erra e `loadAuthUser` lança `auth_permissions_unavailable` em TODA sessão). Base: o `lib/auth/server.ts` de `d03c2b2fd`, que já traz `currency`/`country` no embed e, no ramo de acompanhamento, a leitura por service role de `timezone, currency, country` (#1945). Nada disso pode sumir: o corpo de `orgAtivaSemPortao` é o `resolveActiveOrg` ATUAL da main mais os dois campos novos.
- Produces: `UserOrgMembership.org_status?: string | null`, `UserOrgMembership.suspended_kind?: string | null`, `AuthUser.platform_admin_scope?: string | null`, `ActiveOrg.org_status?`, `ActiveOrg.suspended_kind?`; `orgAtivaSemPortao(user: AuthUser): Promise<ActiveOrg | null>` (React `cache`, sem redirect de suspensão); `resolveActiveOrg` redireciona org não operante para `/account-suspended`. Campos opcionais de propósito (~105 fixtures de `AuthUser`); todo leitor falha fechado.

- [ ] **Passo 1: testes que falham.**

`tests/unit/org-ativa-sem-portao.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthUser, UserOrgMembership } from "@/lib/auth/types";
import { ehOperante } from "@/lib/organizacao/operante";

const estado = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (estado.cookie ? { value: estado.cookie } : undefined),
    getAll: () => [],
    set: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// O ramo de acompanhamento lê fuso, moeda e país por service role (#1945).
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const c = {
        select: () => c,
        eq: () => c,
        maybeSingle: async () => ({ data: { timezone: null, currency: null, country: null } }),
      };
      return c;
    },
  }),
}));

const { orgAtivaSemPortao, resolveActiveOrg } = await import("@/lib/auth/server");

const ATIVA = "aaaaaaaa-0000-4000-8000-000000000001";
const SUSPENSA = "aaaaaaaa-0000-4000-8000-000000000002";

function membro(id: string, org_status: string | null, suspended_kind: string | null = null): UserOrgMembership {
  return { organization_id: id, organization_name: id, role: "admin", org_status, suspended_kind };
}
function usuario(organizations: UserOrgMembership[], extra: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u1", email: "a@b.c", full_name: null, avatar_url: null,
    is_platform_admin: false, idioma: "pt-BR", organizations, ...extra,
  };
}

beforeEach(() => {
  estado.cookie = undefined;
});

describe("orgAtivaSemPortao / resolveActiveOrg — a org parada", () => {
  it("sem cookie, prefere a membership OPERANTE mesmo com a suspensa antes na ordem", async () => {
    const org = await orgAtivaSemPortao(usuario([membro(SUSPENSA, "suspended", "administrativa"), membro(ATIVA, "active")]));
    expect(org).toMatchObject({ orgId: ATIVA, org_status: "active" });
  });

  it("com cookie na suspensa, MANTÉM a suspensa (é por ela que se chega ao hub para pagar)", async () => {
    estado.cookie = SUSPENSA;
    const org = await orgAtivaSemPortao(usuario([membro(ATIVA, "active"), membro(SUSPENSA, "suspended", "cobranca")]));
    expect(org).toMatchObject({ orgId: SUSPENSA, org_status: "suspended", suspended_kind: "cobranca" });
  });

  it("cookie de org sem vínculo cai na primeira OPERANTE", async () => {
    estado.cookie = "ffffffff-0000-4000-8000-00000000000f";
    const org = await orgAtivaSemPortao(usuario([membro(SUSPENSA, "suspended", "administrativa"), membro(ATIVA, "active")]));
    expect(org?.orgId).toBe(ATIVA);
  });

  it("sem nenhuma operante cai na primeira, e resolveActiveOrg redireciona ao hub", async () => {
    const u = usuario([membro(SUSPENSA, "suspended", "administrativa")]);
    expect((await orgAtivaSemPortao(u))?.orgId).toBe(SUSPENSA);
    await expect(resolveActiveOrg(u)).rejects.toThrow("redirect:/account-suspended");
  });

  it("status desconhecido (null) também é parada — falha fechada", async () => {
    await expect(resolveActiveOrg(usuario([membro(ATIVA, null)]))).rejects.toThrow("redirect:/account-suspended");
  });

  it("CONTROLE: org operante passa por resolveActiveOrg sem redirecionar", async () => {
    await expect(resolveActiveOrg(usuario([membro(ATIVA, "active")]))).resolves.toMatchObject({ orgId: ATIVA });
  });

  // Review Focus 2: o layout (resolveActiveOrg) e o hub (orgAtivaSemPortao) têm
  // de escolher a MESMA org para o mesmo cookie; se divergirem, laço de 307.
  it.each([
    ["sem cookie, suspensa antes", undefined, [membro(SUSPENSA, "suspended", "administrativa"), membro(ATIVA, "active")]],
    ["cookie na suspensa", SUSPENSA, [membro(ATIVA, "active"), membro(SUSPENSA, "suspended", "cobranca")]],
    ["cookie na ativa", ATIVA, [membro(SUSPENSA, "suspended", "administrativa"), membro(ATIVA, "active")]],
    ["só a suspensa", undefined, [membro(SUSPENSA, "suspended", "administrativa")]],
    ["cookie órfão", "ffffffff-0000-4000-8000-00000000000f", [membro(SUSPENSA, "suspended", null)]],
  ] as const)("sem laço (%s): resolveActiveOrg redireciona SÓ quando a org de orgAtivaSemPortao não opera", async (_nome, cookie, orgs) => {
    estado.cookie = cookie;
    const u = usuario([...orgs]);
    const semPortao = await orgAtivaSemPortao(u);
    if (ehOperante(semPortao?.org_status)) {
      await expect(resolveActiveOrg(u)).resolves.toMatchObject({ orgId: semPortao!.orgId });
    } else {
      await expect(resolveActiveOrg(u)).rejects.toThrow("redirect:/account-suspended");
    }
  });

  it("acompanhamento ativo entra como operante; encerrado segue para /support-ended", async () => {
    const suporte = {
      id: "33333333-3333-4333-8333-333333333333", organization_id: SUSPENSA,
      actor_user_id: "u1", auth_session_id: "44444444-4444-4444-8444-444444444444",
      previous_organization_id: null, expires_at: "2099-01-01T00:00:00Z", name: "Org",
      locale: null, access_mode: "support_readonly" as const, status: "active" as const,
    };
    await expect(resolveActiveOrg(usuario([], { support: suporte }))).resolves.toMatchObject({
      orgId: SUSPENSA, role: "viewer", org_status: "active",
    });
    await expect(orgAtivaSemPortao(usuario([], { support: { ...suporte, status: "expired" } }))).rejects.toThrow(
      "redirect:/support-ended",
    );
  });
});
```

`tests/unit/auth-falha-alto.test.ts` — três mudanças:

1. No caso "usuário com organização resolve normalmente", no objeto esperado, logo depois de `        country: null,`:

```ts
        // Status e tipo da suspensão da organização (spec da cobrança §4):
        // mesma carona, mesmo contrato — sem a coluna, `null`.
        org_status: null,
        suspended_kind: null,
```

2. No caso "a organização ATIVA leva a moeda e o país até o cliente", Edit com `old_string` = `            currency: "EUR",\n            country: "PT",\n          },` (única: é o objeto `organizations` do fixture, com 12 espaços) e `new_string` = `            currency: "EUR",\n            country: "PT",\n            status: "active",\n          },`. Sem isso o `resolveActiveOrg` real desse caso lê `org_status` nulo e lança `redirect` (o mock de `next/navigation` do arquivo lança `"redirect"`).

3. Logo depois do caso "usuário com organização resolve normalmente", no mesmo `describe`:

```ts
  it("traz status e tipo de suspensão da org e o scope do platform admin", async () => {
    consultas.platformAdmins = { data: { user_id: "u1", scope: "support_readonly", revoked_at: null }, error: null };
    consultas.memberships = {
      data: [{ organization_id: "o1", role: "admin", organizations: { display_name: "Acme", status: "suspended", suspended_kind: "cobranca" } }],
      error: null,
    };
    const u = await loadAuthUser();
    expect(u?.is_platform_admin).toBe(true);
    expect(u?.platform_admin_scope).toBe("support_readonly");
    expect(u?.organizations[0]).toMatchObject({ org_status: "suspended", suspended_kind: "cobranca" });
  });
```

O caso "no acompanhamento administrativo a organização também chega completa" NÃO muda: o ramo de acompanhamento devolve `org_status: STATUS_OPERANTE` e mantém a leitura por service role que o caso mede.

`tests/unit/telas-falam-a-moeda-e-o-pais-da-organizacao.test.tsx` — a cerca de fonte exige o embed exato. Troque (hoje `:224`)

```ts
    expect(fonte).toMatch(/organizations\(display_name, locale, timezone, currency, country\)/);
```

por

```ts
    expect(fonte).toMatch(/organizations\(display_name, locale, timezone, currency, country, status, suspended_kind\)/);
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/org-ativa-sem-portao.test.ts tests/unit/auth-falha-alto.test.ts tests/unit/telas-falam-a-moeda-e-o-pais-da-organizacao.test.tsx` → `orgAtivaSemPortao is not a function`; o `toEqual` sem `org_status`; o regex do embed sem `status, suspended_kind`.

- [ ] **Passo 3: implementar.**

`lib/auth/types.ts` (âncoras únicas em `d03c2b2fd`):

- `UserOrgMembership`: Edit com `old_string` = `  currency?: string | null;\n  country?: string | null;\n}\n\nexport interface AuthUser {` e `new_string`:

```ts
  currency?: string | null;
  country?: string | null;
  /**
   * `organizations.status` da empresa. Quem decide se ela opera é `ehOperante`
   * (`lib/organizacao/operante.ts`); ausente ou nulo = NÃO operante.
   */
  org_status?: string | null;
  /** `organizations.suspended_kind` — só significa algo com status 'suspended'. */
  suspended_kind?: string | null;
}

export interface AuthUser {
```

- `AuthUser`: depois de `  is_platform_admin: boolean;` (única no arquivo):

```ts
  /**
   * `platform_admins.scope` (`full` | `support_readonly`), nulo para quem não é
   * platform admin. Escrita de platform admin exige `=== "full"`; ausente = sem escrita.
   */
  platform_admin_scope?: string | null;
```

- `ActiveOrg`: Edit com `old_string` = `  /** País da organização (ISO-3166 alpha-2); nulo = Brasil. */\n  country?: string | null;\n  orgId: string;` e `new_string`:

```ts
  /** País da organização (ISO-3166 alpha-2); nulo = Brasil. */
  country?: string | null;
  /** Status da org ativa (`orgAtivaSemPortao` sempre preenche). Ausente/nulo = não operante. */
  org_status?: string | null;
  /** Tipo da suspensão — só significa algo com status 'suspended'. */
  suspended_kind?: string | null;
  orgId: string;
```

`lib/auth/server.ts`:
- import, depois de `import { normalizarIdioma } from "@/lib/i18n/idiomas";`: `import { STATUS_OPERANTE, ehOperante } from "@/lib/organizacao/operante";`
- `interface OrgJoin`: Edit com `old_string` = `  currency: string | null;\n  country: string | null;\n}\n\n/** O mesmo \`organizations\`` e `new_string` = `  currency: string | null;\n  country: string | null;\n  status?: string;\n  suspended_kind?: string | null;\n}\n\n/** O mesmo \`organizations\``.
- select de `platform_admins` (hoje `:178`): `.select("user_id, revoked_at")` → `.select("user_id, scope, revoked_at")`.
- select de `user_organizations` (hoje `:192`): `organizations(display_name, locale, timezone, currency, country), interface_da_empresa:organizations(interface_settings)` → `organizations(display_name, locale, timezone, currency, country, status, suspended_kind), interface_da_empresa:organizations(interface_settings)`.
- no `rows.map`, depois de `      country: org?.country ?? null,`:

```ts
      org_status: org?.status ?? null,
      suspended_kind: org?.suspended_kind ?? null,
```

- no `return` de `loadAuthUser`, depois de `    is_platform_admin: !!paRow,`: `    platform_admin_scope: paRow?.scope ?? null,`
- corpo de `escolherMembroAtivo` (hoje `:80-85`) passa a ser:

```ts
  if (memberships.length === 0) return null;
  if (cookieOrg) {
    // Com cookie, MANTÉM mesmo a suspensa: é por ela que a pessoa chega ao hub
    // `/account-suspended` para pagar, pedir LGPD ou trocar de empresa.
    const achado = memberships.find((o) => o.organization_id === cookieOrg);
    if (achado) return achado;
  }
  // Sem cookie, a primeira OPERANTE na mesma ordem (`accepted_at`,
  // `organization_id`); a primeira de todas só quando nenhuma opera.
  return memberships.find((o) => ehOperante(o.org_status)) ?? memberships[0] ?? null;
```

- substitua o bloco inteiro que começa em `/**\n * Resolves the active organization for the current request.` e termina no `});` de `resolveActiveOrg` (hoje `:283-324`) por:

```ts
/**
 * A organização ativa SEM o portão de suspensão — o corpo que `resolveActiveOrg`
 * tinha até a spec da cobrança (§4, item 3).
 *
 * Só para quem PRECISA enxergar a org parada: `requireRole` (responde 403
 * `org_suspended` em JSON, não 307), o hub `/account-suspended` e leitura que não
 * pode sumir para o suspenso (`lib/legal/operador.ts`). O resto usa `resolveActiveOrg`.
 */
export const orgAtivaSemPortao = cache(async (authUser: AuthUser): Promise<ActiveOrg | null> => {
  if (authUser.support) {
    if (authUser.support.status !== "active") redirect("/support-ended");
    // Acompanhamento não tem membership, e era por isso que este caminho
    // devolvia a organização PELADA: sem fuso, e agora sem moeda nem país. A
    // tela então caía nos padrões e mostrava `R$` dentro de uma empresa em
    // euro — o mesmo defeito que este conserto ataca, por outra porta. Uma
    // leitura por id, só nas sessões de acompanhamento; falha degrada para o
    // que havia antes, porque perder o acesso de suporte é pior que um símbolo
    // errado.
    const { data: orgDoSuporte } = await createAdminClient()
      .from("organizations")
      .select("timezone, currency, country")
      .eq("id", authUser.support.organization_id)
      .maybeSingle();
    return {
      orgId: authUser.support.organization_id,
      name: authUser.support.name,
      role: authUser.support.access_mode === "full" ? "admin" : "viewer",
      timezone: orgDoSuporte?.timezone ?? null,
      currency: orgDoSuporte?.currency ?? null,
      country: orgDoSuporte?.country ?? null,
      // `fn_support_context` só devolve status 'active' com a org em 'active'
      // (`o.status <> 'active'` vira 'revoked'), e a linha acima já saiu.
      org_status: STATUS_OPERANTE,
      suspended_kind: null,
    };
  }
  const store = await cookies();
  const ativo = escolherMembroAtivo(authUser.organizations, store.get(ACTIVE_ORG_COOKIE)?.value);
  if (!ativo) return null;
  return {
    orgId: ativo.organization_id,
    name: ativo.organization_name,
    role: ativo.role,
    interface_settings: ativo.interface_settings,
    timezone: ativo.timezone ?? null,
    currency: ativo.currency ?? null,
    country: ativo.country ?? null,
    org_status: ativo.org_status ?? null,
    suspended_kind: ativo.suspended_kind ?? null,
  };
});

/**
 * Resolves the active organization for the current request.
 * Priority: cookie `active_org` (if member of) → first OPERANT membership → first.
 * Returns null if user has zero memberships.
 *
 * Org NÃO operante redireciona para `/account-suspended` (mesmo precedente do
 * `/support-ended`). É isto que fecha páginas, layouts e server actions de uma vez.
 */
export const resolveActiveOrg = cache(async (authUser: AuthUser): Promise<ActiveOrg | null> => {
  const org = await orgAtivaSemPortao(authUser);
  if (org && !ehOperante(org.org_status)) redirect("/account-suspended");
  return org;
});
```

`lib/legal/operador.ts` (as páginas `/legal/privacy` e `/legal/terms` não podem expulsar o suspenso — LGPD nunca bloqueada): no import (hoje `:18`) troque `resolveActiveOrg` por `orgAtivaSemPortao` e, na linha `const activeOrg = await resolveActiveOrg(user);` (hoje `:98`), troque por `const activeOrg = await orgAtivaSemPortao(user);`.

- [ ] **Passo 4: ver passar:**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run tests/unit/org-ativa-sem-portao.test.ts tests/unit/auth-falha-alto.test.ts \
  tests/unit/telas-falam-a-moeda-e-o-pais-da-organizacao.test.tsx tests/unit/auth-getuser-erro-mudo.test.ts lib/legal/operador.test.ts
pnpm typecheck; echo "tsc=$?"
```

Esperado: todos `passed`; `tsc=0`.

- [ ] **Passo 5: a suíte inteira, porque `resolveActiveOrg` agora falha fechado para membership sem `org_status`**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:unit > /tmp/t8-vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t8-vt.log | tail -2
r=$(grep -aE "^ *Tests " /tmp/t8-vt.log | tail -1 | grep -oE "[0-9]+ failed" | head -1)
g=$(grep -acE "^ *FAIL " /tmp/t8-vt.log)
echo "rodapé: ${r:-0 failed} | grep contou: $g"
grep -aE "^ *FAIL " /tmp/t8-vt.log | sed 's/ > .*//' | sort | uniq -c
grep -a "redirect:/account-suspended\|Error: redirect$" /tmp/t8-vt.log | head
```

Esperado: `rodapé: 0 failed | grep contou: 0` (se divergirem, `pnpm test:unit --reporter=verbose` antes de concluir). Receita para cada arquivo vermelho em que o `resolveActiveOrg` REAL passou a lançar `redirect:/account-suspended` (ou o `"redirect"` genérico do mock do arquivo) porque a fixture de membership não traz `org_status`: acrescente `org_status: "active",` a cada objeto `UserOrgMembership` da fixture (ou `status: "active",` ao objeto `organizations` da linha crua, quando o arquivo passa por `loadAuthUser`), rode o arquivo isolado (`pnpm exec vitest run <arquivo>` → `passed`) e commite separado:

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add <arquivo>
git commit -F - <<'FIM'
test(fixture): <arquivo> declara a organização operante

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

Vermelho de `lib/ai/dispatcher/rate-limit.test.ts` com 15 s de timeout é o Redis local fora do ar, não esta tarefa (ver Task 36, passo 3).

- [ ] **Passo 6: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/auth/types.ts lib/auth/server.ts lib/legal/operador.ts tests/unit/org-ativa-sem-portao.test.ts \
  tests/unit/auth-falha-alto.test.ts tests/unit/telas-falam-a-moeda-e-o-pais-da-organizacao.test.tsx
git commit -F - <<'FIM'
feat(auth): org suspensa redireciona para o hub; sessão carrega status da org e scope do platform admin

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 9: Códigos de erro + `requireRole` (org_suspended, permiteOrgSuspensa, allowPlatformAdmin `true | "leitura"`)

**Files:** Modify `lib/api/errors.ts`, `lib/i18n/dicionario.ts`, `lib/auth/require-role.ts`, `lib/auth/require-role.test.ts`, `tests/unit/require-role-mfa.test.ts`, `tests/unit/mfa-leitura-falha-fechado.test.ts`, `tests/unit/rbac-matrix.test.ts`, `tests/unit/team-list-roster.test.ts`, `tests/unit/team-role-change.test.ts`, `tests/unit/tags-vocabulario-sem-atalho-de-platform-admin.test.ts`.

**Interfaces**
- Consumes: `ehOperante`, `STATUS_OPERANTE` (Task 7); `orgAtivaSemPortao`, `AuthUser.platform_admin_scope`, `UserOrgMembership.org_status` (Task 8); `mfaEmDivida` (`lib/auth/server.ts`).
- Produces: `requireRole(min, { requestId?, resource?, organizationId?, permiteOrgSuspensa?: boolean; allowPlatformAdmin?: boolean | "leitura" })`; códigos `org_suspended` (403), `forbidden_scope` (403), `suspensao_de_cobranca` (409) em `lib/api/errors.ts`; chave de dicionário `"A conta desta empresa está suspensa."` (também é a mensagem de `OrgNaoOperanteError`).

- [ ] **Passo 1: testes que falham** — em `lib/auth/require-role.test.ts`:
  - `perl -pi -e 's/\bresolveActiveOrg\b/orgAtivaSemPortao/g' lib/auth/require-role.test.ts`
  - import de `@/lib/auth/server` → `import { loadAuthUser, mfaEmDivida, orgAtivaSemPortao } from "@/lib/auth/server";` (a factory do `vi.mock` já expõe `mfaEmDivida` como `vi.fn`? confira com `grep -n "mfaEmDivida" lib/auth/require-role.test.ts`; se não, acrescente `mfaEmDivida: vi.fn(async () => false),` à factory).
  - substitua `authUserFixture` e `session` por:

```ts
function authUserFixture(role: Role | null, platformAdmin = false, scope = "full"): AuthUser {
  return {
    id: USER_ID,
    email: "user@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: platformAdmin,
    platform_admin_scope: platformAdmin ? scope : null,
    idioma: "pt-BR" as const,
    organizations: role
      ? [{ organization_id: ORG_ID, organization_name: "Org", role, org_status: "active" }]
      : [],
  };
}

/** Configura sessão + role efetivo devolvido pelo banco (fn_user_role_in_org). */
function session(
  role: Role | null,
  opts: { dbRole?: string | null; platformAdmin?: boolean; scope?: string; orgStatus?: string } = {},
) {
  const platformAdmin = opts.platformAdmin ?? false;
  const dbRole = opts.dbRole === undefined ? role : opts.dbRole;
  vi.mocked(loadAuthUser).mockResolvedValue(
    role || platformAdmin ? authUserFixture(role, platformAdmin, opts.scope ?? "full") : null,
  );
  vi.mocked(orgAtivaSemPortao).mockResolvedValue(
    role ? { orgId: ORG_ID, name: "Org", role, org_status: opts.orgStatus ?? "active" } : null,
  );
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: dbRole, error: null } : { data: null, error: null },
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}
```

  - em `dualOrgSession`, nas duas memberships acrescente `org_status: "active"`, e no `mockResolvedValue` da org ativa também.
  - no fim do arquivo:

```ts
describe("org não operante e scope do platform admin (spec cobrança §4 item 4)", () => {
  it("org suspensa → 403 org_suspended, sem ler papel", async () => {
    session("admin", { orgStatus: "suspended" });
    const res = await requireRole("viewer");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(403);
    expect((await res.response.json()).error.code).toBe("org_suspended");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("permiteOrgSuspensa libera a org suspensa (LGPD)", async () => {
    session("admin", { orgStatus: "suspended" });
    expect((await requireRole("admin", { permiteOrgSuspensa: true })).ok).toBe(true);
  });

  it("o atalho de platform admin NÃO atravessa a suspensão", async () => {
    session("viewer", { platformAdmin: true, orgStatus: "suspended" });
    const res = await requireRole("admin", { allowPlatformAdmin: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect((await res.response.json()).error.code).toBe("org_suspended");
  });

  it("allowPlatformAdmin:true com support_readonly NÃO bypassa (cai no rank → 403)", async () => {
    session("viewer", { platformAdmin: true, scope: "support_readonly" });
    const res = await requireRole("admin", { allowPlatformAdmin: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect((await res.response.json()).error.code).toBe("forbidden_role");
  });

  it("allowPlatformAdmin:true com full e MFA em dívida → 403 mfa_required", async () => {
    session("viewer", { platformAdmin: true });
    vi.mocked(mfaEmDivida).mockResolvedValueOnce(true);
    const res = await requireRole("admin", { allowPlatformAdmin: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect((await res.response.json()).error.code).toBe("mfa_required");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("allowPlatformAdmin:'leitura' libera support_readonly", async () => {
    session("viewer", { platformAdmin: true, scope: "support_readonly" });
    expect((await requireRole("admin", { allowPlatformAdmin: "leitura" })).ok).toBe(true);
  });

  it("CONTROLE: full com sessão em dia bypassa sem ler papel", async () => {
    session("viewer", { platformAdmin: true });
    expect((await requireRole("admin", { allowPlatformAdmin: true })).ok).toBe(true);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("org do RECURSO suspensa → org_suspended; com permiteOrgSuspensa segue ao papel", async () => {
    const OUTRA = "33333333-3333-4333-8333-333333333333";
    vi.mocked(loadAuthUser).mockResolvedValue({
      ...authUserFixture("admin"),
      organizations: [
        { organization_id: ORG_ID, organization_name: "A", role: "admin", org_status: "active" },
        { organization_id: OUTRA, organization_name: "B", role: "admin", org_status: "suspended" },
      ],
    });
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn(async () => ({ data: "admin", error: null })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const barrado = await requireRole("admin", { organizationId: OUTRA });
    expect(barrado.ok).toBe(false);
    if (!barrado.ok) expect((await barrado.response.json()).error.code).toBe("org_suspended");
    expect((await requireRole("admin", { organizationId: OUTRA, permiteOrgSuspensa: true })).ok).toBe(true);
  });
});
```

  Em `tests/unit/require-role-mfa.test.ts`: factory → `return { ...real, loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn(), orgAtivaSemPortao: vi.fn() };`; import → `import { loadAuthUser, orgAtivaSemPortao, resolveActiveOrg } from "@/lib/auth/server";`; em `preparar`, troque o mock de `resolveActiveOrg` (hoje `:69`) por `vi.mocked(orgAtivaSemPortao).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: cenario.role, org_status: "active" });` e acrescente ao objeto `user` `platform_admin_scope: cenario.isPlatformAdmin ? "full" : null,`. Substitua o caso "platform admin com opt-in passa sem ler papel nem MFA, como antes" por:

```ts
  it("platform admin FULL com opt-in e sessão aal2 passa sem ler papel", async () => {
    preparar({ role: "viewer", temFator: true, aal: "aal2", isPlatformAdmin: true });
    const stub = montarStub({ role: "viewer", temFator: true, aal: "aal2" });
    vi.mocked(createClient).mockResolvedValue(stub as unknown as Awaited<ReturnType<typeof createClient>>);
    const r = await requireRole("admin", { allowPlatformAdmin: true });
    expect(r.ok).toBe(true);
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it("platform admin FULL com fator em aal1 é BARRADO: o atalho de escrita cobra MFA", async () => {
    preparar({ role: "viewer", temFator: true, aal: "aal1", isPlatformAdmin: true });
    const r = await requireRole("admin", { allowPlatformAdmin: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((await r.response.json()).error.code).toBe("mfa_required");
  });
```

  Nos cinco dublês abaixo, a receita: (a) a factory de `@/lib/auth/server` ganha `orgAtivaSemPortao`; (b) o import ganha `orgAtivaSemPortao`; (c) depois de cada `vi.mocked(resolveActiveOrg).mockResolvedValue(X)` vem o mesmo valor com `org_status: "active"` para `orgAtivaSemPortao`:
  - `tests/unit/mfa-leitura-falha-fechado.test.ts`: factory `{ ...real, loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn(), orgAtivaSemPortao: vi.fn() }`; depois do mock de `resolveActiveOrg` (hoje `:46`): `vi.mocked(orgAtivaSemPortao).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "admin", org_status: "active" });`
  - `tests/unit/rbac-matrix.test.ts`: factory `orgAtivaSemPortao: vi.fn(),`; em `session()`, depois do mock de `resolveActiveOrg`: `vi.mocked(orgAtivaSemPortao).mockResolvedValue(role ? { orgId: ORG_ID, name: "Org", role, org_status: "active" } : null);`
  - `tests/unit/team-list-roster.test.ts`: factory `orgAtivaSemPortao: vi.fn(),`; depois de `:91`: `vi.mocked(orgAtivaSemPortao).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "manager", org_status: "active" });`
  - `tests/unit/team-role-change.test.ts`: factory `orgAtivaSemPortao: vi.fn(),`; depois de `:90`: `vi.mocked(orgAtivaSemPortao).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "admin", org_status: "active" });`
  - `tests/unit/tags-vocabulario-sem-atalho-de-platform-admin.test.ts`: na factory, depois de `resolveActiveOrg: ...`: `orgAtivaSemPortao: async () => ({ orgId: ORG, name: "Org", role: estado.papelDaMembresia, org_status: "active" }),`

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run lib/auth/require-role.test.ts tests/unit/require-role-mfa.test.ts` → casos novos vermelhos (`orgAtivaSemPortao` nunca chamado; `org_suspended` ausente; `true` com readonly passa).

- [ ] **Passo 3: implementar.**

`lib/api/errors.ts` — no bloco `// 403 — authz`, depois de `forbidden_tenant`:

```ts
  // Conta da empresa suspensa (spec da cobrança §4): sessão, token `dsk_` e MCP.
  // Só LGPD e cobrança passam, por `requireRole({ permiteOrgSuspensa: true })`.
  org_suspended: "org_suspended",
  // Platform admin `support_readonly` tentando ESCREVER (`requirePlatformAdminEscrita`).
  forbidden_scope: "forbidden_scope",
```

no bloco `// 409 — conflito`, depois de `state_conflict`:

```ts
  // POST /admin/tenants/[id]/reactivate sobre suspensão por falta de pagamento:
  // a saída é "Dar prazo" ou "Tornar isenta", nunca o "Reativar" genérico.
  suspensao_de_cobranca: "suspensao_de_cobranca",
```

`lib/i18n/dicionario.ts` — confira `grep -c '"A conta desta empresa está suspensa."' lib/i18n/dicionario.ts` → `0`; logo abaixo da entrada `"A conta está conectada e o envio está ligado.": {...},`:

```ts
  "A conta desta empresa está suspensa.": { es: "La cuenta de esta empresa está suspendida." },
```

`lib/auth/require-role.ts` — conteúdo completo:

```ts
/**
 * Helper ÚNICO de autorização por role nas rotas /api/v1 (spec 13 §4 — G2-01).
 *
 * Resolve o role efetivo do usuário na org ativa e nega com 403 padronizado
 * (`fail("forbidden_role", ...)`). Nenhuma rota deve reimplementar a checagem
 * na mão (comparação com ROLE_RANK direto em rota é proibida — anti-padrão
 * "matriz advisória").
 *
 * Fluxo:
 *  1. `loadAuthUser()` — valida o JWT via `supabase.auth.getUser()` (nunca
 *     `getSession()`); 401 se não autenticado.
 *  2. `orgAtivaSemPortao()` — org ativa de fonte confiável (cookie validado
 *     contra memberships), NUNCA do body; 403 `forbidden_tenant` se ausente.
 *     SEM o portão de `resolveActiveOrg`: aquele REDIRECIONA a org suspensa, e
 *     rota de API responde 403 JSON, não 307 HTML.
 *  3. Org não operante (`lib/organizacao/operante.ts`) → 403 `org_suspended`,
 *     salvo `permiteOrgSuspensa` (só LGPD e cobrança — cerca
 *     `tests/unit/org-suspensa-so-nas-rotas-permitidas.test.ts`).
 *  4. Atalho de platform admin: `"leitura"` libera qualquer scope; `true` só
 *     `scope === 'full'` sem dívida de MFA.
 *  5. `rpc fn_user_role_in_org(org)` — role efetivo direto do banco, a MESMA
 *     função SECURITY DEFINER que as policies RLS usam; falha fechada se o
 *     membership foi revogado.
 *  6. Rank insuficiente → audit `authz.denied` (fire-and-forget) + 403.
 */
import type { NextResponse } from "next/server";

import { fail, type ApiError } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, orgAtivaSemPortao } from "@/lib/auth/server";
import { ROLE_RANK, type ActiveOrg, type AuthUser, type Role } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { STATUS_OPERANTE, ehOperante } from "@/lib/organizacao/operante";
import { createClient } from "@/lib/supabase/server";

export type RoleCheck =
  | { ok: true; user: AuthUser; org: ActiveOrg }
  | { ok: false; response: NextResponse<ApiError> };

const MENSAGEM_DE_MFA =
  "Esta sessão precisa da verificação em duas etapas. Entre novamente com o código do aplicativo.";

interface RequireRoleOpts {
  /** Correlaciona a resposta e o audit com o X-Request-Id da rota. */
  requestId?: string;
  /** resource_type gravado no audit `authz.denied` (ex.: "api_tokens"). */
  resource?: string;
  /**
   * Platform admin (role transversal) bypassa o rank do tenant.
   * - `true`: rota que ESCREVE — só `scope === 'full'` e sessão sem dívida de
   *   MFA; `support_readonly` cai no rank normal do tenant.
   * - `"leitura"`: qualquer scope. Só em handler `GET` exportado — `requireRole`
   *   não recebe o método, e quem garante isso é
   *   `tests/unit/admin-escrita-exige-scope-full.test.ts`.
   */
  allowPlatformAdmin?: boolean | "leitura";
  /**
   * Override da org onde o role é resolvido (default: org ativa do cookie).
   * Use quando a autorização é sobre a org do RECURSO (ex.: LGPD anonymize —
   * admin na org do CONTATO), resolvida de fonte confiável (query RLS-scoped),
   * NUNCA do body. O role vem de `fn_user_role_in_org(p_org)` nessa org.
   */
  organizationId?: string;
  /** Deixa passar org NÃO operante. Só rotas de LGPD e de cobrança. */
  permiteOrgSuspensa?: boolean;
}

/**
 * Gate de rota: `const authz = await requireRole("manager", { requestId });`
 * `if (!authz.ok) return authz.response;`
 */
export async function requireRole(min: Role, opts: RequireRoleOpts = {}): Promise<RoleCheck> {
  const {
    requestId,
    resource,
    allowPlatformAdmin = false,
    organizationId,
    permiteOrgSuspensa = false,
  } = opts;

  const user = await loadAuthUser();
  if (!user) {
    return { ok: false, response: fail("unauthenticated", "Auth required.", 401, { requestId }) };
  }
  const t = (texto: string) => traduzir(texto, user.idioma);

  if (user.support && user.support.status !== "active") {
    return { ok: false, response: fail("forbidden", "O acompanhamento terminou. Saia para continuar.", 403, { requestId }) };
  }
  let org: ActiveOrg | null;
  if (organizationId) {
    const membership = user.organizations.find((o) => o.organization_id === organizationId);
    org = user.support?.organization_id === organizationId
      ? {
          orgId: organizationId,
          name: user.support.name,
          role: user.support.access_mode === "full" ? "admin" : "viewer",
          // `fn_support_context` só dá 'active' com a org em 'active' (e o
          // acompanhamento encerrado já saiu acima).
          org_status: STATUS_OPERANTE,
        }
      : membership
      ? {
          orgId: membership.organization_id,
          name: membership.organization_name,
          role: membership.role,
          org_status: membership.org_status ?? null,
          suspended_kind: membership.suspended_kind ?? null,
        }
      : allowPlatformAdmin !== false && user.is_platform_admin
        // Sem membership o status é desconhecido: `null` falha fechado. Hoje o
        // único chamador (LGPD anonymize) passa `permiteOrgSuspensa`.
        ? { orgId: organizationId, name: "—", role: "viewer", org_status: null }
        : null;
  } else {
    org = await orgAtivaSemPortao(user);
  }
  if (!org) {
    return {
      ok: false,
      response: fail("forbidden_tenant", t("Sem organização ativa."), 403, { requestId }),
    };
  }

  // ANTES do atalho de platform admin: nada que custe ou saia roda em org
  // parada, nem pelas mãos do dono da instalação.
  if (!permiteOrgSuspensa && !ehOperante(org.org_status)) {
    return {
      ok: false,
      response: fail("org_suspended", t("A conta desta empresa está suspensa."), 403, { requestId }),
    };
  }

  if (user.is_platform_admin && !user.support && allowPlatformAdmin !== false) {
    if (allowPlatformAdmin === "leitura") return { ok: true, user, org };
    if (user.platform_admin_scope === "full") {
      if (await mfaEmDivida()) {
        void audit({
          action: "authz.denied",
          actorUserId: user.id,
          organizationId: org.orgId,
          resourceType: resource ?? null,
          requestId,
          metadata: { reason: "mfa_required", via: "platform_admin" },
        });
        return { ok: false, response: fail("mfa_required", t(MENSAGEM_DE_MFA), 403, { requestId }) };
      }
      return { ok: true, user, org };
    }
    // `support_readonly` com `true`: sem atalho — segue para o rank do tenant.
  }

  // Role efetivo do banco (não do snapshot do cookie/membership em memória).
  const supabase = await createClient();
  // Duas leituras independentes da mesma requisição: não somar a espera de
  // permissões com a de MFA em cada botão/consulta. Nenhuma decisão é cacheada.
  // Capturar a rejeição mantém a precedência: papel insuficiente continua 403,
  // e uma falha de MFA só é propagada quando essa checagem seria necessária.
  const mfaPendente = mfaEmDivida().then(
    (required) => ({ required }),
    (error: unknown) => ({ error }),
  );
  const { data: effectiveRole, error } = await supabase.rpc("fn_user_role_in_org", {
    p_org: org.orgId,
  });
  if (error) {
    return { ok: false, response: fail("internal_error", error.message, 500, { requestId }) };
  }

  const rank = effectiveRole ? (ROLE_RANK[effectiveRole as Role] ?? 0) : 0;

  // MFA como política de SESSÃO (layout não roda em rota de API). Fica DEPOIS
  // do rank e ANTES do sucesso: quem não tem papel leva 403 por papel, sem que a
  // resposta revele o estado de MFA de quem nem chegaria lá.
  let mfaRequired = false;
  if (rank >= ROLE_RANK[min]) {
    const mfa = await mfaPendente;
    if ("error" in mfa) throw mfa.error;
    mfaRequired = mfa.required;
  }
  if (mfaRequired) {
    void audit({
      action: "authz.denied",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: resource ?? null,
      requestId,
      metadata: { reason: "mfa_required", effective_role: effectiveRole ?? null },
    });
    return { ok: false, response: fail("mfa_required", t(MENSAGEM_DE_MFA), 403, { requestId }) };
  }

  if (rank < ROLE_RANK[min]) {
    void audit({
      action: "authz.denied",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: resource ?? null,
      requestId,
      metadata: { required_role: min, effective_role: effectiveRole ?? null },
    });
    return {
      ok: false,
      response: fail("forbidden_role", `Permissão insuficiente. Requer role >= ${min}.`, 403, {
        requestId,
      }),
    };
  }

  return { ok: true, user, org: { ...org, role: effectiveRole as Role } };
}
```

(Antes de sobrescrever, compare com o arquivo atual: se a main mudou algo fora dos pontos acima — por exemplo o comentário longo de MFA —, preserve a versão da main e aplique só os deltas: import de `orgAtivaSemPortao`/`ehOperante`/`STATUS_OPERANTE`, opção `permiteOrgSuspensa`, tipo de `allowPlatformAdmin`, `org_status` no override, o bloco `org_suspended` e o bloco do atalho.)

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run lib/auth/require-role.test.ts tests/unit/require-role-mfa.test.ts tests/unit/mfa-leitura-falha-fechado.test.ts tests/unit/rbac-matrix.test.ts tests/unit/team-list-roster.test.ts tests/unit/team-role-change.test.ts tests/unit/tags-vocabulario-sem-atalho-de-platform-admin.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts` → todos verdes.

- [ ] **Passo 5: suíte inteira** (outros dublês podem mockar só `resolveActiveOrg`):

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:unit > /tmp/t9-vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t9-vt.log | tail -2
grep -aE "^ *FAIL " /tmp/t9-vt.log | sed 's/ > .*//' | sort | uniq -c
```

Arquivo vermelho com `No "orgAtivaSemPortao" export is defined on the mock` ou `org_suspended` inesperado: aplique a receita (a)(b)(c) nele. Não mexa em asserção de comportamento. Se o `grep FAIL` vier vazio com o rodapé acusando falha, rode com `--reporter=verbose`.

- [ ] **Passo 6: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/api/errors.ts lib/i18n/dicionario.ts lib/auth tests/unit
git commit -F - <<'FIM'
feat(auth): requireRole barra org suspensa e o atalho de escrita exige scope full

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 10: Cerca `org-suspensa-so-nas-rotas-permitidas` + LGPD + GETs para `"leitura"`

**Files:** Create `tests/unit/org-suspensa-so-nas-rotas-permitidas.test.ts`. Modify `app/api/v1/lgpd/requests/route.ts`, `app/api/v1/lgpd/requests/[id]/route.ts`, `app/api/v1/lgpd/requests/[id]/preview/route.ts`, `app/api/v1/lgpd/requests/[id]/approve/route.ts`, `app/api/v1/lgpd/anonymize/route.ts`, `app/api/v1/lead-captures/route.ts`, `app/api/v1/audit/route.ts`, `app/api/v1/audit/export/route.ts`, `app/api/v1/settings/routing/channels/route.ts`, `app/api/v1/channel-sessions/[id]/ai-access/route.ts`.

**Interfaces** — Consumes: Task 9; `arquivosDeCodigo`, `caminhoRelativo` de `tests/unit/helpers/varrer-codigo.ts`. Produces: `usosDaPermissao(fonte, arquivo): number[]`, `requireRoleSemPermissao(fonte, arquivo): number[]`; as 5 rotas LGPD liberam org suspensa (consumido pelo hub, Task 32).

- [ ] **Passo 1: teste que falha** — `tests/unit/org-suspensa-so-nas-rotas-permitidas.test.ts`:

```ts
import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * ORG SUSPENSA SÓ PASSA NAS ROTAS DE LGPD E DE COBRANÇA
 * (spec docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §4 item 21).
 *
 * `requireRole({ permiteOrgSuspensa: true })` é a única porta de uma org parada
 * para a API de sessão. Duas direções, pelo AST (comentário não conta):
 *  1. a chave só aparece em `app/api/v1/lgpd/**` e `app/api/v1/cobranca/**`;
 *  2. TODA chamada de `requireRole(` em `app/api/v1/lgpd/**` a passa — LGPD
 *     nunca é bloqueada, nem para quem teve a conta suspensa.
 */
const PREFIXOS_PERMITIDOS = ["app/api/v1/lgpd/", "app/api/v1/cobranca/"] as const;
const DEFINICAO = "lib/auth/require-role.ts";

function arvore(fonte: string, arquivo: string): ts.SourceFile {
  return ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true,
    arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Linhas onde `permiteOrgSuspensa` aparece como propriedade de objeto. */
export function usosDaPermissao(fonte: string, arquivo: string): number[] {
  const sf = arvore(fonte, arquivo);
  const linhas: number[] = [];
  const visitar = (n: ts.Node): void => {
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
        ts.isIdentifier(n.name) && n.name.text === "permiteOrgSuspensa") {
      linhas.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return linhas;
}

/** Chamadas de `requireRole(` cujo 2º argumento não é objeto literal com `permiteOrgSuspensa: true`. */
export function requireRoleSemPermissao(fonte: string, arquivo: string): number[] {
  const sf = arvore(fonte, arquivo);
  const linhas: number[] = [];
  const visitar = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "requireRole") {
      const opts = n.arguments[1];
      const libera = !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "permiteOrgSuspensa" &&
        p.initializer.kind === ts.SyntaxKind.TrueKeyword);
      if (!libera) linhas.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return linhas;
}

const FONTES = arquivosDeCodigo(["app", "lib", "workers", "components", "hooks"]).map((abs) => ({
  arquivo: caminhoRelativo(abs),
  fonte: readFileSync(abs, "utf8"),
}));
const permitido = (arquivo: string) => PREFIXOS_PERMITIDOS.some((p) => arquivo.startsWith(p));
const LGPD = FONTES.filter((f) => f.arquivo.startsWith("app/api/v1/lgpd/"));

describe("org suspensa só nas rotas permitidas (a CLASSE)", () => {
  it("o instrumento enxerga o terreno (controle positivo)", () => {
    expect(FONTES.length).toBeGreaterThan(100);
    expect(LGPD.some((f) => f.fonte.includes("requireRole("))).toBe(true);
  });

  it("permiteOrgSuspensa não aparece fora de LGPD e cobrança", () => {
    const fora = FONTES.filter((f) => f.arquivo !== DEFINICAO && !permitido(f.arquivo))
      .flatMap((f) => usosDaPermissao(f.fonte, f.arquivo).map((l) => `${f.arquivo}:${l}`));
    expect(fora, "org parada passaria por uma rota que custa ou sai para fora").toEqual([]);
  });

  it("toda requireRole de app/api/v1/lgpd/** libera a org suspensa", () => {
    const presas = LGPD.flatMap((f) => requireRoleSemPermissao(f.fonte, f.arquivo).map((l) => `${f.arquivo}:${l}`));
    expect(presas, "LGPD nunca é bloqueada (spec §1.3)").toEqual([]);
  });
});

describe("controles do instrumento", () => {
  it("acusa a chave fora do lugar e a requireRole de LGPD sem ela", () => {
    expect(usosDaPermissao(`requireRole("admin", { permiteOrgSuspensa: true });`, "x.ts")).toEqual([1]);
    expect(requireRoleSemPermissao(`requireRole("admin", { requestId });`, "x.ts")).toEqual([1]);
    expect(requireRoleSemPermissao(`requireRole("admin", { permiteOrgSuspensa: false });`, "x.ts")).toEqual([1]);
  });
  it("não confunde comentário com código", () => {
    expect(usosDaPermissao(`// requireRole(x, { permiteOrgSuspensa: true })\nexport const a = 1;`, "x.ts")).toEqual([]);
    expect(requireRoleSemPermissao(`requireRole("admin", { permiteOrgSuspensa: true });`, "x.ts")).toEqual([]);
  });
});
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/org-suspensa-so-nas-rotas-permitidas.test.ts` → "toda requireRole de app/api/v1/lgpd/**" vermelho com as 5 rotas LGPD.

- [ ] **Passo 3: implementar.** Nas três rotas GET de LGPD (`lgpd/requests/route.ts` hoje `:50-54`, `lgpd/requests/[id]/route.ts` `:26-30`, `lgpd/requests/[id]/preview/route.ts` `:33-37`), o `requireRole` vira:

```ts
  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: "leitura",
    permiteOrgSuspensa: true,
  });
```

Em `lgpd/requests/[id]/approve/route.ts` (`:37-41`, POST, fica `true`):

```ts
  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: true,
    permiteOrgSuspensa: true,
  });
```

Em `lgpd/anonymize/route.ts` (`:93-98`):

```ts
  const authz = await requireRole("admin", {
    requestId,
    resource: "contact",
    allowPlatformAdmin: true,
    organizationId: existing.organization_id,
    permiteOrgSuspensa: true,
  });
```

Handlers GET que trocam `allowPlatformAdmin: true` por `allowPlatformAdmin: "leitura"` (só dentro do `GET`):
  - `app/api/v1/lead-captures/route.ts` (`:36`)
  - `app/api/v1/audit/route.ts` (`:24`)
  - `app/api/v1/audit/export/route.ts` (`:41`)
  - `app/api/v1/settings/routing/channels/route.ts` (`:14`; o `PATCH` de `:25` fica `true`)
  - `app/api/v1/channel-sessions/[id]/ai-access/route.ts` (`:20`; o `PATCH` de `:36` fica `true`)

Ficam `true` de propósito: `app/api/v1/voice/events/route.ts:51` (GET que repassa o QR de pareamento — credencial) e `app/api/v1/system/relogio/tick/route.ts:56` (helper do POST e de um GET que executa o POST).

Sonda de conferência: `grep -rn 'allowPlatformAdmin: true' app --include=route.ts` (use `grep -rn ... app | grep route.ts` se o zsh reclamar do glob) — cada linha deve estar num handler de escrita, em `voice/events` ou em `system/relogio/tick`.

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run tests/unit/org-suspensa-so-nas-rotas-permitidas.test.ts 'app/api/v1/channel-sessions/[id]/ai-access/route.test.ts' tests/unit/rbac-matrix.test.ts` → verdes.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add tests/unit/org-suspensa-so-nas-rotas-permitidas.test.ts app/api/v1
git commit -F - <<'FIM'
feat(lgpd): LGPD passa com a org suspensa; leitura de platform admin marcada como leitura

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 11: `requirePlatformAdminEscrita`

**Files:** Modify `lib/auth/requirePlatformAdmin.ts`, `lib/auth/types.ts`. Create `lib/auth/requirePlatformAdmin.test.ts`.

**Interfaces**
- Consumes: `requirePlatformAdmin()` e `type PlatformAdminContext` (já no arquivo); `mfaEmDivida` (`lib/auth/server.ts`); `fail`, `type ApiError` (`lib/api/wrappers.ts`); `AuthUser.platform_admin_scope` (Task 8).
- Produces: `requirePlatformAdminEscrita(): Promise<PlatformAdminContext>` (mesmo redirect de `requirePlatformAdmin` para quem não é platform admin; lança `EscritaDePlatformAdminNegada` com `code: "forbidden_scope" | "mfa_required"`); `class EscritaDePlatformAdminNegada`; `falhaDaEscritaDePlatformAdmin(err: unknown, requestId?: string, mensagemDeRecusa?: string): NextResponse<ApiError>`; e, em `lib/auth/types.ts` (puro, sem import de servidor), `escreveComoPlatformAdmin(user: Pick<AuthUser, "is_platform_admin" | "platform_admin_scope">): boolean` — o predicado do ATALHO de papel ("platform admin pula o papel do tenant"), que as Tasks 14 e 15b usam no lugar de `user.is_platform_admin` puro.

- [ ] **Passo 1: teste que falha** — `lib/auth/requirePlatformAdmin.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ linha: null as Record<string, unknown> | null, divida: false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => h.divida }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "pa-1" } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }) },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: h.linha, error: null });
      return c;
    },
  }),
}));

import {
  EscritaDePlatformAdminNegada,
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "./requirePlatformAdmin";
import { escreveComoPlatformAdmin } from "./types";

const linha = (scope: string) => ({ user_id: "pa-1", scope, mfa_required: false, revoked_at: null });
async function recusa(): Promise<unknown> {
  return requirePlatformAdminEscrita().then(() => null, (e: unknown) => e);
}

beforeEach(() => {
  h.linha = null;
  h.divida = false;
});

describe("requirePlatformAdminEscrita", () => {
  it("full com sessão em dia passa e devolve o contexto", async () => {
    h.linha = linha("full");
    await expect(requirePlatformAdminEscrita()).resolves.toMatchObject({ platformAdmin: { scope: "full" } });
  });
  it("support_readonly é recusado com forbidden_scope", async () => {
    h.linha = linha("support_readonly");
    const e = await recusa();
    expect(e).toBeInstanceOf(EscritaDePlatformAdminNegada);
    expect(e).toMatchObject({ code: "forbidden_scope" });
  });
  it("full com MFA em dívida é recusado com mfa_required", async () => {
    h.linha = linha("full");
    h.divida = true;
    expect(await recusa()).toMatchObject({ code: "mfa_required" });
  });
  it("quem não é platform admin segue redirecionado, como em requirePlatformAdmin", async () => {
    expect(String(await recusa())).toContain("redirect:/admin/forbidden");
  });
  it("falhaDaEscritaDePlatformAdmin: recusa nomeada vira o seu código; o resto, forbidden", async () => {
    const a = falhaDaEscritaDePlatformAdmin(new EscritaDePlatformAdminNegada("forbidden_scope", "x"), "r1");
    expect(a.status).toBe(403);
    expect((await a.json()).error.code).toBe("forbidden_scope");
    const b = falhaDaEscritaDePlatformAdmin(new Error("redirect:/admin/forbidden"), "r2", "Só o dono.");
    expect(await b.json()).toMatchObject({ error: { code: "forbidden", message: "Só o dono." } });
  });
});

describe("escreveComoPlatformAdmin — o atalho de papel exige scope full", () => {
  it.each([
    [{ is_platform_admin: true, platform_admin_scope: "full" }, true],
    [{ is_platform_admin: true, platform_admin_scope: "support_readonly" }, false],
    [{ is_platform_admin: true, platform_admin_scope: null }, false],
    [{ is_platform_admin: true }, false],
    [{ is_platform_admin: false, platform_admin_scope: "full" }, false],
  ])("%o → %s (ausente = sem escrita)", (user, esperado) => {
    expect(escreveComoPlatformAdmin(user)).toBe(esperado);
  });
});
```

(Medido em `d03c2b2fd`: `lib/auth/requirePlatformAdmin.ts` redireciona quem não é platform admin para `/admin/forbidden` (`:53`) e lê `platform_admins` por `.select("user_id, scope, mfa_required, revoked_at").eq("user_id", …).is("revoked_at", null).maybeSingle()` (`:47-50`) — o dublê acima tem exatamente essa cadeia.)

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run lib/auth/requirePlatformAdmin.test.ts` → `requirePlatformAdminEscrita is not a function` e `escreveComoPlatformAdmin is not a function`.

- [ ] **Passo 3: implementar** — em `lib/auth/requirePlatformAdmin.ts`, imports:

```ts
import type { NextResponse } from "next/server";
import { fail, type ApiError } from "@/lib/api/wrappers";
import { mfaEmDivida } from "@/lib/auth/server";
```

e no fim do arquivo:

```ts
/** Platform admin que existe mas não pode ESCREVER. `code` é o de `lib/api/errors.ts`. */
export class EscritaDePlatformAdminNegada extends Error {
  constructor(
    readonly code: "forbidden_scope" | "mfa_required",
    message: string,
  ) {
    super(message);
    this.name = "EscritaDePlatformAdminNegada";
  }
}

/**
 * `requirePlatformAdmin()` + o que a ESCRITA exige e a leitura não:
 * `scope === 'full'` (o `support_readonly` lê o painel e nada muda) e sessão sem
 * dívida de MFA (quem TEM fator prova nesta sessão).
 *
 * `requirePlatformAdmin` devolvia o scope sem impor; só `admin/tenants` POST e as
 * rotas de extensões conferiam. A cerca `tests/unit/admin-escrita-exige-scope-full.test.ts`
 * exige este helper em todo handler de escrita e em toda server action de admin.
 *
 * Mantém o contrato de `requirePlatformAdmin` (quem não é platform admin é
 * REDIRECIONADO); as duas recusas novas LANÇAM `EscritaDePlatformAdminNegada`.
 */
export async function requirePlatformAdminEscrita(): Promise<PlatformAdminContext> {
  const ctx = await requirePlatformAdmin();
  if (ctx.platformAdmin.scope !== "full") {
    throw new EscritaDePlatformAdminNegada(
      "forbidden_scope",
      "Seu acesso à administração da plataforma é somente leitura.",
    );
  }
  if (await mfaEmDivida()) {
    throw new EscritaDePlatformAdminNegada("mfa_required", "Confirme a verificação em duas etapas nesta sessão.");
  }
  return ctx;
}

/**
 * Resposta de rota para o que `requirePlatformAdminEscrita` lançou. A recusa
 * nomeada vira o seu código; o resto (redirect de quem não é platform admin,
 * sessão ilegível) vira o 403 `forbidden` que as rotas de admin já davam.
 */
export function falhaDaEscritaDePlatformAdmin(
  err: unknown,
  requestId?: string,
  mensagemDeRecusa = "Platform admin required",
): NextResponse<ApiError> {
  if (err instanceof EscritaDePlatformAdminNegada) return fail(err.code, err.message, 403, { requestId });
  return fail("forbidden", mensagemDeRecusa, 403, { requestId });
}
```

(`lib/auth/server.ts` não importa `requirePlatformAdmin` em `d03c2b2fd` — `grep -n requirePlatformAdmin lib/auth/server.ts` sai vazio —, então o import de `mfaEmDivida` não cria ciclo.)

`lib/auth/types.ts` — logo depois da função `roleAtLeast` (hoje `:44`):

```ts
/**
 * O platform admin pode ESCREVER pulando o papel do tenant?
 *
 * `is_platform_admin` sozinho responde "tem a linha em platform_admins" — e o
 * `support_readonly` também tem. Todo atalho do tipo
 * `!user.is_platform_admin && ROLE_RANK[...] < ROLE_RANK.admin` deixava o
 * `support_readonly` que é membro comum de uma empresa escrever nela como se
 * administrasse. Só `scope === "full"` escreve; ausente = sem escrita.
 *
 * Mora aqui, e não em `requirePlatformAdmin.ts`, porque é puro: as server actions
 * que o usam já importam `ROLE_RANK` daqui e não ganham dependência de servidor.
 * MFA não entra: quem chama já confere `mfaEmDivida` como fazia antes.
 */
export function escreveComoPlatformAdmin(
  user: Pick<AuthUser, "is_platform_admin" | "platform_admin_scope">,
): boolean {
  return user.is_platform_admin && user.platform_admin_scope === "full";
}
```

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run lib/auth/requirePlatformAdmin.test.ts && pnpm typecheck` → `10 passed`; `tsc` exit 0.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/auth/requirePlatformAdmin.ts lib/auth/requirePlatformAdmin.test.ts lib/auth/types.ts
git commit -F - <<'FIM'
feat(auth): requirePlatformAdminEscrita exige scope full e MFA da sessão

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 12: Cerca `admin-escrita-exige-scope-full` (com as conversões pendentes na allowlist)

**Files:** Create `tests/unit/admin-escrita-exige-scope-full.test.ts`.

**Interfaces** — Consumes: Task 11 (nomes `requirePlatformAdminEscrita` e `escreveComoPlatformAdmin`), Task 10 (existem `allowPlatformAdmin: "leitura"` em GET). Produces: `violacoesDeEscrita(fonte, arquivo): Violacao[]` e a allowlist `EXCECOES`, que as Tasks 13–15b esvaziam (ficam só as permanentes de `impersonate` e `politicaDeMfa`).

- [ ] **Passo 1: escrever a cerca** — `tests/unit/admin-escrita-exige-scope-full.test.ts`:

```ts
import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * ESCRITA DE PLATFORM ADMIN EXIGE SCOPE `full` — PELO MECANISMO, EM `app/**` INTEIRO
 * (spec docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §4,
 * "Scope support_readonly").
 *
 * `requirePlatformAdmin()` devolvia o scope e ninguém o impunha: um
 * `support_readonly` suspendia, reativava, resolvia incidente e disparava
 * atualização do servidor. Três regras, pelo AST (comentário não conta):
 *  A. handler exportado POST|PATCH|PUT|DELETE que chama `requirePlatformAdmin(`
 *     ou lê `.is_platform_admin` — no corpo ou numa função do MESMO arquivo que
 *     ele chama — precisa chamar `requirePlatformAdminEscrita(`;
 *  B. arquivo `"use server"` não importa `requirePlatformAdmin`, e, se lê
 *     `.is_platform_admin` (o atalho "platform admin pula o papel do tenant"),
 *     chama `escreveComoPlatformAdmin(` ou `requirePlatformAdminEscrita(`;
 *  C. `allowPlatformAdmin: "leitura"` só dentro de handler `GET` exportado.
 * Limite conhecido: helper IMPORTADO de outro arquivo não é seguido.
 */
const METODOS_DE_ESCRITA = new Set(["POST", "PATCH", "PUT", "DELETE"]);

const PENDENTE = "convertida numa tarefa seguinte do plano da PR 1 (feat/org-operante) — some ao converter";

/** Allowlist que SÓ ENCOLHE. Chave `arquivo#regra:alvo`; valor = porquê (≥ 20 caracteres). */
const EXCECOES: Record<string, string> = {
  "app/api/v1/admin/tenants/[id]/impersonate/route.ts#A:POST":
    "abrir acompanhamento é o trabalho do support_readonly: fn_support_context rebaixa scope diferente de full a support_readonly, e a rota já confere mfaEmDivida",
  "app/actions/auth/politicaDeMfa.ts#B:flag":
    "lê is_platform_admin só para saber se a política de MFA da PLATAFORMA vale para a própria conta; não é atalho de papel nem escrita em nome de outro",
  // ── temporárias: Task 13 ──
  "app/api/v1/admin/tenants/[id]/suspend/route.ts#A:POST": PENDENTE,
  "app/api/v1/admin/tenants/[id]/reactivate/route.ts#A:POST": PENDENTE,
  // ── temporárias: Task 14 ──
  "app/api/v1/admin/incidents/[id]/resolve/route.ts#A:POST": PENDENTE,
  "app/api/v1/admin/tenants/route.ts#A:POST": PENDENTE,
  "app/api/v1/system/update/route.ts#A:POST": PENDENTE,
  "app/api/v1/marca/logo/route.ts#A:POST": PENDENTE,
  "app/api/v1/marca/logo/route.ts#A:DELETE": PENDENTE,
  // ── temporárias: Task 15 ──
  "app/actions/settings/updateDestinosInternos.ts#B:use-server": PENDENTE,
  "app/actions/settings/smtp.ts#B:use-server": PENDENTE,
  "app/actions/settings/updateMetaApp.ts#B:use-server": PENDENTE,
  "app/actions/settings/updateComportamento.ts#B:use-server": PENDENTE,
  "app/actions/settings/updateGoogleOAuth.ts#B:use-server": PENDENTE,
  "app/actions/settings/updateSignupMode.ts#B:use-server": PENDENTE,
  "app/actions/settings/updateModuloDaInstalacao.ts#B:use-server": PENDENTE,
  "app/actions/settings/updateBranding.ts#B:use-server": PENDENTE,
  "app/actions/registration/decide.ts#B:use-server": PENDENTE,
  "app/actions/admin/salvarConfiguracaoDaInstalacao.ts#B:use-server": PENDENTE,
  // ── temporárias: Task 15b (atalho de papel por is_platform_admin) ──
  "app/actions/integrations/connectNuvemshop.ts#B:flag": PENDENTE,
  "app/actions/integrations/disconnectNuvemshop.ts#B:flag": PENDENTE,
  "app/actions/settings/acoesDeConversaoGoogle.ts#B:flag": PENDENTE,
  "app/actions/settings/apagarDadosOperacionaisDaOrganizacao.ts#B:flag": PENDENTE,
  "app/actions/settings/atualizarInterfaceDaEmpresa.ts#B:flag": PENDENTE,
  "app/actions/settings/definirVendaPeloCanal.ts#B:flag": PENDENTE,
  "app/actions/settings/linksRastreaveis.ts#B:flag": PENDENTE,
  "app/actions/settings/salvarRegrasDeConversaoGoogle.ts#B:flag": PENDENTE,
  "app/actions/settings/updateAdInsightsConnection.ts#B:flag": PENDENTE,
  "app/actions/settings/updateAdPlatformConnection.ts#B:flag": PENDENTE,
  "app/actions/settings/updateCapturaDeUtm.ts#B:flag": PENDENTE,
  "app/actions/settings/updateGoogleAdsConnection.ts#B:flag": PENDENTE,
  "app/actions/settings/updateMarcaDaOrganizacao.ts#B:flag": PENDENTE,
  "app/actions/settings/updatePipelineConfig.ts#B:flag": PENDENTE,
  "app/actions/settings/updateTenant.ts#B:flag": PENDENTE,
};

export interface Violacao {
  chave: string;
  linha: number;
}
type Funcao = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function funcoesDoTopo(sf: ts.SourceFile): Map<string, { no: Funcao; exportada: boolean }> {
  const mapa = new Map<string, { no: Funcao; exportada: boolean }>();
  for (const st of sf.statements) {
    const exportada = !!(ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined)?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (ts.isFunctionDeclaration(st) && st.name) mapa.set(st.name.text, { no: st, exportada });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          mapa.set(d.name.text, { no: d.initializer, exportada });
        }
      }
    }
  }
  return mapa;
}

function oQueAlcanca(no: ts.Node, funcoes: ReturnType<typeof funcoesDoTopo>, visitadas: Set<string>) {
  const r = { chamaLeitura: false, leFlag: false, chamaEscrita: false, chamaAtalhoComScope: false };
  const visitar = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const nome = n.expression.text;
      if (nome === "requirePlatformAdmin") r.chamaLeitura = true;
      if (nome === "requirePlatformAdminEscrita") r.chamaEscrita = true;
      if (nome === "escreveComoPlatformAdmin") r.chamaAtalhoComScope = true;
      const local = funcoes.get(nome);
      if (local && !visitadas.has(nome)) {
        visitadas.add(nome);
        const sub = oQueAlcanca(local.no, funcoes, visitadas);
        r.chamaLeitura ||= sub.chamaLeitura;
        r.leFlag ||= sub.leFlag;
        r.chamaEscrita ||= sub.chamaEscrita;
        r.chamaAtalhoComScope ||= sub.chamaAtalhoComScope;
      }
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === "is_platform_admin") r.leFlag = true;
    ts.forEachChild(n, visitar);
  };
  visitar(no);
  return r;
}

export function violacoesDeEscrita(fonte: string, arquivo: string): Violacao[] {
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true,
    arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const funcoes = funcoesDoTopo(sf);
  const linha = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const saida: Violacao[] = [];

  for (const [nome, { no, exportada }] of funcoes) {
    if (!exportada || !METODOS_DE_ESCRITA.has(nome)) continue;
    const r = oQueAlcanca(no, funcoes, new Set([nome]));
    if ((r.chamaLeitura || r.leFlag) && !r.chamaEscrita) saida.push({ chave: `${arquivo}#A:${nome}`, linha: linha(no) });
  }

  const primeira = sf.statements[0];
  const usaServer = !!primeira && ts.isExpressionStatement(primeira) &&
    ts.isStringLiteral(primeira.expression) && primeira.expression.text === "use server";
  if (usaServer) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) ||
          st.moduleSpecifier.text !== "@/lib/auth/requirePlatformAdmin") continue;
      const nomes = st.importClause?.namedBindings;
      if (nomes && ts.isNamedImports(nomes) &&
          nomes.elements.some((e) => (e.propertyName ?? e.name).text === "requirePlatformAdmin")) {
        saida.push({ chave: `${arquivo}#B:use-server`, linha: linha(st) });
      }
    }
    // O atalho de papel: toda server action é endpoint público, e ler só a
    // flag deixa o support_readonly escrever onde é membro comum.
    const doArquivo = oQueAlcanca(sf, funcoes, new Set());
    if (doArquivo.leFlag && !doArquivo.chamaEscrita && !doArquivo.chamaAtalhoComScope) {
      saida.push({ chave: `${arquivo}#B:flag`, linha: 1 });
    }
  }

  const visitar = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "allowPlatformAdmin" &&
        ts.isStringLiteral(n.initializer) && n.initializer.text === "leitura") {
      const dono = [...funcoes].find(([, f]) => f.no.pos <= n.pos && n.end <= f.no.end);
      if (!dono || dono[0] !== "GET" || !dono[1].exportada) saida.push({ chave: `${arquivo}#C:leitura`, linha: linha(n) });
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return saida;
}

const FONTES = arquivosDeCodigo(["app"]).map((abs) => ({ arquivo: caminhoRelativo(abs), fonte: readFileSync(abs, "utf8") }));
const VIOLACOES = FONTES.flatMap(({ arquivo, fonte }) => violacoesDeEscrita(fonte, arquivo));

describe("escrita de platform admin exige scope full (a CLASSE)", () => {
  it("o instrumento enxerga o terreno (controle positivo)", () => {
    expect(FONTES.length).toBeGreaterThan(100);
    expect(FONTES.some(({ fonte }) => fonte.includes('allowPlatformAdmin: "leitura"'))).toBe(true);
    expect(FONTES.some(({ fonte }) => fonte.includes("requirePlatformAdmin("))).toBe(true);
  });

  it("nenhuma violação fora da allowlist", () => {
    const fora = VIOLACOES.filter((v) => !(v.chave in EXCECOES)).map((v) => `${v.chave} (linha ${v.linha})`);
    expect(fora, "troque por requirePlatformAdminEscrita — support_readonly não escreve").toEqual([]);
  });

  it("a allowlist só encolhe: toda exceção ainda viola e tem porquê", () => {
    const chaves = new Set(VIOLACOES.map((v) => v.chave));
    for (const [chave, porque] of Object.entries(EXCECOES)) {
      expect(chaves.has(chave), `${chave} não viola mais — tire da allowlist`).toBe(true);
      expect(porque.length, chave).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("controles do instrumento", () => {
  const imp = `import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";`;
  it("A: POST que chama requirePlatformAdmin sem a de escrita é acusado; GET não", () => {
    expect(violacoesDeEscrita(`${imp}\nexport async function POST() { await requirePlatformAdmin(); }`, "r.ts")).toHaveLength(1);
    expect(violacoesDeEscrita(`${imp}\nexport async function GET() { await requirePlatformAdmin(); }`, "r.ts")).toEqual([]);
  });
  it("A: lê .is_platform_admin por helper do mesmo arquivo, e export const também é visto", () => {
    const fonte = `async function gate(u: { is_platform_admin: boolean }) { return u.is_platform_admin; }
      export const PATCH = async () => gate({ is_platform_admin: true });`;
    expect(violacoesDeEscrita(fonte, "r.ts").map((v) => v.chave)).toEqual(["r.ts#A:PATCH"]);
  });
  it("A: POST que chama requirePlatformAdminEscrita passa", () => {
    expect(violacoesDeEscrita(`export async function POST() { await requirePlatformAdminEscrita(); }`, "r.ts")).toEqual([]);
  });
  it("B: 'use server' que importa requirePlatformAdmin é acusado; a de escrita passa", () => {
    expect(violacoesDeEscrita(`"use server";\n${imp}`, "a.ts")).toHaveLength(1);
    expect(violacoesDeEscrita(`"use server";\nimport { requirePlatformAdminEscrita } from "@/lib/auth/requirePlatformAdmin";`, "a.ts")).toEqual([]);
  });
  it("B: 'use server' que pula o papel por .is_platform_admin é acusado; com escreveComoPlatformAdmin passa", () => {
    const atalho = `"use server";\nexport async function salvar(u: { is_platform_admin: boolean }, papel: number) { if (!u.is_platform_admin && papel < 4) return; }`;
    expect(violacoesDeEscrita(atalho, "a.ts").map((v) => v.chave)).toEqual(["a.ts#B:flag"]);
    const comScope = `"use server";\nexport async function salvar(u: { is_platform_admin: boolean }, papel: number) { if (!escreveComoPlatformAdmin(u) && papel < 4) return; void u.is_platform_admin; }`;
    expect(violacoesDeEscrita(comScope, "a.ts")).toEqual([]);
    // Fora de "use server" a regra B não vale (a A cobre os handlers de rota).
    expect(violacoesDeEscrita(atalho.replace('"use server";\n', ""), "a.ts")).toEqual([]);
  });
  it("C: 'leitura' em POST ou em helper é acusado; em GET passa", () => {
    expect(violacoesDeEscrita(`export async function POST() { requireRole("admin", { allowPlatformAdmin: "leitura" }); }`, "r.ts")).toHaveLength(1);
    expect(violacoesDeEscrita(`async function h() { requireRole("admin", { allowPlatformAdmin: "leitura" }); }\nexport async function GET() { return h(); }`, "r.ts")).toHaveLength(1);
    expect(violacoesDeEscrita(`export async function GET() { requireRole("admin", { allowPlatformAdmin: "leitura" }); }`, "r.ts")).toEqual([]);
  });
  it("comentário não conta (controle do controle)", () => {
    expect(violacoesDeEscrita(`// export async function POST() { await requirePlatformAdmin(); }\nexport const x = 1;`, "r.ts")).toEqual([]);
  });
});
```

- [ ] **Passo 2: conferir a lista contra o repositório** — comente temporariamente as 32 entradas `PENDENTE` (17 das Tasks 13–15 + 15 da Task 15b) e rode:

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run tests/unit/admin-escrita-exige-scope-full.test.ts > /tmp/t12.log 2>&1; echo "exit=$?"
grep -aoE "app/[^ \"']+#[ABC]:[A-Za-z-]+" /tmp/t12.log | sort -u | tee /tmp/t12-chaves.txt | wc -l
```

Esperado: `exit=1` e exatamente as 32 chaves `PENDENTE` (a sonda de `d03c2b2fd`, `grep -l '\.is_platform_admin'` nos arquivos `"use server"` de `app/`, deu as 15 `#B:flag` mais `politicaDeMfa.ts`, que é permanente). Se a lista divergir (a main andou), a allowlist passa a ser a lista medida — cada entrada a mais ganha a sua conversão na Task 14, 15 ou 15b, no mesmo formato. Descomente as entradas.

- [ ] **Passo 3: ver passar:** o mesmo `vitest run` → verde.

- [ ] **Passo 4: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add tests/unit/admin-escrita-exige-scope-full.test.ts
git commit -F - <<'FIM'
test(auth): cerca de escrita de platform admin exige scope full

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 13: `suspend` / `reactivate` pelas funções SQL

**Files:** Modify (reescrever) `app/api/v1/admin/tenants/[id]/suspend/route.ts`, `app/api/v1/admin/tenants/[id]/reactivate/route.ts`. Create `app/api/v1/admin/tenants/[id]/suspend/route.test.ts`, `app/api/v1/admin/tenants/[id]/reactivate/route.test.ts`. Modify `tests/unit/admin-escrita-exige-scope-full.test.ts` (apaga 2 exceções).

**Interfaces**
- Consumes: `requirePlatformAdminEscrita`, `falhaDaEscritaDePlatformAdmin`, `type PlatformAdminContext` (Task 11); `ehOperante`, `type TipoDeSuspensao` (Task 7); RPCs `fn_suspender_organizacao(p_org, p_kind, p_motivo, p_ator)` (Task 3) e `fn_reativar_organizacao(p_org, p_kind_exigido, p_ator)` (Task 5) → jsonb `{changed, motivo?}` (a função grava o `event_log`).
- Produces: contrato HTTP — body `{reason}` (10–500; `tipo` no body é ignorado); kind sempre `'administrativa'`; 200 `ok({changed, motivo?})`; 404 tenant inexistente; 409 `suspensao_de_cobranca` no reactivate de org suspensa com kind `cobranca`; 403 `forbidden_scope` / `mfa_required` / `forbidden`. Audit `tenant.suspended` / `tenant.reactivated` só quando `changed`.

- [ ] **Passo 1: testes que falham** — `app/api/v1/admin/tenants/[id]/suspend/route.test.ts`:

```ts
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  linhaDoAdmin: null as Record<string, unknown> | null,
  org: null as Record<string, unknown> | null,
  escritasDiretas: [] as string[],
  rpc: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: h.ator } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }) },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: h.linhaDoAdmin, error: null });
      return c;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => ({ data: h.org, error: null });
      c.insert = () => (h.escritasDiretas.push(tabela), c);
      c.update = () => (h.escritasDiretas.push(tabela), c);
      return c;
    },
    rpc: (...args: unknown[]) => h.rpc(...args),
  }),
}));

import { POST } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const MOTIVO = "Fraude confirmada no cartão do cliente";
const ctx = { params: Promise.resolve({ id: TENANT }) };
const pedido = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/suspend`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
const admin = (scope: string) => ({ user_id: h.ator, scope, mfa_required: false, revoked_at: null });

beforeEach(() => {
  vi.clearAllMocks();
  h.linhaDoAdmin = admin("full");
  h.org = { id: TENANT, slug: "acme" };
  h.escritasDiretas = [];
  h.rpc.mockResolvedValue({ data: { changed: true }, error: null });
});

describe("POST /admin/tenants/[id]/suspend", () => {
  it("support_readonly vê o erro: 403 forbidden_scope, nada escrito", async () => {
    h.linhaDoAdmin = admin("support_readonly");
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_scope");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("full suspende pela função, sempre 'administrativa', sem UPDATE nem event_log soltos", async () => {
    const res = await POST(pedido({ reason: MOTIVO, tipo: "cobranca" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ changed: true });
    expect(h.rpc).toHaveBeenCalledWith("fn_suspender_organizacao", {
      p_org: TENANT, p_kind: "administrativa", p_motivo: MOTIVO, p_ator: h.ator,
    });
    expect(h.escritasDiretas).toEqual([]);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]?.[0]).toMatchObject({ action: "tenant.suspended", organizationId: TENANT });
  });

  it("changed:false devolve 200 com o jsonb e NÃO audita", async () => {
    h.rpc.mockResolvedValue({ data: { changed: false, motivo: "ja_suspensa" }, error: null });
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect((await res.json()).data).toEqual({ changed: false, motivo: "ja_suspensa" });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("motivo curto → 400; tenant inexistente → 404; erro da função → 500", async () => {
    expect((await POST(pedido({ reason: "curto" }), ctx)).status).toBe(400);
    h.org = null;
    expect((await POST(pedido({ reason: MOTIVO }), ctx)).status).toBe(404);
    h.org = { id: TENANT, slug: "acme" };
    h.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await POST(pedido({ reason: MOTIVO }), ctx)).status).toBe(500);
  });
});
```

`app/api/v1/admin/tenants/[id]/reactivate/route.test.ts` (arquivo inteiro; os dublês são os mesmos do `suspend`, com a URL em `/reactivate` e a org já suspensa):

```ts
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  linhaDoAdmin: null as Record<string, unknown> | null,
  org: null as Record<string, unknown> | null,
  escritasDiretas: [] as string[],
  rpc: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: h.ator } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }) },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: h.linhaDoAdmin, error: null });
      return c;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => ({ data: h.org, error: null });
      c.insert = () => (h.escritasDiretas.push(tabela), c);
      c.update = () => (h.escritasDiretas.push(tabela), c);
      return c;
    },
    rpc: (...args: unknown[]) => h.rpc(...args),
  }),
}));

import { POST } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const MOTIVO = "Fraude descartada depois da análise do caso";
const ctx = { params: Promise.resolve({ id: TENANT }) };
const pedido = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/reactivate`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
const admin = (scope: string) => ({ user_id: h.ator, scope, mfa_required: false, revoked_at: null });

beforeEach(() => {
  vi.clearAllMocks();
  h.linhaDoAdmin = admin("full");
  h.org = { id: TENANT, slug: "acme", status: "suspended", suspended_kind: "administrativa" };
  h.escritasDiretas = [];
  h.rpc.mockResolvedValue({ data: { changed: true }, error: null });
});

describe("POST /admin/tenants/[id]/reactivate", () => {
  it("suspensão por COBRANÇA → 409 suspensao_de_cobranca, sem chamar a função", async () => {
    h.org = { id: TENANT, slug: "acme", status: "suspended", suspended_kind: "cobranca" };
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("suspensao_de_cobranca");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("administrativa reativa pela função com kind exigido e audita com o motivo", async () => {
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("fn_reativar_organizacao", {
      p_org: TENANT, p_kind_exigido: "administrativa", p_ator: h.ator,
    });
    expect(h.escritasDiretas).toEqual([]);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]?.[0]).toMatchObject({ action: "tenant.reactivated", metadata: { reason: MOTIVO } });
  });

  it("support_readonly → 403 forbidden_scope, nada chamado", async () => {
    h.linhaDoAdmin = admin("support_readonly");
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_scope");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("changed:false (não estava suspensa) → 200 sem audit", async () => {
    h.rpc.mockResolvedValue({ data: { changed: false, motivo: "nao_suspensa" }, error: null });
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect((await res.json()).data).toEqual({ changed: false, motivo: "nao_suspensa" });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("motivo curto → 400; tenant inexistente → 404; erro da função → 500", async () => {
    expect((await POST(pedido({ reason: "curto" }), ctx)).status).toBe(400);
    h.org = null;
    expect((await POST(pedido({ reason: MOTIVO }), ctx)).status).toBe(404);
    h.org = { id: TENANT, slug: "acme", status: "suspended", suspended_kind: "administrativa" };
    h.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await POST(pedido({ reason: MOTIVO }), ctx)).status).toBe(500);
  });
});
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run 'app/api/v1/admin/tenants/[id]/suspend/route.test.ts' 'app/api/v1/admin/tenants/[id]/reactivate/route.test.ts'` → readonly passa ou recebe `forbidden` genérico, `rpc` nunca chamado, `escritasDiretas` com `organizations`/`event_log`.

- [ ] **Passo 3: implementar** — `suspend/route.ts` completo:

```ts
import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/admin/tenants/[id]/suspend (S-11.08)
 *
 * Suspensão ADMINISTRATIVA pela função definer `fn_suspender_organizacao`, numa
 * transação só: status + tipo, jobs `pending` → `failed`, mensagens `queued` →
 * `failed` e `event_log tenant.suspended`. Antes era leitura, UPDATE e um
 * `event_log` solto sem await — não atômico.
 *
 * Body `{reason}` (10–500). O tipo NÃO vem do body: pela sessão é sempre
 * 'administrativa'. Exige `requirePlatformAdminEscrita()` (scope full + MFA).
 * Resposta: o jsonb da função, `{changed, motivo?}`.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import type { TipoDeSuspensao } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";

const bodySchema = z.object({
  reason: z
    .string()
    .min(10, "Motivo deve ter ao menos 10 caracteres")
    .max(500, "Motivo deve ter no máximo 500 caracteres"),
});
const resultadoSchema = z.object({ changed: z.boolean(), motivo: z.string().optional() });
const KIND: TipoDeSuspensao = "administrativa";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supportDenied = await requireSupportWrite((await params).id);
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: tenantId } = await params;

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return fail("validation_failed", "Invalid request body", 400, { requestId });
  }

  const admin = createAdminClient();
  // Só para o 404 e o slug do audit; a decisão e a escrita são da função.
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, slug")
    .eq("id", tenantId)
    .maybeSingle();
  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  const { data, error } = await admin.rpc("fn_suspender_organizacao", {
    p_org: tenantId,
    p_kind: KIND,
    p_motivo: body.reason,
    p_ator: adminCtx.user.id,
  });
  const resultado = resultadoSchema.safeParse(data);
  if (error || !resultado.success) {
    return fail("internal_error", "Failed to suspend tenant", 500, { requestId });
  }

  if (resultado.data.changed) {
    void audit({
      action: "tenant.suspended",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: tenantId,
      resourceType: "organization",
      resourceId: tenantId,
      requestId,
      metadata: { tenant_id: tenantId, tenant_slug: org.slug, suspended_by: adminCtx.user.id, reason: body.reason, kind: KIND },
    });
  }

  return ok(resultado.data, { requestId });
}
```

`reactivate/route.ts` completo:

```ts
import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/admin/tenants/[id]/reactivate (S-11.08)
 *
 * Reativa a suspensão ADMINISTRATIVA pela função definer `fn_reativar_organizacao`
 * (status, cinto da fila, item `org_reativada` na Central, `event_log`, numa
 * transação). Suspensão por COBRANÇA não sai por aqui: 409
 * `suspensao_de_cobranca` — a saída é "Dar prazo" ou "Tornar isenta" (D-6).
 * `reason` (10–500) vai só para o audit. Resposta: `{changed, motivo?}`.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { ehOperante, type TipoDeSuspensao } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";

const bodySchema = z.object({
  reason: z
    .string()
    .min(10, "Motivo deve ter ao menos 10 caracteres")
    .max(500, "Motivo deve ter no máximo 500 caracteres"),
});
const resultadoSchema = z.object({ changed: z.boolean(), motivo: z.string().optional() });
const KIND_EXIGIDO: TipoDeSuspensao = "administrativa";
const KIND_DE_COBRANCA: TipoDeSuspensao = "cobranca";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supportDenied = await requireSupportWrite((await params).id);
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: tenantId } = await params;

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return fail("validation_failed", "Invalid request body", 400, { requestId });
  }

  const admin = createAdminClient();
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, slug, status, suspended_kind")
    .eq("id", tenantId)
    .maybeSingle();
  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  // `suspended_kind` só significa algo com a org parada (operante.ts). A função
  // também recusa o kind divergente; aqui é para a mensagem ter nome.
  if (!ehOperante(org.status) && org.suspended_kind === KIND_DE_COBRANCA) {
    return fail(
      "suspensao_de_cobranca",
      "Esta suspensão é por falta de pagamento. Use Dar prazo ou Tornar isenta.",
      409,
      { requestId },
    );
  }

  const { data, error } = await admin.rpc("fn_reativar_organizacao", {
    p_org: tenantId,
    p_kind_exigido: KIND_EXIGIDO,
    p_ator: adminCtx.user.id,
  });
  const resultado = resultadoSchema.safeParse(data);
  if (error || !resultado.success) {
    return fail("internal_error", "Failed to reactivate tenant", 500, { requestId });
  }

  if (resultado.data.changed) {
    void audit({
      action: "tenant.reactivated",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: tenantId,
      resourceType: "organization",
      resourceId: tenantId,
      requestId,
      metadata: { tenant_id: tenantId, tenant_slug: org.slug, reactivated_by: adminCtx.user.id, reason: body.reason },
    });
  }

  return ok(resultado.data, { requestId });
}
```

Em `tests/unit/admin-escrita-exige-scope-full.test.ts`, apague as entradas `…/[id]/suspend/route.ts#A:POST` e `…/[id]/reactivate/route.ts#A:POST`.

- [ ] **Passo 4: ver passar:** os dois arquivos de rota + `tests/unit/admin-escrita-exige-scope-full.test.ts` + `pnpm typecheck` → verdes.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add 'app/api/v1/admin/tenants/[id]' tests/unit/admin-escrita-exige-scope-full.test.ts
git commit -F - <<'FIM'
fix(admin): suspender e reativar passam pelas funções SQL e exigem scope full

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 14: Demais handlers de escrita (incidents resolve, tenants POST, system/update, marca/logo)

**Files:** Modify `app/api/v1/admin/incidents/[id]/resolve/route.ts`, `app/api/v1/admin/tenants/route.ts`, `app/api/v1/system/update/route.ts`, `app/api/v1/system/update/route.test.ts`, `app/api/v1/marca/logo/route.ts`, `app/api/v1/marca/logo/route.test.ts`, `tests/unit/logo-por-tema-rota.test.ts`, `tests/unit/organizacoes-criacao-e-troca.test.ts`, `tests/unit/admin-escrita-exige-scope-full.test.ts`.

**Interfaces** — Consumes: `requirePlatformAdminEscrita`, `falhaDaEscritaDePlatformAdmin`, `EscritaDePlatformAdminNegada`, `escreveComoPlatformAdmin` (Task 11); `AuthUser.platform_admin_scope` (Task 8).

- [ ] **Passo 1: testes que falham.**
  - `app/api/v1/system/update/route.test.ts`: troque o `vi.hoisted` e os mocks de auth por:

```ts
const mocks = vi.hoisted(() => ({
  insertError: { code: "", message: "" },
  audit: vi.fn(),
  escrita: vi.fn(async () => ({ user: { id: "owner" }, platformAdmin: { user_id: "owner", scope: "full", mfa_required: false } })),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "owner", is_platform_admin: true }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdminEscrita: mocks.escrita,
}));
```

  (mantenha os demais campos que o `vi.hoisted` atual já tinha) e acrescente:

```ts
it("support_readonly não dispara atualização: 403 forbidden_scope, nada gravado", async () => {
  const { EscritaDePlatformAdminNegada } = await import("@/lib/auth/requirePlatformAdmin");
  mocks.escrita.mockRejectedValueOnce(new EscritaDePlatformAdminNegada("forbidden_scope", "somente leitura"));
  const response = await POST(new NextRequest("http://localhost/api/v1/system/update", { method: "POST" }));
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("forbidden_scope");
  expect(mocks.audit).not.toHaveBeenCalled();
});
```

  - `app/api/v1/marca/logo/route.test.ts` e `tests/unit/logo-por-tema-rota.test.ts`: depois do `vi.mock("@/lib/auth/server", …)` de cada um, acrescente:

```ts
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>();
  const { loadAuthUser: usuarioDoCaso } = await import("@/lib/auth/server");
  return {
    ...real,
    // Segue o usuário do caso: o dono do servidor passa; os demais levam o
    // redirect que o helper real faria. Scope e MFA: lib/auth/requirePlatformAdmin.test.ts.
    requirePlatformAdminEscrita: async () => {
      const u = await usuarioDoCaso();
      if (!u?.is_platform_admin) throw new Error("NEXT_REDIRECT;/admin/forbidden");
      return { user: { id: u.id }, platformAdmin: { user_id: u.id, scope: "full", mfa_required: false } };
    },
  };
});
```

  (em `d03c2b2fd` nenhum dos dois mocka `@/lib/supabase/server`; os `vi.mock("@/lib/auth/server", …)` estão em `route.test.ts:41` e `logo-por-tema-rota.test.ts:16`) e em `app/api/v1/marca/logo/route.test.ts`, no describe do escopo `organizacao`:

```ts
  it("platform admin support_readonly, viewer na org, NÃO troca o logo da organização", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      ...usuarioAdminDeOrganizacao(), is_platform_admin: true, platform_admin_scope: "support_readonly",
    } as AuthUser);
    vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "viewer" } as never);
    const espiao = criarAdminEspiao();
    vi.mocked(createAdminClient).mockReturnValue(espiao.client as never);
    const form = new FormData();
    form.set("escopo", "organizacao");
    form.set("file", arquivoPng());
    const { POST } = await import("./route");
    const res = await POST(new NextRequest("http://localhost/api/v1/marca/logo", { method: "POST", body: form }));
    expect(res.status).toBe(403);
    expect(espiao.fromChamadas).toHaveLength(0);
  });
```

  (`usuarioAdminDeOrganizacao` (`:116`), `criarAdminEspiao` (`:71`), `arquivoPng` (`:62`) e `ORG_ID` (`:52`) são os helpers que o arquivo já tem em `d03c2b2fd`.)
  - `tests/unit/organizacoes-criacao-e-troca.test.ts`: no `vi.hoisted` acrescente `escrita: vi.fn(),`; troque o `vi.mock("@/lib/auth/requirePlatformAdmin", …)` (hoje `:7`) por:

```ts
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdmin: h.guard,
  requirePlatformAdminEscrita: h.escrita,
}));
```

  acrescente `import { EscritaDePlatformAdminNegada } from "@/lib/auth/requirePlatformAdmin";`, no `beforeEach` `h.escrita.mockResolvedValue({ user: { id: actor, email: "owner@example.test", user_metadata: {} }, platformAdmin: { scope: "full" } });`, e substitua o 1º caso por:

```ts
  it("não cria nem convida quando a escrita de platform admin é recusada (sem auth, readonly, dívida MFA)", async () => {
    h.escrita.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    expect((await POST(request())).status).toBe(403);
    h.escrita.mockRejectedValueOnce(new EscritaDePlatformAdminNegada("forbidden_scope", "somente leitura"));
    const readonly = await POST(request());
    expect(readonly.status).toBe(403);
    expect((await readonly.json()).error.code).toBe("forbidden_scope");
    h.escrita.mockRejectedValueOnce(new EscritaDePlatformAdminNegada("mfa_required", "mfa"));
    expect((await POST(request())).status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run app/api/v1/system/update/route.test.ts app/api/v1/marca/logo/route.test.ts tests/unit/logo-por-tema-rota.test.ts tests/unit/organizacoes-criacao-e-troca.test.ts` → casos novos vermelhos (readonly passa, código errado).

- [ ] **Passo 3: implementar.**
  - `incidents/[id]/resolve/route.ts`: import de `requirePlatformAdmin` → `import { falhaDaEscritaDePlatformAdmin, requirePlatformAdminEscrita, type PlatformAdminContext } from "@/lib/auth/requirePlatformAdmin";`; o bloco `let adminCtx … catch {…}` (hoje `:36-41`) por:

```ts
  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
```

  - `admin/tenants/route.ts`: import (hoje `:7`) → `import { falhaDaEscritaDePlatformAdmin, requirePlatformAdmin, requirePlatformAdminEscrita, type PlatformAdminContext } from "@/lib/auth/requirePlatformAdmin";`; apague `import { mfaEmDivida } from "@/lib/auth/server";` (hoje `:4`; em `d03c2b2fd` o único uso é o do POST, `:171`); no POST, troque o `try/catch` + a checagem manual de `scope` + `mfaEmDivida` (hoje `:159-172`, do `let adminCtx` até o `return fail("mfa_required", …)`) pelo bloco de 6 linhas acima. O GET (`:52-54`) segue com `requirePlatformAdmin`.
  - `system/update/route.ts`: import `import { falhaDaEscritaDePlatformAdmin, requirePlatformAdminEscrita } from "@/lib/auth/requirePlatformAdmin";` e troque `if (!user.is_platform_admin) {…}` (hoje `:30-32`) por:

```ts
  // Atualizar o servidor é ESCRITA da instalação: support_readonly e sessão com
  // dívida de MFA não disparam. O 401 acima fica: sem sessão é `unauthenticated`.
  try {
    await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, undefined, "Só o dono do servidor pode atualizar o sistema.");
  }
```

  - `marca/logo/route.ts`: import `import { EscritaDePlatformAdminNegada, requirePlatformAdminEscrita } from "@/lib/auth/requirePlatformAdmin";`, e `import { roleAtLeast } from "@/lib/auth/types";` (hoje `:61`) vira `import { escreveComoPlatformAdmin, roleAtLeast } from "@/lib/auth/types";`; em `abrirContexto`, o bloco `if (escopo === "instalacao") { … }` passa a ser:

```ts
  if (escopo === "instalacao") {
    // `requirePlatformAdminEscrita` confere linha ativa, scope `full` e MFA da
    // sessão. Ele REDIRECIONA quem não é platform admin; aqui o redirect vira
    // recusa, porque 307 para HTML num fetch de upload chega como "erro inesperado".
    try {
      await requirePlatformAdminEscrita();
    } catch (err) {
      if (err instanceof EscritaDePlatformAdminNegada) {
        return { recusa: { codigo: err.code, mensagem: err.message, status: 403 } };
      }
      return {
        recusa: {
          codigo: "forbidden_role",
          mensagem: "Só quem administra a instalação pode trocar o logo do sistema.",
          status: 403,
        },
      };
    }
    return { ctx: { escopo, userId: user.id, prefixo: PREFIXO_DA_INSTALACAO } };
  }
```

  e no ramo da organização troque `  if (!user.is_platform_admin && !roleAtLeast(org.role, "admin")) {` por:

```ts
  if (!escreveComoPlatformAdmin(user) && !roleAtLeast(org.role, "admin")) {
```

  (O formato de `recusa` é `{ codigo, mensagem, status }` — `type Recusa` em `:139`, o mesmo que os ramos acima já usam.) O comentário de `abrirContexto`: Edit com `old_string` =

```ts
 * ── Por que `mfaEmDivida` e não o `requirePlatformAdmin()` das telas ─────────
 *
 * `requirePlatformAdmin()` REDIRECIONA (é o gate do layout de `/admin`), e um
 * `307` para `/login` como resposta a um `fetch()` de upload chega ao navegador
 * como HTML no lugar de JSON — a tela mostraria "erro inesperado" para um caso
 * que tem nome. Aqui o predicado é o mesmo que `lib/auth/require-role.ts` aplica
 * em todo `/api/v1`: papel + `mfaEmDivida`. A diferença de comportamento entre os
 * dois é só para quem AINDA NÃO cadastrou fator — e essa pessoa é barrada antes,
 * pelo gate de cadastro do layout, que é onde ela pode resolver.
```

  e `new_string` =

```ts
 * ── Por que `requirePlatformAdminEscrita` dentro de `try/catch` ──────────────
 *
 * Trocar o logo da INSTALAÇÃO é escrita de platform admin e exige o que toda
 * escrita dessas exige: linha ativa, scope `full` (o `support_readonly` lê o
 * painel e nada muda) e sessão sem dívida de MFA — quem confere as três é
 * `requirePlatformAdminEscrita`. Ele REDIRECIONA quem não é platform admin (é o
 * gate do layout de `/admin`), e um `307` como resposta a um `fetch()` de upload
 * chega ao navegador como HTML no lugar de JSON — a tela mostraria "erro
 * inesperado" para um caso que tem nome. Por isso a chamada fica num
 * `try/catch`: a recusa nomeada vira o seu código e o redirect vira
 * `forbidden_role`. No escopo da ORGANIZAÇÃO o predicado segue o de
 * `lib/auth/require-role.ts`: papel `admin` (ou platform admin com scope `full`,
 * `escreveComoPlatformAdmin`) + `mfaEmDivida`.
```
  - Em `tests/unit/admin-escrita-exige-scope-full.test.ts` apague as 5 entradas destes arquivos.

- [ ] **Passo 4: ver passar:** os 4 arquivos do passo 2 + a cerca + `pnpm typecheck` → verdes.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add app/api/v1 tests/unit
git commit -F - <<'FIM'
fix(admin): incidentes, criação de empresa, atualização e logo exigem escrita de platform admin

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 15: Server actions `"use server"` de admin

**Files:** Modify os 10 arquivos: `app/actions/settings/{updateDestinosInternos,smtp,updateMetaApp,updateComportamento,updateGoogleOAuth,updateSignupMode,updateModuloDaInstalacao,updateBranding}.ts`, `app/actions/registration/decide.ts`, `app/actions/admin/salvarConfiguracaoDaInstalacao.ts`; testes `app/actions/registration/decide.test.ts`, `app/actions/settings/updateModuloDaInstalacao.test.ts`, `tests/unit/app-da-meta-save-exige-o-segredo.test.ts`, `tests/unit/app-da-meta-so-quem-administra-a-instalacao.test.ts`, `tests/unit/admin-escrita-exige-scope-full.test.ts`.

**Interfaces** — Consumes: `requirePlatformAdminEscrita` (Task 11). Produces: toda server action de admin lança `EscritaDePlatformAdminNegada` para `support_readonly` (a tela mostra o erro genérico que já mostra).

- [ ] **Passo 1: teste que falha** — em `tests/unit/app-da-meta-so-quem-administra-a-instalacao.test.ts`, no objeto `mfa` do dublê acrescente `listFactors: async () => ({ data: { totp: [] }, error: null }),` (se ainda não houver) e, em `describe("updateMetaApp — o gate da instalação")`:

```ts
  it("support_readonly TEM a linha e mesmo assim não grava: a escrita exige scope full", async () => {
    linhaDeAdmin = { ...ADMIN_DA_INSTALACAO, scope: "support_readonly" };
    const { updateMetaApp } = await acoes();
    await expect(updateMetaApp({ app_secret: SEGREDO })).rejects.toMatchObject({ code: "forbidden_scope" });
    expect(tabelasDoServiceRole).toEqual([]);
  });
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/app-da-meta-so-quem-administra-a-instalacao.test.ts` → o caso novo grava (`platform_meta_app` em `tabelasDoServiceRole`).

- [ ] **Passo 3: implementar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
printf '%s\n' app/actions/settings/updateDestinosInternos.ts app/actions/settings/smtp.ts \
  app/actions/settings/updateMetaApp.ts app/actions/settings/updateComportamento.ts \
  app/actions/settings/updateGoogleOAuth.ts app/actions/settings/updateSignupMode.ts \
  app/actions/settings/updateModuloDaInstalacao.ts app/actions/settings/updateBranding.ts \
  app/actions/registration/decide.ts app/actions/admin/salvarConfiguracaoDaInstalacao.ts > /tmp/t15-acoes.txt
wc -l < /tmp/t15-acoes.txt                                           # esperado: 10
# `(?<![/\w])`: o NOME é trocado, o CAMINHO do módulo não. Sem o lookbehind, o
# `requirePlatformAdmin` de `"@/lib/auth/requirePlatformAdmin"` (entre `/` e `"`,
# duas fronteiras de palavra) viraria um módulo que não existe: TS2307 nos 10.
# A lista vai por arquivo + xargs (e não por variável) porque no zsh `$VAR` não
# se separa em palavras.
xargs perl -pi -e 's{(?<![/\w])requirePlatformAdmin\b(?!Escrita)}{requirePlatformAdminEscrita}g' < /tmp/t15-acoes.txt
perl -pi -e 's/\brequirePlatformAdmin:/requirePlatformAdminEscrita:/' \
  app/actions/registration/decide.test.ts app/actions/settings/updateModuloDaInstalacao.test.ts \
  tests/unit/app-da-meta-save-exige-o-segredo.test.ts
xargs grep -L 'from "@/lib/auth/requirePlatformAdmin";' < /tmp/t15-acoes.txt   # esperado: vazio (os 10 mantêm o caminho)
grep -rn 'requirePlatformAdminEscrita"' app/actions                              # esperado: vazio (nenhum caminho reescrito)
xargs grep -L "requirePlatformAdminEscrita()" < /tmp/t15-acoes.txt               # esperado: vazio (os 10 chamam a de escrita)
grep -rn "requirePlatformAdmin\b" app/actions | grep -v Escrita | grep -v '/lib/auth/requirePlatformAdmin'   # esperado: vazio
```

(Em `d03c2b2fd` cada um dos 10 tem exatamente um `import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";` e uma ou duas chamadas; os três testes mockam o módulo pelo caminho e trocam só a CHAVE do objeto do mock.)

(Os comentários de `updateBranding.ts` e `salvarConfiguracaoDaInstalacao.ts` passam a nomear a versão de escrita — é o que o código faz.) Apague as 10 entradas `#B:use-server` de `EXCECOES`. Ficam as 2 permanentes e as 15 `#B:flag` da Task 15b, que ainda usam `PENDENTE`.

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run tests/unit/admin-escrita-exige-scope-full.test.ts tests/unit/app-da-meta-so-quem-administra-a-instalacao.test.ts tests/unit/app-da-meta-save-exige-o-segredo.test.ts app/actions/registration/decide.test.ts app/actions/settings/updateModuloDaInstalacao.test.ts tests/unit/cadastro-aviso-da-troca-de-modo.test.ts && pnpm typecheck && pnpm lint` → verdes.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add app/actions tests/unit
git commit -F - <<'FIM'
fix(admin): server actions da instalação exigem escrita de platform admin

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 15b: O atalho de papel das server actions exige scope `full`

**Files:** Modify os 15 arquivos `app/actions/integrations/{connectNuvemshop,disconnectNuvemshop}.ts` e `app/actions/settings/{acoesDeConversaoGoogle,apagarDadosOperacionaisDaOrganizacao,atualizarInterfaceDaEmpresa,definirVendaPeloCanal,linksRastreaveis,salvarRegrasDeConversaoGoogle,updateAdInsightsConnection,updateAdPlatformConnection,updateCapturaDeUtm,updateGoogleAdsConnection,updateMarcaDaOrganizacao,updatePipelineConfig,updateTenant}.ts`; `tests/unit/zona-de-perigo-apaga-so-a-propria-org.test.ts`; `tests/unit/admin-escrita-exige-scope-full.test.ts`.

**Interfaces** — Consumes: `escreveComoPlatformAdmin` (Task 11), `AuthUser.platform_admin_scope` (Task 8), regra B de `admin-escrita-exige-scope-full` (Task 12). Produces: nenhuma server action deixa o `support_readonly` pular o papel do tenant.

Por quê: 15 server actions liberam a escrita com `!authUser.is_platform_admin && ROLE_RANK[…] < ROLE_RANK.admin` (ou `(user.is_platform_admin && !user.support)`). A sessão de ACOMPANHAMENTO já é barrada antes por `supportWriteError`, mas um platform admin `support_readonly` que é membro comum (ex.: `viewer`) de uma empresa, fora de acompanhamento, passa pelo atalho e escreve nela — inclusive `apagarDadosOperacionaisDaOrganizacao`, que apaga dado de cliente em massa. É o mesmo "support_readonly deixa de escrever" do objetivo da PR, por outra porta, e a regra B da spec (só `import` de `requirePlatformAdmin`) não o alcançava.

- [ ] **Passo 1: teste que falha** — em `tests/unit/zona-de-perigo-apaga-so-a-propria-org.test.ts`:
  - depois de `let ehPlatformAdmin = false;`: `let escopo: string | null = "full";`
  - o mock de `loadAuthUser` passa a `loadAuthUser: vi.fn(async () => ({ id: USER, is_platform_admin: ehPlatformAdmin, platform_admin_scope: ehPlatformAdmin ? escopo : null })),`
  - no `beforeEach`, depois de `ehPlatformAdmin = false;`: `escopo = "full";`
  - no `describe("zona de perigo: quem pode puxar o gatilho")`, depois do caso "platform admin passa mesmo sem papel de admin no tenant":

```ts
  it("platform admin SÓ LEITURA que é viewer na empresa não apaga nada", async () => {
    // O acompanhamento já é barrado por `supportWriteError`; este é o outro
    // caminho: o support_readonly que também é membro comum da empresa. O
    // atalho de papel exige scope full (`escreveComoPlatformAdmin`).
    papel = "viewer";
    ehPlatformAdmin = true;
    escopo = "support_readonly";
    const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });
    expect(r).toEqual({ ok: false, error: "forbidden_role" });
    expect(delecoes).toEqual([]);
    expect(auditadas).toEqual([]);
  });
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/zona-de-perigo-apaga-so-a-propria-org.test.ts` → o caso novo recebe `{ ok: true }` e 7 `DELETE`s.

- [ ] **Passo 3: implementar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
printf '%s\n' app/actions/integrations/connectNuvemshop.ts app/actions/integrations/disconnectNuvemshop.ts \
  app/actions/settings/acoesDeConversaoGoogle.ts app/actions/settings/apagarDadosOperacionaisDaOrganizacao.ts \
  app/actions/settings/atualizarInterfaceDaEmpresa.ts app/actions/settings/definirVendaPeloCanal.ts \
  app/actions/settings/linksRastreaveis.ts app/actions/settings/salvarRegrasDeConversaoGoogle.ts \
  app/actions/settings/updateAdInsightsConnection.ts app/actions/settings/updateAdPlatformConnection.ts \
  app/actions/settings/updateCapturaDeUtm.ts app/actions/settings/updateGoogleAdsConnection.ts \
  app/actions/settings/updateMarcaDaOrganizacao.ts app/actions/settings/updatePipelineConfig.ts \
  app/actions/settings/updateTenant.ts > /tmp/t15b-acoes.txt
wc -l < /tmp/t15b-acoes.txt                                                        # esperado: 15
# As três formas do atalho, medidas em d03c2b2fd:
#  (a) `!authUser.is_platform_admin && ROLE_RANK`       — 9 ocorrências em 8 arquivos
#  (b) `(authUser|user).is_platform_admin && !(…).support` — 4 arquivos
#  (c) `&& !user.is_platform_admin)` (Nuvemshop)          — 2 arquivos
xargs perl -pi -e 's/!(authUser|user)\.is_platform_admin && ROLE_RANK/!escreveComoPlatformAdmin($1) && ROLE_RANK/g;
  s/\((authUser|user)\.is_platform_admin && !(authUser|user)\.support\)/(escreveComoPlatformAdmin($1) && !$2.support)/g;
  s/&& !user\.is_platform_admin\)/&& !escreveComoPlatformAdmin(user))/g' < /tmp/t15b-acoes.txt
# O import: 13 arquivos já importam ROLE_RANK de @/lib/auth/types; os 2 da Nuvemshop, nada de lá.
xargs perl -pi -e 's/^import \{ ROLE_RANK \} from "\@\/lib\/auth\/types";/import { ROLE_RANK, escreveComoPlatformAdmin } from "\@\/lib\/auth\/types";/' < /tmp/t15b-acoes.txt
perl -0pi -e 's/\A"use server";\n/"use server";\n\nimport { escreveComoPlatformAdmin } from "\@\/lib\/auth\/types";\n/' \
  app/actions/integrations/connectNuvemshop.ts app/actions/integrations/disconnectNuvemshop.ts
xargs grep -n "\.is_platform_admin" < /tmp/t15b-acoes.txt
xargs grep -L "escreveComoPlatformAdmin(" < /tmp/t15b-acoes.txt                    # esperado: vazio
xargs grep -c 'import.*escreveComoPlatformAdmin.*"@/lib/auth/types"' < /tmp/t15b-acoes.txt | grep -v ":1$"   # esperado: vazio
```

Esperado no primeiro `grep -n` (medido numa cópia dos 15 arquivos de `d03c2b2fd`): uma linha só, `app/actions/settings/apagarDadosOperacionaisDaOrganizacao.ts:…: actingAsPlatformAdmin: authUser.is_platform_admin,` — é metadado do audit ("agiu como platform admin"), não decisão, e fica.

Em `tests/unit/admin-escrita-exige-scope-full.test.ts`, apague as 15 entradas `#B:flag` da "Task 15b" e a constante `PENDENTE` (ficou sem uso; o lint acusa). Ficam só as 2 permanentes (`impersonate` e `politicaDeMfa`).

- [ ] **Passo 4: ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run tests/unit/zona-de-perigo-apaga-so-a-propria-org.test.ts tests/unit/admin-escrita-exige-scope-full.test.ts \
  tests/unit/conversoes-formularios.test.tsx tests/unit/links-rastreaveis-action.test.ts tests/unit/google-regras-por-etapa-action.test.ts \
  tests/unit/captura-de-utm-na-tela.test.ts tests/unit/google-ads-cartao-sem-credenciais.test.tsx tests/unit/google-conexao-config.test.ts \
  app/app/settings/tenant/pipelines/_client.test.tsx tests/unit/idioma-aparece-pelo-nivel-do-registro.test.tsx \
  tests/unit/moeda-da-organizacao-se-escolhe-na-tela.test.ts > /tmp/t15b.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t15b.log | tail -2
pnpm typecheck; echo "tsc=$?"
pnpm lint; echo "lint=$?"
pnpm lint:role-rank; echo "role-rank=$?"
```

Esperado: `exit=0`, `tsc=0`, `lint=0`, `role-rank=0`. (São os testes que, em `d03c2b2fd`, citam alguma das 15 ações.) Receita para vermelho num deles: se o caso espera que um platform admin sem papel no tenant ESCREVA e a fixture tem `is_platform_admin: true` sem scope, acrescente `platform_admin_scope: "full"` à fixture — o comportamento pedido (o `full` escreve) é o mesmo; rode o arquivo isolado e inclua-o no commit.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add app/actions tests/unit app/app/settings/tenant/pipelines/_client.test.tsx
git status --short   # confira que só entrou o que esta tarefa tocou
git commit -F - <<'FIM'
fix(auth): o atalho de papel do platform admin nas server actions exige scope full

Quinze server actions deixavam qualquer platform admin pular o papel do
tenant; o support_readonly que é membro comum de uma empresa escrevia
nela, inclusive apagando os dados operacionais. A regra B da cerca passa
a cobrar escreveComoPlatformAdmin em todo "use server" que lê a flag.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 16: `app/app/layout.tsx` — suspensão antes do onboarding; leitura que falha lança

**Files:** Modify `app/app/layout.tsx`. Create `tests/unit/layout-app-suspensao-antes-do-onboarding.test.tsx`.

**Interfaces** — Consumes: `ehOperante` (Task 7). Produces: o layout deixa de comparar `orgRow?.status === "suspended"` (pré-condição da cerca da Task 30).

- [ ] **Passo 1: teste que falha**

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ linha: null as unknown, erro: null as unknown }));
const adminClient = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: estado.linha, error: estado.erro }) }) }),
  }),
};
vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-1", idioma: "pt-BR", is_platform_admin: false, support: null, organizations: [] }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "admin", interface_settings: null }),
  isMfaEnrolled: async () => true,
  requiresMfa: async () => false,
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Deskcomm", logoUrl: null, cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

beforeEach(() => {
  estado.linha = { onboarded_at: "2026-01-01", status: "active", settings: null };
  estado.erro = null;
});

describe("layout de /app × org parada", () => {
  it("org suspensa que nunca terminou o onboarding vai para /account-suspended, não /onboarding", async () => {
    estado.linha = { onboarded_at: null, status: "suspended", settings: null };
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toThrow("redirect:/account-suspended");
  });

  it("leitura de organizations que falha LANÇA em vez de renderizar a casca", async () => {
    estado.linha = null;
    estado.erro = { message: "connection reset" };
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toThrow(/organizacao_ilegivel/);
  });

  it("CONTROLE: org ativa e onboardada renderiza", async () => {
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).resolves.toBeTruthy();
  });
});
```

(Os 8 `vi.mock` acima são cópia dos de `tests/unit/faixa-de-conexao-caida-vem-do-seam.test.tsx:40-73` em `d03c2b2fd` — o vizinho que já executa `AppLayout` de verdade —, com duas diferenças deliberadas: o `redirect` lança `redirect:<destino>` para o caso 1 ler o destino, e o `adminClient.from(...)...maybeSingle()` devolve `{ data, error }` do `estado` para os casos 2 e 3. O vizinho devolve `{ data }` sem `error`, que é `undefined` e não dispara o `if (orgRes.error)` novo.)

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/layout-app-suspensao-antes-do-onboarding.test.tsx` → caso 1 `redirect:/onboarding`, caso 2 resolve.

- [ ] **Passo 3: implementar** — em `app/app/layout.tsx`, acrescente `import { ehOperante } from "@/lib/organizacao/operante";`. Logo depois de `const orgRow = orgRes.data;` (hoje `:110`):

```ts
    // Erro de leitura LANÇA: `orgRow` nulo passava por "sem onboarding pendente
    // e não suspensa" e renderizava a casca de uma org que ninguém conseguiu ler.
    if (orgRes.error) {
      throw new Error(`organizacao_ilegivel: ${orgRes.error.message}`);
    }
```

e troque as duas linhas (hoje `:115-116`)

```ts
    if (orgRow && !orgRow.onboarded_at && !user.support) redirect("/onboarding");
    if (orgRow?.status === "suspended") redirect("/account-suspended");
```

por

```ts
    // Suspensão ANTES de onboarding: a org suspensa que nunca terminou o
    // onboarding ia para `/onboarding` e escapava da tela da suspensão.
    if (!ehOperante(orgRow?.status)) redirect("/account-suspended");
    if (orgRow && !orgRow.onboarded_at && !user.support) redirect("/onboarding");
```

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run tests/unit/layout-app-suspensao-antes-do-onboarding.test.tsx tests/unit/faixa-de-conexao-caida-vem-do-seam.test.tsx` → verdes.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add app/app/layout.tsx tests/unit/layout-app-suspensao-antes-do-onboarding.test.tsx
git commit -F - <<'FIM'
fix(app): suspensão vem antes do onboarding e leitura da org que falha não renderiza a casca

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 17: Token `dsk_` e MCP — 403 `org_suspended` sem debitar o balde

**Files:** Modify `lib/mcp/auth.ts`, `lib/api/auth-dual.ts`, `app/api/v1/contacts/route.ts`, `lib/mcp/auth-resolve-api-token.test.ts`, `lib/mcp/auth-teto-de-token.test.ts`, `lib/api/auth-dual.test.ts`.

**Interfaces**
- Consumes: `ehOperante` (Task 7); FK única `api_tokens_organization_id_fkey` (o embed `organizations!inner(status)` não é ambíguo).
- Produces: `ApiTokenError.reason` ganha `"org_suspended"`; `McpAuthError` ganha 4º parâmetro opcional `codigo?: string`; `validateBearerToken` lança `McpAuthError(-32002, 403, "Organization suspended.", "org_suspended")` sem debitar o teto de falhas e sem gravar `last_used_at`; `auth-dual` e `contacts` respondem `err.codigo ?? …`.

- [ ] **Passo 1: testes que falham.**
  - `lib/mcp/auth-resolve-api-token.test.ts`: `interface LinhaDoToken` ganha `organizations: { status: string };` e `linhaViva` ganha `organizations: { status: "active" },`. Em `describe("resolveApiToken — os cinco motivos de recusa")`:

```ts
  it("token vivo de organização SUSPENSA é `org_suspended` e não registra uso", async () => {
    const reg = armar(achou(linhaViva({ organizations: { status: "suspended" } })));
    expect(await reasonDe(PLAINTEXT)).toBe("org_suspended");
    expect(reg.updates).toEqual([]);
    expect(reg.colunas.join(",")).toContain("organizations!inner(status)");
  });
```

  e na `TABELA_DE_TRADUCAO`, antes do caso do banco:

```ts
  {
    caso: "token vivo de organização suspensa (org_suspended)",
    header: `Bearer ${PLAINTEXT}`,
    resposta: achou(linhaViva({ organizations: { status: "suspended" } })),
    mcpCode: -32002,
    httpStatus: 403,
    message: "Organization suspended.",
  },
```

  - `lib/mcp/auth-teto-de-token.test.ts`: `linhaDeToken(extra: { revoked_at?: string | null; expires_at?: string | null; organizations?: { status: string } } = {})` com `organizations: { status: "active" },` no default; e:

```ts
  it("token válido de org suspensa não paga imposto: 40 chamadas, todas 403, nenhuma 429", async () => {
    bancoFalso({ data: linhaDeToken({ organizations: { status: "suspended" } }), error: null });
    for (let i = 0; i < 40; i++) {
      expect(await tentar("dsk_token_de_org_suspensa", "10.9.9.9")).toMatchObject({ tipo: "falha", mcpCode: -32002, httpStatus: 403 });
    }
  });
```

  - `lib/api/auth-dual.test.ts`:

```ts
  it("token de org suspensa responde 403 org_suspended", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32002, 403, "Organization suspended.", "org_suspended"));
    const r = await resolveAuthDual(req({ authorization: "Bearer dsk_x_y" }), OPCOES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect((await r.response.json()).error.code).toBe("org_suspended");
    }
  });
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run lib/mcp/auth-resolve-api-token.test.ts lib/mcp/auth-teto-de-token.test.ts lib/api/auth-dual.test.ts` → token suspenso resolve / código `forbidden`.

- [ ] **Passo 3: implementar** — `lib/mcp/auth.ts`: `import { ehOperante } from "@/lib/organizacao/operante";`; `McpAuthError`:

```ts
export class McpAuthError extends Error {
  constructor(
    public readonly mcpCode: number,
    public readonly httpStatus: number,
    message: string,
    /** Código de `lib/api/errors.ts` quando a recusa tem nome próprio na API REST (ex.: `org_suspended`). */
    public readonly codigo?: string,
  ) {
    super(message);
    this.name = "McpAuthError";
  }
}
```

`ApiTokenError.reason`: `"malformed" | "not_found" | "revoked" | "expired" | "lookup_failed" | "org_suspended"`. Em `resolveApiToken`, o select vira `"id, organization_id, scopes, revoked_at, expires_at, created_by, organizations!inner(status)"` e, depois da checagem de `expires_at` e ANTES da atualização de `last_used_at`:

```ts
  // Token vivo de empresa parada: a integração não opera enquanto a conta está
  // suspensa (spec da cobrança §4 item 6). Antes do `last_used_at`: recusa não é uso.
  const orgDoToken = Array.isArray(data.organizations) ? data.organizations[0] : data.organizations;
  if (!ehOperante(orgDoToken?.status)) {
    throw new ApiTokenError("org_suspended", "Organization suspended.");
  }
```

Em `validateBearerToken`, no `catch`, antes de `if (err.reason !== "lookup_failed")`:

```ts
      if (err.reason === "org_suspended") {
        // Token VÁLIDO: nem chute nem token morto. Debitar o balde trancaria a
        // integração do cliente por minutos depois da reativação.
        throw new McpAuthError(-32002, 403, err.message, "org_suspended");
      }
```

Em `lib/api/auth-dual.ts` (hoje `:107`) e `app/api/v1/contacts/route.ts` (hoje `:69`), troque `err.httpStatus === 401 ? "unauthenticated" : "forbidden",` por:

```ts
            err.codigo ?? (err.httpStatus === 401 ? "unauthenticated" : "forbidden"),
```

- [ ] **Passo 4: ver passar:** o comando do passo 2 + `tests/unit/formato-do-token-de-servidor-bate-com-a-spec.test.ts app/api/v1/contacts/route.test.ts` + `pnpm typecheck` → verdes.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/mcp lib/api/auth-dual.ts lib/api/auth-dual.test.ts app/api/v1/contacts/route.ts
git commit -F - <<'FIM'
fix(mcp): token de empresa suspensa recebe 403 sem debitar o teto de falhas

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 18: Gate de elegibilidade — `orgStatus` obrigatório e primeiro veto

**Files:**
- Modify: `lib/ai/elegibilidade/gate.ts`, `lib/ai/elegibilidade/consulta-pg.ts`, `lib/ai/elegibilidade/consulta-supabase.ts`, `lib/followup/silence-sweep.ts`, `lib/agenda/meet-delivery.ts`
- Test: `lib/ai/elegibilidade/gate.test.ts`, `lib/ai/elegibilidade/consulta-supabase.test.ts`, `lib/agent-engine/edge/crm/drain.test.ts`, `lib/followup/silence-sweep-pre-go-live.test.ts`
- Fixtures: `lib/escalacao/atendimento-manual.test.ts`, `tests/unit/gate-volta-a-autorizacao-por-origem.test.ts`, `tests/unit/fronteira-exige-procedencia-e-o-backfill-cobre-o-legado.test.ts`, `tests/unit/ai-response-worker-elegibilidade.test.ts`, `tests/unit/ai-response-worker-model-routing.test.ts`, `tests/unit/agente-pausado-nao-atende.test.ts`, `tests/unit/orcamento-caminho-legado.test.ts`, `tests/unit/ai-response-worker-sent-via.test.ts`, `tests/unit/ai-response-bot-veto.test.ts`, `tests/unit/telemetria-diz-o-modelo-do-painel.test.ts`

**Interfaces**
- Consumes: `ehOperante`, `STATUS_OPERANTE` (Task 7); FK única `conversations_organization_id_fkey` (embed `organizations:organization_id(status)` não ambíguo). O alias é o NOME DA TABELA, como `contacts:contact_id(...)` e `channel_sessions:channel_session_id(...)` ao lado: é a convenção do repo, e `tests/pg-como-supabase.ts` (`:117-128`) traduz o alias em `from public."<alias>"` — um alias `org` faria qualquer invariante que passe por esses selects morrer com `relation "org" does not exist`.
- Produces: `EstadoDeElegibilidade.orgStatus: string | null` (obrigatório); `MotivoDeElegibilidade` ganha `"org_nao_operante"`; `montarEstadoDeElegibilidade(raw)` exige a chave `orgStatus: string | null | undefined`. `decidirElegibilidadeDaConversaViaSupabase` passa a devolver `org_nao_operante` para org parada (consumido pelo e2e, Task 34).

Montadores reais (medido com `grep -rn "montarEstadoDeElegibilidade(" app lib workers tests`): `consulta-pg.ts:54`, `consulta-supabase.ts:67`, `silence-sweep.ts:378`, `meet-delivery.ts:36` e, em teste, `tests/unit/gate-volta-a-autorizacao-por-origem.test.ts:81`. Literal de `EstadoDeElegibilidade`: `lib/escalacao/atendimento-manual.test.ts:62`. Reconfira antes de editar.

- [ ] **Passo 1: testes que falham — regra pura.** Em `lib/ai/elegibilidade/gate.test.ts`, o import passa a incluir `montarEstadoDeElegibilidade`:

```ts
import {
  AI_ALLOWLIST_TTL_DAYS_DEFAULT,
  decidirElegibilidade,
  lerModoDoGate,
  montarEstadoDeElegibilidade,
  ttlDaAutorizacaoMs,
  type EstadoDeElegibilidade,
} from "./gate";
```

o `base` ganha `orgStatus: "active",` como primeira chave:

```ts
const base: EstadoDeElegibilidade = {
  orgStatus: "active",
  modo: "open",
  forceHuman: false,
  botSilencedUntil: null,
  assigneeKind: "ai",
  aiAuthorizedAt: null,
  preGoLiveAtivo: false,
  numeroDeTesteAutorizado: false,
  agora: AGORA,
  ttlMs: 21 * DIA,
};
```

e no fim do arquivo:

```ts
describe("decidirElegibilidade — organização não operante vence tudo", () => {
  it.each(["suspended", "redacted", "archived", "status_que_ainda_nao_existe", null])(
    "orgStatus %s → nega com org_nao_operante, antes de force_human, silêncio, dono humano e allowlist",
    (orgStatus) => {
      const d = decidirElegibilidade({
        ...base,
        orgStatus,
        modo: "allowlist",
        forceHuman: true,
        botSilencedUntil: new Date(AGORA.getTime() + DIA),
        assigneeKind: "user",
        aiAuthorizedAt: AGORA,
      });
      expect(d).toEqual({ permite: false, motivo: "org_nao_operante", bloqueioPorAllowlist: false });
    },
  );

  it("org active não muda nada (controle): gate aberto segue permitindo", () => {
    expect(decidirElegibilidade({ ...base, orgStatus: "active" }).motivo).toBe("gate_aberto");
  });
});

describe("montarEstadoDeElegibilidade — a org viaja", () => {
  it("orgStatus ausente vira null, e null é não operante (falha fechada)", () => {
    const e = montarEstadoDeElegibilidade({
      aiGate: null,
      forceHuman: false,
      assigneeKind: null,
      botSilencedUntil: null,
      aiAuthorizedAt: null,
      orgStatus: undefined,
      agora: AGORA,
      ttlMs: DIA,
    });
    expect(e.orgStatus).toBeNull();
    expect(decidirElegibilidade(e).motivo).toBe("org_nao_operante");
  });
});
```

(Se o `base` atual tem campos além destes, mantenha-os; o que muda é só a chave `orgStatus` nova. Se `montarEstadoDeElegibilidade` exige outras chaves no `raw` hoje, acrescente-as ao literal do último caso com o valor neutro que `tests/unit/gate-volta-a-autorizacao-por-origem.test.ts:81` usa.)

- [ ] **Passo 2: testes que falham — transportes.**

`lib/ai/elegibilidade/consulta-supabase.test.ts` — em `linha()`, acrescente `organizations: { status: "active" },` depois de `channel_sessions: { metadata: {} },`, e antes de `it("conversa inexistente → null"`:

```ts
  it("org suspensa: NÃO permite, com org_nao_operante", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({ data: linha({ organizations: { status: "suspended" } }), error: null }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    expect(d).toEqual({ permite: false, motivo: "org_nao_operante", bloqueioPorAllowlist: false });
  });

  it("embed da org ausente: NÃO permite (falha fechada)", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({ data: linha({ organizations: null }), error: null }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    expect(d?.motivo).toBe("org_nao_operante");
  });
```

`lib/agent-engine/edge/crm/drain.test.ts` — em `poolElegibilidade`, acrescente `orgStatus?: string | null;` ao tipo de `opts` e, na linha devolvida para `channel_metadata`, `org_status: opts.orgStatus === undefined ? 'active' : opts.orgStatus,` depois de `phone_number: opts.phoneNumber ?? null,`. E:

```ts
it('gate: organização não operante na leitura de elegibilidade → turno pulado, sem job', async () => {
  const calls: string[] = [];
  await drainTick(poolElegibilidade(calls, { orgStatus: 'suspended' }), knobs, log);
  const consulta = calls.find((s) => s.includes('channel_metadata'));
  expect(consulta, 'a consulta de elegibilidade não rodou').toBeDefined();
  expect(consulta).toMatch(/join organizations o on o\.id = cv\.organization_id/);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
});
```

`lib/followup/silence-sweep-pre-go-live.test.ts` — em `conversa()`, acrescente `organizations: { status: "active" },` depois de `sessao: { metadata },`; no `describe`:

```ts
  it("org não operante: nenhum candidato, nem o número de teste", async () => {
    const parada = { ...conversa("tester", "+5585987654321"), organizations: { status: "suspended" } };
    const db = createSupabaseSilenceSweepDb(supabaseComConversas([parada]));
    await expect(db.loadSilentContactIds("org", "2026-09-02T10:00:00.000Z", [])).resolves.toEqual([]);
  });
```

- [ ] **Passo 3: rodar e ver falhar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run lib/ai/elegibilidade/gate.test.ts lib/ai/elegibilidade/consulta-supabase.test.ts lib/agent-engine/edge/crm/drain.test.ts lib/followup/silence-sweep-pre-go-live.test.ts
```

Esperado: FAIL — motivo `force_human` em vez de `org_nao_operante`; `org suspensa` recebe `gate_aberto`; o caso do drain encontra `insert into job_queue`; o do sweep devolve `["tester"]`.

- [ ] **Passo 4: implementar a regra** — `lib/ai/elegibilidade/gate.ts`: import (logo abaixo do de `./pre-go-live`):

```ts
import { ehOperante } from "@/lib/organizacao/operante";
```

Primeiro campo de `EstadoDeElegibilidade`:

```ts
  /**
   * `organizations.status` da conversa. Organização não operante (suspensa,
   * redigida, arquivada ou status que ainda não existe) vence todos os vetos —
   * a régua é única, `lib/organizacao/operante.ts`. Obrigatório de propósito:
   * montador novo que esquecer a organização não compila.
   */
  orgStatus: string | null;
```

`MotivoDeElegibilidade` ganha `| "org_nao_operante"` como primeiro membro. Início de `decidirElegibilidade`:

```ts
export function decidirElegibilidade(e: EstadoDeElegibilidade): DecisaoDeElegibilidade {
  if (!ehOperante(e.orgStatus)) {
    return { permite: false, motivo: "org_nao_operante", bloqueioPorAllowlist: false };
  }
```

(o `if (e.forceHuman) {` que vinha como primeira linha continua logo abaixo). Em `montarEstadoDeElegibilidade`, no tipo de `raw` (depois de `aiGate: unknown;`):

```ts
  /** `organizations.status`; obrigatório como CHAVE — quem monta tem de dizer de onde leu. */
  orgStatus: string | null | undefined;
```

e no objeto devolvido, primeira propriedade `orgStatus: raw.orgStatus ?? null,`.

- [ ] **Passo 5: os quatro montadores.**

`lib/ai/elegibilidade/consulta-pg.ts` — `LinhaDeElegibilidade` ganha `org_status: string | null;`; a query:

```ts
    `select
       cs.metadata                  as channel_metadata,
       ct.force_human               as force_human,
       cv.assignee_kind             as assignee_kind,
       cv.bot_silenced_until        as bot_silenced_until,
       ct.ai_authorized_at          as ai_authorized_at,
       ct.phone_number              as phone_number,
       o.status                     as org_status
     from conversations cv
     join organizations o on o.id = cv.organization_id
     join contacts ct
       on ct.id = cv.contact_id and ct.organization_id = cv.organization_id
     join channel_sessions cs
       on cs.id = cv.channel_session_id and cs.organization_id = cv.organization_id
     where cv.organization_id = $1 and cv.id = $2`,
```

e o `montarEstadoDeElegibilidade({` ganha `orgStatus: r.org_status,` como primeira chave. (Se a query atual tem colunas além dessas, mantenha-as; o delta é `o.status as org_status` + o `join organizations`.)

`lib/ai/elegibilidade/consulta-supabase.ts` — `ConversaEmbed` ganha `organizations: { status: string | null } | null;`; o select:

```ts
      "bot_silenced_until, assignee_kind, organizations:organization_id(status), contacts:contact_id(force_human, ai_authorized_at, phone_number), channel_sessions:channel_session_id(metadata)",
```

(mesma sintaxe de dica de FK que `contacts:contact_id(...)` já usa). No montar, primeira chave `orgStatus: row.organizations?.status ?? null,`.

`lib/followup/silence-sweep.ts` — no select de `loadSilentContactIds` (hoje `~:337`), acrescente `, organizations:organization_id(status)` ao fim da string (depois de `sessao:channel_session_id(metadata)`); no `type Row`, `organizations: { status: string | null } | null;`; no `montarEstadoDeElegibilidade({` (hoje `~:378`), primeira chave `orgStatus: row.organizations?.status ?? null,`.

`lib/agenda/meet-delivery.ts` — imports:

```ts
import { decidirElegibilidade, montarEstadoDeElegibilidade, ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { STATUS_OPERANTE } from "@/lib/organizacao/operante";
```

e no montar de `requirePolicy`, primeira chave:

```ts
    // `current: true` só sai de `fn_meet_delivery_current`, que já exige a
    // organização operante (join organizations status='active'): quando a
    // política chega aqui, a org ESTAVA operante na mesma leitura.
    orgStatus: STATUS_OPERANTE,
```

(Garantia medida em `d03c2b2fd`: o corpo de `fn_meet_delivery_current` no `baseline.sql` tem `join public.organizations o on o.id=a.organization_id and o.status='active'` nas duas consultas que decidem `current`. Se a main mudar isso, a constante deixa de valer: leia `organizations.status` na mesma consulta de `requirePolicy`.)

- [ ] **Passo 6: fixtures que precisam dizer a org.**
  - `lib/escalacao/atendimento-manual.test.ts:62` — no literal de `decidirElegibilidade({`, primeira chave `orgStatus: "active",`.
  - `tests/unit/gate-volta-a-autorizacao-por-origem.test.ts:81` — no `montarEstadoDeElegibilidade({`, primeira chave `orgStatus: "active",`.
  - `tests/unit/fronteira-exige-procedencia-e-o-backfill-cobre-o-legado.test.ts` — em `conversaLegada`, depois de `sessao: { metadata },`, `organizations: { status: "active" },`.
  - Nos 7 testes do worker legado, na linha de `conversations` (o objeto com `last_inbound_at`), `organizations: { status: "active" },` logo depois de `assignee_kind: …,`: `tests/unit/ai-response-worker-elegibilidade.test.ts` (`convRow`), `tests/unit/ai-response-worker-model-routing.test.ts` (hoje `:87`), `tests/unit/agente-pausado-nao-atende.test.ts` (`:89`), `tests/unit/orcamento-caminho-legado.test.ts` (`:129`), `tests/unit/ai-response-worker-sent-via.test.ts` (`:121`), `tests/unit/ai-response-bot-veto.test.ts` (`convRow`), `tests/unit/telemetria-diz-o-modelo-do-painel.test.ts` (`:82`).

- [ ] **Passo 7: rodar e ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run lib/ai/elegibilidade lib/agent-engine/edge/crm/drain.test.ts lib/followup lib/escalacao/atendimento-manual.test.ts tests/unit/gate-volta-a-autorizacao-por-origem.test.ts tests/unit/fronteira-exige-procedencia-e-o-backfill-cobre-o-legado.test.ts tests/unit/ai-response-worker-elegibilidade.test.ts tests/unit/ai-response-worker-model-routing.test.ts tests/unit/agente-pausado-nao-atende.test.ts tests/unit/orcamento-caminho-legado.test.ts tests/unit/ai-response-worker-sent-via.test.ts tests/unit/ai-response-bot-veto.test.ts tests/unit/telemetria-diz-o-modelo-do-painel.test.ts
pnpm typecheck
```

Esperado: todos `passed`; `tsc` limpo (montador esquecido = `Property 'orgStatus' is missing`).

- [ ] **Passo 8: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/ai/elegibilidade lib/followup/silence-sweep.ts lib/followup/silence-sweep-pre-go-live.test.ts lib/agenda/meet-delivery.ts lib/agent-engine/edge/crm/drain.test.ts lib/escalacao/atendimento-manual.test.ts tests/unit/gate-volta-a-autorizacao-por-origem.test.ts tests/unit/fronteira-exige-procedencia-e-o-backfill-cobre-o-legado.test.ts tests/unit/ai-response-worker-elegibilidade.test.ts tests/unit/ai-response-worker-model-routing.test.ts tests/unit/agente-pausado-nao-atende.test.ts tests/unit/orcamento-caminho-legado.test.ts tests/unit/ai-response-worker-sent-via.test.ts tests/unit/ai-response-bot-veto.test.ts tests/unit/telemetria-diz-o-modelo-do-painel.test.ts
git commit -F - <<'FIM'
fix(ia): organização parada é o primeiro veto do gate de elegibilidade

orgStatus vira campo obrigatório do estado; os quatro montadores leem a org
na mesma consulta (pg, supabase-js, varredura de silêncio) e o de reunião
herda a garantia de fn_meet_delivery_current.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 19: Barramento — `naOrgParada` obrigatório; dreno lê o status do lote

**Files:**
- Modify: `lib/event-log/dispatcher.ts`, `lib/event-log/drain.ts`, os 23 handlers (Passo 4), `tests/invariants/event-log-drain.test.ts`
- Create: `tests/unit/dispatcher-org-parada.test.ts`

**Interfaces**
- Consumes: `ehOperante` (Task 7).
- Produces: `EventHandler.naOrgParada: "roda" | "pula"` (obrigatório); `dispatchEvent(row: EventRow, opts: { orgParada: boolean }): Promise<HandlerResult[]>`; `export const DETALHE_DA_ORG_PARADA = "org_nao_operante"`. Registrados hoje: 23 (`grep -c "registerHandler(" lib/event-log/register-handlers.ts` → `23`).

- [ ] **Passo 1: teste que falha** — `tests/unit/dispatcher-org-parada.test.ts`:

```ts
/**
 * ORGANIZAÇÃO PARADA NÃO GASTA NEM FALA — pelo barramento de eventos.
 *
 * Todo consumidor do `event_log` declara o que faz quando a organização do
 * evento não está operante (`lib/organizacao/operante.ts`):
 *
 *   "roda" — escrita interna, LGPD ou entrada: segue normal;
 *   "pula" — custa dinheiro ou sai para fora: vira `skipped` com
 *            `org_nao_operante`, entra em `consumed_by` e NÃO volta na
 *            reativação (reativação é sem rajada, spec §1.3).
 *
 * O campo é obrigatório no tipo: handler novo sem classificação não compila.
 * A lista literal abaixo é a segunda metade — ela reprova quem registrar um
 * handler sem passar por aqui.
 */
import { describe, expect, it, vi } from "vitest";

import {
  dispatchEvent,
  getRegisteredHandlers,
  registerHandler,
  type EventHandler,
  type EventRow,
} from "@/lib/event-log/dispatcher";
import { drainEventLog } from "@/lib/event-log/drain";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { automationRulesHandler } from "@/lib/automation/engine.handler";
import { campanhaRespostaHandler } from "@/lib/campanhas/resposta.handler";
import { conversaoDeVendaHandler } from "@/lib/conversoes/envio.handler";
import { conversaoDeQualificacaoHandler } from "@/lib/conversoes/qualificacao.handler";
import { avisoDeCasoAoSuporteHandler } from "@/lib/escalacao/aviso-ao-suporte.handler";
import { casoNaCentralHandler } from "@/lib/escalacao/caso-na-central.handler";
import { followupGatilhoCasoHandler } from "@/lib/followup/gatilho-caso.handler";
import { followupGatilhoEtapaHandler } from "@/lib/followup/gatilho-etapa.handler";
import { followupGatilhoLeadHandler } from "@/lib/followup/gatilho-lead.handler";
import { followupGatilhoPresencaHandler } from "@/lib/followup/gatilho-presenca.handler";
import { followupGatilhoRetornoHandler } from "@/lib/followup/gatilho-retorno.handler";
import { followupReactivityHandler } from "@/lib/followup/reactivity.handler";
import { avisoDeEtapaHandler } from "@/lib/leads/aviso-de-etapa.handler";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import { avisoDePropostaNoWhatsAppHandler } from "@/lib/propostas/aviso-no-whatsapp.handler";
import { aiHandoffFromSentimentHandler } from "@/workers/ai-handoff-from-sentiment.handler";
import { aiResponseHandler } from "@/workers/ai-response-worker.handler";
import { aiSentimentHandler } from "@/workers/ai-sentiment-worker.handler";
import { lgpdExportHandler } from "@/workers/lgpd-export-worker.handler";
import { lgpdRedactHandler } from "@/workers/lgpd-redact-worker.handler";
import { mediaDeriveHandler } from "@/workers/media-derive-worker.handler";
import { mediaPersistHandler } from "@/workers/media-persist-worker.handler";
import { ragIndexerHandler } from "@/workers/rag-indexer.handler";

const RODA: EventHandler[] = [
  followupReactivityHandler,
  campanhaRespostaHandler,
  avisoDeEtapaHandler,
  casoNaCentralHandler,
  mediaPersistHandler,
  lgpdExportHandler,
  lgpdRedactHandler,
];

const PULA: EventHandler[] = [
  aiResponseHandler,
  aiSentimentHandler,
  aiHandoffFromSentimentHandler,
  ragIndexerHandler,
  mediaDeriveHandler,
  automationRulesHandler,
  followupGatilhoRetornoHandler,
  followupGatilhoEtapaHandler,
  followupGatilhoLeadHandler,
  followupGatilhoCasoHandler,
  followupGatilhoPresencaHandler,
  webPushInboundHandler,
  avisoDeCasoAoSuporteHandler,
  avisoDePropostaNoWhatsAppHandler,
  conversaoDeVendaHandler,
  conversaoDeQualificacaoHandler,
];

const PREFIXO_DE_TESTE = "teste-org-parada";
const EVENTO_DE_TESTE = "teste.org_parada";
const handleRoda = vi.fn(async () => ({ consumer_key: `${PREFIXO_DE_TESTE}-roda`, status: "ok" as const }));
const handlePula = vi.fn(async () => ({ consumer_key: `${PREFIXO_DE_TESTE}-pula`, status: "ok" as const }));
registerHandler({ key: `${PREFIXO_DE_TESTE}-roda`, events: [EVENTO_DE_TESTE], naOrgParada: "roda", handle: handleRoda });
registerHandler({ key: `${PREFIXO_DE_TESTE}-pula`, events: [EVENTO_DE_TESTE], naOrgParada: "pula", handle: handlePula });

function linha(): EventRow {
  return {
    id: "ev-1",
    organization_id: "org-1",
    event_type: EVENTO_DE_TESTE,
    entity_kind: "teste",
    entity_id: null,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date().toISOString(),
  };
}

type Resposta = { data: unknown; error: { message: string } | null };

/** Dublê do supabase-js: responde ao que o dreno pede e registra os updates do `event_log`. */
function dublarAdmin(opts: {
  linhas: EventRow[];
  orgs: Array<{ id: string; status: string }> | { erro: string };
}) {
  const updates: Array<{ tabela: string; payload: Record<string, unknown> }> = [];
  const from = (tabela: string) => {
    let ehUpdate = false;
    let pedeProcessing = false;
    const q: Record<string, unknown> = {
      select: () => q,
      update: (payload: Record<string, unknown>) => {
        ehUpdate = true;
        updates.push({ tabela, payload });
        return q;
      },
      eq: (coluna: string, valor: unknown) => {
        if (coluna === "status" && valor === "processing") pedeProcessing = true;
        return q;
      },
      lt: () => q,
      or: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      then: (resolve: (r: Resposta) => unknown) => {
        if (ehUpdate) return resolve({ data: [{ id: "ev-1" }], error: null });
        if (tabela === "organizations") {
          return resolve(
            "erro" in opts.orgs
              ? { data: null, error: { message: opts.orgs.erro } }
              : { data: opts.orgs, error: null },
          );
        }
        if (tabela === "event_log") return resolve({ data: pedeProcessing ? [] : opts.linhas, error: null });
        return resolve({ data: null, error: null });
      },
    };
    return q;
  };
  return { admin: { from } as never, updates };
}

describe("classificação literal dos handlers registrados", () => {
  it.each(RODA.map((h) => [h.key, h] as const))("%s roda na org parada", (_chave, h) => {
    expect(h.naOrgParada).toBe("roda");
  });

  it.each(PULA.map((h) => [h.key, h] as const))("%s pula na org parada", (_chave, h) => {
    expect(h.naOrgParada).toBe("pula");
  });

  it("a lista literal cobre EXATAMENTE o registro de produção — handler novo tem de entrar aqui", () => {
    ensureHandlersRegistered();
    const registrados = getRegisteredHandlers()
      .map((h) => h.key)
      .filter((k) => !k.startsWith(PREFIXO_DE_TESTE))
      .sort();
    expect(registrados).toEqual([...RODA, ...PULA].map((h) => h.key).sort());
  });
});

describe("dispatchEvent × org parada", () => {
  it("org parada: 'pula' vira skipped/org_nao_operante SEM rodar; 'roda' roda", async () => {
    handleRoda.mockClear();
    handlePula.mockClear();
    const r = await dispatchEvent(linha(), { orgParada: true });
    expect(handlePula).not.toHaveBeenCalled();
    expect(handleRoda).toHaveBeenCalledOnce();
    expect(r).toContainEqual({
      consumer_key: `${PREFIXO_DE_TESTE}-pula`,
      status: "skipped",
      detail: "org_nao_operante",
    });
  });

  it("org operante: os dois rodam (controle)", async () => {
    handleRoda.mockClear();
    handlePula.mockClear();
    await dispatchEvent(linha(), { orgParada: false });
    expect(handlePula).toHaveBeenCalledOnce();
    expect(handleRoda).toHaveBeenCalledOnce();
  });
});

describe("drainEventLog lê o status das orgs do lote", () => {
  it("org parada: o 'pula' entra em consumed_by e o evento fecha done — não volta na reativação", async () => {
    handlePula.mockClear();
    const { admin, updates } = dublarAdmin({ linhas: [linha()], orgs: [{ id: "org-1", status: "suspended" }] });
    const resumo = await drainEventLog(admin);
    const fim = updates.filter((u) => u.tabela === "event_log").pop()!.payload;
    expect(fim.status).toBe("done");
    expect(fim.consumed_by).toEqual(
      expect.arrayContaining([`${PREFIXO_DE_TESTE}-pula`, `${PREFIXO_DE_TESTE}-roda`]),
    );
    expect(String(fim.last_error)).toContain(`${PREFIXO_DE_TESTE}-pula: org_nao_operante`);
    expect(handlePula).not.toHaveBeenCalled();
    expect(resumo.pulados).toContain(`${EVENTO_DE_TESTE}/${PREFIXO_DE_TESTE}-pula: org_nao_operante`);
  });

  it("org que não volta da leitura conta como parada (falha fechada)", async () => {
    handlePula.mockClear();
    const { admin } = dublarAdmin({ linhas: [linha()], orgs: [] });
    await drainEventLog(admin);
    expect(handlePula).not.toHaveBeenCalled();
  });

  it("leitura do status falha: nada é reclamado, o lote espera o próximo tique", async () => {
    handlePula.mockClear();
    handleRoda.mockClear();
    const { admin, updates } = dublarAdmin({ linhas: [linha()], orgs: { erro: "connection reset" } });
    await drainEventLog(admin);
    expect(updates.some((u) => u.payload.status === "processing")).toBe(false);
    expect(handlePula).not.toHaveBeenCalled();
    expect(handleRoda).not.toHaveBeenCalled();
  });
});
```

(Medido em `d03c2b2fd`: o dreno registra cada `skipped` com `detail` em `summary.pulados` no formato `` `${row.event_type}/${r.consumer_key}: ${r.detail}` `` (`lib/event-log/drain.ts:354-355`) e em `last_error` como `` `${r.consumer_key}: ${r.detail}` `` (`:364`) — as asserções acima usam exatamente esses formatos. Os nomes de export dos handlers vêm de `grep -n "export const .*: EventHandler" <arquivo>` no passo 4.)

- [ ] **Passo 2: rodar e ver falhar:** `pnpm exec vitest run tests/unit/dispatcher-org-parada.test.ts` → FAIL (`expected undefined to be 'roda'` nos 23; o `pula` é chamado; o dreno não pede `organizations`).

- [ ] **Passo 3: dispatcher** — em `lib/event-log/dispatcher.ts`, antes de `export interface EventHandler`:

```ts
/** `detail` do `skipped` de um handler "pula" numa organização parada. */
export const DETALHE_DA_ORG_PARADA = "org_nao_operante";
```

em `EventHandler`, depois de `events: string[];`:

```ts
  /**
   * O que fazer quando a organização do evento NÃO está operante
   * (`lib/organizacao/operante.ts`). Obrigatório: handler novo sem classificação
   * não compila, e `tests/unit/dispatcher-org-parada.test.ts` guarda a lista.
   *
   *   "roda" — escrita interna, LGPD ou entrada: segue normal.
   *   "pula" — custa dinheiro ou sai para fora: `skipped` com
   *            `org_nao_operante`, vai para `consumed_by` e NÃO volta na
   *            reativação (reativação é sem rajada, spec §1.3).
   */
  naOrgParada: "roda" | "pula";
```

e `dispatchEvent` passa a:

```ts
export async function dispatchEvent(
  row: EventRow,
  opts: { orgParada: boolean },
): Promise<HandlerResult[]> {
  const matches = _handlers.filter(
    (h) => h.events.includes(row.event_type) && !row.consumed_by.includes(h.key),
  );
  if (!matches.length) return [];

  const results: HandlerResult[] = [];
  for (const handler of matches) {
    if (opts.orgParada && handler.naOrgParada === "pula") {
      results.push({ consumer_key: handler.key, status: "skipped", detail: DETALHE_DA_ORG_PARADA });
      continue;
    }
    try {
```

(o resto do laço fica como está). Em `d03c2b2fd` o único chamador de `dispatchEvent` do barramento é `lib/event-log/drain.ts:284` (o resto do `grep -rn "dispatchEvent(" app lib workers tests` é `document`/`window.dispatchEvent` do DOM), e ele é tratado no passo 5.

- [ ] **Passo 4: classificar os 23 handlers** — em cada arquivo, a linha logo abaixo da linha `key:` do objeto `: EventHandler = {`:
  - `naOrgParada: "roda",` em: `lib/followup/reactivity.handler.ts`, `lib/campanhas/resposta.handler.ts`, `lib/leads/aviso-de-etapa.handler.ts`, `lib/escalacao/caso-na-central.handler.ts`, `workers/media-persist-worker.handler.ts`, `workers/lgpd-export-worker.handler.ts`, `workers/lgpd-redact-worker.handler.ts`.
  - `naOrgParada: "pula",` em: `workers/ai-response-worker.handler.ts`, `workers/ai-sentiment-worker.handler.ts`, `workers/ai-handoff-from-sentiment.handler.ts`, `workers/rag-indexer.handler.ts`, `workers/media-derive-worker.handler.ts`, `lib/automation/engine.handler.ts`, `lib/followup/gatilho-retorno.handler.ts`, `lib/followup/gatilho-etapa.handler.ts`, `lib/followup/gatilho-lead.handler.ts`, `lib/followup/gatilho-caso.handler.ts`, `lib/followup/gatilho-presenca.handler.ts`, `lib/notifications/push.handler.ts`, `lib/escalacao/aviso-ao-suporte.handler.ts`, `lib/propostas/aviso-no-whatsapp.handler.ts`, `lib/conversoes/envio.handler.ts`, `lib/conversoes/qualificacao.handler.ts`.

  Formato (igual nos 23):

```ts
export const aiResponseHandler: EventHandler = {
  key: AI_RESPONSE_HANDLER_KEY,
  naOrgParada: "pula",
  events: ["message.received"],
```

  Em `tests/invariants/event-log-drain.test.ts`, os quatro `registerHandler({` (chaves `test-drain-handler`, `test-drain-multi-err`, `test-drain-multi-retry`, `test-drain-retry-no-backoff`) ganham `naOrgParada: "roda",` logo abaixo de `key:`. Qualquer outro `registerHandler(` em teste (`grep -rn "registerHandler({" tests lib | grep -v register-handlers.ts`) também.

- [ ] **Passo 5: o dreno lê o status do lote** — em `lib/event-log/drain.ts`, `import { ehOperante } from "@/lib/organizacao/operante";`, e o trecho do `if (error) { … }` do select de `pending` até `const results = await dispatchEvent(row);` (hoje a partir de `~:250`) passa a:

```ts
  if (error) {
    logger.error("[event-log.drain] select failed", { error: error.message });

    return summary;
  }

  // ─── ORGANIZAÇÃO PARADA ────────────────────────────────────────────────────
  //
  // Uma consulta por lote, `in (...)`, ANTES de reclamar qualquer linha. Org
  // que não volta da leitura conta como parada (falha fechada). Se a LEITURA
  // falha, o lote inteiro espera o próximo tique: consumir às cegas marcaria
  // `skipped` para sempre o handler "pula" de uma org operante.
  const orgIds = [...new Set((rows ?? []).map((r) => (r as { organization_id: string }).organization_id))];
  const parados = new Set<string>();
  if (orgIds.length) {
    const { data: orgs, error: orgErr } = await admin
      .from("organizations")
      .select("id, status")
      .in("id", orgIds);
    if (orgErr) {
      logger.error("[event-log.drain] status das organizações indisponível — lote adiado", {
        error: orgErr.message,
      });
      return summary;
    }
    const operantes = new Set(
      ((orgs ?? []) as Array<{ id: string; status: string | null }>)
        .filter((o) => ehOperante(o.status))
        .map((o) => o.id),
    );
    for (const id of orgIds) if (!operantes.has(id)) parados.add(id);
  }

  for (const raw of rows ?? []) {
    const row = raw as unknown as EventRow;
    summary.scanned += 1;

    // Claim otimista — outra instância pode ter pego a mesma linha.
    const { data: claimed } = await admin
      .from("event_log")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed?.length) continue;

    const results = await dispatchEvent(row, { orgParada: parados.has(row.organization_id) });
```

(Preserve o que o arquivo atual já faz entre o `select` e o `dispatchEvent` — ex.: outras guardas; o delta é o bloco de `orgIds`/`parados` e o 2º argumento de `dispatchEvent`.)

- [ ] **Passo 6: rodar e ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run tests/unit/dispatcher-org-parada.test.ts tests/unit/dreno-nao-perde-evento.test.ts tests/unit/evento-de-fato-nao-fica-pendente.test.ts tests/unit/evento-comando-tem-consumidor.test.ts tests/unit/event-log-drain-loop.test.ts tests/unit/drain-loop-carrega-deps-sob-tsx.test.ts
pnpm typecheck
# O dreno com a leitura de status do lote, no Postgres real (a consulta nova a
# `organizations` roda com o papel de verdade — o dublê não mede isso):
pnpm test:db tests/invariants/event-log-drain.test.ts > /tmp/t19-db.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t19-db.log | tail -2
```

Esperado: todos `passed`; `tsc` limpo (handler sem classificação = `Property 'naOrgParada' is missing`); test:db `exit=0`, `Test Files  1 passed (1)`.

- [ ] **Passo 7: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/event-log workers lib/followup lib/campanhas/resposta.handler.ts lib/leads/aviso-de-etapa.handler.ts lib/escalacao lib/automation/engine.handler.ts lib/notifications/push.handler.ts lib/propostas/aviso-no-whatsapp.handler.ts lib/conversoes tests/invariants/event-log-drain.test.ts tests/unit/dispatcher-org-parada.test.ts
git status --short   # confira que só entrou o que esta tarefa tocou
git commit -F - <<'FIM'
fix(eventos): handler declara o que faz na organização parada

naOrgParada obrigatório no EventHandler; o dreno lê o status das orgs do
lote numa consulta só e o dispatcher consome como skipped quem custa ou
sai para fora. Leitura que falha adia o lote em vez de consumir às cegas.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 20: Dreno do agent-engine — mensagem de org parada não vira job

**Files:** Modify `lib/agent-engine/edge/crm/drain.ts` (bloco do modo externo, hoje `:219-226`); Test `lib/agent-engine/edge/crm/drain.test.ts`.

**Interfaces** — Consumes: `ehOperante` (Task 7). Produces: nada novo (desfecho `'processado'`, evento `done` sem job).

- [ ] **Passo 1: teste que falha** — em `lib/agent-engine/edge/crm/drain.test.ts`, as respostas do `ai_dispatch_mode` passam a trazer o status: `grep -n "ai_dispatch_mode" lib/agent-engine/edge/crm/drain.test.ts` (hoje `:25`, `:58`, `:217`, `:302`); na de `:25` `{ rows: [{ mode: 'external', status: 'active' }] }`, nas demais `{ rows: [{ mode: null, status: 'active' }] }`. Depois do primeiro `it`:

```ts
it('org não operante: evento vira done SEM job, antes de qualquer outra consulta', async () => {
  const calls: string[] = [];
  const query = vi.fn().mockImplementation((sql: string) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [event] };
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null, status: 'suspended' }] };
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    if (sql.includes('tem_agente')) return { rows: [{ tem_agente: true, tem_roteador: false }] };
    return { rows: [] };
  });
  await drainTick({ query } as unknown as pg.Pool, knobs, log);
  expect(calls.find((s) => s.includes('ai_dispatch_mode'))).toMatch(/\bstatus\b/);
  expect(calls.some((s) => s.includes('is_group')), 'parou antes de ler a conversa').toBe(false);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run lib/agent-engine/edge/crm/drain.test.ts` → FAIL no caso novo (a consulta não seleciona `status`; `is_group` roda).

- [ ] **Passo 3: implementar** — import `import { ehOperante } from '@/lib/organizacao/operante';` junto dos outros `@/`, e o bloco do modo externo passa a:

```ts
  // Organização parada (suspensa, redigida, arquivada) não gera turno: o evento
  // é consumido sem job. Vai na MESMA consulta do modo externo — uma ida ao banco
  // por evento, não duas — e vem ANTES do `canAssist`, que desliga o gate.
  const { rows: modeRows } = await pool.query<{ mode: string | null; status: string | null }>(
    `select settings->>'ai_dispatch_mode' as mode, status from organizations where id = $1`,
    [event.organization_id],
  );
  if (!ehOperante(modeRows[0]?.status)) {
    log.info('drain: organização não operante — evento consumido sem job', { event_id: event.id });
    return 'processado';
  }
  // Spec 14: org em modo 'external' tem agente EXTERNO como dono da conversa —
  // o engine não responde por cima. Evento é consumido (done) sem job.
  if (modeRows[0]?.mode === 'external') {
    log.info('drain: org em modo external (spec 14) — evento pulado', { event_id: event.id });
    return 'processado';
  }
```

- [ ] **Passo 4: ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run lib/agent-engine/edge/crm/drain.test.ts tests/unit/despacho-da-ia-que-morre-avisa-a-central.test.ts
# `processEvent` com a consulta nova (`status` junto do modo), no Postgres real:
pnpm test:db tests/invariants/evento-morto-nao-inunda-a-central.test.ts tests/invariants/portao-de-capacidade-mede-quem-executa.test.ts \
  tests/invariants/resposta-descartada-tem-quem-responda.test.ts tests/invariants/agent-dispatch-single-consumer.test.ts \
  tests/invariants/aviso-da-ia-nao-some-atras-de-outro-evento-morto.test.ts > /tmp/t20-db.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t20-db.log | tail -2
```

Esperado: vitest `passed`; test:db `exit=0`, `Test Files  5 passed (5)` (são os invariantes que exercitam `drainTick`/`processEvent` em `d03c2b2fd`; as orgs que eles semeiam nascem `active`, então nenhum muda de desfecho).

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/agent-engine/edge/crm/drain.ts lib/agent-engine/edge/crm/drain.test.ts
git commit -F - <<'FIM'
fix(agent-engine): mensagem de organização parada não vira turno

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 21: Agendador — `fireOneDue` avança sem enfileirar (unit + invariante no Postgres real)

**Files:** Modify `lib/agent-engine/cron/scheduler.ts` (`CronTickResult`, `fireOneDue`, `tickCron`, `runCronLoop`); Create `lib/agent-engine/cron/scheduler.test.ts`, `tests/invariants/cron-org-parada.test.ts`.

**Interfaces**
- Consumes: SQL `public.fn_org_operante(uuid)` (Task 1; EXECUTE só `service_role`, o pool do worker conecta como dono `postgres`); `computeNextRunAt`, `specFromRow` (já no arquivo).
- Produces: `CronTickResult.skipped: number`; `fireOneDue` devolve também `'skipped'`; cron de org parada grava `last_error='org_nao_operante'`, avança `next_run_at` (recorrente) ou `enabled=false` (one-shot).

- [ ] **Passo 1: teste unitário que falha** — `lib/agent-engine/cron/scheduler.test.ts`:

```ts
/**
 * O AGENDADOR NÃO DISPARA FOLLOW-UP DE ORGANIZAÇÃO PARADA.
 *
 * O cron vencido da org suspensa/redigida/arquivada avança sem enfileirar job,
 * e o one-shot se encerra. Reativar não devolve o que venceu parado: a
 * reativação é sem rajada (spec §1.3).
 */
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { tickCron } from './scheduler';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const AGORA = Date.parse('2026-09-29T12:00:00Z');
const HORA = 3_600_000;
const cfg = { batchSize: 1, staggerWindowMs: 0, retryBaseMs: 1000, now: () => AGORA };

function cron(over: Record<string, unknown>) {
  return {
    id: 'cron-1', organization_id: 'org-1', contact_id: 'contato-1', kind: 'every',
    interval_ms: String(HORA), cron_expr: null, tz: 'UTC', job_kind: 'followup_turn', payload: {},
    next_run_at: new Date(AGORA - 1000), enabled: true, attempts: 0, max_attempts: 5,
    last_error: null, created_at: new Date(AGORA), updated_at: new Date(AGORA), operante: false,
    ...over,
  };
}

function poolCom(linha: Record<string, unknown>) {
  const sqls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql, params });
      if (sql.includes('fn_org_operante')) return { rows: [linha] };
      if (sql.includes('insert into job_queue')) return { rows: [{ id: 'job-1' }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, sqls };
}

describe('fireOneDue × organização parada', () => {
  it('recorrente: avança next_run_at, NÃO enfileira, e conta como skipped', async () => {
    const { pool, sqls } = poolCom(cron({}));
    const r = await tickCron(pool, cfg, log);
    expect(sqls.some((s) => s.sql.includes('insert into job_queue'))).toBe(false);
    const reagenda = sqls.find((s) => s.sql.startsWith('update cron_jobs set next_run_at'));
    expect(reagenda?.params).toEqual(['cron-1', new Date(AGORA - 1000 + HORA)]);
    expect(reagenda?.sql).toContain("last_error = 'org_nao_operante'");
    expect(sqls.some((s) => s.sql === 'commit')).toBe(true);
    expect(r).toEqual({ fired: 0, retried: 0, disabled: 0, skipped: 1 });
  });

  it("one-shot ('at'): se encerra (enabled=false) sem enfileirar", async () => {
    const { pool, sqls } = poolCom(cron({ kind: 'at', interval_ms: null }));
    await tickCron(pool, cfg, log);
    expect(sqls.some((s) => s.sql.includes('insert into job_queue'))).toBe(false);
    expect(sqls.some((s) => s.sql.startsWith('update cron_jobs set enabled = false'))).toBe(true);
  });

  it('org operante: enfileira como sempre (controle)', async () => {
    const { pool, sqls } = poolCom(cron({ operante: true }));
    const r = await tickCron(pool, cfg, log);
    expect(sqls.some((s) => s.sql.includes('insert into job_queue'))).toBe(true);
    expect(r.fired).toBe(1);
  });
});
```

(Medido em `d03c2b2fd`: o caminho feliz enfileira por `enqueueJob` (`lib/agent-engine/queue/queue.ts`, importado em `scheduler.ts:23`), cujo SQL começa com `insert into job_queue` (`queue.ts:86`) — é a string que o dublê reconhece.)

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run lib/agent-engine/cron/scheduler.test.ts` → FAIL (a consulta não contém `fn_org_operante`, o dublê devolve `rows: []` e o tick sai `empty`; `r` sem `skipped`).

- [ ] **Passo 3: implementar** — em `lib/agent-engine/cron/scheduler.ts`:

```ts
export interface CronTickResult {
  fired: number;
  retried: number;
  disabled: number;
  /** Vencidos de organização não operante: avançados sem enfileirar. */
  skipped: number;
}
```

Em `fireOneDue`, o tipo de retorno vira `Promise<'fired' | 'retried' | 'disabled' | 'skipped' | 'empty'>`, e o claim + a guarda (substituem o `select * from cron_jobs … for update skip locked` e o `if (cron === undefined)` atuais, hoje `~:197-215`):

```ts
    const { rows } = await client.query<CronJobRow & { operante: boolean }>(
      `select *, public.fn_org_operante(organization_id) as operante from cron_jobs
       where enabled = true and next_run_at <= $1
       order by next_run_at
       limit 1
       for update skip locked`,
      [new Date(nowMs)],
    );
    const cron = rows[0];
    if (cron === undefined) {
      await client.query('rollback');
      return 'empty';
    }
    const spec = specFromRow(cron);
    // Organização parada (suspensa, redigida, arquivada) não recebe follow-up:
    // o disparo avança sem enfileirar e o one-shot se encerra. Reativar não
    // devolve o que venceu parado — reativação é sem rajada (spec §1.3).
    if (!cron.operante) {
      const proximo = computeNextRunAt(spec, cron.next_run_at.getTime(), nowMs, cfg.staggerWindowMs, cron.contact_id);
      if (proximo === null) {
        await client.query(
          `update cron_jobs set enabled = false, last_error = 'org_nao_operante', updated_at = now() where id = $1`,
          [cron.id],
        );
      } else {
        await client.query(
          `update cron_jobs set next_run_at = $2, last_error = 'org_nao_operante', updated_at = now() where id = $1`,
          [cron.id, proximo],
        );
      }
      await client.query('commit');
      log.info('cron: organização não operante — disparo pulado sem enfileirar', { cron_job_id: cron.id });
      return 'skipped';
    }
```

(Se `const spec = specFromRow(cron)` já existe mais abaixo, não o declare duas vezes — mova-o para cá.) Em `tickCron`: `const result: CronTickResult = { fired: 0, retried: 0, disabled: 0, skipped: 0 };`. Em `runCronLoop`: `if (tick.fired + tick.retried + tick.disabled + tick.skipped > 0) log.info('cron: tick processado', { ...tick });`.

- [ ] **Passo 4: ver passar (unidade):** `pnpm exec vitest run lib/agent-engine/cron/scheduler.test.ts tests/unit/assistido-roda-as-deteccoes.test.ts && pnpm typecheck` → `passed`; `tsc` limpo.

- [ ] **Passo 5: invariante no Postgres real (Review Focus 3)** — `tests/invariants/cron-org-parada.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { tickCron } from "@/lib/agent-engine/cron/scheduler";
import { createLogger } from "@/lib/agent-engine/obs/logger";

/**
 * O SQL REAL do agendador com a régua (migration 0492).
 *
 * `fireOneDue` chama `public.fn_org_operante(organization_id)` dentro do
 * `select … for update skip locked`, pelo pool `pg` do worker. O teste unitário
 * usa dublê; só aqui o Postgres executa o SQL com o papel do pool — um erro de
 * sintaxe ou de EXECUTE pararia TODOS os follow-ups da instalação.
 * Conexão copiada de `agent-watchdog.test.ts`.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});
const log = createLogger();

const ORG_PARADA = "c0de0492-8888-4000-8000-00000000000a";
const ORG_ATIVA = "c0de0492-8888-4000-8000-00000000000b";
const CONTATO = "c0de0492-8888-4000-8000-0000000000c1";
const CRON_RECORRENTE = "c0de0492-8888-4000-8000-0000000000d1";
const CRON_UNICO = "c0de0492-8888-4000-8000-0000000000d2";
const HORA = 3_600_000;
/**
 * `tickCron` reivindica QUALQUER cron vencido do banco compartilhado, na ordem
 * de `next_run_at` (`scheduler.ts:208-211`), e o `test:db` roda os arquivos em
 * ordem embaralhada (`--sequence.shuffle.files=true`). Com os NOSSOS dois crons
 * vencidos em 2000 — antes de qualquer cron que outro arquivo semeie — e
 * `batchSize: 2`, o tick pega exatamente os dois e não dispara cron alheio.
 * As asserções medem só as nossas linhas.
 */
const VENCIDO_EM = "2000-01-01T00:00:00Z";

beforeAll(async () => {
  await pool.query(`
    insert into public.organizations (id, slug, legal_name, display_name, status, suspended_kind, suspended_at) values
      ('${ORG_PARADA}', 'cron-0492-parada', 'Parada', 'Parada', 'suspended', 'administrativa', now()),
      ('${ORG_ATIVA}', 'cron-0492-ativa', 'Ativa', 'Ativa', 'active', null, null)
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${ORG_PARADA}', 'Contato cron 0492') on conflict (id) do nothing;
    insert into public.cron_jobs (id, organization_id, contact_id, kind, interval_ms, job_kind, next_run_at) values
      ('${CRON_RECORRENTE}', '${ORG_PARADA}', '${CONTATO}', 'every', ${HORA}, 'followup_turn', '${VENCIDO_EM}'),
      ('${CRON_UNICO}', '${ORG_PARADA}', '${CONTATO}', 'at', null, 'followup_turn', '${VENCIDO_EM}')
      on conflict (id) do nothing;
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("tickCron × organização parada, no Postgres real", () => {
  it("controle: o papel do pool executa fn_org_operante e a régua responde", async () => {
    const { rows } = await pool.query<{ parada: boolean; ativa: boolean }>(
      "select public.fn_org_operante($1) as parada, public.fn_org_operante($2) as ativa",
      [ORG_PARADA, ORG_ATIVA],
    );
    expect(rows[0]).toEqual({ parada: false, ativa: true });
  });

  it("os vencidos da org parada avançam/encerram sem job, com last_error org_nao_operante", async () => {
    await tickCron(pool, { batchSize: 2, staggerWindowMs: 0, retryBaseMs: 1000 }, log);
    // Só as NOSSAS linhas: nenhuma delas pode seguir vencida e habilitada.
    const { rows: pendentes } = await pool.query(
      "select count(*)::int as n from public.cron_jobs where id in ($1, $2) and enabled and next_run_at <= now()",
      [CRON_RECORRENTE, CRON_UNICO],
    );
    expect(pendentes[0].n, "o tick não reivindicou os dois crons da org parada").toBe(0);
    const { rows: jobs } = await pool.query("select count(*)::int as n from public.job_queue where organization_id = $1", [ORG_PARADA]);
    expect(jobs[0].n).toBe(0);
    const { rows: crons } = await pool.query<{ id: string; enabled: boolean; last_error: string; futuro: boolean }>(
      "select id, enabled, last_error, next_run_at > now() as futuro from public.cron_jobs where id in ($1, $2) order by id",
      [CRON_RECORRENTE, CRON_UNICO],
    );
    expect(crons).toEqual([
      { id: CRON_RECORRENTE, enabled: true, last_error: "org_nao_operante", futuro: true },
      { id: CRON_UNICO, enabled: false, last_error: "org_nao_operante", futuro: false },
    ]);
  });
});
```

(Colunas obrigatórias em `d03c2b2fd`: `organizations` exige `slug`, `legal_name`, `display_name` (`status` tem default `'active'`). Semeie como `postgres`, nunca como `authenticated` — o gatilho da Task 2 recusa org nascida pela sessão. O recorrente vencido em 2000 avança para depois de agora: `computeNextRunAt` colapsa os disparos perdidos (`schedule.ts:197-213`, `while (next <= nowMs) next += intervalMs`).)

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db tests/invariants/cron-org-parada.test.ts > /tmp/t21-db.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t21-db.log | tail -2
```

Esperado: `exit=0`; `Tests  2 passed (2)`.

- [ ] **Passo 6: commit** (antes da sabotagem, para ela não apagar o conserto)

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/agent-engine/cron/scheduler.ts lib/agent-engine/cron/scheduler.test.ts tests/invariants/cron-org-parada.test.ts
git commit -F - <<'FIM'
fix(agent-engine): agendador avança o cron de organização parada sem enfileirar

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

- [ ] **Passo 7: sabotagem — a invariante morde**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git status --short | wc -l   # esperado: 0
perl -pi -e 's/if \(!cron\.operante\) \{/if (false) {/' lib/agent-engine/cron/scheduler.ts
grep -c "if (!cron.operante)" lib/agent-engine/cron/scheduler.ts   # esperado: 0
pnpm test:db tests/invariants/cron-org-parada.test.ts > /tmp/t21-sab.log 2>&1; echo "exit=$?"
grep -aE "Tests " /tmp/t21-sab.log | tail -1   # esperado: 1 failed
grep -a "expected" /tmp/t21-sab.log | head -3  # esperado: a asserção de `jobs[0].n` (2 jobs da org parada, esperado 0)
git checkout -- lib/agent-engine/cron/scheduler.ts
grep -c "if (!cron.operante)" lib/agent-engine/cron/scheduler.ts   # esperado: 1 — o conserto VOLTOU
git status --short | wc -l   # esperado: 0
```

Se o caso 2 falhar por outro motivo que não o job (ex.: `23514` do CHECK de coerência kind⇔contato no enqueue), a sabotagem ainda prova que o caminho sem guarda não passa — registre a mensagem vista no corpo do PR.

---

### Task 22: Resgate de fila — redrive direto ao WAHA respeita a org

**Files:** Modify `lib/agent-engine/edge/crm/session-reconciler.ts` (`redriveQueued`, releitura hoje `:373-389`); Test `lib/agent-engine/edge/crm/session-reconciler.test.ts`.

**Interfaces** — Consumes: SQL `public.fn_org_operante(uuid)` (Task 1). Produces: `messages.status='failed'`, `error_code='org_suspensa'` (o mesmo código que `fn_suspender_organizacao` grava, Task 3).

- [ ] **Passo 1: teste que falha** — em `bancoComFila`, a resposta de `select s.metadata` vira `[{ metadata: {}, phone_number: "+5531999998888", operante: true }]`. E:

```ts
describe("redrive × organização parada", () => {
  it("org não operante: a mensagem vira failed/org_suspensa e nada sai para o WAHA", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "message-test", organization_id: "org-test", body: "Resposta de teste",
        waha_session_name: "session-test", phone_number: "+5511999998888",
        wa_identity: null, wa_lid: null, is_group: false, group_chat_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: "0" }] })
      .mockResolvedValueOnce({ rows: [{ metadata: {}, phone_number: "+5511999998888", operante: false }] })
      .mockResolvedValue({ rows: [] });

    expect(await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
      intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
    }, createLogger())).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(query.mock.calls[2]?.[0]).toContain("public.fn_org_operante(m.organization_id)");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("error_code = 'org_suspensa'"), ["message-test", "org-test"]);
  });
});
```

(Confira a ordem das consultas de `redriveQueued` — `grep -n "pool.query" lib/agent-engine/edge/crm/session-reconciler.ts` — e alinhe os `mockResolvedValueOnce` a ela; o 3º é a releitura com `s.metadata`.)

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run lib/agent-engine/edge/crm/session-reconciler.test.ts` → FAIL (`fetch` chamado; sem `org_suspensa`).

- [ ] **Passo 3: implementar** — em `redriveQueued`, a releitura passa a:

```ts
      const { rows: acesso } = await pool.query<{ metadata: unknown; phone_number: string | null; operante: boolean }>(
        `select s.metadata, c.phone_number, public.fn_org_operante(m.organization_id) as operante
         from messages m
         join channel_sessions s on s.id = m.channel_session_id and s.organization_id = m.organization_id
         join contacts c on c.id = m.contact_id and c.organization_id = m.organization_id
         where m.id = $1 and m.organization_id = $2 and m.status = 'queued'`,
        [m.id, m.organization_id],
      );
      const atual = acesso[0];
      if (!atual) continue;
      // Organização parada não fala: o resgate direto ao WAHA não pode ser a
      // porta dos fundos da suspensão. Mesmo desfecho que a suspensão grava.
      if (atual.operante !== true) {
        await pool.query(
          `update messages set status = 'failed', error_code = 'org_suspensa',
             error_message = 'Envio automático bloqueado: a organização está suspensa.'
           where id = $1 and organization_id = $2 and status = 'queued'`,
          [m.id, m.organization_id],
        );
        log.info('watchdog: reenvio bloqueado — organização não operante', { message_id: m.id });
        continue;
      }
```

(o que o código atual faz com `atual.metadata`/`atual.phone_number` depois segue igual.)

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run lib/agent-engine/edge/crm/session-reconciler.test.ts` → verde (inclusive o describe do #652, que agora recebe `operante: true`); depois `pnpm test:db tests/invariants/agent-watchdog.test.ts` → verde (o SQL novo roda no Postgres real).

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/agent-engine/edge/crm/session-reconciler.ts lib/agent-engine/edge/crm/session-reconciler.test.ts
git commit -F - <<'FIM'
fix(agent-engine): resgate de fila não reenvia mensagem de organização parada

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 23: Porta de saída — `assertOrgOperante` no topo de `sendMessageHandler`

**Files:** Modify `app/api/v1/messages/_handler.ts` (topo do handler, hoje `:363-368`), `tests/helpers/duble-do-handler.ts` (`:49` e o ramo `organizations`, hoje `:263-286`); Create `tests/unit/envio-recusa-org-parada.test.ts`.

**Interfaces** — Consumes: `assertOrgOperante`, `OrgNaoOperanteError` (Task 7). Produces: `sendMessageHandler` lança `OrgNaoOperanteError` (403 `org_suspended`, `terminal: true`) antes de qualquer leitura/escrita; o dublê compartilhado responde org `active` por padrão.

- [ ] **Passo 1: teste que falha** — `tests/unit/envio-recusa-org-parada.test.ts`:

```ts
/**
 * A PORTA DE SAÍDA RECUSA ORGANIZAÇÃO PARADA.
 *
 * `sendMessageHandler` é a saída de ~20 chamadores (tela, MCP, token,
 * automação, campanha, agente). O gate e os filtros dos crons barram antes;
 * este assert é a última porta — e é ele que fecha a corrida de quem passou
 * pelo gate um instante antes da suspensão.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const USER = "55555555-5555-4555-8555-555555555555";
const conversa = {
  id: CONV,
  organization_id: ORG,
  contact_id: "33333333-3333-4333-8333-333333333333",
  channel_session_id: "44444444-4444-4444-8444-444444444444",
  is_group: false,
  group_chat_id: null,
  contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false },
  channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null },
};
const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };
const texto = { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendMessageHandler × organização parada", () => {
  it.each(["suspended", "redacted", "archived"])(
    "org %s → 403 org_suspended, nenhuma linha nasce e nada sai",
    async (status) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { supabase, mensagens } = criarDubleDoHandler({ conversation: conversa, organizacao: { settings: {}, status } });
      const erro = await sendMessageHandler(supabase, ctx, texto).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(OrgNaoOperanteError);
      expect(erro).toMatchObject({ status: 403, code: "org_suspended", terminal: true });
      expect(mensagens).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("org active segue o caminho de sempre (controle)", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "");
    vi.stubEnv("WAHA_API_KEY", "");
    const { supabase } = criarDubleDoHandler({ conversation: conversa, organizacao: { settings: {}, status: "active" } });
    const msg = await sendMessageHandler(supabase, ctx, texto);
    expect(msg.status).toBe("queued");
  });
});
```

(Medido em `d03c2b2fd`: `tests/helpers/duble-do-handler.ts` exporta `criarDubleDoHandler` (`:135`), com a opção `organizacao` (`:50`) e o retorno `mensagens` (`:59`); `HandlerCtx` é `export interface` em `lib/api/handlers/types.ts:74`; `SendMessageInput` sai de `@/lib/schemas` (`lib/schemas/messaging.ts:136`), o mesmo import que `_handler.ts:48` usa.)

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/envio-recusa-org-parada.test.ts` → FAIL nos 3 casos parados (`Message { status: 'queued' … }` em vez do erro).

- [ ] **Passo 3: implementar** — em `app/api/v1/messages/_handler.ts`, `import { assertOrgOperante } from "@/lib/organizacao/operante";` junto dos `@/lib`, e o topo do handler:

```ts
export async function sendMessageHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: SendMessageInput,
): Promise<Message> {
  // Organização parada (suspensa, redigida, arquivada) não envia nada. Esta é a
  // porta de saída de TODOS os chamadores, e fecha a corrida de quem passou pelo
  // gate antes da suspensão. O erro é terminal (`terminal: true`).
  await assertOrgOperante(supabase, ctx.organization_id);
  if (ctx.prospectingDelivery) await assertProspectingDelivery(supabase, ctx.prospectingDelivery);
```

(`_handler.ts:55` declara `type SB = SupabaseClient`, o mesmo tipo do parâmetro de `assertOrgOperante`: sem cast.)

- [ ] **Passo 4: o dublê compartilhado passa a responder a org operante** — em `tests/helpers/duble-do-handler.ts`, o comentário de `:49` vira `/** Linha de \`organizations\` lida pelo aviso ao lead, pela guarda de agenda e pelo assert de org operante. Padrão: \`{ settings: {}, status: "active" }\`. */` e o ramo `if (tabela === "organizations")`:

```ts
      if (tabela === "organizations") {
        // Lido pelo aviso ao lead (idioma da organização), pela guarda de agenda
        // e pelo `assertOrgOperante` do topo do handler. Padrão operante: sem o
        // `status`, todo caso legado viraria 403 `org_suspended`.
        const padrao = { settings: {}, status: "active" };
        const cadeia = {
          select: (colunas = "") => {
            capturas.selects.organizations!.push(colunas);
            return cadeia;
          },
          eq: (coluna: string, valor: unknown) => {
            capturas.filtros.organizations!.push({ coluna, valor });
            return cadeia;
          },
          maybeSingle: async () => ({ data: opcoes.organizacao ?? padrao, error: null }),
          single: async () => ({ data: opcoes.organizacao ?? padrao, error: null }),
        };
        return cadeia;
      }
```

- [ ] **Passo 5: ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run tests/unit/envio-recusa-org-parada.test.ts tests/unit/messages-handler-desfechos.test.ts tests/unit/messages-handler-canal-intermediado.test.ts tests/unit/messages-handler-silencio-ia-apos-humano.test.ts tests/unit/messages-handler-eco-duplicado.test.ts tests/unit/janela-24h-recusa-quem-envia-por-token.test.ts tests/unit/automacao-carimbo-de-origem.test.ts tests/unit/inbox-unread-send.test.ts tests/unit/falha-de-entrega-vira-evento.test.ts tests/unit/mensagem-escrita-pela-ia-segue-ia.test.ts tests/unit/duble-do-handler-compartilhado.test.ts \
  tests/unit/automacao-nao-diz-sucesso-para-envio-morto.test.ts tests/unit/rotulo-de-origem-tem-emissor.test.ts
# O `sendMessageHandler` REAL sobre o Postgres (via `tests/pg-como-supabase.ts`):
# o assert novo é a primeira leitura do handler e roda com o papel de verdade.
pnpm test:db tests/invariants/envio-nao-alcanca-conversa-de-outro-tenant.test.ts \
  tests/invariants/automation-send-whatsapp.test.ts > /tmp/t23-db.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t23-db.log | tail -2
```

Esperado: vitest todos `passed`; test:db `exit=0`, `Test Files  2 passed (2)`. Vermelho com `org_suspended` num desses é dublê/semente sem a org operante: no dublê, `status: "active"` na linha de `organizations`; no invariante, a org semeada já nasce `active` (default da coluna) — se não nascer, é sinal de que a semente grava outro status e o caso precisa dizer `status = 'active'`.

- [ ] **Passo 6: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add app/api/v1/messages/_handler.ts tests/helpers/duble-do-handler.ts tests/unit/envio-recusa-org-parada.test.ts
git commit -F - <<'FIM'
fix(mensagens): a porta de saída recusa organização parada com 403 org_suspended

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 24: Settle terminal — o ledger não trata suspensão como opt-out; o texto fixo encerra o job

**Files:** Modify `lib/agent-engine/edge/crm/send-ledger.ts` (`catch`, hoje `:56-64`), `lib/followup/enviar-texto-fixo.ts` (`settle` do `catch`, hoje `:150-154`); Test `tests/unit/followup-send-ledger.test.ts`, `lib/followup/enviar-texto-fixo.test.ts`.

**Interfaces** — Consumes: `OrgNaoOperanteError` (Task 7). Produces: `sendWithLedger` relança `OrgNaoOperanteError` sem gravar `vetoed`; `enviarTextoFixoPendente` encerra (done) o job cujo envio lançou `OrgNaoOperanteError`.

Por quê: `sendWithLedger` converte TODO `ApiError` 403 em `blocked` + `vetoed`; no agent-engine `blocked` chama `applySendOutcome` → `cancelJob` **e** `cancelPendingCronsForLead` — o 403 da suspensão apagaria todos os follow-ups do contato como "opt-out irrevogável", e a reativação não os devolveria. No texto fixo, o erro nunca chegaria ao `catch`.

- [ ] **Passo 1: testes que falham** — `tests/unit/followup-send-ledger.test.ts`: os imports passam a

```ts
import { expect, it, vi } from "vitest";
import { sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
import { ApiError } from "@/lib/api/types";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
```

e:

```ts
it('organização parada não é veto do contato: o erro sobe e o ledger NÃO vira vetoed',async()=>{
 const db=store();db.create=vi.fn(async()=>'ledger-novo');
 const send=vi.fn(async()=>{throw new OrgNaoOperanteError('org');});
 await expect(sendWithLedger(db,intent,send)).rejects.toBeInstanceOf(OrgNaoOperanteError);
 expect(db.update).not.toHaveBeenCalled();
});
it('403 do contato bloqueado continua virando blocked (controle)',async()=>{
 const db=store();db.create=vi.fn(async()=>'ledger-novo');
 const send=vi.fn(async()=>{throw new ApiError(403,'forbidden',undefined,'req');});
 expect((await sendWithLedger(db,intent,send)).kind).toBe('blocked');
 expect(db.update).toHaveBeenCalledWith('org','ledger-novo','vetoed',null,'handler 403');
});
```

(`store` e `intent` são os helpers do topo do arquivo em `d03c2b2fd`; `store()` tem `message: async () => null`, então `send` é chamado, e o ramo 403 de `send-ledger.ts:59-61` grava exatamente `update(input.tenantId, key, "vetoed", null, "handler 403")`.)

`lib/followup/enviar-texto-fixo.test.ts`: `import { OrgNaoOperanteError } from "@/lib/organizacao/operante";` e:

```ts
it("org suspensa entre o gate e o envio → job encerrado (done), sem reenvio nem avanço do fluxo", async () => {
  decidir.mockResolvedValue({ permite: true, motivo: "gate_aberto", bloqueioPorAllowlist: false });
  sendMessageHandler.mockRejectedValueOnce(new OrgNaoOperanteError("org-1"));
  expect(await enviarTextoFixoPendente(admin())).toBe(0);
  expect(completeTurnForEnrollment).not.toHaveBeenCalled();
  expect(statusUpdates).toContain("done");
  expect(statusUpdates).not.toContain("pending");
});
```

(`sendMessageHandler` (`:10`), `decidir` (`:11`), `completeTurnForEnrollment` (`:12`), `statusUpdates` (`:38`, alimentado pelo `fn_followup_inline_settle` do dublê, `:78`) e `admin()` (`:42`) são os dublês do arquivo em `d03c2b2fd`.)

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/followup-send-ledger.test.ts lib/followup/enviar-texto-fixo.test.ts` → o ledger devolve `{ kind: 'blocked' }`; o texto fixo termina em `pending` (`message_blocked`).

- [ ] **Passo 3: implementar** — `send-ledger.ts`: `import { OrgNaoOperanteError } from "@/lib/organizacao/operante";` e no `catch`, ANTES do ramo 403:

```ts
    } catch (error) {
      // Organização parada NÃO é veto do contato. Gravar `vetoed` faria o dono
      // do job ler `blocked` — e no agent-engine `blocked` cancela TODOS os
      // follow-ups do contato como opt-out irrevogável (`applySendOutcome`).
      // Sobe como está: `terminal: true` encerra o job sem tocar no contato.
      if (error instanceof OrgNaoOperanteError) throw error;
      if (error instanceof ApiError && error.status === 403) {
```

`enviar-texto-fixo.ts`: `import { OrgNaoOperanteError } from "@/lib/organizacao/operante";` e a chamada de `settle` do `catch` (hoje `:153`) passa a:

```ts
      await settle(job.organization_id,job.id,jobClaim.acquired_at,err instanceof StaleServiceBoundaryError||err instanceof OrgNaoOperanteError,message,err instanceof AgendaDeferredError?err:undefined);
```

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run tests/unit/followup-send-ledger.test.ts lib/followup/enviar-texto-fixo.test.ts tests/unit/autonomia-receipt-persistence.test.ts` → `passed`.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/agent-engine/edge/crm/send-ledger.ts lib/followup/enviar-texto-fixo.ts lib/followup/enviar-texto-fixo.test.ts tests/unit/followup-send-ledger.test.ts
git commit -F - <<'FIM'
fix(envio): suspensão não vira opt-out no ledger e encerra o texto fixo

O 403 da organização parada passava pelo ramo do contato bloqueado: o
agent-engine cancelaria todos os follow-ups do contato em definitivo.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 25: Prospecção exclui org parada no SQL, antes do limite

**Files:** Modify `lib/prospecting/worker.ts` (início de `tickProspecting`, hoje `:337-341`); Test `tests/unit/prospecting-worker.test.ts`.

**Interfaces** — Consumes: `idsDeOrgsParadas` (Task 7).

- [ ] **Passo 1: teste que falha** — em `tests/unit/prospecting-worker.test.ts`: acrescente `paradas: vi.fn(),` ao `vi.hoisted` (objeto `mocks`); junto dos outros `vi.mock`:

```ts
// Só `idsDeOrgsParadas` é dublê: `OrgNaoOperanteError` segue a classe real
// (a Task 26b a usa no `catch` do tick, e `instanceof` exige a mesma classe).
vi.mock("@/lib/organizacao/operante", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizacao/operante")>()),
  idsDeOrgsParadas: mocks.paradas,
}));
```

O import passa a `import { sendNextCandidate, tickProspecting } from "@/lib/prospecting/worker";`; e no fim:

```ts
describe("tick da prospecção × organização parada", () => {
  it("exclui as paradas NO SQL, antes do limit — filtrar depois deixaria a parada no topo para sempre", async () => {
    const parada = "20000000-0000-4000-8000-000000000002";
    mocks.paradas.mockResolvedValue([parada]);
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    await tickProspecting({ query } as never, {} as never);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/organization_id <> all\(\$1::uuid\[\]\)/);
    expect(sql.indexOf("<> all")).toBeLessThan(sql.indexOf("limit 20"));
    expect(params).toEqual([[parada]]);
  });
});
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/prospecting-worker.test.ts` → FAIL (`… to match /organization_id <> all/`).

- [ ] **Passo 3: implementar** — `import { idsDeOrgsParadas } from "@/lib/organizacao/operante";` e o início de `tickProspecting`:

```ts
export async function tickProspecting(pool: pg.Pool, admin: SupabaseClient) {
  // Organização parada (suspensa, redigida, arquivada) não prospecta: a busca é
  // paga e a abordagem sai para fora. O corte é no SQL, ANTES do `limit 20`: a
  // ordem é `min(updated_at)`, e a org pulada nunca toca `updated_at` — filtrar
  // depois a deixaria no topo para sempre, com as operantes esperando atrás.
  const paradas = await idsDeOrgsParadas(admin);
  const { rows: organizations } = await pool.query<{ organization_id: string }>(
    "select organization_id from prospecting_campaigns where (status='running' or search_status in ('starting','running')) and organization_id <> all($1::uuid[]) group by organization_id order by min(updated_at) limit 20",
    [paradas],
  );
```

(Em `d03c2b2fd` o SQL é `select organization_id from prospecting_campaigns where status='running' or search_status in ('starting','running') group by organization_id order by min(updated_at) limit 20` (`worker.ts:339-341`), sem parâmetros; o novo só põe o `or` entre parênteses e acrescenta o filtro.)

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run tests/unit/prospecting-worker.test.ts tests/unit/cron-da-prospeccao-nao-engole-o-erro.test.ts` → `passed`.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/prospecting/worker.ts tests/unit/prospecting-worker.test.ts
git commit -F - <<'FIM'
fix(prospeccao): organização parada sai da escolha no SQL, antes do limite

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 26: Campanhas — régua única e o comentário falso de `rodada.ts`

**Files:** Modify `lib/campanhas/rodada.ts` (hoje `:99-117` e `:160-173`); Test `tests/unit/suspensao-nao-dispara-campanha.test.ts`.

**Interfaces** — Consumes: `idsDeOrgsParadas` (Task 7). Produces: nada novo; é a correção de DoD 16 da spec §11 (o comentário dizia que `= 'suspended'` "é a mesma decisão da fila do agente"; o `CLAIM_SQL` de `lib/agent-engine/queue/queue.ts:126-148` nunca olhou `organizations`).

- [ ] **Passo 1: teste que falha** — em `tests/unit/suspensao-nao-dispara-campanha.test.ts`: `interface Chamada` ganha `neq?: [string, string];`; o `estado` do builder falso ganha `neq?: [string, string]`; o builder ganha

```ts
      neq: (coluna: string, valor: string) => {
        estado.neq = [coluna, valor];
        return b;
      },
```

e o `then` registra `chamadas.push({ tabela, operacao: estado.operacao, not: estado.not, neq: estado.neq });`. No `describe`:

```ts
  it("parada é tudo que não é 'active' — redigida e arquivada também não disparam", async () => {
    const { admin, chamadas } = fakeAdmin({ suspensas: [ORG_SUSPENSA], campanhas: [] });
    await rodarUmaRodadaDeCampanha(admin as never);
    expect(chamadas[0]).toMatchObject({ tabela: "organizations", neq: ["status", "active"] });
  });
```

(Em `d03c2b2fd`: `ORG_SUSPENSA` (`:20`), `interface Chamada` (`:22`), `fakeAdmin` (`:29`) e o `then` que faz `chamadas.push({ tabela, operacao: estado.operacao, not: estado.not })` (`:52`) são os do arquivo; `rodarUmaRodadaDeCampanha` é o export de `lib/campanhas/rodada.ts:96`.)

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/suspensao-nao-dispara-campanha.test.ts` → FAIL no caso novo (`neq` undefined: a rodada usa `.eq("status","suspended")`).

- [ ] **Passo 3: implementar** — `import { idsDeOrgsParadas } from "@/lib/organizacao/operante";` e troque

```ts
  // Organização SUSPENSA não prospecta. A decisão é a mesma da fila do agente:
  // `= 'suspended'` e não `<> 'active'`, porque o CHECK aceita também 'redacted'
  // e 'archived', e desligá-los seria mudança que ninguém pediu.
  const { data: suspensas } = await admin.from("organizations").select("id").eq("status", "suspended");
  const idsSuspensas = (suspensas ?? []).map((o) => (o as { id: string }).id);
```

por

```ts
  // Organização que não OPERA (suspensa, redigida ou arquivada) não dispara
  // campanha: disparo em massa custa ao dono da instalação e sai para fora. A
  // régua é a única do produto, `lib/organizacao/operante.ts`. O comentário que
  // morava aqui dizia que `= 'suspended'` era "a mesma decisão da fila do
  // agente"; a fila nunca filtrou status (o `CLAIM_SQL` de
  // `lib/agent-engine/queue/queue.ts` não olha `organizations`), e quem fecha a
  // fila é `fn_suspender_organizacao`, que falha os jobs pendentes.
  const idsParadas = await idsDeOrgsParadas(admin);
```

e troque todos os demais `idsSuspensas` por `idsParadas` (o uso em `promoverAgendadas(admin, …, agora)`, o filtro das campanhas e o parâmetro/uso dentro de `promoverAgendadas`, hoje `:114-115`, `:163`, `:171-172`).

- [ ] **Passo 4: ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run tests/unit/suspensao-nao-dispara-campanha.test.ts lib/campanhas
grep -n "idsSuspensas\|mesma da fila do agente\|SUSPENSA não prospecta" lib/campanhas/rodada.ts; echo "exit=$?"
```

Esperado: `passed`; o `grep` não imprime linha e mostra `exit=1`.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/campanhas/rodada.ts tests/unit/suspensao-nao-dispara-campanha.test.ts
git commit -F - <<'FIM'
fix(campanhas): rodada usa a régua única de organização parada

Corrige o comentário que dizia seguir a fila do agente.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 26b: Chamadores com `catch` próprio — a suspensão não pausa a prospecção nem queima o destinatário da campanha

**Files:** Modify `lib/prospecting/worker.ts` (`catch` de `sendNextCandidate` dentro de `tickProspecting`), `lib/campanhas/rodada.ts` (`catch` do envio em `rodarUmaCampanha`); Test `tests/unit/prospecting-worker.test.ts`, `tests/unit/suspensao-nao-dispara-campanha.test.ts`.

**Interfaces** — Consumes: `OrgNaoOperanteError` (Task 7), lançado pelo topo de `sendMessageHandler` (Task 23); o mock de `@/lib/organizacao/operante` com `importOriginal` (Task 25). Produces: `export async function registrarExcecaoDoEnvio(admin: SupabaseClient, destinatarioId: string, err: unknown): Promise<string>` em `lib/campanhas/rodada.ts` (devolve o `detalhe` da rodada: `"org_nao_operante"` ou `"falhou"`).

Por quê (§4 item 12 e §12 da spec pedem um teste por chamador com settle próprio): numa corrida entre o filtro do tick e o assert da porta de saída, o `catch` de `tickProspecting` PAUSA a campanha (a exceção não é `ProspectingError` de candidato) e o de `rodarUmaCampanha` marca o destinatário `failed`/`send_exception`. As duas coisas sobrevivem à reativação: a lista fica pausada esperando alguém retomar à mão, e o destinatário sai da campanha para sempre por algo que não é dele. `agenda-reminder`, o terceiro, é a Task 28b; `enviar-texto-fixo`, a Task 24; os demais só propagam e entram na cerca da Task 28b.

- [ ] **Passo 1: testes que falham.**

`tests/unit/prospecting-worker.test.ts` — o import de `@/lib/organizacao/operante` e o de `@/lib/prospecting/store` (os dois já mockados no arquivo):

```ts
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
import { withProspectingLock } from "@/lib/prospecting/store";
```

e no fim do arquivo:

```ts
describe("tick da prospecção × organização que para no meio do envio", () => {
  function tickComEnvioQueFalha(erro: Error) {
    mocks.paradas.mockResolvedValue([]);
    mocks.send.mockRejectedValueOnce(erro);
    const base = database();
    const db = {
      query: vi.fn(async (sql: string) =>
        sql.startsWith("select * from prospecting_campaigns where organization_id=$1 and status='running'")
          ? { rows: [campaign] }
          : base.query(sql),
      ),
    };
    (withProspectingLock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_pool: unknown, _org: unknown, fn: (d: unknown) => Promise<unknown>) => fn(db),
    );
    const pool = { query: vi.fn(async () => ({ rows: [{ organization_id: id }] })) };
    return { db, rodar: () => tickProspecting(pool as never, {} as never) };
  }
  const pausou = (db: { query: ReturnType<typeof vi.fn> }) =>
    db.query.mock.calls.some(([sql]) => String(sql).includes("status='paused'"));

  it("OrgNaoOperanteError no envio NÃO pausa a campanha: ela volta sozinha na reativação", async () => {
    const { db, rodar } = tickComEnvioQueFalha(new OrgNaoOperanteError(id, "suspended"));
    await rodar();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(pausou(db)).toBe(false);
  });

  it("controle: falha inesperada do envio continua pausando a campanha", async () => {
    const { db, rodar } = tickComEnvioQueFalha(new Error("provedor fora do ar"));
    await rodar();
    expect(pausou(db)).toBe(true);
  });
});
```

`tests/unit/suspensao-nao-dispara-campanha.test.ts` — o import de `@/lib/campanhas/rodada` passa a `import { registrarExcecaoDoEnvio, rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";`, acrescente `import { OrgNaoOperanteError } from "@/lib/organizacao/operante";` e, antes do `vi.mock("@/lib/agent-engine/db/request-pool", …)` do fim:

```ts
describe("exceção do envio × organização parada", () => {
  /** Supabase falso que só registra o que o `update` gravaria. */
  function adminQueGrava() {
    const gravados: Array<Record<string, unknown>> = [];
    const b: Record<string, unknown> = {
      update: (payload: Record<string, unknown>) => {
        gravados.push(payload);
        return b;
      },
      eq: () => b,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return { admin: { from: () => b } as never, gravados };
  }

  it("org parada no meio do envio devolve o destinatário à fila, sem send_exception", async () => {
    const { admin, gravados } = adminQueGrava();
    await expect(registrarExcecaoDoEnvio(admin, "dest-1", new OrgNaoOperanteError("org"))).resolves.toBe("org_nao_operante");
    expect(gravados).toEqual([{ status: "pending", sending_at: null }]);
  });

  it("controle: outro erro segue marcando failed/send_exception com o motivo", async () => {
    const { admin, gravados } = adminQueGrava();
    await expect(registrarExcecaoDoEnvio(admin, "dest-1", new Error("rede"))).resolves.toBe("falhou");
    expect(gravados).toEqual([{ status: "failed", last_error_code: "send_exception", last_error_detail: "rede" }]);
  });
});
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/prospecting-worker.test.ts tests/unit/suspensao-nao-dispara-campanha.test.ts` → o caso da prospecção encontra `status='paused'`; `registrarExcecaoDoEnvio is not a function`.

- [ ] **Passo 3: implementar.**

`lib/prospecting/worker.ts` — o import da Task 25 passa a `import { OrgNaoOperanteError, idsDeOrgsParadas } from "@/lib/organizacao/operante";`, e em `tickProspecting` Edit com `old_string` = `          } catch (error) {\n            // DE QUEM É A FALHA decide se a fila para.` e `new_string`:

```ts
          } catch (error) {
            // Organização parada entre a escolha do tick e o envio (a porta de
            // saída lança `OrgNaoOperanteError`): não é falha da campanha nem do
            // candidato. Pausar deixaria a lista parada DEPOIS da reativação,
            // esperando alguém retomar à mão. Ela segue `running`; o filtro do
            // tick (`idsDeOrgsParadas`) a deixa de fora até a org voltar. O
            // `return` pula o carimbo de `updated_at` e a contagem: nesta rodada
            // a org não devia nem estar aqui.
            if (error instanceof OrgNaoOperanteError) {
              logger.info("[prospecting] organização parada no envio; a campanha segue", {
                organization_id: org,
                campaign_id: c.id,
              });
              return;
            }
            // DE QUEM É A FALHA decide se a fila para.
```

`lib/campanhas/rodada.ts` — `import { OrgNaoOperanteError, idsDeOrgsParadas } from "@/lib/organizacao/operante";` (o import da Task 26 ganha o nome) e o `catch` do envio em `rodarUmaCampanha` (`:474-487` em `d03c2b2fd`, o segundo `} catch (err) {` do arquivo — o que grava `last_error_code: "send_exception"`) passa a:

```ts
  } catch (err) {
    logger.warn("[campanha] envio falhou", { campanha: campanha.id, destinatario: alvo.id });
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: await registrarExcecaoDoEnvio(admin, alvo.id, err) };
  }
}

/**
 * O que a exceção do envio faz com o destinatário já reservado (`sending`).
 * Exportada para o teste: o caminho inteiro da rodada precisa de ritmo, canal
 * e pool.
 *
 * Organização parada entre a leitura da rodada e o envio (`OrgNaoOperanteError`
 * da porta de saída) NÃO é falha do destinatário: ele volta a `pending` e sai
 * na reativação, no ritmo da campanha. Marcar `send_exception` o tiraria da
 * campanha para sempre por algo que não é dele.
 */
export async function registrarExcecaoDoEnvio(
  admin: SupabaseClient,
  destinatarioId: string,
  err: unknown,
): Promise<string> {
  if (err instanceof OrgNaoOperanteError) {
    await admin
      .from("campaign_recipients")
      .update({ status: "pending", sending_at: null })
      .eq("id", destinatarioId)
      .eq("status", "sending");
    return "org_nao_operante";
  }
  const motivoErro = err instanceof Error ? err.message : String(err);
  await admin
    .from("campaign_recipients")
    .update({
      status: "failed",
      last_error_code: "send_exception",
      last_error_detail: motivoErro.slice(0, 300),
    })
    .eq("id", destinatarioId)
    .eq("status", "sending");
  return "falhou";
```

(O `}` que fechava `rodarUmaCampanha` agora fecha `registrarExcecaoDoEnvio`: o bloco acima substitui do `} catch (err) {` até o `}` final da função, inclusive. `sending_at` é `timestamptz` nulável e `pending` está no CHECK `campaign_recipients_status_check`, medidos no `baseline.sql` de `d03c2b2fd`.)

- [ ] **Passo 4: ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run tests/unit/prospecting-worker.test.ts tests/unit/suspensao-nao-dispara-campanha.test.ts \
  tests/unit/cron-da-prospeccao-nao-engole-o-erro.test.ts lib/campanhas
pnpm typecheck; echo "tsc=$?"
```

Esperado: todos `passed`; `tsc=0`. (`cron-da-prospeccao-nao-engole-o-erro` lê a forma do `logger.error("[prospecting] rodada falhou"` do worker, que esta tarefa não toca.)

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add lib/prospecting/worker.ts lib/campanhas/rodada.ts tests/unit/prospecting-worker.test.ts tests/unit/suspensao-nao-dispara-campanha.test.ts
git commit -F - <<'FIM'
fix(envio): suspensão no meio do envio não pausa a prospecção nem queima o destinatário da campanha

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 27: Voz em tempo real encerra a chamada de org parada

**Files:** Modify `workers/voice-agent/index.ts` (import; `handleAudioSocketConnection`, entre o `if (error || !callRow) {…}` de `:237` e `getActiveVoiceAgent(` de `:243`); Create `tests/unit/voz-nao-atende-org-parada.test.ts`.

**Interfaces** — Consumes: `ehOperante` (Task 7). `workers/voice-agent/index.ts` executa `main()` no import, então o teste lê o fonte (molde `tests/unit/prompt-editado-e-o-que-o-motor-executa.test.ts`).

- [ ] **Passo 1: teste que falha** — `tests/unit/voz-nao-atende-org-parada.test.ts`:

```ts
/**
 * A VOZ NÃO ATENDE EM NOME DE ORGANIZAÇÃO PARADA.
 *
 * `workers/voice-agent/index.ts` chama `main()` ao ser importado (abre socket e
 * conecta no Asterisk), então o teste lê o fonte — o mesmo molde de
 * `prompt-editado-e-o-que-o-motor-executa.test.ts`. O que se prende é a ORDEM:
 * o status da org é lido e a conexão encerrada ANTES de montar o agente (que
 * abre a sessão paga na OpenAI).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FONTE = readFileSync(join(process.cwd(), "workers/voice-agent/index.ts"), "utf8");

function corpoDe(nome: string): string {
  const inicio = FONTE.indexOf(`async function ${nome}(`);
  expect(inicio, `função ${nome} sumiu do worker de voz`).toBeGreaterThan(-1);
  const fim = FONTE.indexOf("\nfunction ", inicio + 1);
  return FONTE.slice(inicio, fim === -1 ? undefined : fim);
}

describe("voz × organização parada", () => {
  it("importa a régua única", () => {
    expect(FONTE).toMatch(/import \{ ehOperante \} from "@\/lib\/organizacao\/operante";/);
  });

  it("lê o status da org e encerra ANTES de montar o agente de voz", () => {
    const corpo = corpoDe("handleAudioSocketConnection");
    expect(corpo).toMatch(/\.from\("organizations"\)\s*\.select\("status"\)/);
    const veto = corpo.indexOf("ehOperante(");
    const agente = corpo.indexOf("getActiveVoiceAgent(");
    expect(veto).toBeGreaterThan(-1);
    expect(agente).toBeGreaterThan(veto);
    expect(corpo.slice(veto, agente)).toMatch(/voz_org_suspensa[\s\S]{0,200}socket\.end\(\);\s*return;/);
  });
});
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/voz-nao-atende-org-parada.test.ts` → FAIL nos dois casos.

- [ ] **Passo 3: implementar** — import depois de `import { buscarConhecimento, resolverAcervoDoAgente } from "@/lib/ai/knowledge/busca";`:

```ts
import { ehOperante } from "@/lib/organizacao/operante";
```

e em `handleAudioSocketConnection`, entre o `if (error || !callRow) { … }` e `const agent = await getActiveVoiceAgent(...)`:

```ts
  // Organização parada (suspensa, redigida, arquivada) não atende por voz: a
  // sessão em tempo real é o gasto mais caro por minuto do produto. Falha de
  // leitura também encerra — sem saber o status, não se abre a sessão paga.
  const { data: org, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .select("status")
    .eq("id", callRow.organization_id)
    .maybeSingle();
  if (orgErr || !ehOperante(org?.status)) {
    console.warn(`[audiosocket] voz_org_suspensa org ${callRow.organization_id} — encerrando`);
    socket.end();
    return;
  }
```

(O cliente admin do arquivo pode ter outro nome — `grep -n "createAdminClient\|supabaseAdmin" workers/voice-agent/index.ts`; use o que a leitura de `callRow` usa. O arquivo já loga por `console.*` com prefixo `[audiosocket]`.)

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run tests/unit/voz-nao-atende-org-parada.test.ts tests/unit/prompt-editado-e-o-que-o-motor-executa.test.ts && pnpm typecheck` → `passed`; `tsc` limpo.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add workers/voice-agent/index.ts tests/unit/voz-nao-atende-org-parada.test.ts
git commit -F - <<'FIM'
fix(voz): chamada de organização parada é encerrada antes de abrir a sessão

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 28: Embedding de conversas pula org parada

**Files:** Modify `app/api/v1/cron/kb-conversations-batch/route.ts` (hoje `:18-61`); Create `tests/unit/kb-conversas-pula-org-parada.test.ts`.

**Interfaces** — Consumes: `idsDeOrgsParadas` (Task 7).

- [ ] **Passo 1: teste que falha** — `tests/unit/kb-conversas-pula-org-parada.test.ts`:

```ts
/**
 * O EMBEDDING DE CONVERSAS NÃO GASTA COM ORGANIZAÇÃO PARADA.
 *
 * O cron diário ingere as conversas de toda org com agente ativo; o provedor
 * cobra por token, e quem paga é o dono da instalação.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  paradas: vi.fn(),
  agentes: [] as Array<{ id: string; organization_id: string }>,
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/ai/rag/ingest/conversations", () => ({ ingestConversationsBatch: mocks.ingest }));
vi.mock("@/lib/organizacao/operante", () => ({ idsDeOrgsParadas: mocks.paradas }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: async () => ({ data: mocks.agentes, error: null }) }) }),
  }),
}));

import { GET } from "@/app/api/v1/cron/kb-conversations-batch/route";

const pedido = () => new Request("http://localhost/api/v1/cron/kb-conversations-batch") as never;

beforeEach(() => {
  mocks.ingest.mockReset();
  mocks.paradas.mockReset();
  mocks.agentes = [
    { id: "agente-parada", organization_id: "org-parada" },
    { id: "agente-ativa", organization_id: "org-ativa" },
  ];
  mocks.ingest.mockResolvedValue({ processed: 1, flaggedReview: 0, skipped: 0 });
});

describe("kb-conversations-batch × organização parada", () => {
  it("não ingere a org parada; a operante segue", async () => {
    mocks.paradas.mockResolvedValue(["org-parada"]);
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-ativa" }));
  });

  it("leitura das paradas falha → 500 e nada é ingerido (falha fechada)", async () => {
    mocks.paradas.mockRejectedValue(new Error("connection reset"));
    const res = await GET(pedido());
    expect(res.status).toBe(500);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
```

(Medido em `d03c2b2fd`: a rota exporta `GET` (`:33`), o guard é `autorizaCron(req)` de `@/lib/auth/cron-auth` (`:36`), e a leitura dos agentes é `admin.from("ai_agents").select("id, organization_id").eq("is_active", true)` (`:43-46`), aguardada direto no `eq` — a cadeia que o dublê imita.)

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/kb-conversas-pula-org-parada.test.ts` → FAIL (`ingest` chamado 2 vezes; 200 no caso da falha).

- [ ] **Passo 3: implementar** — `import { idsDeOrgsParadas } from "@/lib/organizacao/operante";`; depois do `if (agentErr) { … }`:

```ts
  // Organização parada (suspensa, redigida, arquivada) não gasta embedding: o
  // provedor cobra por token, e quem paga é o dono da instalação.
  let paradas: Set<string>;
  try {
    paradas = new Set(await idsDeOrgsParadas(admin));
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : String(err), 500, { requestId });
  }
```

e no laço de escolha: `if (seenOrgs.has(a.organization_id) || paradas.has(a.organization_id)) continue;`.

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run tests/unit/kb-conversas-pula-org-parada.test.ts tests/unit/cron-audita-so-quando-ha-efeito.test.ts` → `passed`.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add app/api/v1/cron/kb-conversations-batch/route.ts tests/unit/kb-conversas-pula-org-parada.test.ts
git commit -F - <<'FIM'
fix(rag): embedding de conversas pula organização parada

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 28b: Lembrete da agenda pula org parada, e a cerca dos chamadores da porta de saída

**Files:** Modify `app/api/v1/cron/agenda-reminder/route.ts`; Create `tests/unit/lembrete-pula-org-parada.test.ts`, `tests/unit/chamadores-do-envio-tratam-org-parada.test.ts`.

**Interfaces** — Consumes: `idsDeOrgsParadas`, `OrgNaoOperanteError` (Task 7); `arquivosDeCodigo`, `caminhoRelativo` (`tests/unit/helpers/varrer-codigo.ts`, que já exclui `.test.`). Produces: o motivo `org_nao_operante` em `motivos` da resposta do cron; a cerca `chamadores-do-envio-tratam-org-parada`.

Por quê: até aqui o `agenda-reminder` só "respeitava" a suspensão pelo assert da porta de saída (Task 23), e assert na saída não é filtro. Para cada lembrete de empresa suspensa a rota fazia `ensureConversation` (que pode CRIAR conversa), recebia o 403, logava `logger.error("[agenda-reminder] envio falhou")` e deixava o compromisso sem carimbo — a cada 5 minutos, durante a suspensão inteira; e, na reativação, os degraus ainda na janela saíam de uma vez. A §1.3 da spec lista "lembrete" em "nada roda e nada sai".

- [ ] **Passo 1: testes que falham** — `tests/unit/lembrete-pula-org-parada.test.ts`:

```ts
/**
 * O LEMBRETE DA AGENDA NÃO SAI PARA ORGANIZAÇÃO PARADA.
 *
 * E não abre conversa nem vira `erro_no_envio` a cada 5 minutos: a org parada
 * sai da rodada antes do contato, e a corrida com o assert da porta de saída
 * vira o mesmo `pulado`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrgNaoOperanteError } from "@/lib/organizacao/operante";

const mocks = vi.hoisted(() => ({
  paradas: vi.fn(),
  enviar: vi.fn(),
  abrirConversa: vi.fn(),
  compromissos: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.enviar }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: mocks.abrirConversa }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: async () => null }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: async () => {} }));
vi.mock("@/lib/organizacao/operante", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizacao/operante")>()),
  idsDeOrgsParadas: mocks.paradas,
}));
/** PostgREST falso: toda cadeia devolve a si mesma; a lista e as linhas únicas vêm de `mocks`. */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const unico: Record<string, unknown> = {
        contacts: { id: "contato-1", name: "Ana", display_name: null, phone_number: "+5531999998888", is_blocked: false },
        channel_sessions: { id: "canal-1" },
        organizations: { timezone: "America/Sao_Paulo", locale: "pt-BR" },
      };
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "gt", "lte", "order", "limit", "or", "update"]) c[m] = () => c;
      c.maybeSingle = async () => ({ data: unico[tabela] ?? null, error: null });
      c.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: tabela === "calendar_appointments" ? mocks.compromissos : null, error: null }).then(r);
      return c;
    },
  }),
}));

import { GET } from "@/app/api/v1/cron/agenda-reminder/route";

const pedido = () => new Request("http://localhost/api/v1/cron/agenda-reminder") as never;
const tipo = {
  name: "Consulta", reminder_enabled: true, reminder_minutes_before: 60, reminder_extra_offsets_minutes: null,
  reminder_template_name: null, reminder_body: null, reminder_bodies: null, location_details: null,
};
const compromisso = (id: string, organization_id: string) => ({
  id, organization_id, contact_id: "contato-1", title: "Retorno",
  starts_at: new Date(Date.now() + 30 * 60_000).toISOString(), location_details: null,
  reminder_sent_offsets_minutes: null, calendar_event_types: tipo,
});

beforeEach(() => {
  mocks.paradas.mockReset();
  mocks.enviar.mockReset();
  mocks.abrirConversa.mockReset();
  mocks.abrirConversa.mockResolvedValue("conversa-1");
  mocks.enviar.mockResolvedValue({ id: "msg-1", status: "queued" });
  mocks.compromissos = [compromisso("c-parada", "org-parada"), compromisso("c-ativa", "org-ativa")];
});

describe("agenda-reminder × organização parada", () => {
  it("não abre conversa nem envia para a org parada; a operante segue", async () => {
    mocks.paradas.mockResolvedValue(["org-parada"]);
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(mocks.abrirConversa).toHaveBeenCalledTimes(1);
    expect(mocks.abrirConversa.mock.calls[0]?.[1]).toBe("org-ativa");
    expect(mocks.enviar).toHaveBeenCalledTimes(1);
    expect(mocks.enviar.mock.calls[0]?.[1]).toMatchObject({ organization_id: "org-ativa" });
    expect((await res.json()).data).toMatchObject({ enviados: 1, motivos: { org_nao_operante: 1 } });
  });

  it("corrida com a porta de saída: OrgNaoOperanteError vira pulado org_nao_operante, não erro_no_envio", async () => {
    mocks.paradas.mockResolvedValue([]);
    mocks.enviar.mockRejectedValueOnce(new OrgNaoOperanteError("org-parada", "suspended"));
    const res = await GET(pedido());
    const { data } = await res.json();
    expect(data.motivos).toMatchObject({ org_nao_operante: 1 });
    expect(data.motivos.erro_no_envio).toBeUndefined();
  });

  it("leitura das paradas falha → 500 e nada sai (falha fechada)", async () => {
    mocks.paradas.mockRejectedValue(new Error("connection reset"));
    const res = await GET(pedido());
    expect(res.status).toBe(500);
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(mocks.abrirConversa).not.toHaveBeenCalled();
  });
});
```

`tests/unit/chamadores-do-envio-tratam-org-parada.test.ts`:

```ts
/**
 * QUEM CHAMA A PORTA DE SAÍDA SABE O QUE FAZER COM A ORGANIZAÇÃO PARADA.
 *
 * `sendMessageHandler` lança `OrgNaoOperanteError` (403 `org_suspended`,
 * `terminal`) para org suspensa, redigida ou arquivada. Quem só propaga o erro
 * está certo. Quem tem `catch` próprio que GRAVA um desfecho (pausa a campanha,
 * marca o destinatário, retenta a cada rodada) precisa distinguir a suspensão —
 * senão o efeito sobrevive à reativação. Chamador novo entra aqui com a decisão
 * escrita; os que tratam têm teste de comportamento na tarefa citada.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const TRATA = "trata";

const CHAMADORES: Record<string, string> = {
  "app/api/v1/cron/agenda-reminder/route.ts": TRATA, // tests/unit/lembrete-pula-org-parada.test.ts
  "lib/campanhas/rodada.ts": TRATA, // registrarExcecaoDoEnvio, tests/unit/suspensao-nao-dispara-campanha.test.ts
  "lib/prospecting/worker.ts": TRATA, // tests/unit/prospecting-worker.test.ts
  "lib/followup/enviar-texto-fixo.ts": TRATA, // lib/followup/enviar-texto-fixo.test.ts
  "lib/agent-engine/edge/crm/send-message.ts":
    "propaga o 403 como ApiError; sendWithLedger relança a suspensão e o agent-worker encerra o job terminal",
  "app/api/v1/messages/route.ts": "rota de API: o ApiError 403 org_suspended vira a resposta JSON de quem chamou",
  "app/api/v1/proposals/[id]/send/route.ts":
    "o catch devolve a proposta a rascunho; nada fica gravado como enviado, e a pessoa reenvia depois",
  "lib/ai/handoff/aviso-ao-lead.ts": "devolve avisado:false; é aviso de um instante, sem fila nem estado que sobreviva",
  "lib/ai/runtime/finalize.ts": "devolve null ao turno; o gate já nega a org parada antes de existir turno",
  "lib/automation/actions/send-ai-message.ts": "o desfecho vira failed na execução da regra; registro do instante, sem retentativa",
  "lib/automation/actions/send-whatsapp.ts": "o desfecho vira failed na execução da regra; registro do instante, sem retentativa",
  "lib/campanhas/acoes.ts": "ação disparada da tela: o erro sobe para quem clicou, sem estado gravado",
  "lib/mcp/tools/messages.ts": "ferramenta MCP: o erro sobe ao cliente; o token da org parada já é recusado antes",
  "lib/mcp/tools/start-conversation.ts": "ferramenta MCP: o erro sobe ao cliente; o token da org parada já é recusado antes",
};

const PORTA = "app/api/v1/messages/_handler.ts";
const FONTES = arquivosDeCodigo(["app", "lib", "workers"]).map((abs) => ({
  arquivo: caminhoRelativo(abs),
  fonte: readFileSync(abs, "utf8"),
}));
const QUEM_CHAMA = FONTES.filter(({ arquivo, fonte }) => arquivo !== PORTA && /\bsendMessageHandler\(/.test(fonte))
  .map(({ arquivo }) => arquivo)
  .sort();

describe("chamadores de sendMessageHandler × organização parada", () => {
  it("o instrumento enxerga os chamadores (controle positivo)", () => {
    expect(QUEM_CHAMA).toContain("lib/campanhas/rodada.ts");
    expect(QUEM_CHAMA.length).toBeGreaterThanOrEqual(10);
  });

  it("todo chamador consta da lista com a decisão — e a lista só tem quem chama", () => {
    expect(QUEM_CHAMA).toEqual(Object.keys(CHAMADORES).sort());
  });

  it("quem 'trata' distingue OrgNaoOperanteError no próprio arquivo; quem propaga diz por quê", () => {
    for (const [arquivo, decisao] of Object.entries(CHAMADORES)) {
      if (decisao === TRATA) {
        const fonte = FONTES.find((f) => f.arquivo === arquivo)?.fonte ?? "";
        expect(fonte, `${arquivo} diz que trata e não cita OrgNaoOperanteError`).toContain("OrgNaoOperanteError");
      } else {
        expect(decisao.length, arquivo).toBeGreaterThanOrEqual(20);
      }
    }
  });
});
```

(A lista é a de `grep -rln "sendMessageHandler(" app lib workers | grep -v "\.test\." | grep -v "messages/_handler.ts"` em `d03c2b2fd`: 14 arquivos. Se a main ganhou um chamador, ele entra com a decisão medida no `catch` dele: grava desfecho que sobrevive → `TRATA` + teste de comportamento; só propaga → o motivo.)

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/lembrete-pula-org-parada.test.ts tests/unit/chamadores-do-envio-tratam-org-parada.test.ts` → no lembrete, `abrirConversa` chamado 2 vezes, `erro_no_envio` no lugar de `org_nao_operante` e 200 no caso da falha; na cerca, `agenda-reminder/route.ts diz que trata e não cita OrgNaoOperanteError`.

- [ ] **Passo 3: implementar** — em `app/api/v1/cron/agenda-reminder/route.ts`, depois de `import { autorizaCron } from "@/lib/auth/cron-auth";`:

```ts
import { OrgNaoOperanteError, idsDeOrgsParadas } from "@/lib/organizacao/operante";
```

logo depois do `if (error) { … }` da consulta de compromissos (o que devolve `"Falha ao buscar compromissos."`):

```ts
  // Organização parada (suspensa, redigida, arquivada) não recebe lembrete: é
  // mensagem que sai para o cliente dela (spec §1.3, "nada roda e nada sai").
  // Lida UMA vez por rodada; leitura que falha para a rodada — lembrete enviado
  // por palpite não se desfaz.
  let paradas: Set<string>;
  try {
    paradas = new Set(await idsDeOrgsParadas(admin));
  } catch (err) {
    logger.error("[agenda-reminder] leitura das organizações paradas falhou", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", "Falha ao ler as organizações paradas.", 500, { requestId });
  }
```

no laço, logo depois de `    const org = linha.organization_id;`:

```ts
    // Antes do contato e da conversa: org parada não abre conversa nem carimba
    // o compromisso. Na reativação, o degrau que ainda estiver na janela sai
    // normalmente; o que venceu parado não volta (reativação sem rajada).
    if (paradas.has(org)) {
      pular("org_nao_operante");
      continue;
    }
```

e no `catch (err) {` do envio, como primeira coisa:

```ts
      // A org parou entre a leitura da rodada e o envio: não é erro, é a
      // suspensão (a porta de saída lança OrgNaoOperanteError).
      if (err instanceof OrgNaoOperanteError) {
        pular("org_nao_operante");
        continue;
      }
```

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run tests/unit/lembrete-pula-org-parada.test.ts tests/unit/chamadores-do-envio-tratam-org-parada.test.ts app/api/v1/cron/agenda-reminder/route.test.ts tests/unit/cron-audita-so-quando-ha-efeito.test.ts && pnpm typecheck` → `passed`; `tsc` limpo. (`route.test.ts` prende por fonte que contato, canal e carimbo filtram `organization_id` — nada disso muda.)

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add app/api/v1/cron/agenda-reminder/route.ts tests/unit/lembrete-pula-org-parada.test.ts tests/unit/chamadores-do-envio-tratam-org-parada.test.ts
git commit -F - <<'FIM'
fix(agenda): lembrete não sai nem abre conversa para organização parada

A rota só respeitava a suspensão pelo assert da porta de saída: abria a
conversa, logava erro e retentava a cada 5 minutos. A cerca nova exige
que todo chamador de sendMessageHandler declare o que faz com a org parada.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 29: Cerca `cron-respeita-org-operante`

**Files:** Create `tests/unit/cron-respeita-org-operante.test.ts`.

**Interfaces** — Consumes: Tasks 19, 24, 25, 26, 28, 28b (por elas `event-log-drain`, `followup-flow-worker`, `prospecting`, `campaign-worker`, `kb-conversations-batch` e `agenda-reminder` passam a importar a régua, na rota ou num módulo que ela importa diretamente). A porta de saída (`app/api/v1/messages/_handler.ts`, Task 23) NÃO conta como import da régua: assert no envio não é filtro da varredura — o `agenda-reminder` passava só por ela até a Task 28b.

- [ ] **Passo 1: escrever a cerca**

```ts
/**
 * TODO CRON RESPEITA A ORGANIZAÇÃO PARADA — OU DIZ, POR ESCRITO, POR QUE NÃO PRECISA.
 *
 * Organização parada (suspensa, redigida, arquivada — `lib/organizacao/operante.ts`)
 * não gasta nem fala. Rota nova em `app/api/v1/cron/` nasce sem saber disso, e o
 * modo de falha é mudo: nada quebra, a org suspensa só continua custando.
 *
 * A rota passa se ELA ou um módulo que ela importa DIRETAMENTE usa a régua
 * (import de `@/lib/organizacao/operante`, ou `fn_org_operante(` no SQL). Um nível
 * só, de propósito: o filtro de várias rotas mora no módulo de `lib/` que elas
 * chamam. Import só de TIPO não conta — tipo não filtra nada. E a porta de saída
 * (`app/api/v1/messages/_handler.ts`) não conta: ela recusa o envio, mas quem a
 * chama já abriu conversa, gastou a varredura e vai retentar na próxima rodada.
 *
 * As demais constam de `SEM_FILTRO` com o motivo. A lista só encolhe: entrada de
 * rota que sumiu, ou que passou a usar a régua, reprova até ser tirada.
 *
 * A rota da cobrança (PR 3a) importa a régua para o filtro da §3.2 e não entra
 * na lista.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const DIR_CRON = join(RAIZ, "app", "api", "v1", "cron");
const MODULO_DA_REGUA = "@/lib/organizacao/operante";
const FUNCAO_SQL_DA_REGUA = "fn_org_operante(";
/** Importar isto não faz a rota respeitar a org parada: assert na saída não é filtro. */
const NAO_E_FILTRO = new Set([join(RAIZ, "app", "api", "v1", "messages", "_handler.ts")]);

const SEM_FILTRO: Record<string, string> = {
  "agenda-expira-pendentes": "só libera o horário de pedido pendente vencido; escrita interna, sem custo nem saída",
  "agenda-google-push": "sincronia com o Google Agenda: deliberadamente não gatilhada (spec §4)",
  "agenda-google-refresh": "renova token do Google Agenda: deliberadamente não gatilhado (spec §4)",
  "agenda-google-sync": "sincronia com o Google Agenda: deliberadamente não gatilhada (spec §4)",
  "agent-dispatcher": "no-op permanente desde a convergência; não há o que filtrar",
  "canal-mudo-watcher": "só abre aviso na Central da própria org; sem custo nem saída",
  "case-stale-watcher": "só reabre aviso de caso na Central; sem custo nem saída",
  "channel-health": "só pergunta ao transporte se a sessão está de pé; nenhuma mensagem ao cliente",
  "contact-avatars": "baixa a foto de perfil: deliberadamente não gatilhado (spec §4)",
  "contact-birthdays": "só emite contact.birthday; o consumidor (automationRulesHandler) é 'pula'",
  "contact-phones": "só consulta o transporte para achar o telefone; nenhuma mensagem ao cliente",
  "contact-proposals-watcher": "só expira propostas de dado vencidas; escrita interna",
  "data-retention": "retenção e expurgo: obrigação, nunca bloqueada (spec §1.3)",
  "followup-sem-agente": "só abre aviso na Central sobre fluxo sem agente; sem custo nem saída",
  "handoff-devolucao": "devolve a conversa à IA; a IA só fala por evento, barrado pelo gate e pelo dispatcher",
  "lead-date-field-due": "só emite lead.date_field_due; o consumidor (automationRulesHandler) é 'pula'",
  "lead-time-triggers": "só emite lead.silent_for/stage_stale; o consumidor (automationRulesHandler) é 'pula'",
  "lgpd-sla-watcher": "LGPD nunca é bloqueada (spec §1.3)",
  "media-retention": "retenção de mídia: apagar é obrigação, não custo",
  "proposal-acceptance-rate": "só calcula a taxa e abre aviso interno; sem custo nem saída",
  "proposal-expiry": "só vence proposta e abre aviso interno; sem custo nem saída",
  "proposal-promised-not-created": "só abre aviso interno de promessa vencida; sem custo nem saída",
  "proposta-travada": "só destrava proposta presa em 'enviando'; escrita interna",
  "recover-stuck-messages": "marca failed e avisa, nunca reenvia: deliberadamente não gatilhado (spec §4)",
  "recurring-entries": "só gera lançamento financeiro pendente; escrita interna",
  "risk-watcher": "só classifica risco e registra a proposta de reativação; nada sai",
  "routing-worker": "só distribui o dono da conversa; sem custo nem saída",
  "snooze-watcher": "só reabre conversa adiada; sem custo nem saída",
  "storage-redaction": "LGPD e retenção nunca são bloqueadas (spec §1.3)",
  "sync-model-catalog": "catálogo da instalação inteira; não pertence a organização nenhuma",
  "webhook-log-retention": "retenção do arquivo de webhook: obrigação, nunca bloqueada",
  "webhook-replay": "reprocessa ENTRADA do WAHA; mensagem que chega continua gravada (spec §1.3)",
};

function rotasDeCron(): string[] {
  return readdirSync(DIR_CRON, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(DIR_CRON, e.name, "route.ts")))
    .map((e) => e.name)
    .sort();
}

function usaAReguaNaFonte(fonte: string, nome: string): boolean {
  const arquivo = ts.createSourceFile(nome, fonte, ts.ScriptTarget.Latest, true);
  let usa = false;
  const visitar = (no: ts.Node): void => {
    if (usa) return;
    if (
      ts.isImportDeclaration(no) &&
      ts.isStringLiteral(no.moduleSpecifier) &&
      no.moduleSpecifier.text === MODULO_DA_REGUA &&
      !no.importClause?.isTypeOnly
    ) {
      usa = true;
      return;
    }
    if (
      (ts.isStringLiteral(no) ||
        ts.isNoSubstitutionTemplateLiteral(no) ||
        ts.isTemplateHead(no) ||
        ts.isTemplateMiddle(no) ||
        ts.isTemplateTail(no)) &&
      no.text.includes(FUNCAO_SQL_DA_REGUA)
    ) {
      usa = true;
      return;
    }
    ts.forEachChild(no, visitar);
  };
  visitar(arquivo);
  return usa;
}

function resolver(especificador: string): string | null {
  const base = join(RAIZ, especificador.slice(2));
  for (const candidato of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidato)) return candidato;
  }
  return null;
}

function importsDiretos(caminho: string): string[] {
  const arquivo = ts.createSourceFile(caminho, readFileSync(caminho, "utf8"), ts.ScriptTarget.Latest, true);
  const saida: string[] = [];
  for (const st of arquivo.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.importClause?.isTypeOnly || !st.moduleSpecifier.text.startsWith("@/")) continue;
    const alvo = resolver(st.moduleSpecifier.text);
    if (alvo) saida.push(alvo);
  }
  return saida;
}

function rotaRespeita(rota: string): boolean {
  const arquivo = join(DIR_CRON, rota, "route.ts");
  const usa = (caminho: string) => usaAReguaNaFonte(readFileSync(caminho, "utf8"), caminho);
  return usa(arquivo) || importsDiretos(arquivo).filter((c) => !NAO_E_FILTRO.has(c)).some(usa);
}

describe("a sonda", () => {
  it("reconhece o import da régua e a função SQL (controles positivos)", () => {
    expect(usaAReguaNaFonte(`import { idsDeOrgsParadas } from "@/lib/organizacao/operante";`, "a.ts")).toBe(true);
    expect(
      usaAReguaNaFonte("await pool.query(`select public.fn_org_operante($1) as operante`, [id]);", "b.ts"),
    ).toBe(true);
  });

  it("a porta de saída existe e é a que não conta como filtro (controle do NAO_E_FILTRO)", () => {
    for (const caminho of NAO_E_FILTRO) expect(existsSync(caminho), caminho).toBe(true);
  });

  it("não se engana com comentário nem com import só de tipo (controles negativos)", () => {
    expect(usaAReguaNaFonte("// não chama fn_org_operante( aqui\nexport const x = 1;", "c.ts")).toBe(false);
    expect(usaAReguaNaFonte(`import type { TipoDeSuspensao } from "@/lib/organizacao/operante";`, "d.ts")).toBe(false);
  });
});

describe("crons × organização parada", () => {
  const rotas = rotasDeCron();

  it("o diretório de crons foi lido (instrumento vivo)", () => {
    expect(rotas).toContain("event-log-drain");
    expect(rotas).toContain("kb-conversations-batch");
  });

  it.each(rotas)("%s usa a régua ou consta de SEM_FILTRO com motivo", (rota) => {
    expect(
      rotaRespeita(rota) || rota in SEM_FILTRO,
      `app/api/v1/cron/${rota} não filtra organização parada. Importe ${MODULO_DA_REGUA} ` +
        "(ou chame fn_org_operante no SQL) — ou, se ela não custa nem sai para fora, " +
        "acrescente-a a SEM_FILTRO com o motivo.",
    ).toBe(true);
  });

  it("a lista só encolhe: toda entrada existe e ainda não usa a régua", () => {
    for (const rota of Object.keys(SEM_FILTRO)) {
      expect(existsSync(join(DIR_CRON, rota, "route.ts")), `${rota} não existe mais — tire de SEM_FILTRO`).toBe(true);
      expect(rotaRespeita(rota), `${rota} já usa a régua — tire de SEM_FILTRO`).toBe(false);
    }
  });

  it("todo motivo tem ao menos 20 caracteres", () => {
    for (const [rota, motivo] of Object.entries(SEM_FILTRO)) {
      expect(motivo.trim().length, `${rota}: motivo curto demais`).toBeGreaterThanOrEqual(20);
    }
  });

  it("a rota da cobrança não entra na lista — ela filtra pela régua (PR 3a)", () => {
    expect(Object.keys(SEM_FILTRO)).not.toContain("cobranca");
  });
});
```

- [ ] **Passo 2: rodar** — `pnpm exec vitest run tests/unit/cron-respeita-org-operante.test.ts`. Esperado: verde. Se uma rota (criada depois da medição, hoje 38 diretórios) aparecer vermelha: ou ela custa/sai para fora e ganha o filtro (conserto no molde da Task 28, com teste), ou entra em `SEM_FILTRO` com o motivo. Se uma entrada de `SEM_FILTRO` acusar "já usa a régua", tire-a.

- [ ] **Passo 3: provar que a cerca morde** (sem commitar)

```bash
cd ~/deskcomm-saas/pr1 || exit 1
cp -p app/api/v1/cron/kb-conversations-batch/route.ts /tmp/kb-route.bak
sed -i '' '/organizacao\/operante/d' app/api/v1/cron/kb-conversations-batch/route.ts
pnpm exec vitest run tests/unit/cron-respeita-org-operante.test.ts > /tmp/t29.log 2>&1; echo "exit=$?"
grep -aE "Tests " /tmp/t29.log | tail -1
cp -p /tmp/kb-route.bak app/api/v1/cron/kb-conversations-batch/route.ts
grep -c "organizacao/operante" app/api/v1/cron/kb-conversations-batch/route.ts
git status --short app/api/v1/cron/kb-conversations-batch/route.ts
```

Esperado: `exit=1`, `Tests  1 failed` (a rota `kb-conversations-batch`); depois da restauração, `grep -c` = `1` e `git status` sem linha.

- [ ] **Passo 4: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add tests/unit/cron-respeita-org-operante.test.ts
git commit -F - <<'FIM'
test(cron): cerca de que todo cron respeita organização parada ou diz por quê

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 30: Cerca `org-operante-uma-regua` (AST de decisões)

**Files:** Create `tests/unit/org-operante-uma-regua.test.ts`.

**Interfaces** — Consumes: todas as tarefas acima, em especial a Task 16 (`app/app/layout.tsx` deixou de comparar `orgRow?.status === "suspended"`) e a Task 26 (`rodada.ts`). Escopo: `app/**`, `lib/**`, `workers/**`, fora `lib/organizacao/operante.ts`, `app/admin/**` e `app/api/v1/admin/**` (o painel decide TRANSIÇÃO de estado e conta orgs para exibição, ex.: `app/api/v1/admin/dashboard/kpis/route.ts:57`). Allowlist inicial: só `app/actions/shell/setActiveOrg.ts` (`.eq("organizations.status", "active")` na troca de org).

- [ ] **Passo 1: escrever a cerca**

```ts
/**
 * "ORGANIZAÇÃO OPERANTE" TEM UMA RÉGUA SÓ — `lib/organizacao/operante.ts`.
 *
 * O predicado é `status = 'active'`. Toda DECISÃO sobre operar (redirect, fail,
 * return de gate, `if` que desvia, filtro de seleção por status de org) passa
 * por `ehOperante`/`idsDeOrgsParadas`/`assertOrgOperante` ou pela função SQL
 * `fn_org_operante`. Comparar o status da org com um literal é a segunda régua
 * nascendo: foi assim que as campanhas filtravam só `'suspended'` e deixavam
 * passar a org redigida.
 *
 * Mede AST, não texto: a prosa do repositório cita `status === 'active'` em
 * comentário o tempo todo, e SQL em string (outra tabela, ex.:
 * `lib/agent-engine/agent/org-memory.ts`) não é decisão desta régua.
 *
 * Fora do escopo, de propósito: exibição (JSX, badge) e o painel da plataforma
 * (`app/admin/**`, `app/api/v1/admin/**`), que decide TRANSIÇÃO de estado — ela
 * mora em `fn_suspender_organizacao`/`fn_reativar_organizacao`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const RAIZES = ["app", "lib", "workers"];
const A_REGUA = "lib/organizacao/operante.ts";
const TRANSICAO_DE_ESTADO = ["app/admin/", "app/api/v1/admin/"];
const STATUS_DE_ORG = new Set(["active", "suspended", "redacted", "archived"]);
const RECEPTOR_DE_ORG = /(^|[^a-z])org|organi[sz]a[tcç]/i;
const CHAMADAS_DE_DECISAO = new Set(["redirect", "fail", "notFound"]);
const FILTROS = new Set(["eq", "neq", "in", "not", "filter", "match"]);
const COMPARACOES = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Allowlist que só encolhe: cada entrada ainda tem de conter a decisão. */
const ALLOWLIST: Record<string, string> = {
  "app/actions/shell/setActiveOrg.ts": "troca de org só para ativa; molde anterior ao predicado",
};

function ehLiteralDeStatus(e: ts.Node): boolean {
  return (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && STATUS_DE_ORG.has(e.text);
}

function ehStatusDeOrg(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return e.text === "orgStatus" || e.text === "org_status";
  if (!ts.isPropertyAccessExpression(e)) return false;
  const nome = e.name.text;
  if (nome === "orgStatus" || nome === "org_status") return true;
  return nome === "status" && RECEPTOR_DE_ORG.test(e.expression.getText());
}

function ehComparacaoDeStatusDeOrg(no: ts.Node): no is ts.BinaryExpression {
  if (!ts.isBinaryExpression(no) || !COMPARACOES.has(no.operatorToken.kind)) return false;
  return (
    (ehStatusDeOrg(no.left) && ehLiteralDeStatus(no.right)) ||
    (ehStatusDeOrg(no.right) && ehLiteralDeStatus(no.left))
  );
}

function estaNumaDecisao(no: ts.Node): boolean {
  let filho: ts.Node = no;
  let pai = no.parent;
  while (pai && !ts.isSourceFile(pai) && !ts.isFunctionLike(pai)) {
    if (ts.isReturnStatement(pai)) return true;
    if (ts.isIfStatement(pai) && pai.expression === filho) return true;
    if (
      ts.isCallExpression(pai) &&
      ts.isIdentifier(pai.expression) &&
      CHAMADAS_DE_DECISAO.has(pai.expression.text) &&
      pai.arguments.some((a) => a === filho)
    )
      return true;
    filho = pai;
    pai = pai.parent;
  }
  return false;
}

function cadeiaVemDeOrganizations(e: ts.Expression): boolean {
  let atual: ts.Expression = e;
  for (;;) {
    if (ts.isCallExpression(atual)) {
      const [primeiro] = atual.arguments;
      if (
        ts.isPropertyAccessExpression(atual.expression) &&
        atual.expression.name.text === "from" &&
        primeiro !== undefined &&
        ts.isStringLiteral(primeiro) &&
        primeiro.text === "organizations"
      )
        return true;
      atual = atual.expression;
    } else if (ts.isPropertyAccessExpression(atual) || ts.isParenthesizedExpression(atual) || ts.isAwaitExpression(atual)) {
      atual = atual.expression;
    } else {
      return false;
    }
  }
}

function ehFiltroDeStatusDeOrg(no: ts.Node): boolean {
  if (!ts.isCallExpression(no) || !ts.isPropertyAccessExpression(no.expression)) return false;
  if (!FILTROS.has(no.expression.name.text)) return false;
  const [coluna, ...resto] = no.arguments;
  if (coluna === undefined || !ts.isStringLiteral(coluna)) return false;
  const colunaEmbutida = coluna.text === "organizations.status";
  if (!colunaEmbutida && coluna.text !== "status") return false;
  const temLiteral = resto.some(
    (a) => ehLiteralDeStatus(a) || (ts.isArrayLiteralExpression(a) && a.elements.some(ehLiteralDeStatus)),
  );
  return temLiteral && (colunaEmbutida || cadeiaVemDeOrganizations(no.expression.expression));
}

function decisoesPorStatusDeOrg(fonte: string, nome: string): number[] {
  const arquivo = ts.createSourceFile(
    nome,
    fonte,
    ts.ScriptTarget.Latest,
    true,
    nome.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const linhas: number[] = [];
  const visitar = (no: ts.Node): void => {
    if ((ehComparacaoDeStatusDeOrg(no) && estaNumaDecisao(no)) || ehFiltroDeStatusDeOrg(no)) {
      linhas.push(arquivo.getLineAndCharacterOfPosition(no.getStart(arquivo)).line + 1);
    }
    ts.forEachChild(no, visitar);
  };
  visitar(arquivo);
  return linhas;
}

function arquivosDe(dir: string): string[] {
  const saida: string[] = [];
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules") saida.push(...arquivosDe(rel));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      saida.push(rel);
    }
  }
  return saida;
}

function varrer(): Map<string, number[]> {
  const achados = new Map<string, number[]>();
  for (const raiz of RAIZES) {
    for (const rel of arquivosDe(raiz)) {
      if (rel === A_REGUA || TRANSICAO_DE_ESTADO.some((p) => rel.startsWith(p))) continue;
      const linhas = decisoesPorStatusDeOrg(readFileSync(join(RAIZ, rel), "utf8"), rel);
      if (linhas.length) achados.set(rel, linhas);
    }
  }
  return achados;
}

describe("a sonda (controles no próprio arquivo)", () => {
  it.each([
    [`if (orgRow?.status === "suspended") redirect("/account-suspended");`, "a.ts"],
    [`async function f(){ const { data } = await admin.from("organizations").select("id").eq("status", "suspended"); }`, "b.ts"],
    [`function g(org: { status: string }) { return org.status === "active"; }`, "c.ts"],
    [`db.from("user_organizations").select("x").eq("organizations.status", "active");`, "d.ts"],
    [`if (m.org_status !== "active") return fail("org_suspended", "x", 403);`, "e.ts"],
  ])("acusa decisão por literal: %s", (fonte, nome) => {
    expect(decisoesPorStatusDeOrg(fonte, nome)).toHaveLength(1);
  });

  it.each([
    [`if (!ehOperante(orgRow?.status)) redirect("/account-suspended");`, "f.ts"],
    [`if (user.support.status !== "active") redirect("/support-ended");`, "g.ts"],
    [`const sql = "select 1 from organizations where status = 'active'";`, "h.ts"],
    [`export const X = () => <p>{organization.status === "suspended" && "Suspensa"}</p>;`, "i.tsx"],
    [`admin.from("followup_flow_pointers").select("id").eq("status", "active");`, "j.ts"],
    [`// if (org.status === "active") redirect("/x")\nexport const y = 1;`, "k.ts"],
  ])("não acusa o que não é decisão por literal de org: %s", (fonte, nome) => {
    expect(decisoesPorStatusDeOrg(fonte, nome)).toEqual([]);
  });
});

describe("o repositório", () => {
  const achados = varrer();

  it("nenhuma decisão compara o status da org com literal fora da régua", () => {
    const fora = [...achados.entries()]
      .filter(([arquivo]) => !(arquivo in ALLOWLIST))
      .map(([arquivo, linhas]) => `${arquivo}:${linhas.join(",")}`);
    expect(
      fora,
      "Use ehOperante / idsDeOrgsParadas / assertOrgOperante (lib/organizacao/operante.ts) " +
        "ou fn_org_operante no SQL, em vez de comparar organizations.status com literal.",
    ).toEqual([]);
  });

  it("a allowlist só encolhe: cada entrada ainda contém a decisão, e diz por quê", () => {
    for (const [arquivo, motivo] of Object.entries(ALLOWLIST)) {
      expect(achados.has(arquivo), `${arquivo} já não decide por literal — tire da allowlist`).toBe(true);
      expect(motivo.trim().length).toBeGreaterThanOrEqual(20);
    }
  });
});
```

- [ ] **Passo 2: rodar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run tests/unit/org-operante-uma-regua.test.ts > /tmp/t30.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/t30.log | tail -2
grep -aE "app/|lib/|workers/" /tmp/t30.log | grep -a ":[0-9]" | head
```

Esperado: `exit=0`. Se aparecer arquivo fora da allowlist, converta a decisão para a régua (`ehOperante`/`idsDeOrgsParadas`) com commit próprio `fix(<escopo>): <arquivo> decide pela régua única de org operante` — não o ponha na allowlist. Um falso positivo (decisão que não é sobre operar) entra na allowlist com o motivo.

- [ ] **Passo 3: provar que a cerca morde** (sem commitar)

```bash
cd ~/deskcomm-saas/pr1 || exit 1
cp -p lib/campanhas/rodada.ts /tmp/rodada.bak
printf '\nexport async function sabotagem(admin: SupabaseClient) {\n  return admin.from("organizations").select("id").eq("status", "suspended");\n}\n' >> lib/campanhas/rodada.ts
pnpm exec vitest run tests/unit/org-operante-uma-regua.test.ts > /tmp/t30-sab.log 2>&1; echo "exit=$?"
grep -a "lib/campanhas/rodada.ts" /tmp/t30-sab.log | head -2
cp -p /tmp/rodada.bak lib/campanhas/rodada.ts
grep -c "idsDeOrgsParadas" lib/campanhas/rodada.ts
git status --short lib/campanhas/rodada.ts
```

Esperado: `exit=1` com `lib/campanhas/rodada.ts:<linha>` no log; depois, `grep -c` ≥ `2` (o conserto da Task 26 está lá) e `git status` sem linha.

- [ ] **Passo 4: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add tests/unit/org-operante-uma-regua.test.ts
git commit -F - <<'FIM'
test(organizacao): cerca de uma régua só para organização operante

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 31: A lista e o detalhe de LGPD recebem o endereço dos links

**Files:** Modify `app/app/lgpd/requests/RequestsTable.tsx`, `app/app/lgpd/requests/[id]/_client.tsx`; Create `app/app/lgpd/requests/RequestsTable.test.tsx`.

**Interfaces** — Produces: `RequestsTable({ baseDoPedido?: string })` (padrão `"/app/lgpd/requests/"`); `LgpdRequestDetail({ id: string; hrefDaLista?: string })` (padrão `"/app/lgpd/requests"`). As peças já só dependem de `IdiomaProvider` e do `QueryClientProvider` da raiz (`app/providers.tsx`); o acoplamento com `/app` são dois links fixos — `RequestsTable.tsx:321` e `[id]/_client.tsx:86` —, que mandariam a empresa suspensa de volta ao hub. Prop string, não função: o hub é Server Component.

- [ ] **Passo 1: teste que falha** — `app/app/lgpd/requests/RequestsTable.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const PEDIDO = "aaaaaaaa-0000-4000-8000-000000000001";

vi.mock("@/hooks/useLgpdRequests", () => ({
  useLgpdRequests: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    data: {
      data: [
        {
          id: "aaaaaaaa-0000-4000-8000-000000000001",
          organization_id: "o",
          request_type: "data_request",
          source: "manual",
          contact_id: null,
          external_customer_id: null,
          status: "received",
          attempts: 0,
          received_at: new Date().toISOString(),
          due_at: null,
          completed_at: null,
          emergency: false,
          scope: "contact",
          error_message: null,
          sla_bucket: "ok",
        },
      ],
      meta: { total: 1, page: 1, limit: 25, has_more: false },
    },
  }),
}));

import { RequestsTable } from "./RequestsTable";

describe("RequestsTable: para onde o Ver leva", () => {
  it("por padrão, abre o detalhe em /app", () => {
    render(<RequestsTable />);
    expect(screen.getByRole("link", { name: "Ver" })).toHaveAttribute("href", `/app/lgpd/requests/${PEDIDO}`);
  });

  it("no hub da suspensão, abre no próprio hub, porque o layout de /app devolveria a pessoa para lá", () => {
    render(<RequestsTable baseDoPedido="/account-suspended?pedido=" />);
    expect(screen.getByRole("link", { name: "Ver" })).toHaveAttribute("href", `/account-suspended?pedido=${PEDIDO}`);
  });
});
```

(Confira o hook e o formato de dados que `RequestsTable` consome — `grep -n "useLgpdRequests\|import" app/app/lgpd/requests/RequestsTable.tsx`; se o componente precisa de `IdiomaProvider`/`QueryClientProvider` para renderizar, envolva o `render` como os testes vizinhos de `app/app/lgpd` fazem.)

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run app/app/lgpd/requests/RequestsTable.test.tsx` → FAIL no segundo caso (`href` ainda em `/app/lgpd/requests/…`).

- [ ] **Passo 3: implementar** — em `RequestsTable.tsx`, `export function RequestsTable() {` vira:

```tsx
export function RequestsTable({
  baseDoPedido = "/app/lgpd/requests/",
}: {
  /**
   * Prefixo do "Ver". O hub de `/account-suspended` passa o próprio endereço:
   * o detalhe em `/app/lgpd/requests/[id]` mora sob o layout de `/app`, que
   * devolve a empresa suspensa ao hub. String e não função, porque o hub é
   * Server Component e função não atravessa para o cliente.
   */
  baseDoPedido?: string;
} = {}) {
```

e `<Link href={`/app/lgpd/requests/${r.id}`}>{t("Ver")}</Link>` vira `<Link href={`${baseDoPedido}${r.id}`}>{t("Ver")}</Link>`.

Em `[id]/_client.tsx`:

```tsx
interface Props {
  id: string;
  /** Volta para a lista. O hub de `/account-suspended` passa o próprio endereço (ver `RequestsTable`). */
  hrefDaLista?: string;
}
```

`export function LgpdRequestDetail({ id }: Props) {` → `export function LgpdRequestDetail({ id, hrefDaLista = "/app/lgpd/requests" }: Props) {`, e `<Link href="/app/lgpd/requests">` → `<Link href={hrefDaLista}>`.

- [ ] **Passo 4: ver passar:** `pnpm exec vitest run app/app/lgpd/requests/RequestsTable.test.tsx && pnpm typecheck` → 2 passed; `tsc` exit 0.

- [ ] **Passo 5: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add app/app/lgpd/requests/RequestsTable.tsx app/app/lgpd/requests/RequestsTable.test.tsx "app/app/lgpd/requests/[id]/_client.tsx"
git commit -F - <<'FIM'
refactor(lgpd): a lista e o detalhe recebem o endereço dos links

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 32: `/account-suspended` vira o hub

**Files:** Modify (reescrever) `app/account-suspended/page.tsx`; Create `app/account-suspended/page.test.tsx`; Modify `tests/unit/lang-das-telas-fora-do-app.test.tsx`, `lib/i18n/dicionario.ts`, `docs/threat-model.md` (hoje `:43`).

**Interfaces**
- Consumes: `requireAuth()` (`lib/auth/server.ts`, `:330` em `d03c2b2fd`), `orgAtivaSemPortao` com `org_status` (Task 8); `ehOperante` (Task 7); `ROLE_RANK` (`lib/auth/types.ts`); `emailDeSuporte()` (`lib/branding/saida.ts:243`, lê `SUPPORT_EMAIL`); `OutrasOrganizacoes({ outras: Array<{ id: string; nome: string }> })` (`app/onboarding/_components/OutrasOrganizacoes.tsx`, troca por `setActiveOrg`, que só aceita org `active`); `RequestsTable`/`LgpdRequestDetail` (Task 31); rotas `app/api/v1/lgpd/**` com `permiteOrgSuspensa` (Task 10); `IdiomaProvider` (`lib/i18n/IdiomaProvider.tsx`); `z.uuid()` (zod 4).
- Produces: `AccountSuspendedPage({ searchParams: Promise<{ pedido?: string }> })`; hub com heading "Conta suspensa", seção "Solicitações LGPD" só para quem administra, `?pedido=<uuid>` abre o detalhe.

Decisões medidas: LGPD só para quem administra (as 5 rotas LGPD exigem `requireRole("admin")`); kind `cobranca` recebe o mesmo texto nesta PR (ninguém o produz ainda — a página nem lê `suspended_kind`); trocar de empresa reusa `OutrasOrganizacoes` ("Voltar para X" / "Ir para outra organização", já com `es`).

- [ ] **Passo 1: teste que falha** — `app/account-suspended/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cena = vi.hoisted(() => ({
  B: "00000000-0000-4000-8000-00000000000b",
  C: "00000000-0000-4000-8000-00000000000c",
  D: "00000000-0000-4000-8000-00000000000d",
  papel: "admin" as "admin" | "agent",
  status: {} as Record<string, string>,
  statusNaSessao: undefined as string | undefined,
  falhaNaLeitura: false,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    email: "admin@empresa.test",
    is_platform_admin: false,
    support: null,
    idioma: "pt-BR",
    organizations: [
      { organization_id: cena.B, organization_name: "Empresa B", role: cena.papel },
      { organization_id: cena.C, organization_name: "Empresa C", role: "admin" },
      { organization_id: cena.D, organization_name: "Empresa D", role: "admin" },
    ],
  }),
  // A régua da SESSÃO (o embed de `loadAuthUser`), que é a do `resolveActiveOrg`
  // do layout; `statusNaSessao` só difere do banco no caso da divergência.
  orgAtivaSemPortao: async () => ({
    orgId: cena.B, name: "Empresa B", role: cena.papel,
    org_status: cena.statusNaSessao ?? cena.status[cena.B],
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        in: async (_coluna: string, ids: string[]) =>
          cena.falhaNaLeitura
            ? { data: null, error: { message: "rede" } }
            : { data: ids.map((id) => ({ id, status: cena.status[id] ?? "active" })), error: null },
      }),
    }),
  }),
}));
vi.mock("@/lib/branding/saida", () => ({ emailDeSuporte: async () => "suporte@revenda.test" }));
vi.mock("@/app/app/lgpd/requests/RequestsTable", () => ({
  RequestsTable: ({ baseDoPedido }: { baseDoPedido?: string }) => <p data-testid="lgpd-lista">{baseDoPedido}</p>,
}));
vi.mock("@/app/app/lgpd/requests/[id]/_client", () => ({
  LgpdRequestDetail: ({ id, hrefDaLista }: { id: string; hrefDaLista?: string }) => (
    <p data-testid="lgpd-pedido">{`${id} ${hrefDaLista}`}</p>
  ),
}));
vi.mock("@/app/onboarding/_components/OutrasOrganizacoes", () => ({
  OutrasOrganizacoes: ({ outras }: { outras: Array<{ id: string; nome: string }> }) => (
    <p data-testid="outras">{outras.map((o) => o.nome).join(",")}</p>
  ),
}));

import AccountSuspendedPage from "./page";

async function montar(pedido?: string) {
  return render(await AccountSuspendedPage({ searchParams: Promise.resolve(pedido ? { pedido } : {}) }));
}

beforeEach(() => {
  cena.papel = "admin";
  cena.status = { [cena.B]: "suspended", [cena.C]: "active", [cena.D]: "suspended" };
  cena.statusNaSessao = undefined;
  cena.falhaNaLeitura = false;
});

describe("/account-suspended: o hub de quem está numa empresa suspensa", () => {
  it("empresa que opera não fica presa aqui: volta para /app", async () => {
    cena.status[cena.B] = "active";
    await expect(montar()).rejects.toThrow("NEXT_REDIRECT:/app");
  });

  // Review Focus 2: o layout de /app manda para cá se QUALQUER das duas réguas
  // (sessão ou leitura do banco) diz parada; o hub só devolve para /app quando
  // AS DUAS dizem que opera. Sem isso, a divergência vira laço de 307.
  it.each([
    ["sessão diz parada, banco diz ativa", "suspended", "active"],
    ["sessão diz ativa, banco diz parada", "active", "suspended"],
  ])("%s → renderiza o hub, sem redirect", async (_nome, naSessao, noBanco) => {
    cena.statusNaSessao = naSessao;
    cena.status[cena.B] = noBanco;
    await montar();
    expect(screen.getByRole("heading", { name: "Conta suspensa" })).toBeVisible();
  });

  it("admin vê o suporte, a LGPD abrindo no próprio hub e só as empresas que operam", async () => {
    await montar();
    expect(screen.getByRole("heading", { name: "Conta suspensa" })).toBeVisible();
    expect(screen.getByRole("link", { name: "suporte@revenda.test" })).toHaveAttribute("href", "mailto:suporte@revenda.test");
    expect(screen.getByTestId("lgpd-lista")).toHaveTextContent("/account-suspended?pedido=");
    expect(screen.getByTestId("outras")).toHaveTextContent(/^Empresa C$/);
  });

  it("quem não administra é mandado ao administrador, sem LGPD e sem o endereço do suporte", async () => {
    cena.papel = "agent";
    await montar();
    expect(screen.getByText("Sua conta está suspensa. Avise o administrador da sua empresa.")).toBeVisible();
    expect(screen.queryByTestId("lgpd-lista")).toBeNull();
    expect(screen.queryByRole("link", { name: "suporte@revenda.test" })).toBeNull();
  });

  it("?pedido= com uuid abre o detalhe no hub", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await montar(id);
    expect(screen.getByTestId("lgpd-pedido")).toHaveTextContent(`${id} /account-suspended`);
  });

  it("?pedido= que não é uuid cai na lista", async () => {
    await montar("../app/inbox");
    expect(screen.getByTestId("lgpd-lista")).toBeVisible();
    expect(screen.queryByTestId("lgpd-pedido")).toBeNull();
  });

  it("leitura do estado que falha LANÇA: nem hub nem redirect por palpite", async () => {
    cena.falhaNaLeitura = true;
    await expect(montar()).rejects.toThrow(/account_suspended_status_indisponivel/);
  });
});
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run app/account-suspended/page.test.tsx` → FAIL (a página atual não lê sessão; "empresa que opera" não lança; LGPD e "Avise o administrador" ausentes).

- [ ] **Passo 3: implementar** — substitua `app/account-suspended/page.tsx` inteiro por:

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";

import { LgpdRequestDetail } from "@/app/app/lgpd/requests/[id]/_client";
import { RequestsTable } from "@/app/app/lgpd/requests/RequestsTable";
import { OutrasOrganizacoes } from "@/app/onboarding/_components/OutrasOrganizacoes";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { orgAtivaSemPortao, requireAuth } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { emailDeSuporte } from "@/lib/branding/saida";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { traduzir } from "@/lib/i18n/dicionario";
import { ehOperante } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Conta suspensa",
};

const PEDIDO = z.uuid();

/**
 * O HUB de quem está numa empresa suspensa (spec da cobrança do revendedor, §9).
 *
 * Fica fora de `app/app/` de propósito: quem manda a empresa suspensa para cá é
 * o layout de `/app`, então nada aqui pode depender dele. Não lê `x-pathname`:
 * o `proxy.ts` grava esse cabeçalho DEPOIS do `NextResponse.next`.
 *
 * Esta tela entregava o NOSSO endereço de suporte ao cliente de um revendedor,
 * e aqui isso é ativamente errado: quem suspendeu a conta foi o revendedor, e
 * escrever para nós não desbloqueia nada. O endereço sai de `SUPPORT_EMAIL`
 * (o do operador) e, quando ninguém configurou, o parágrafo do contato NÃO
 * renderiza.
 *
 * ponytail: nesta entrega ninguém produz a suspensão de kind `cobranca`, e se
 * ela aparecer recebe o mesmo texto administrativo. Por isso a página não lê
 * `suspended_kind`. O painel de pagamento entra com a régua (PR 3a).
 */
export default async function AccountSuspendedPage({
  searchParams,
}: {
  searchParams: Promise<{ pedido?: string }>;
}) {
  const user = await requireAuth();
  const ativa = await orgAtivaSemPortao(user);
  if (!ativa) redirect("/app");

  // Service role com ids que vieram da SESSÃO (a org ativa e os vínculos do
  // próprio usuário), nunca da URL. Uma leitura responde as duas perguntas:
  // a ativa opera? e quais das outras operam?
  const ids = [...new Set([ativa.orgId, ...user.organizations.map((o) => o.organization_id)])];
  const { data: orgs, error } = await createAdminClient()
    .from("organizations")
    .select("id, status")
    .in("id", ids);
  // Leitura que não aconteceu não vira resposta: redirecionar por palpite
  // prenderia a pessoa num laço com o layout de `/app`.
  if (error) throw new Error(`account_suspended_status_indisponivel: ${error.message}`);
  const statusDe = new Map((orgs ?? []).map((o) => [o.id, o.status]));
  // Volta para `/app` só quando AS DUAS réguas que o layout de `/app` usa dizem
  // que a org opera: a da sessão (`org_status`, a do `resolveActiveOrg`) e a do
  // banco (a leitura por service role, a do `orgRow.status` do layout). O layout
  // manda para cá quando QUALQUER uma diz parada; olhar só uma aqui faria da
  // divergência um laço de 307.
  if (ehOperante(ativa.org_status) && ehOperante(statusDe.get(ativa.orgId))) redirect("/app");

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  // A MESMA régua da página `/app/lgpd/requests` e das rotas `/api/v1/lgpd/**`.
  const administra =
    (user.is_platform_admin && !user.support) || ROLE_RANK[ativa.role] >= ROLE_RANK.admin;
  const suporte = administra ? await emailDeSuporte() : "";
  const outras = user.organizations
    .filter((o) => o.organization_id !== ativa.orgId && ehOperante(statusDe.get(o.organization_id)))
    .map((o) => ({ id: o.organization_id, nome: o.organization_name }));
  const { pedido } = await searchParams;
  const pedidoAberto = administra && PEDIDO.safeParse(pedido).success ? pedido : undefined;

  return (
    <IdiomaProvider locale={idioma}>
      <main className="flex min-h-screen flex-col items-center gap-8 p-4 sm:p-8">
        <Card className="w-full max-w-md space-y-4 p-8 text-center">
          <h1 className="text-2xl font-semibold">{t("Conta suspensa")}</h1>
          {!administra ? (
            <p className="text-sm text-muted-foreground">
              {t("Sua conta está suspensa. Avise o administrador da sua empresa.")}
            </p>
          ) : suporte ? (
            <p className="text-sm text-muted-foreground">
              {t("Sua conta está suspensa. Entre em contato com")}{" "}
              <a
                href={`mailto:${suporte}`}
                className="underline underline-offset-4 hover:text-foreground transition-colors"
              >
                {suporte}
              </a>{" "}
              {t("para mais informações.")}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(
                "Sua conta está suspensa. Fale com quem administra este sistema para saber o motivo e como reativá-la.",
              )}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <OutrasOrganizacoes outras={outras} />
            <Button asChild variant="outline">
              <Link href="/login">{t("Sair")}</Link>
            </Button>
          </div>
        </Card>
        {administra && (
          <section aria-labelledby="lgpd-no-hub" className="w-full max-w-5xl space-y-4">
            <header className="space-y-1">
              <h2 id="lgpd-no-hub" className="text-lg font-semibold">
                {t("Solicitações LGPD")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("Os pedidos de LGPD dos seus clientes continuam com prazo durante a suspensão.")}
              </p>
            </header>
            {pedidoAberto ? (
              <LgpdRequestDetail id={pedidoAberto} hrefDaLista="/account-suspended" />
            ) : (
              <RequestsTable baseDoPedido="/account-suspended?pedido=" />
            )}
          </section>
        )}
      </main>
    </IdiomaProvider>
  );
}
```

(Medido em `d03c2b2fd`: os textos "Conta suspensa", "Sua conta está suspensa. Entre em contato com", "para mais informações.", "Sair" e o fallback "Sua conta está suspensa. Fale com quem administra…" já existem na página atual e no dicionário, e ficam idênticos; "Solicitações LGPD" já tem `es` (`dicionario.ts:7818`, "Solicitudes LGPD"); `IdiomaProvider` recebe `locale` (`lib/i18n/IdiomaProvider.tsx:61-65`).)

`lib/i18n/dicionario.ts` — confira `grep -c '"Sua conta está suspensa. Avise o administrador\|"Os pedidos de LGPD dos seus clientes' lib/i18n/dicionario.ts` → `0`; logo depois do bloco

```ts
  "Sua conta está suspensa. Fale com quem administra este sistema para saber o motivo e como reativá-la.": {
    es: "Tu cuenta está suspendida. Habla con quien administra este sistema para saber el motivo y cómo reactivarla.",
  },
```

acrescente:

```ts
  "Sua conta está suspensa. Avise o administrador da sua empresa.": {
    es: "Tu cuenta está suspendida. Avisa a quien administra tu empresa.",
  },
  "Os pedidos de LGPD dos seus clientes continuam com prazo durante a suspensão.": {
    es: "Las solicitudes LGPD de tus clientes siguen con plazo durante la suspensión.",
  },
```

- [ ] **Passo 4: ver passar o teste novo:** `pnpm exec vitest run app/account-suspended/page.test.tsx` → 8 passed.

- [ ] **Passo 5: ver falhar o teste irmão:** `pnpm exec vitest run tests/unit/lang-das-telas-fora-do-app.test.tsx` → FAIL em `/account-suspended` (a tela agora exige sessão e `searchParams`).

- [ ] **Passo 6: adaptar o teste irmão** — em `tests/unit/lang-das-telas-fora-do-app.test.tsx`, logo depois de `vi.mock("@/lib/auth/invite-token", …);`:

```ts
// `/account-suspended` virou o hub: exige sessão e lê o estado da org. As peças
// de LGPD e a troca de org são clientes com dados próprios e ficam de fora daqui.
// O que se mede aqui é só o `lang`.
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({
    id: "u",
    email: "x@exemplo.com",
    is_platform_admin: false,
    support: null,
    idioma: locale.valor === "es" ? "es" : "pt-BR",
    organizations: [{ organization_id: "o", organization_name: "Empresa", role: "admin" }],
  }),
  orgAtivaSemPortao: async () => ({ orgId: "o", name: "Empresa", role: "admin", org_status: "suspended" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ in: async () => ({ data: [{ id: "o", status: "suspended" }], error: null }) }) }),
  }),
}));
vi.mock("@/app/app/lgpd/requests/RequestsTable", () => ({ RequestsTable: () => null }));
vi.mock("@/app/app/lgpd/requests/[id]/_client", () => ({ LgpdRequestDetail: () => null }));
vi.mock("@/app/onboarding/_components/OutrasOrganizacoes", () => ({ OutrasOrganizacoes: () => null }));
```

e a linha de `TELAS`

```ts
  ["/account-suspended", async () => (await import("@/app/account-suspended/page")).default()],
```

vira

```ts
  [
    "/account-suspended",
    async () =>
      (await import("@/app/account-suspended/page")).default({ searchParams: Promise.resolve({}) }),
  ],
```

(Medido em `d03c2b2fd`: `locale` é o `vi.hoisted` de `:19` (`locale.valor`); nenhuma outra tela da lista `TELAS` (`/403`, `/500`, `/acesso-revogado`, `/admin/forbidden`, o layout de `/legal`, `/team/accept-invite/[token]`) importa `@/lib/auth/server` ou `@/lib/supabase/admin`, então os dois mocks novos só alcançam o hub.)

- [ ] **Passo 7: modelo de ameaça (DoD 16)** — em `docs/threat-model.md`, troque

```
| `/account-suspended`, `/403`, `/404`, `/500`, `/503`, `/admin/forbidden` | — | ❌ |
```

por

```
| `/403`, `/404`, `/500`, `/503`, `/admin/forbidden` | — | ❌ |
| `/account-suspended` | `requireAuth()` + organização ativa da SESSÃO; o estado das orgs é lido por service role só com ids da sessão, nunca da URL | ❌ |
```

- [ ] **Passo 8: ver passar**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm exec vitest run app/account-suspended/page.test.tsx tests/unit/lang-das-telas-fora-do-app.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts
pnpm typecheck; pnpm lint
```

Esperado: todos passam; `tsc` e `eslint` com código 0.

- [ ] **Passo 9: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add app/account-suspended/page.tsx app/account-suspended/page.test.tsx tests/unit/lang-das-telas-fora-do-app.test.tsx lib/i18n/dicionario.ts docs/threat-model.md
git commit -F - <<'FIM'
feat(suspensao): /account-suspended vira o hub com LGPD e troca de empresa

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 33: Mapa vivo da suspensão (DoD 13)

**Files:** Create `docs/architecture/suspensao-de-organizacao.architecture.json`; Modify `tests/unit/mapas-de-arquitetura.test.ts`, `docs/architecture/README.md` (última linha da tabela "Mapas").

**Interfaces** — Consumes: o tipo `Mapa`, `DIR`, `fs`, `path` já usados em `tests/unit/mapas-de-arquitetura.test.ts`. O `cobranca-do-revendedor.architecture.json` da §13 é da capacidade inteira (PR 2+); a PR 1 tem mapa próprio.

- [ ] **Passo 1: teste que falha** — em `tests/unit/mapas-de-arquitetura.test.ts`, depois do caso `"o índice de atrito está no mapa, e com mais de duas arestas"`:

```ts
  it("a suspensão que suspende está no mapa, e nenhuma peça dela é ilha", () => {
    // O caso concreto do DoD 13 para a PR 1 da cobrança do revendedor. O laço
    // de retorno é `fnReativar → itemCentral → central → fila`: é por ele que
    // uma pessoa revisa o que chegou enquanto a IA estava calada.
    const m = JSON.parse(
      fs.readFileSync(path.join(DIR, "suspensao-de-organizacao.architecture.json"), "utf8"),
    ) as Mapa;
    const grau = (id: string) => (m.edges ?? []).filter((e) => e.from === id || e.to === id).length;
    for (const n of m.nodes!) {
      expect(grau(n.id), `${n.id} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
    const liga = (de: string, para: string) => (m.edges ?? []).some((e) => e.from === de && e.to === para);
    expect(liga("fnReativar", "itemCentral"), "a reativação não deixa rastro para uma pessoa revisar").toBe(true);
    expect(liga("central", "fila"), "o aviso de reativação não leva à Fila").toBe(true);
    expect(liga("operante", "motor"), "a régua única não chega ao motor da IA").toBe(true);
  });
```

- [ ] **Passo 2: ver falhar:** `pnpm exec vitest run tests/unit/mapas-de-arquitetura.test.ts` → FAIL com `ENOENT … suspensao-de-organizacao.architecture.json`.

- [ ] **Passo 3: criar o mapa** `docs/architecture/suspensao-de-organizacao.architecture.json`:

```json
{
  "schema_version": 1,
  "diagram_type": "architecture",
  "meta": {
    "title": "Suspensão que suspende",
    "subtitle": "Uma régua de 'opera', uma única escrita do estado e a revisão depois da volta",
    "output": "suspensao-de-organizacao.html",
    "quality_profile": "standard"
  },
  "lanes": [
    { "id": "pessoa", "label": "Pessoa" },
    { "id": "app", "label": "Aplicativo" },
    { "id": "motor", "label": "Motor da IA e barramento" },
    { "id": "db", "label": "Banco" }
  ],
  "mainPath": ["telaAdmin", "rotaSuspensao", "fnSuspender", "orgs", "operante", "sessao", "hub"],
  "nodes": [
    { "id": "telaAdmin", "lane": "pessoa", "col": 0, "type": "ui", "label": "/admin/tenants/[id] › Suspender / Reativar", "sublabel": "o botão lê organizations.status" },
    { "id": "rotaSuspensao", "lane": "app", "col": 1, "type": "api", "label": "POST admin/tenants/[id]/suspend · /reactivate", "sublabel": "requirePlatformAdminEscrita: scope full + MFA; kind cobranca → 409" },
    { "id": "fnSuspender", "lane": "db", "col": 2, "type": "database", "label": "fn_suspender_organizacao", "sublabel": "for update; kind; fila e envio fechados; tenant.suspended na mesma transação" },
    { "id": "fnReativar", "lane": "db", "col": 2, "type": "database", "label": "fn_reativar_organizacao", "sublabel": "guarda do kind; zero rajada; conta conversas com inbound desde suspended_at" },
    { "id": "orgs", "lane": "db", "col": 3, "type": "table", "label": "organizations.status + suspended_kind" },
    { "id": "filaEEnvio", "lane": "db", "col": 3, "type": "table", "label": "job_queue pending → failed · messages queued → failed" },
    { "id": "gatilhoEstado", "lane": "db", "col": 4, "type": "database", "label": "trg_organizacao_estado_so_pelo_servidor", "sublabel": "authenticated/anon: 42501 em status, suspended_*, created_by e INSERT" },
    { "id": "eventLog", "lane": "db", "col": 4, "type": "table", "label": "event_log", "sublabel": "tenant.suspended / tenant.reactivated; evento de org parada consumido como skipped" },
    { "id": "itemCentral", "lane": "db", "col": 4, "type": "table", "label": "agent_inbox_items kind org_reativada", "sublabel": "sem referência; severity warn" },
    { "id": "postgrest", "lane": "app", "col": 3, "type": "api", "label": "PostgREST com JWT de sessão", "sublabel": "inclusive platform admin support_readonly" },
    { "id": "operante", "lane": "app", "col": 4, "type": "lib", "label": "lib/organizacao/operante.ts · fn_org_operante", "sublabel": "opera ⇔ status = 'active'" },
    { "id": "sessao", "lane": "app", "col": 5, "type": "service", "label": "resolveActiveOrg · requireRole · resolveApiToken", "sublabel": "redirect /account-suspended · 403 org_suspended" },
    { "id": "lgpd", "lane": "app", "col": 6, "type": "api", "label": "/api/v1/lgpd/**", "sublabel": "permiteOrgSuspensa: a LGPD nunca para" },
    { "id": "motor", "lane": "motor", "col": 5, "type": "service", "label": "gate de elegibilidade · dispatcher naOrgParada", "sublabel": "veto org_nao_operante; handler 'pula' → skipped" },
    { "id": "hub", "lane": "pessoa", "col": 6, "type": "ui", "label": "/account-suspended (hub)", "sublabel": "suporte ou 'avise o administrador'; LGPD; voltar para outra empresa" },
    { "id": "central", "lane": "pessoa", "col": 5, "type": "ui", "label": "Central de avisos (/app/ai/inbox)" },
    { "id": "fila", "lane": "pessoa", "col": 7, "type": "ui", "label": "/app/inbox, aba Fila" }
  ],
  "edges": [
    { "id": "e1", "from": "telaAdmin", "to": "rotaSuspensao", "label": "suspender / reativar com motivo" },
    { "id": "e2", "from": "rotaSuspensao", "to": "fnSuspender", "label": "kind administrativa" },
    { "id": "e3", "from": "rotaSuspensao", "to": "fnReativar", "label": "kind exigido administrativa" },
    { "id": "e4", "from": "fnSuspender", "to": "orgs", "label": "status=suspended, suspended_kind" },
    { "id": "e5", "from": "fnSuspender", "to": "filaEEnvio", "label": "pending/queued → failed" },
    { "id": "e6", "from": "fnSuspender", "to": "eventLog", "label": "tenant.suspended" },
    { "id": "e7", "from": "fnReativar", "to": "orgs", "label": "status=active, suspended_* nulos" },
    { "id": "e8", "from": "fnReativar", "to": "filaEEnvio", "label": "cinto: pending antigo → failed" },
    { "id": "e9", "from": "fnReativar", "to": "eventLog", "label": "tenant.reactivated" },
    { "id": "e10", "from": "fnReativar", "to": "itemCentral", "label": "um item com a contagem de conversas" },
    { "id": "e11", "from": "postgrest", "to": "gatilhoEstado", "label": "PATCH/INSERT com JWT" },
    { "id": "e12", "from": "gatilhoEstado", "to": "orgs", "label": "guarda as colunas de estado" },
    { "id": "e13", "from": "gatilhoEstado", "to": "postgrest", "label": "recusa 42501" },
    { "id": "e14", "from": "orgs", "to": "telaAdmin", "label": "mostra Suspender ou Reativar" },
    { "id": "e15", "from": "orgs", "to": "operante", "label": "status" },
    { "id": "e16", "from": "operante", "to": "sessao", "label": "ehOperante" },
    { "id": "e17", "from": "operante", "to": "motor", "label": "orgStatus / idsDeOrgsParadas" },
    { "id": "e18", "from": "motor", "to": "eventLog", "label": "skipped: org_nao_operante" },
    { "id": "e19", "from": "sessao", "to": "hub", "label": "redirect da org parada" },
    { "id": "e20", "from": "sessao", "to": "lgpd", "label": "exceção permiteOrgSuspensa" },
    { "id": "e21", "from": "hub", "to": "lgpd", "label": "pedidos de LGPD no próprio hub" },
    { "id": "e22", "from": "sessao", "to": "fila", "label": "só com org operante" },
    { "id": "e23", "from": "itemCentral", "to": "central", "label": "projeção sob RLS" },
    { "id": "e24", "from": "central", "to": "fila", "label": "Abrir o Inbox" }
  ],
  "cards": [
    {
      "dot": "rose",
      "title": "Não-ligações declaradas: o que a suspensão NÃO corta",
      "items": [
        "webhooks de entrada (waha, meta, channel, in/[token], nuvemshop) continuam gravando: a mensagem chega e fica, e nada responde",
        "landings anuncios/*/[org] e rastreio/[id] seguem de pé (decisão D-11): cortá-las desperdiçaria a verba de anúncio do cliente final",
        "escrita de dados de negócio pelo PostgREST, por membro da org suspensa, segue pela RLS (decisão D-12). Nada que custe ou saia passa por aí",
        "fn_support_write_allowed e emit_event NÃO olham o status: derrubariam a LGPD e a própria entrada de mensagens"
      ]
    }
  ]
}
```

(Confira os `type` de nó aceitos pelos outros mapas — `grep -ho '"type": "[a-z]*"' docs/architecture/*.architecture.json | sort -u` — e troque qualquer tipo que o validador não conheça.)

- [ ] **Passo 4: README** — última linha da tabela "Mapas" de `docs/architecture/README.md`:

```
| `suspensao-de-organizacao.architecture.json` | suspensão que suspende (PR 1 da cobrança do revendedor): 17 peças, 24 arestas; a régua única de "opera", a escrita do estado só por duas funções definer (e o gatilho que fecha o PostgREST), o hub `/account-suspended` e o laço de retorno pela Central até a Fila; as **não-ligações declaradas** (entrada de mensagens, landings, escrita pela RLS) estão no card do próprio mapa |
```

- [ ] **Passo 5: ver passar:** `pnpm exec vitest run tests/unit/mapas-de-arquitetura.test.ts` → todos passam, inclusive o caso novo e "nenhuma peça é ilha".

- [ ] **Passo 6: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add docs/architecture/suspensao-de-organizacao.architecture.json docs/architecture/README.md tests/unit/mapas-de-arquitetura.test.ts
git commit -F - <<'FIM'
docs(arquitetura): o mapa vivo da suspensão, com o laço de retorno pela Central

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 34: e2e `tests/e2e/suspensao-administrativa.spec.ts` no CI

**Files:** Create `tests/e2e/suspensao-administrativa.spec.ts`; Modify `.github/workflows/e2e.yml` (`SPECS_PARTE_6`, hoje `:1152-1153`).

**Interfaces**
- Consumes: tudo da PR 1 pela tela e pelo HTTP — `TenantActions`/`SuspendDialog` (`aria-label="Suspender tenant"`, `#suspend-reason`, "Confirmar suspensão"; toast "Erro ao suspender tenant" de `hooks/useSuspendTenant.ts`), `ReactivateDialog` (`#reactivate-reason`, "Confirmar reativação"), Central `data-testid="inbox-item"` (`app/app/ai/inbox/_components/AgentInboxList.tsx`, renderiza `title`, `body`, orientação e o link do destino), `OutrasOrganizacoes` `data-testid="sair-do-onboarding"`, cookie `active_org`; `decidirElegibilidadeDaConversaViaSupabase` (Task 18, contra PostgREST real — Review Focus 4); `fn_mark_conversation_message` (move `last_inbound_at`, contado pela Task 5).
- Moldes: `tests/e2e/suporte-temporario.spec.ts` (fixtures pelo service role e limpeza no `finally`), `tests/e2e/central-avisos-destino.spec.ts`.
- Por que o cookie `active_org`: sem cookie, `escolherMembroAtivo` prefere a membership operante (Task 8); o cookie reproduz "estava trabalhando em B quando B foi suspensa".

- [ ] **Passo 1: escrever a spec** (confira antes os seletores: `grep -rn 'Suspender tenant\|suspend-reason\|Confirmar suspensão\|Reativar tenant\|reactivate-reason\|Erro ao suspender tenant\|sair-do-onboarding' app components hooks`; e as colunas obrigatórias das tabelas semeadas no `baseline.sql`)

```ts
/**
 * E2E: a suspensão que suspende, pela tela (PR 1 da cobrança do revendedor).
 *
 * Spec: `docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md`,
 * §1.3, §4, §9 ("Suspenso") e §14 (PR 1). Sem chave de cobrança e sem plano:
 * é a suspensão ADMINISTRATIVA, que já existia e só tirava a pessoa da tela.
 *
 * Um caso só, porque cada passo depende do estado do anterior:
 *   1. quem só tem leitura clica em Suspender e vê o erro. A empresa segue ativa;
 *   2. o dono suspende B pela tela. Job pendente e mensagem na fila viram `failed`,
 *      e o gate de elegibilidade (pelo PostgREST real) passa a negar;
 *   3. a admin de B cai no hub, abre um pedido de LGPD ali mesmo e vê a volta para C;
 *   4. `/app/inbox` volta para o hub, e o token `dsk_` de B responde 403;
 *   5. a captação por `webhooks/in/[token]` é GRAVADA, e nada responde:
 *      nenhuma `llm_calls`, nenhuma mensagem de saída;
 *   6. a atendente de B lê "Avise o administrador", sem LGPD;
 *   7. o dono reativa. Nada sai em rajada, e a Central mostra o item de revisão.
 *
 * Self-contida: orgs, pessoas, token, fonte e pedido de LGPD nascem pelo
 * service role com sufixo próprio e morrem no `finally`.
 *
 * NÃO prova a IA calada com um agente publicado de verdade: B não tem agente,
 * então "zero llm_calls" também valeria sem o conserto. Quem prova o veto é
 * `lib/ai/elegibilidade/gate.test.ts`, `tests/invariants/org-suspensa.test.ts`
 * e o controle do gate pelo PostgREST no passo 2.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";

import { test, expect, type BrowserContext, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const senha = `Local-${randomUUID()}!`;
const sufixo = randomUUID().slice(0, 8);
const EVIDENCIA = "evidence/suspensao-administrativa";

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function criarPessoa(rotulo: string): Promise<{ id: string; email: string }> {
  const email = `susp-${rotulo}-${sufixo}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (error || !data.user) throw error ?? new Error(`não criou ${rotulo}`);
  return { id: data.user.id, email };
}

async function entrar(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

async function estadoDaOrg(id: string): Promise<{ status: string; suspended_kind: string | null }> {
  const { data, error } = await db.from("organizations").select("status, suspended_kind").eq("id", id).single();
  if (error) throw error;
  return data as { status: string; suspended_kind: string | null };
}

async function saidasDe(org: string): Promise<{ llm: number; outbound: number }> {
  const llm = await db.from("llm_calls").select("id", { count: "exact", head: true }).eq("organization_id", org);
  if (llm.error) throw llm.error;
  const outbound = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org)
    .eq("direction", "outbound")
    .neq("status", "failed");
  if (outbound.error) throw outbound.error;
  return { llm: llm.count ?? -1, outbound: outbound.count ?? -1 };
}

function segredoInterno(): string {
  const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!segredo) throw new Error("sem INTERNAL_CRON_SECRET/INTERNAL_SECRET no ambiente do e2e");
  return segredo;
}

test("suspender cala B pela tela; o hub atende quem ficou; reativar não solta rajada", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(20_000);
  mkdirSync(EVIDENCIA, { recursive: true });
  const pessoas: string[] = [];
  const orgs: string[] = [];
  const contextos: BrowserContext[] = [];
  let falhaDoCenario: unknown;

  try {
    // ── Fixtures ────────────────────────────────────────────────────────────
    const dono = await criarPessoa("dono");
    const leitura = await criarPessoa("leitura");
    const adminB = await criarPessoa("admin-b");
    const atendenteB = await criarPessoa("atendente-b");
    pessoas.push(dono.id, leitura.id, adminB.id, atendenteB.id);

    const agora = new Date().toISOString();
    const orgB = await inserir("organizations", {
      slug: `susp-b-${sufixo}`, display_name: `Suspensa B ${sufixo}`, legal_name: "Suspensa B", onboarded_at: agora,
    });
    const orgC = await inserir("organizations", {
      slug: `susp-c-${sufixo}`, display_name: `Ativa C ${sufixo}`, legal_name: "Ativa C", onboarded_at: agora,
    });
    orgs.push(orgB, orgC);

    const vinculos = await db.from("user_organizations").insert([
      { organization_id: orgB, user_id: adminB.id, role: "admin", accepted_at: new Date(Date.now() - 60_000).toISOString() },
      { organization_id: orgC, user_id: adminB.id, role: "admin", accepted_at: agora },
      { organization_id: orgB, user_id: atendenteB.id, role: "agent", accepted_at: agora },
      { organization_id: orgC, user_id: dono.id, role: "admin", accepted_at: agora },
      { organization_id: orgC, user_id: leitura.id, role: "viewer", accepted_at: agora },
    ]);
    if (vinculos.error) throw vinculos.error;
    const admins = await db.from("platform_admins").insert([
      { user_id: dono.id, granted_by: dono.id, scope: "full", mfa_required: false, reason: "E2E suspensão" },
      { user_id: leitura.id, granted_by: dono.id, scope: "support_readonly", mfa_required: false, reason: "E2E suspensão leitura" },
    ]);
    if (admins.error) throw admins.error;

    const canal = await inserir("channel_sessions", {
      organization_id: orgB, waha_session_name: `susp-${randomUUID()}`, display_name: "Canal B", status: "STOPPED", webhook_secret_encrypted: "\\x00",
    });
    const contato = await inserir("contacts", {
      organization_id: orgB, name: `Cliente B ${sufixo}`, display_name: `Cliente B ${sufixo}`,
    });
    const conversa = await inserir("conversations", {
      organization_id: orgB, contact_id: contato, channel_session_id: canal, status: "open",
    });
    const funil = await inserir("crm_pipelines", { organization_id: orgB, name: "Funil B", slug: `susp-${sufixo}` });
    const etapa = await inserir("crm_stages", { organization_id: orgB, pipeline_id: funil, name: "Entrada", slug: "entrada", position: 1 });
    const pathToken = `susp_${randomBytes(16).toString("hex")}`;
    await inserir("webhook_sources", {
      organization_id: orgB, name: `Captação B ${sufixo}`, path_token: pathToken, default_pipeline_id: funil, default_stage_id: etapa,
    });
    const pedidoLgpd = await inserir("lgpd_requests", {
      organization_id: orgB, request_type: "data_request", source: "manual", contact_id: contato,
      due_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    // O acúmulo que a suspensão precisa fechar: um turno agendado e uma resposta na fila.
    const jobPendente = await inserir("job_queue", {
      organization_id: orgB, contact_id: contato, kind: "inbound_turn", run_after: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const msgNaFila = await inserir("messages", {
      organization_id: orgB, conversation_id: conversa, channel_session_id: canal, contact_id: contato,
      direction: "outbound", type: "text", body: "Não deve sair", status: "queued",
    });
    const tokenPlano = `dsk_${randomBytes(4).toString("hex")}_${randomBytes(32).toString("base64url")}`;
    await inserir("api_tokens", {
      organization_id: orgB, created_by: adminB.id, name: `Token B ${sufixo}`, prefix: tokenPlano.slice(0, 12),
      token_hash: `\\x${createHash("sha256").update(tokenPlano).digest("hex")}`, scopes: ["mcp:read", "role:admin"],
    });
    const comToken = { headers: { authorization: `Bearer ${tokenPlano}` } };
    const gateDeB = () =>
      decidirElegibilidadeDaConversaViaSupabase(db, {
        organizationId: orgB, conversationId: conversa, agora: new Date(), ttlMs: 86_400_000,
      });

    // Controles positivos contra o PostgREST REAL (Review Focus 4): com B ativa,
    // o token funciona e o gate não nega por org. Sem isto, o 403 e o veto lá
    // embaixo não mediriam nada — um embed errado daria os dois sozinho.
    const antes = await request.get("/api/v1/contacts", comToken);
    expect(antes.status(), await antes.text()).toBe(200);
    expect((await gateDeB())?.motivo).not.toBe("org_nao_operante");

    // ── 1. Quem só tem leitura tenta suspender ─────────────────────────────
    const ctxLeitura = await browser.newContext();
    contextos.push(ctxLeitura);
    const pLeitura = await ctxLeitura.newPage();
    await entrar(pLeitura, leitura.email);
    await pLeitura.goto(`/admin/tenants/${orgB}`);
    await pLeitura.getByRole("button", { name: "Suspender tenant" }).click();
    await pLeitura.locator("#suspend-reason").fill("Tentativa de quem só tem leitura");
    await pLeitura.getByRole("button", { name: "Confirmar suspensão" }).click();
    await expect(pLeitura.getByText("Erro ao suspender tenant")).toBeVisible();
    expect((await estadoDaOrg(orgB)).status).toBe("active");
    await pLeitura.screenshot({ path: `${EVIDENCIA}/leitura-recusada.png` });

    // ── 2. O dono suspende B pela tela ─────────────────────────────────────
    await entrar(page, dono.email);
    await page.goto(`/admin/tenants/${orgB}`);
    await page.getByRole("button", { name: "Suspender tenant" }).click();
    await page.locator("#suspend-reason").fill("Suspensão administrativa de teste E2E");
    await page.getByRole("button", { name: "Confirmar suspensão" }).click();
    await expect.poll(async () => (await estadoDaOrg(orgB)).status).toBe("suspended");
    expect((await estadoDaOrg(orgB)).suspended_kind).toBe("administrativa");
    const job = await db.from("job_queue").select("status, last_error").eq("id", jobPendente).single();
    expect(job.data).toEqual({ status: "failed", last_error: "org_nao_operante" });
    const msg = await db.from("messages").select("status, error_code").eq("id", msgNaFila).single();
    expect(msg.data).toEqual({ status: "failed", error_code: "org_suspensa" });
    expect((await gateDeB())?.motivo).toBe("org_nao_operante");

    // ── 3. A admin de B, que estava trabalhando em B, cai no hub ───────────
    const ctxAdminB = await browser.newContext();
    contextos.push(ctxAdminB);
    await ctxAdminB.addCookies([{ name: "active_org", value: orgB, url: test.info().project.use.baseURL! }]);
    const pAdminB = await ctxAdminB.newPage();
    pAdminB.setDefaultTimeout(20_000);
    await entrar(pAdminB, adminB.email);
    await pAdminB.waitForURL("**/account-suspended");
    await expect(pAdminB.getByRole("heading", { name: "Conta suspensa" })).toBeVisible();
    await expect(pAdminB.getByRole("heading", { name: "Solicitações LGPD" })).toBeVisible();
    await expect(pAdminB.getByTestId("sair-do-onboarding")).toContainText(`Ativa C ${sufixo}`);
    // Medida, não olho: o hub cabe na largura, sem rolagem horizontal.
    expect(await pAdminB.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await pAdminB.screenshot({ path: `${EVIDENCIA}/hub-admin.png`, fullPage: true });
    // A LGPD não para: o pedido abre no próprio hub.
    await pAdminB.getByRole("link", { name: "Ver" }).click();
    await pAdminB.waitForURL(new RegExp(`/account-suspended\\?pedido=${pedidoLgpd}$`));
    await expect(pAdminB.getByText(`#${pedidoLgpd.slice(0, 8)}`)).toBeVisible();
    await expect(pAdminB.getByRole("link", { name: "Solicitações", exact: true })).toHaveAttribute("href", "/account-suspended");
    await pAdminB.screenshot({ path: `${EVIDENCIA}/hub-pedido-lgpd.png`, fullPage: true });

    // ── 4. /app/inbox volta para o hub; o token de B é recusado ────────────
    await pAdminB.goto("/app/inbox");
    await pAdminB.waitForURL("**/account-suspended");
    const depois = await request.get("/api/v1/contacts", comToken);
    expect(depois.status(), await depois.text()).toBe(403);
    expect(((await depois.json()) as { error: { code: string } }).error.code).toBe("org_suspended");

    // ── 5. A entrada continua gravando; nada responde ──────────────────────
    const captura = await request.post(`/api/v1/webhooks/in/${pathToken}`, {
      data: { nome: `Lead na suspensão ${sufixo}`, telefone: "11955550000" },
    });
    expect(captura.status(), await captura.text()).toBe(200);
    const leadId = ((await captura.json()) as { data: { lead_id: string } }).data.lead_id;
    const lead = await db.from("crm_leads").select("organization_id").eq("id", leadId).single();
    expect(lead.data?.organization_id).toBe(orgB);
    // A mensagem de WhatsApp que chega enquanto B está suspensa, pelo mesmo
    // marcador que a ingestão grava (`fn_mark_conversation_message`). É ela que
    // a reativação conta para o item de revisão.
    const marca = await db.rpc("fn_mark_conversation_message", {
      p_conv: conversa, p_direction: "inbound", p_preview: "Oi, tem alguém aí?", p_at: new Date().toISOString(),
    });
    if (marca.error) throw marca.error;
    const dreno = await request.post("/api/v1/cron/event-log-drain", { headers: { authorization: `Bearer ${segredoInterno()}` } });
    expect(dreno.status(), await dreno.text()).toBe(200);
    expect(await saidasDe(orgB)).toEqual({ llm: 0, outbound: 0 });

    // ── 6. A atendente lê "Avise o administrador", sem LGPD ────────────────
    const ctxAtendente = await browser.newContext();
    contextos.push(ctxAtendente);
    const pAtendente = await ctxAtendente.newPage();
    await entrar(pAtendente, atendenteB.email);
    await pAtendente.waitForURL("**/account-suspended");
    await expect(pAtendente.getByText("Sua conta está suspensa. Avise o administrador da sua empresa.")).toBeVisible();
    await expect(pAtendente.getByRole("heading", { name: "Solicitações LGPD" })).toHaveCount(0);
    await pAtendente.screenshot({ path: `${EVIDENCIA}/hub-atendente.png`, fullPage: true });

    // ── 7. O dono reativa: nada em rajada, e a Central pede revisão ────────
    await page.goto(`/admin/tenants/${orgB}`);
    await page.getByRole("button", { name: "Reativar tenant" }).click();
    await page.locator("#reactivate-reason").fill("Reativação administrativa de teste E2E");
    await page.getByRole("button", { name: "Confirmar reativação" }).click();
    await expect.poll(async () => (await estadoDaOrg(orgB)).status).toBe("active");
    expect((await db.from("job_queue").select("status").eq("id", jobPendente).single()).data?.status).toBe("failed");
    expect((await db.from("messages").select("status").eq("id", msgNaFila).single()).data?.status).toBe("failed");
    expect(await saidasDe(orgB)).toEqual({ llm: 0, outbound: 0 });
    const itens = await db
      .from("agent_inbox_items")
      .select("severity, ref_kind, ref_id")
      .eq("organization_id", orgB)
      .eq("kind", "org_reativada");
    if (itens.error) throw itens.error;
    expect(itens.data).toEqual([{ severity: "warn", ref_kind: null, ref_id: null }]);

    await pAdminB.goto("/app/inbox");
    await expect(pAdminB).toHaveURL(/\/app\/inbox/);
    await pAdminB.goto("/app/ai/inbox");
    const item = pAdminB.getByTestId("inbox-item").filter({ hasText: "enquanto a conta estava suspensa" });
    await expect(item).toHaveCount(1);
    await expect(item.getByRole("link", { name: "Abrir o Inbox" })).toHaveAttribute("href", "/app/inbox");
    await pAdminB.screenshot({ path: `${EVIDENCIA}/central-apos-reativar.png`, fullPage: true });
  } catch (erro) {
    falhaDoCenario = erro;
    throw erro;
  } finally {
    try {
      const fechamentos = await Promise.allSettled(contextos.map((c) => c.close()));
      const falhas = fechamentos.filter((r) => r.status === "rejected");
      if (falhas.length) throw new AggregateError(falhas.map((r) => r.reason), "falha ao fechar contextos");
      for (const org of orgs) {
        const r = await db.from("organizations").delete().eq("id", org);
        if (r.error) throw r.error;
      }
      const pa = await db.from("platform_admins").delete().in("user_id", pessoas);
      if (pa.error) throw pa.error;
      for (const id of pessoas) {
        const r = await db.auth.admin.deleteUser(id);
        if (r.error) throw r.error;
      }
    } catch (erroDaLimpeza) {
      // Não troca a causa original por erro de teardown.
      test.info().annotations.push({ type: "cleanup", description: `limpeza incompleta: orgs ${orgs.join(",")}` });
      if (!falhaDoCenario) throw erroDaLimpeza;
    }
  }
});
```

- [ ] **Passo 2: registrar no CI** — em `.github/workflows/e2e.yml`, troque

```yaml
      # NÃO MEDIDO até aquele run: se as 11 specs passam na vizinhança nova.
      SPECS_PARTE_6: >-
```

por

```yaml
      # NÃO MEDIDO até aquele run: se as 11 specs passam na vizinhança nova.
      #
      # `suspensao-administrativa` entrou em 2026-09-29 (PR 1 da cobrança do
      # revendedor) na PARTE_6, a de menor previsão (857s). Semeia as próprias
      # orgs, pessoas, token, fonte de captação e pedido de LGPD pelo service
      # role e apaga tudo no fim; não depende de seed de passo nem de vizinha.
      # PREVISÃO, não medida: ~1,5 min de caso.
      SPECS_PARTE_6: >-
```

e troque

```yaml
        redes-sociais-volta-nao-desloga.spec.ts
        sons-dos-avisos.spec.ts
```

por

```yaml
        redes-sociais-volta-nao-desloga.spec.ts
        sons-dos-avisos.spec.ts
        suspensao-administrativa.spec.ts
```

(Se a lista da PARTE_6 não terminar mais nessas duas linhas, acrescente a spec na última linha da lista, mantendo a indentação.)

- [ ] **Passo 3: cercas das specs:** `pnpm exec vitest run tests/unit/e2e-cobertura-completa.test.ts tests/unit/e2e-specs-usam-o-test-da-suite.test.ts tests/unit/e2e-dois-logins-nao-cabem-no-teto-padrao.test.ts tests/unit/spec-de-envio-declara-a-janela.test.ts` → todos passam (se `e2e-dois-logins-nao-cabem-no-teto-padrao` exigir um `test.setTimeout` maior, o `300_000` já está lá).

- [ ] **Passo 4: rodar contra o ambiente fresco** (Supabase local com o `baseline.sql` da branch; `next build` + `next start`)

```bash
cd ~/deskcomm-saas/pr1 || exit 1
supabase start -x studio,postgres-meta
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -q -f supabase/baseline.sql   # update: re-aplica sobre o banco local
pnpm e2e:env && pnpm e2e:build
pnpm exec playwright test tests/e2e/suspensao-administrativa.spec.ts --reporter=list > /tmp/e2e-susp.log 2>&1; echo "exit=$?"
grep -aE "passed|failed|flaky" /tmp/e2e-susp.log | tail -3
```

Esperado: `exit=0` e `1 passed`. Se falhar, a linha do `expect` diz qual grupo quebrou: conserte na causa (não na spec) e rode de novo.

- [ ] **Passo 5: commit** (as imagens entram na Task 36)

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add tests/e2e/suspensao-administrativa.spec.ts .github/workflows/e2e.yml
git commit -F - <<'FIM'
test(e2e): a suspensão administrativa pela tela, do clique à volta sem rajada

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 35: Fechamento — jornada J37, fragmento `.changes/` e conferência do CLAUDE.md

**Files:** Modify `docs/testing/user-journey-map.md` (seção nova antes de `## Jornadas exercitadas (instalação final, virgem)`, hoje `:1288`); Create `.changes/suspensao-que-suspende.md`; Verify (sem edição esperada) `CLAUDE.md`.

- [ ] **Passo 1: número da jornada:** `grep -oE "^## J[0-9]+" docs/testing/user-journey-map.md | sort -t J -k2 -n | tail -1` → `## J36` hoje; use `J37` (ou o próximo livre na branch E nos PRs abertos que tocam o arquivo).

- [ ] **Passo 2: a jornada** — logo antes de `## Jornadas exercitadas (instalação final, virgem)`:

```markdown
## J37 — Suspender uma empresa cala a IA e os envios dela `[P0]` (2026-09-29)

**Origem:** PR 1 da cobrança do revendedor
(`docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md`, §1.3, §4 e §9).
Antes, suspender só tirava a pessoa da tela: a IA, o follow-up, as automações,
o token de API e o MCP seguiam funcionando, e quem tinha acesso só de leitura ao
painel suspendia e reativava empresas.

| Caso | Spec | Estado |
|---|---|---|
| Quem só tem leitura clica em Suspender e vê o erro; a empresa segue ativa | `tests/e2e/suspensao-administrativa.spec.ts` | CI (PARTE_6) |
| O dono suspende pela tela; o turno agendado e a resposta na fila viram `failed` na mesma transação; o gate (pelo PostgREST real) passa a negar | idem | CI (PARTE_6) |
| A admin da empresa suspensa cai no hub: texto do suporte, pedido de LGPD abrindo no próprio hub, volta para a empresa que opera | idem | CI (PARTE_6) |
| `/app/inbox` volta para o hub; o token `dsk_` da empresa responde 403 `org_suspended` | idem | CI (PARTE_6) |
| A captação por `webhooks/in/[token]` é gravada durante a suspensão; nenhuma `llm_calls` nem mensagem de saída nasce | idem | CI (PARTE_6) |
| A atendente da empresa suspensa lê "Avise o administrador da sua empresa", sem LGPD | idem | CI (PARTE_6) |
| O dono reativa: nada sai em rajada, e a Central mostra o aviso que leva ao Inbox | idem | CI (PARTE_6) |
| Hub: empresa que opera volta para `/app`, pedido inválido cai na lista, leitura que falha lança | `app/account-suspended/page.test.tsx` | unit |
| O aviso de reativação leva ao Inbox só para quem atende, e nunca por referência | `lib/ai/inbox-destino.test.ts` | unit |
| O agendador pula o follow-up da empresa parada, no Postgres real | `tests/invariants/cron-org-parada.test.ts` | test:db |
| O lembrete da agenda não sai nem abre conversa para a empresa parada | `tests/unit/lembrete-pula-org-parada.test.ts` | unit |
| Suspensão no meio do envio não pausa a prospecção nem tira o destinatário da campanha | `tests/unit/prospecting-worker.test.ts`, `tests/unit/suspensao-nao-dispara-campanha.test.ts` | unit |
| Quem tem acesso só de leitura ao painel e é membro comum de uma empresa não apaga os dados dela | `tests/unit/zona-de-perigo-apaga-so-a-propria-org.test.ts` | unit |

**Não coberto pela tela:** a suspensão por falta de pagamento e o painel de
pagamento no hub (PR 3a); a IA calada com um agente publicado de verdade (a
spec não publica agente — quem prova o veto é `lib/ai/elegibilidade/gate.test.ts`,
`tests/invariants/org-suspensa.test.ts` e o controle do gate na própria spec);
APROVAR um pedido de LGPD pelo hub (a spec abre o pedido, não aprova).
```

- [ ] **Passo 3: o fragmento** `.changes/suspensao-que-suspende.md` (formato de `lib/release/fragmento.ts`: frontmatter `impacto`/`secao`/`titulo`, corpo sem linha começando com `#` e sem `⚠`):

```markdown
---
impacto: nada_mudou
secao: corrigido
titulo: Suspender uma empresa passa a calar a IA e os envios dela; quem tem acesso só de leitura ao painel deixa de poder alterar dados
---

Até aqui, suspender uma empresa em Admin › Empresas só tirava as pessoas da tela. A IA continuava respondendo aos clientes, o follow-up e as automações seguiam disparando, e o token de API e o MCP da empresa continuavam funcionando. Agora a suspensão suspende: nada que custe dinheiro ou saia para fora roda enquanto ela durar, e o que estava na fila para sair é descartado na hora em vez de sair depois.

As mensagens que chegam continuam gravadas, e as páginas de anúncio e o link de rastreio seguem no ar. Quem entra numa empresa suspensa cai numa tela que diz o que fazer. Quem administra vê o contato do suporte e os pedidos de LGPD dos clientes, que não param durante a suspensão. As demais pessoas leem que devem avisar o administrador, e quem participa de outra empresa ativa volta para ela com um clique.

Ao reativar, nada sai em rajada: a Central mostra um aviso com quantas conversas receberam mensagem durante a suspensão e leva ao Inbox, porque a IA não vai respondê-las sozinha. Quem tem acesso só de leitura ao painel da instalação deixa de conseguir suspender, reativar ou alterar o estado de uma empresa, pela tela ou pela API, e também deixa de mudar configurações ou apagar dados de uma empresa em que é só participante. Nenhuma configuração ou ação é necessária.
```

- [ ] **Passo 4: conferir o fragmento:** `pnpm exec vitest run tests/unit/fragmentos-de-release.test.ts && pnpm release:conferir` → testes passam; a conferência lista `nada_mudou  corrigido  Suspender uma empresa passa a calar a IA…` e termina com `(conferência: nada foi escrito — use --escrever)`.

- [ ] **Passo 5: CLAUDE.md na fonte (pg15 × pg17, `GRANT MAINTAIN`)**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
grep -n "major_version" supabase/config.toml
grep -c "MAINTAIN" supabase/baseline.sql
grep -n "pg15\|pg17" CLAUDE.md AGENTS.md
```

Esperado (medido em `c31d421c5` e de novo em `d03c2b2fd`): `29:major_version = 15`; `0`; `CLAUDE.md:555` diz `Supabase local **pg15** … Já foi pg17, por causa de 9 \`GRANT MAINTAIN\`…` e `:625` diz `pgvector/pgvector:pg15`; nada em `AGENTS.md`. **Com essa saída, não há o que editar** — a correção que a spec §11 pede já está na main (desde `6bfb48d53`); registre isso na descrição do PR. Só se `:555` disser pg17, troque o trecho por `num Supabase local **pg15** (\`config.toml major_version = 15\`). Já foi pg17, por causa de 9 \`GRANT MAINTAIN\` que o \`pg_dump\` emitiu sozinho; hoje quem guarda o piso é \`tests/unit/baseline-no-piso-do-postgres.test.ts\``.

- [ ] **Passo 6: cercas do mapa de jornadas:** `pnpm exec vitest run tests/unit/numero-de-jornada-e-unico.test.ts tests/unit/evidencia-citada.test.ts` → passam.

- [ ] **Passo 7: commit**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add docs/testing/user-journey-map.md .changes/suspensao-que-suspende.md
git commit -F - <<'FIM'
docs(suspensao): a jornada J37 e o fragmento da suspensão que suspende

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 36: Verificação final (árvore mesclada, a suíte inteira, banco, e2e, evidência)

**Files:** Modify `docs/testing/user-journey-map.md` (linha de evidência da J37); Create `evidence/suspensao-administrativa/*.png` (gerados pela Task 34).

- [ ] **Passo 1: trazer a main e conferir o que só nasce na árvore mesclada** (Review Focus 5)

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git status --short | wc -l        # esperado: 0
git fetch origin && git merge origin/main
git diff --name-only --diff-filter=U   # conflito? resolva com cabeça: baseline/lock/types partem do lado AUTORITATIVO (main) e reaplicam o delta desta PR
ls supabase/migrations | grep -E '_0492_'      # esperado: só a nossa; se a main ganhou 0492, renumere (Global Constraints)
grep -c "0492_org_operante_e_suspensao_tipada" supabase/migrations/MANIFEST.md   # esperado: 1 (merge=union duplica)
for k in '"Abrir o Inbox"' '"A conta foi reativada — há conversas para revisar"' '"A conta desta empresa está suspensa."' \
         '"A IA não respondeu nem vai responder sozinha às conversas que chegaram durante a suspensão. Abra o Inbox e revise a aba Fila."' \
         '"Sua conta está suspensa. Avise o administrador da sua empresa."' \
         '"Os pedidos de LGPD dos seus clientes continuam com prazo durante a suspensão."'; do
  printf '%s -> ' "$k"; grep -cF "$k:" lib/i18n/dicionario.ts
done                                   # esperado: 1 em cada uma das 6 (chave duplicada é TS1117 só aqui)
# 'org_reativada' aparece 3 vezes no baseline (o comentário do cabeçalho do
# apêndice, o INSERT de fn_reativar_organizacao e o CHECK); a duplicata que
# importa é a do CHECK, então a sonda mede só o bloco dele:
awk '/add constraint agent_inbox_items_kind_check/,/\)\);/' supabase/baseline.sql | grep -c "'org_reativada'"   # esperado: 1
pnpm typecheck; echo "typecheck=$?"
```

- [ ] **Passo 2: cercas, tipos e lint**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm cercas; echo "cercas=$?"
pnpm typecheck; echo "typecheck=$?"
pnpm lint; echo "lint=$?"
pnpm lint:channels; echo "channels=$?"
pnpm lint:role-rank; echo "role-rank=$?"
```

Esperado: os cinco com `=0`.

- [ ] **Passo 3: a suíte unitária inteira, reconciliando rodapé e `FAIL`**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/vt.log | tail -2
grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c
r=$(grep -aE "^ *Tests " /tmp/vt.log | tail -1 | grep -oE "[0-9]+ failed" | head -1)
g=$(grep -acE "^ *FAIL " /tmp/vt.log)
echo "rodapé: ${r:-0 failed} | grep contou: $g"
grep -a "org_suspended\|org_nao_operante\|orgAtivaSemPortao" /tmp/vt.log | head
```

Esperado: `exit=0`; `rodapé: 0 failed | grep contou: 0`. Se divergirem, rode `pnpm test:unit --reporter=verbose` antes de concluir. Falha com `org_suspended`/`org_nao_operante`/`orgAtivaSemPortao` num arquivo fora das tarefas acima é fixture sem a org: acrescente `status: "active"` à linha de `organizations` do dublê (ou `organizations: { status: "active" }` à de `conversations`, ou `orgAtivaSemPortao` à factory de `@/lib/auth/server`), rode o arquivo isolado e commite `test(fixture): <arquivo> declara a organização operante`. Vermelho de `lib/ai/dispatcher/rate-limit.test.ts` com 15 s de timeout é o Redis local fora do ar (`.env.local` com `UPSTASH_*`), não esta PR: suba o `serverless-redis-http` e rode de novo.

- [ ] **Passo 4: banco real (install com `ON_ERROR_STOP=1` + update)**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
pnpm test:db > /tmp/tdb.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/tdb.log | tail -2
```

Esperado: `exit=0`, nenhum `failed`, inclusive `org-suspensa`, `cron-org-parada`, `agent-watchdog`, `event-log-drain`, `hardening-definer-varredura` e `vocabulario-banco-x-typescript`.

- [ ] **Passo 5: e2e da spec nova sobre a árvore final**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -q -f supabase/baseline.sql
pnpm e2e:env && pnpm e2e:build
pnpm exec playwright test tests/e2e/suspensao-administrativa.spec.ts --reporter=list > /tmp/e2e-susp.log 2>&1; echo "exit=$?"
grep -aE "passed|failed|flaky" /tmp/e2e-susp.log | tail -3
ls evidence/suspensao-administrativa/
```

Esperado: `exit=0`, `1 passed` e os cinco arquivos `central-apos-reativar`, `hub-admin`, `hub-atendente`, `hub-pedido-lgpd`, `leitura-recusada`. Abra `hub-admin` e `central-apos-reativar` e confira que a tela diz o que a spec afirma.

- [ ] **Passo 6: citar a evidência** — na J37, logo depois do parágrafo **Não coberto pela tela:**:

```markdown
**Evidência** (PNG em `evidence/suspensao-administrativa/`): `leitura-recusada`,
`hub-admin`,
`hub-pedido-lgpd`,
`hub-atendente`,
`central-apos-reativar`.
```

`pnpm exec vitest run tests/unit/evidencia-citada.test.ts tests/unit/evidencia-no-caminho-versionado.test.ts` → passam.

- [ ] **Passo 7: commit da evidência**

```bash
cd ~/deskcomm-saas/pr1 || exit 1
git add evidence/suspensao-administrativa docs/testing/user-journey-map.md
git commit -F - <<'FIM'
test(e2e): evidência da suspensão administrativa pela tela

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

A descrição do PR cita: o SHA medido (`git rev-parse HEAD`), os rodapés de `/tmp/vt.log`, `/tmp/tdb.log`, `/tmp/e2e-susp.log`, as sabotagens das Tasks 6, 21, 29 e 30, a conferência do CLAUDE.md (Task 35 passo 5) e a seção abaixo. Termina com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Push/PR/merge só com o aval do dono.

---

## Divergências registradas da spec

Medido em `c31d421c5` e reconferido em `d03c2b2fd`. Cada item diz o que a spec afirma, o que o código mostra e o que o plano faz.

1. **`InboxKind` arrasta rótulo, destino e dicionário (§2.5).** A spec cita só o CHECK e o par `InboxKind`. `KIND_LABEL` (`lib/ai/agent-inbox-copy.ts`, `satisfies Record<InboxKind, string>`) e `POLITICAS_DE_AVISO` (`lib/ai/inbox-destino.ts`, `satisfies Record<InboxKind, Politica>`) obrigam entradas pelo compilador, e `lib/ai/inbox-destino.test.ts` exige `es` para toda orientação e rótulo. A Task 4 inclui os três.
2. **Contrato `ref_kind`/`ref_id` nulos do item `org_reativada` (§2.5/§3.1 não dizem).** O resolvedor só dá destino "geral" com as duas colunas nulas (`inbox-destino.ts:204-219`); com `ref_kind='organization'` ele não chega ao Inbox. A "Fila" não tem URL (`app/app/inbox/page.tsx` só lê `id` e `rascunho`): o destino é `/app/inbox` (`agent`+), e a orientação nomeia a aba Fila. O título gravado (`A conta foi reativada — há conversas para revisar`, igual a `KIND_LABEL`) e a forma singular do corpo não estão na spec.
3. **Vocabulário de `motivo` e erros das funções de estado.** A spec só fixa `{changed, motivo?}`, `org_isenta` (PR 2) e o código de rota `suspensao_de_cobranca`. O plano fixa `ja_suspensa`, `administrativa_prevalece`, `org_encerrada`, `nao_suspensa`, `suspensao_de_cobranca`, `suspensao_administrativa`, e os erros `22023 tipo_de_suspensao_invalido` / `P0002 organization_not_found`.
4. **Suspensão com `suspended_kind` NULO depois do backfill.** O rollback de imagem do `agent.sh` volta a rota antiga, que grava `status='suspended'` via service role (passa pelo gatilho) sem tipo. As duas funções tratam `coalesce(suspended_kind,'administrativa')`; a spec só previa o backfill.
5. **Troca `cobranca → administrativa`.** A função mantém `suspended_at` (usado na contagem da reativação) e reaplica o anti-backlog e o evento; a spec diz só "troca o kind".
6. **Um arquivo de invariante (`tests/invariants/org-suspensa.test.ts`)** para os invariantes 2–4, como a §14 nomeia; recusa do gatilho é conferida pela MENSAGEM, porque RLS e gatilho usam o mesmo SQLSTATE `42501` e `writeCountAs` só engole erro com "row-level security".
7. **`lib/database.types.ts` editado à mão** no formato gerado: `AGENTS.md` diz "gerado, não edite", mas `package.json` não tem gerador (`db:migrate` é TODO) e o precedente `9834a1e82` faz o mesmo.
8. **`OrgNaoOperanteError` estende `ApiError` com `terminal = true` e `orgStatus`.** A spec não diz a classe-base. A rota `/messages` só traduz `ApiError` (`route.ts:354-375`) e o agent-worker só cancela sem retry quem tem `.terminal === true` (`workers/agent-worker/main.ts:176-180`). O campo da org chama `orgStatus` porque `status` é o HTTP herdado.
9. **`sendWithLedger` relança a suspensão (§4 item 12).** Sem isso o `OrgNaoOperanteError` nunca chegaria ao `catch` de `enviar-texto-fixo.ts`: `send-ledger.ts:59-61` converte todo 403 em `blocked`/`vetoed`, e no agent-engine `blocked` chama `cancelPendingCronsForLead`, apagando os follow-ups do contato como opt-out. Mudança fora da lista literal da spec, necessária para o item valer.
10. **Dreno do `event_log` com leitura de status que falha (§4 item 8 não diz).** Consumir às cegas marcaria `skipped` para sempre o handler "pula" de org operante; o plano adia o lote inteiro (retorna antes do claim). Org ausente da resposta conta como parada.
11. **23 handlers, não "23 com o da cobrança".** A §4/§14 conta `cobrancaSinalHandler` (PR 3a), que não existe; `register-handlers.ts` registra 23 hoje (7 "roda" + 16 "pula"). A classificação literal cobre exatamente esses.
12. **Prospecção filtra no SQL, antes do `limit 20` (§4 item 13).** Filtrar depois criaria inanição: a ordem é `min(updated_at)` e a org pulada nunca toca `updated_at`.
13. **`meet-delivery` passa `STATUS_OPERANTE`** apoiado em `fn_meet_delivery_current`, que só devolve `current: true` com a org `active`.
14. **`ai-sentiment-worker` não é parado pelo gate** (só pula por `bloqueioPorAllowlist`); a proteção é o "pula" do `aiSentimentHandler`, sua única entrada. Não alterado.
15. **Cerca de crons mede rota + imports diretos, sem contar a porta de saída.** Com isso `event-log-drain` e `followup-flow-worker` passam por import e NÃO entram na allowlist, ao contrário do exemplo da spec. O `agenda-reminder` (que a spec põe na allowlist) ganha filtro de verdade (Task 28b) e passa por import direto da régua; importar `app/api/v1/messages/_handler.ts` não conta (`NAO_E_FILTRO`), porque assert na saída não é filtro da varredura. A allowlist inicial tem 32 das 38 rotas, sem `cobranca`.
16. **Cerca de régua única exclui `app/admin/**` e `app/api/v1/admin/**`** (transição de estado e KPIs, ex.: `admin/dashboard/kpis/route.ts:57`); allowlist inicial só `app/actions/shell/setActiveOrg.ts`.
17. **Chamadores com settle próprio (§4 item 12, §12, risco 15).** Numa corrida com o assert, `lib/campanhas/rodada.ts` marcaria o destinatário `failed/send_exception`, `lib/prospecting/worker.ts` pausaria a campanha e `agenda-reminder` retentaria a cada rodada. Os três tratam `OrgNaoOperanteError` com teste de comportamento (Tasks 26b e 28b): o destinatário volta a `pending` (`registrarExcecaoDoEnvio`, desfecho que a spec não fixa), a campanha segue `running` e o lembrete vira `pulado org_nao_operante`. Os outros 10 chamadores só propagam, e a cerca `chamadores-do-envio-tratam-org-parada` exige que chamador novo declare a decisão.
18. **`voice/events` GET e `system/relogio/tick` ficam com `allowPlatformAdmin: true`** apesar de a spec mandar todo GET para `"leitura"`: o primeiro repassa o QR de pareamento (credencial), o segundo é helper de um GET que executa o POST.
19. **Exceção permanente na cerca de escrita:** `admin/tenants/[id]/impersonate` POST — abrir acompanhamento é o trabalho do `support_readonly` (`fn_support_context` rebaixa scope diferente de `full`), e a rota já confere MFA.
20. **`marca/logo` POST/DELETE** não estão na spec, mas a regra A da cerca os alcança (`abrirContexto` lê `is_platform_admin`); convertidos.
21. **`lib/legal/operador.ts` usa `orgAtivaSemPortao`:** sem isso `/legal/privacy` e `/legal/terms` redirecionariam o suspenso, e a spec (§1.3) diz que LGPD nunca é bloqueada.
22. **`system/update` mantém o 401 `unauthenticated`** antes de `requirePlatformAdminEscrita` (a spec diz só "passa a usar o helper"; o helper sozinho transformaria sessão ausente em 403).
23. **Campos novos de sessão são opcionais** (`org_status`, `suspended_kind`, `platform_admin_scope`): ~105 fixtures de `AuthUser` e ~72 de membership; todo leitor falha fechado.
24. **`requireRole` usa `orgAtivaSemPortao`** (rota de API responde 403 JSON, não 307); 7 arquivos de teste que mockavam só `resolveActiveOrg` ganham o mock novo. As ~15 rotas de API que chamam `resolveActiveOrg` sem `requireRole` passam a devolver 307 para org suspensa (risco 3 da spec, aceito).
25. **`reactivate` lê `organizations` antes da função**, para o 404 e o 409 com nome; a escrita continua atômica na função, que também recusa o kind divergente.
26. **`requirePlatformAdminEscrita` lança `EscritaDePlatformAdminNegada`** (também serve às server actions); as rotas convertem com `falhaDaEscritaDePlatformAdmin`. Server actions mostram o erro genérico que já mostravam.
27. **Hub: LGPD só para quem administra.** A §9 diz "Todos"; as 5 rotas LGPD exigem `requireRole("admin")` e `/app/lgpd/requests` manda não admin para `/app`.
28. **Hub: "extrair a parte de dados" virou duas props string** (`baseDoPedido`, `hrefDaLista`); as peças só dependiam de `IdiomaProvider` e do `QueryClientProvider` da raiz, e o acoplamento real eram dois links fixos. O detalhe abre por `?pedido=<uuid>`.
29. **Hub: "Trocar de empresa" reusa `OutrasOrganizacoes`**, com os rótulos "Voltar para X" / "Ir para outra organização" já no dicionário.
30. **e2e com cookie `active_org=B`:** sem cookie `escolherMembroAtivo` prefere a membership operante (§4 item 2), e a admin com vínculo em C entraria em C — é o desenho.
31. **e2e: a mensagem que conta para o item de revisão entra por `fn_mark_conversation_message`,** não por `webhooks/in/[token]`, que é captação de lead e não cria conversa (§12 fala em "mensagem por webhooks/in/[token]").
32. **Nome do e2e:** `tests/e2e/suspensao-administrativa.spec.ts`, como a §14 PR 1 (um rascunho usava `suspensao-que-suspende.spec.ts`).
33. **Mapa vivo próprio da PR 1** (`suspensao-de-organizacao.architecture.json`); o `cobranca-do-revendedor.architecture.json` da §13 é da capacidade inteira e nasce na PR 2+.
34. **CLAUDE.md pg15 já está correto na main (§11 pede a correção).** `CLAUDE.md:555` e `:625` dizem pg15 desde `6bfb48d53`; `config.toml:29` = 15; `grep -c MAINTAIN supabase/baseline.sql` = 0. A Task 35 vira conferência. (O CLAUDE.md que ainda diz pg17 é o de outro checkout, `/Users/rafaelmelgaco/DeskcommCRM`.)
35. **Deriva de linhas desde `76355d4b9`:** VARREDURA anon segue em `baseline.sql:42990`; bloco do kind em `:9997-10110` (spec: ~9996-10000); `organizations` em `:1747-1772`; `orgs_write_platform_admin` em `:4195`; select do `drain.ts` em `:250` (spec: 257-284); voz em `workers/voice-agent/index.ts:237-243` (spec: :243); `sendMessageHandler` em `:363` (spec: 367-373); resolução de org no `require-role` em `:64-80` (spec: :62-79); select de `platform_admins` em `server.ts:174-179`. Nenhuma divergência de conteúdo. O apêndice 0491 está DEPOIS da VARREDURA (`:44374`) porque só cria índice; o 0492 cria função e vai acima de `:42990`. Reconferido em `d03c2b2fd`: o `baseline.sql` e as migrations não mudaram; `lib/auth/server.ts` ganhou `currency`/`country` no embed e a leitura por service role no ramo de acompanhamento (#1945), e a Task 8 foi reescrita sobre esse corpo; `platform_admins` passou a `:176-181` e `resolveActiveOrg` a `:283-324`; o dicionário andou 11 linhas (`"Ligar de volta"` em `:9999`, `"Solicitações LGPD"` em `:7818`).
36. **Invariante extra `tests/invariants/cron-org-parada.test.ts`** (fora da lista da §12): a única prova no Postgres real do SQL novo do agendador.
37. **O atalho de papel das server actions exige scope `full` (Task 15b).** A §4 só manda a regra B cobrar quem IMPORTA `requirePlatformAdmin`. Em `d03c2b2fd`, 15 server actions liberam a escrita com `!authUser.is_platform_admin && ROLE_RANK[…] < ROLE_RANK.admin` (ou `(user.is_platform_admin && !user.support)`); a sessão de acompanhamento já cai antes em `supportWriteError`, mas o `support_readonly` que é membro comum de uma empresa, fora de acompanhamento, escrevia nela — inclusive `apagarDadosOperacionaisDaOrganizacao`. O plano cria `escreveComoPlatformAdmin(user)` em `lib/auth/types.ts` (puro), troca os 15 atalhos por ele e estende a regra B (`#B:flag`): `"use server"` que lê `.is_platform_admin` precisa chamar `escreveComoPlatformAdmin(` ou `requirePlatformAdminEscrita(`. Exceção permanente: `app/actions/auth/politicaDeMfa.ts`, que lê a flag para decidir a política de MFA da PRÓPRIA conta. O que continua aberto é o do risco 2 da spec: escrita pelo PostgREST onde a policy aceita `fn_is_platform_admin()`.
38. **O hub devolve para `/app` só com as duas réguas de acordo (Review Focus 2).** A §9 não diz qual fonte decide. O layout de `/app` manda para o hub quando a sessão (`org_status` do embed) OU a leitura por service role (`orgRow.status`) diz parada; o hub só redireciona de volta quando as duas dizem que opera. Decidir por uma fonte só (qualquer das duas) deixa a divergência entre elas virar laço de 307.
39. **A rodada de campanhas passa a excluir TODA org não operante pela URL (Task 26).** `idsDeOrgsParadas` devolve também as redigidas, que só crescem com a LGPD, e `rodada.ts` monta `.not("organization_id", "in", "(…)")` na query string do PostgREST, que tem teto de tamanho de URL. Não bloqueia a PR 1 (self-host tem poucas orgs); o conserto quando o número crescer é filtrar em memória as campanhas lidas ou usar um embed `organizations!inner(status)` avaliado por `ehOperante`. Mesmo teto na promoção de agendadas.

## Achados recusados

Todos os achados altos e médios das duas revisões foram aplicados, e os baixos também. Dois foram aplicados de forma diferente da proposta, e a razão está abaixo.

1. **Revisor 2, baixo: "o hub decide só pela régua da sessão" (`if (ehOperante(ativa.org_status)) redirect("/app")`). Recusado em favor do conserto do revisor 1, que exige as duas réguas.** Evidência: o layout de `/app` redireciona para o hub por DUAS fontes. `resolveActiveOrg` usa o `org_status` do embed da sessão (Task 8), e `app/app/layout.tsx` usa `orgRow.status` lido por service role (`:110-116` em `d03c2b2fd`, Task 16). Se o hub decidir só pela sessão, o laço reaparece no caso inverso (sessão ativa, banco suspenso): o layout manda para o hub pela leitura do banco, e o hub devolve para `/app` pela sessão. O teste `it.each` da Task 32 cobre as duas divergências.
2. **Revisor 1, médio: invariante `cron-org-parada` com "laço de até 20 ticks, `batchSize: 50`". Aplicado de outra forma.** O próprio achado aponta que o tick "enfileira jobs de crons alheios", e um laço com `batchSize: 50` dispara MAIS crons de outros arquivos, que o `test:db` roda em ordem embaralhada (`scripts/test-db.sh:502`, `--sequence.shuffle.files=true`). O plano semeia os dois crons com `next_run_at = 2000-01-01`. Como o claim ordena por `next_run_at` (`scheduler.ts:208-211`), `batchSize: 2` reivindica exatamente os dois, e nada alheio é disparado. As asserções medem só as próprias linhas (nenhuma segue vencida, zero jobs da org parada, o estado dos dois), como o revisor pediu. A sabotagem continua reprovando pela asserção de `jobs[0].n`.
