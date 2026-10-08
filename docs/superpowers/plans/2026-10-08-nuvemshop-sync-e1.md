# Nuvemshop · E1 — Sincronização de pedidos — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ao conectar uma loja Nuvemshop, os pedidos dos últimos 12 meses (e os novos, por webhook e reconciliação de 30 min) passam a existir em `public.orders`, ligados a contatos, visíveis na tela da integração e no painel do contato.

**Architecture:** uma página da API por evento `nuvemshop.sync_page` no `event_log` (retry/backoff/aviso de evento morto já existem no dreno). Estado do run em `integration_sync_state` (trava + cursor). Escrita "mais novo vence" por `fn_gravar_pedido_externo` (security definer, só `service_role`). Webhooks `order/*` viram `GET /orders/{id}` + mesma gravação. Erro de autorização vira aviso na Central (`integracao_desautorizada`) e se resolve na reconexão.

**Tech Stack:** Next.js 16 Route Handlers + Server Actions, Supabase (admin client), Postgres (migration + apêndice do `baseline.sql`), Zod, Vitest (unit + `test:db`), Playwright (e2e com receptor HTTP).

**Spec:** `docs/superpowers/specs/2026-10-08-nuvemshop-sync-e1-design.md` (ler inteira antes da Task 1).

**Worktree:** `/root/projects/DeskcommCRM-nuvemshop-sync`, branch `feat/nuvemshop-sync-e1`, base `upstream/main` (`melgarafael/DeskcommCRM`). **Nunca** `origin/main` (fork da Axis, ~2200 commits atrás).

## Global Constraints

- Migration: `supabase/migrations/20261008160000_0611_nuvemshop_sync_de_pedidos.sql` (NNNN 0611: teto medido em 08/10 = 0600 na main, 0610 no PR #2584 aberto). Reconfirmar com `pnpm checar:colisao-de-migration` antes do commit da Task 1; se colidir, renumerar para o próximo livre e trocar em todo o plano.
- Toda mudança de schema: migration **+** bloco idempotente no apêndice do `baseline.sql` **+** linha `-- manifest:` no cabeçalho do `.sql`. Nunca linha nova no `MANIFEST.md`.
- `agent_inbox_items_kind_check`: o valor novo entra no **bloco único** do baseline (lista que termina em `'canal_pausado', 'other'`) e a migration reconstrói a constraint com a lista **completa** (40 valores). Nenhum bloco novo de `add constraint` dessa constraint no baseline.
- Função `security definer` nova em `public`: `revoke execute ... from public, anon, authenticated; grant execute ... to service_role;` e `set search_path = public, pg_temp`.
- Admin client sempre com `.eq("organization_id", ...)` explícito; `organization_id` vem do evento/estado/cookie, nunca de body.
- `total_cents` por parsing de string decimal, **nunca** `parseFloat * 100`.
- Sem `console.log`; usar `logger` de `@/lib/logger`. Token/secret nunca em log ou audit.
- Textos de tela via `traduzir()`/`useT()` com entrada `es` no `lib/i18n/dicionario.ts`.
- Handler keys: `nuvemshop-sync.v1` (`pula`), `nuvemshop-pedido.v1` (`pula`), `nuvemshop-desinstalacao.v1` (`roda`).
- Cron: `*/30 * * * *|60|api/v1/cron/nuvemshop-reconcile` em `docker/scheduler/entrypoint.sh`; audita **só** quando iniciou run.
- Página da API: `per_page = 50` (desvio consciente da spec, que dizia 200: com ~4 consultas por pedido, 200 pedidos por evento passaria de 45 s no dreno por cron). Teto da Nuvemshop = 10.000 itens por consulta ⇒ página máxima = 200.
- Env nova: `NUVEMSHOP_API_BASE_URL` (opcional, default host real; mesmo portão de `hostAceito` da Meta). Entra em `lib/env.ts` + `.env.example` + `scripts/gerar-env-e2e.sh`.
- Commits: conventional (`feat:`, `test:`, `docs:`), sem linha de atribuição.
- `pnpm test:unit` sem caminho é a suíte; `pnpm test:db` obrigatório (schema + RLS). Exit code é a autoridade.

## Review Focus

1. **Pedido de contato já anonimizado (LGPD) re-sincronizado** — o backfill/reconciliação re-lê um pedido cujo `orders.is_anonymized = true`; o esperado é **não** recriar contato com o telefone/e-mail do pedido nem tocar a linha. Teste em Task 5 (`gravarPedido` pula antes de resolver contato).
2. **Janela vazia** — a Nuvemshop responde `404 {"description":"Last page is 0"}` para página sem itens; o esperado é lista vazia e o run seguir, não `pedido_inexistente` nem erro. Teste em Task 2.
3. **Webhook antigo chegando depois do backfill gravar versão mais nova** — o esperado é a linha mais nova permanecer. Teste em Task 1 (invariante SQL).
4. **Loja desconectada/desinstalada no meio do backfill** — o esperado é o run encerrar sem erro, sem novos eventos encadeados. Teste em Task 8.
5. **Telefone estrangeiro** (`+5491112345678`, loja Tiendanube AR) — o esperado é casar/criar contato com o E.164 informado, sem prefixar `+55`. Teste em Task 4.

---

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20261008160000_0611_nuvemshop_sync_de_pedidos.sql` | tabela `integration_sync_state`, `fn_gravar_pedido_externo`, kind `integracao_desautorizada`, índice de aviso único |
| `supabase/baseline.sql` | mesmo schema no apêndice + valor no bloco único do kind |
| `lib/database.types.ts` | tipos da tabela e da função |
| `lib/nuvemshop/config.ts` | `nuvemshopApiBase()` (override por env) |
| `lib/nuvemshop/api-client.ts` | timeout, `retryAfterMs`, `listOrders`, `getOrder` |
| `lib/nuvemshop/sync/constantes.ts` | constantes + schema do passo |
| `lib/nuvemshop/sync/pedido-nuvemshop.ts` | schema Zod tolerante do pedido |
| `lib/nuvemshop/sync/traduzir-pedido.ts` | pedido → linha de `orders` (puro) |
| `lib/nuvemshop/sync/contato-do-pedido.ts` | chaves + decisão (puro) + efeito |
| `lib/nuvemshop/sync/gravar-pedido.ts` | compõe tradução + contato + RPC |
| `lib/nuvemshop/sync/janelas.ts` | janelas e próximo passo (puro) |
| `lib/nuvemshop/sync/estado.ts` | leitura/escrita de `integration_sync_state` |
| `lib/nuvemshop/sync/integracao.ts` | carrega integração + token decifrado |
| `lib/nuvemshop/sync/desautorizada.ts` | aviso na Central + estado `auth` |
| `lib/nuvemshop/sync/deps.ts` | interface de dependências + implementação real |
| `lib/nuvemshop/sync/iniciar.ts` | inicia run (callback/cron/manual) |
| `lib/nuvemshop/sync/resumo.ts` | estado → texto da tela (puro) |
| `lib/nuvemshop/sync/sync-page.handler.ts` | handler `nuvemshop-sync.v1` |
| `lib/nuvemshop/sync/pedido.handler.ts` | handler `nuvemshop-pedido.v1` |
| `lib/nuvemshop/sync/desinstalacao.handler.ts` | handler `nuvemshop-desinstalacao.v1` |
| `app/api/v1/cron/nuvemshop-reconcile/route.ts` | reconciliação 30 min |
| `app/actions/integrations/syncNuvemshopNow.ts` | "Sincronizar agora" |
| `app/app/integrations/nuvemshop/_components/PedidosDaLoja.tsx` + `SyncNowButton.tsx` | bloco Pedidos |
| `tests/invariants/nuvemshop-gravar-pedido.test.ts` | invariantes SQL |
| `tests/e2e/nuvemshop-sincroniza-pedidos.spec.ts` | prova pela tela |

---

### Task 0: Preparação do worktree

**Files:** nenhum versionado.

- [ ] **Step 1: Carregar a skill do contribuidor** — invocar `deskcomm-contribuir` (este clone não é do mantenedor) e seguir o que ela medir.

- [ ] **Step 2: Atualizar com a base e instalar dependências**

```bash
cd /root/projects/DeskcommCRM-nuvemshop-sync
git status --short            # esperado: vazio (só este plano, se ainda não commitado)
git fetch upstream && git merge --no-edit upstream/main
nvm use && pnpm install --frozen-lockfile
```
Expected: merge fast-forward ou merge limpo; `node_modules/` real (não symlink).

- [ ] **Step 3: Medir o verde de partida**

```bash
pnpm typecheck > /tmp/ns-tc.log 2>&1; echo "typecheck exit=$?"
pnpm test:unit > /tmp/ns-vt.log 2>&1; echo "unit exit=$?"; grep -aE "Test Files|Tests |Errors " /tmp/ns-vt.log | tail -3
```
Expected: anotar falhas pré-existentes (ex.: `lib/ai/dispatcher/rate-limit.test.ts` sem Redis local) para não confundir com regressão.

- [ ] **Step 4: Commit do plano**

```bash
git add docs/superpowers/plans/2026-10-08-nuvemshop-sync-e1.md
git commit -m "docs(nuvemshop): plano da E1 — sincronização de pedidos"
```

---

### Task 1: Schema — `integration_sync_state`, `fn_gravar_pedido_externo`, kind da Central

**Files:**
- Create: `supabase/migrations/20261008160000_0611_nuvemshop_sync_de_pedidos.sql`
- Modify: `supabase/baseline.sql` (bloco único do kind ~linha 10170; apêndice no fim)
- Modify: `lib/database.types.ts`
- Modify: `tests/invariants/rls-isolation.test.ts` (seed + `TABLES`)
- Create: `tests/invariants/nuvemshop-gravar-pedido.test.ts`

**Interfaces:**
- Produces: tabela `public.integration_sync_state` (colunas da spec §5.5); RPC `fn_gravar_pedido_externo(p_organization_id uuid, p_pedido jsonb) returns uuid` — `p_pedido` com chaves `external_provider, external_id, customer_external_id, contact_id, status, total_cents, currency, payment_method, fulfillment_status, tracking_code, payload, ordered_at, updated_at_remote`; devolve `null` quando não gravou (mais velho ou anonimizado). Kind `integracao_desautorizada`; índice `agent_inbox_integracao_desautorizada_aberto_unico`.

- [ ] **Step 1: Escrever o invariante (falha antes da migration)**

`tests/invariants/nuvemshop-gravar-pedido.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * `fn_gravar_pedido_externo` (migration 0611): o pedido MAIS NOVO vence, o
 * anonimizado nunca é reescrito, contato de outra organização não é aceito, e
 * só `service_role` executa. `integration_sync_state` é lida pela org e escrita
 * só pelo servidor.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 2 });

const ORG_A = "c1a0f611-0000-4000-8000-00000000000a";
const ORG_B = "c1a0f611-0000-4000-8000-00000000000b";
const CONTATO_B = "c1a0f611-0000-4000-8000-0000000000cb";

function pedido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    external_provider: "nuvemshop",
    external_id: "9001",
    customer_external_id: "77",
    contact_id: null,
    status: "pending",
    total_cents: 12345,
    currency: "BRL",
    payment_method: "pix",
    fulfillment_status: null,
    tracking_code: null,
    payload: { number: 1001 },
    ordered_at: "2026-09-01T10:00:00Z",
    updated_at_remote: "2026-09-01T10:00:00Z",
    ...over,
  };
}

async function gravar(org: string, p: Record<string, unknown>): Promise<string | null> {
  const { rows } = await pool.query<{ id: string | null }>(
    "select public.fn_gravar_pedido_externo($1, $2::jsonb) as id",
    [org, JSON.stringify(p)],
  );
  return rows[0]!.id;
}

async function linha(org: string, externalId = "9001") {
  const { rows } = await pool.query(
    `select status, total_cents, contact_id, is_anonymized from public.orders
      where organization_id = $1 and external_provider = 'nuvemshop' and external_id = $2`,
    [org, externalId],
  );
  return rows[0];
}

beforeAll(async () => {
  for (const [id, slug] of [[ORG_A, "ns-sync-a"], [ORG_B, "ns-sync-b"]]) {
    await pool.query(
      "insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)",
      [id, slug],
    );
  }
  await pool.query(
    "insert into contacts (id, organization_id, name) values ($1, $2, 'Contato de B')",
    [CONTATO_B, ORG_B],
  );
});

afterAll(async () => {
  await pool.query("delete from orders where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await pool.query("delete from integration_sync_state where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await pool.query("delete from contacts where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await pool.query("delete from organizations where id in ($1, $2)", [ORG_A, ORG_B]);
  await pool.end();
});

describe("fn_gravar_pedido_externo", () => {
  it("insere na primeira vez e devolve o id", async () => {
    expect(await gravar(ORG_A, pedido())).toMatch(/^[0-9a-f-]{36}$/);
    expect((await linha(ORG_A))?.status).toBe("pending");
  });

  it("versão mais nova sobrescreve", async () => {
    await gravar(ORG_A, pedido({ status: "paid", updated_at_remote: "2026-09-02T10:00:00Z" }));
    expect((await linha(ORG_A))?.status).toBe("paid");
  });

  it("versão mais velha NÃO sobrescreve (webhook atrasado)", async () => {
    const id = await gravar(ORG_A, pedido({ status: "cancelled", updated_at_remote: "2026-09-01T12:00:00Z" }));
    expect(id).toBeNull();
    expect((await linha(ORG_A))?.status).toBe("paid");
  });

  it("pedido anonimizado nunca é reescrito", async () => {
    await pool.query(
      `update orders set is_anonymized = true where organization_id = $1 and external_id = '9001'`,
      [ORG_A],
    );
    const id = await gravar(ORG_A, pedido({ status: "delivered", updated_at_remote: "2026-09-10T10:00:00Z" }));
    expect(id).toBeNull();
    expect((await linha(ORG_A))?.status).toBe("paid");
  });

  it("contato de OUTRA organização vira null", async () => {
    await gravar(ORG_A, pedido({ external_id: "9002", contact_id: CONTATO_B }));
    expect((await linha(ORG_A, "9002"))?.contact_id).toBeNull();
  });

  it("anon e authenticated não executam; service_role executa", async () => {
    const { rows } = await pool.query<{ anon: boolean; auth: boolean; svc: boolean }>(
      `select has_function_privilege('anon', 'public.fn_gravar_pedido_externo(uuid, jsonb)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.fn_gravar_pedido_externo(uuid, jsonb)', 'execute') as auth,
              has_function_privilege('service_role', 'public.fn_gravar_pedido_externo(uuid, jsonb)', 'execute') as svc`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });
});

describe("integration_sync_state", () => {
  it("um estado por (org, provider, resource)", async () => {
    await pool.query(
      "insert into integration_sync_state (organization_id, provider, resource) values ($1, 'nuvemshop', 'orders')",
      [ORG_A],
    );
    await expect(
      pool.query(
        "insert into integration_sync_state (organization_id, provider, resource) values ($1, 'nuvemshop', 'orders')",
        [ORG_A],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("authenticated não tem privilégio de escrita", async () => {
    const { rows } = await pool.query<{ ins: boolean; upd: boolean; del: boolean }>(
      `select has_table_privilege('authenticated', 'public.integration_sync_state', 'insert') as ins,
              has_table_privilege('authenticated', 'public.integration_sync_state', 'update') as upd,
              has_table_privilege('authenticated', 'public.integration_sync_state', 'delete') as del`,
    );
    expect(rows[0]).toEqual({ ins: false, upd: false, del: false });
  });

  it("kind integracao_desautorizada aceito, um aviso aberto por integração", async () => {
    const ref = "c1a0f611-0000-4000-8000-0000000000e1";
    const inserir = () =>
      pool.query(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
         values ($1, 'integracao_desautorizada', 'warn', 't', 'b', 'tenant_integration', $2)`,
        [ORG_A, ref],
      );
    await inserir();
    await expect(inserir()).rejects.toMatchObject({ code: "23505" });
    await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG_A]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:db tests/invariants/nuvemshop-gravar-pedido.test.ts > /tmp/ns-db.log 2>&1; echo "exit=$?"; grep -aE "Tests |FAIL|function .* does not exist|relation .* does not exist" /tmp/ns-db.log | head`
Expected: FAIL com `function public.fn_gravar_pedido_externo(uuid, jsonb) does not exist` / `relation "integration_sync_state" does not exist`.

- [ ] **Step 3: Escrever a migration**

`supabase/migrations/20261008160000_0611_nuvemshop_sync_de_pedidos.sql` — a primeira linha é o manifest (uma linha só):

```sql
-- manifest: **Nuvemshop sincroniza pedidos (E1).** Cria `integration_sync_state` (estado, trava e cursor da sincronização por organização/provedor/recurso; leitura pela org, escrita só pelo servidor), a função `fn_gravar_pedido_externo` (upsert em `orders` onde o pedido MAIS NOVO vence e o anonimizado nunca é reescrito; `security definer` só para `service_role`) e o kind `integracao_desautorizada` na Central, com um aviso aberto por integração. Idempotente e auto-curativa: a lista do kind só cresce e o dedupe roda antes do índice.

-- 0611 — sincronização de pedidos da Nuvemshop
--
-- Por quê: o EPIC-07 entregou OAuth e recepção de webhook, mas nenhum consumidor
-- gravava `orders` (spec 2026-10-08-nuvemshop-sync-e1-design.md §1).

create table if not exists public.integration_sync_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('nuvemshop')),
  resource text not null check (resource in ('orders')),
  status text not null default 'idle' check (status in ('idle', 'running', 'error')),
  run_id uuid,
  run_origem text check (run_origem in ('conexao', 'reconciliacao', 'manual')),
  trava_ate timestamptz,
  cursor_updated_at timestamptz,
  janela_atual_ini timestamptz,
  janela_atual_fim timestamptz,
  alvo_fim timestamptz,
  pedidos_gravados integer not null default 0,
  pedidos_com_erro integer not null default 0,
  ultimo_erro text,
  ultimo_run_fim timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, resource)
);

alter table public.integration_sync_state enable row level security;

drop policy if exists tenant_isolation_integration_sync_state_read on public.integration_sync_state;
create policy tenant_isolation_integration_sync_state_read on public.integration_sync_state
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

-- Escrita é do servidor (handlers e cron com service_role). O default ACL do
-- Supabase concede tudo a anon/authenticated em tabela nova; a RLS já barra,
-- e o revoke tira a porta do catálogo também.
revoke insert, update, delete, truncate on public.integration_sync_state from anon, authenticated;
revoke select on public.integration_sync_state from anon;

drop trigger if exists trg_integration_sync_state_updated_at on public.integration_sync_state;
create trigger trg_integration_sync_state_updated_at
  before update on public.integration_sync_state
  for each row execute function public.fn_set_updated_at();

create or replace function public.fn_gravar_pedido_externo(p_organization_id uuid, p_pedido jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_contato uuid := nullif(p_pedido->>'contact_id', '')::uuid;
begin
  -- Contato só vale se for DESTA organização: a função ignora RLS.
  if v_contato is not null and not exists (
    select 1 from public.contacts c
     where c.id = v_contato and c.organization_id = p_organization_id
  ) then
    v_contato := null;
  end if;

  insert into public.orders as o (
    organization_id, external_provider, external_id, customer_external_id, contact_id,
    status, total_cents, currency, payment_method, fulfillment_status, tracking_code,
    payload, ordered_at, updated_at_remote
  ) values (
    p_organization_id,
    p_pedido->>'external_provider',
    p_pedido->>'external_id',
    nullif(p_pedido->>'customer_external_id', ''),
    v_contato,
    p_pedido->>'status',
    (p_pedido->>'total_cents')::bigint,
    coalesce(nullif(p_pedido->>'currency', ''), 'BRL'),
    nullif(p_pedido->>'payment_method', ''),
    nullif(p_pedido->>'fulfillment_status', ''),
    nullif(p_pedido->>'tracking_code', ''),
    coalesce(p_pedido->'payload', '{}'::jsonb),
    (p_pedido->>'ordered_at')::timestamptz,
    nullif(p_pedido->>'updated_at_remote', '')::timestamptz
  )
  on conflict (organization_id, external_provider, external_id) do update set
    customer_external_id = excluded.customer_external_id,
    contact_id = coalesce(excluded.contact_id, o.contact_id),
    status = excluded.status,
    total_cents = excluded.total_cents,
    currency = excluded.currency,
    payment_method = excluded.payment_method,
    fulfillment_status = excluded.fulfillment_status,
    tracking_code = excluded.tracking_code,
    payload = excluded.payload,
    ordered_at = excluded.ordered_at,
    updated_at_remote = excluded.updated_at_remote
  where not o.is_anonymized
    and (o.updated_at_remote is null or excluded.updated_at_remote >= o.updated_at_remote)
  returning o.id into v_id;

  return v_id;
end
$$;

revoke execute on function public.fn_gravar_pedido_externo(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_gravar_pedido_externo(uuid, jsonb) to service_role;
```

Na mesma migration, a constraint do kind (lista COMPLETA = os 39 valores da 0589 na mesma ordem + o novo antes de `'other'`) e o índice:

```sql
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required', 'appointment_recovery_review', 'qr_rescan',
    'routing_unassigned', 'job_dead', 'event_dead', 'budget_exceeded', 'handoff',
    'promotion_review', 'judge_unaligned', 'followup_dead', 'snooze_expired',
    'next_action_ambiguous', 'risk_backlog_seeded', 'reactivation_expired',
    'capabilities_missing', 'message_send_stuck', 'midia_nao_lida',
    'channel_template_review', 'channel_number_alert', 'promise_unfulfilled',
    'contact_proposal_expired', 'budget_warning', 'conhecimento_nao_indexado',
    'voice_call_missed', 'case_stale', 'aviso_de_caso_nao_entregue',
    'followup_sem_agente', 'canal_mudo_sem_numero', 'proposal_expired_notice',
    'proposal_acceptance_rate_drop', 'proposal_promised_not_created',
    'proposta_travada', 'proposta_pronta_para_revisao', 'org_reativada',
    'jev_pedido_de_humano', 'jev_parar_de_receber', 'canal_pausado',
    'integracao_desautorizada',
    'other'
  ));

with repetidas as (
  select id, row_number() over (
           partition by organization_id, kind, ref_id order by created_at asc, id asc
         ) as ordem
    from public.agent_inbox_items
   where status = 'open' and kind = 'integracao_desautorizada'
)
update public.agent_inbox_items i
   set status = 'resolved', resolved_at = now()
  from repetidas r
 where i.id = r.id and r.ordem > 1;

create unique index if not exists agent_inbox_integracao_desautorizada_aberto_unico
  on public.agent_inbox_items (organization_id, kind, ref_id)
  where status = 'open' and kind = 'integracao_desautorizada';

notify pgrst, 'reload schema';

-- 0611
```

Antes de colar a lista: conferir que ela é a da **última** migration que reconstrói a constraint (`grep -ln agent_inbox_items_kind_check supabase/migrations/*.sql | sort | tail -1`) **+** o valor novo. Se outra migration entrou depois da 0589, partir da lista dela.

- [ ] **Step 4: Refletir no baseline**

(a) No bloco único (procure `'canal_pausado',` seguido de `'other'` dentro do `add constraint agent_inbox_items_kind_check` — **o último** do arquivo), inserir antes de `'other'`:

```sql
    -- (migration 0611) A loja Nuvemshop revogou o acesso do app (401/403 na API):
    -- os pedidos param de sincronizar. Um aviso por integração, resolvido na
    -- reconexão. NESTA lista pelas razões de sempre (#159).
    'integracao_desautorizada',
```

(b) No fim do arquivo, bloco rotulado `-- ---- nuvemshop sync de pedidos (migration 0611) ----` com **todo** o SQL da migration **exceto** o `drop/add constraint agent_inbox_items_kind_check` (que já está no bloco único). Inclui: `create table if not exists`, RLS, policy, revokes, trigger, função + revoke/grant, dedupe + índice, `notify pgrst`.

- [ ] **Step 5: Registrar a tabela no isolamento RLS**

Em `tests/invariants/rls-isolation.test.ts`, dentro do bloco de seed por organização (ao lado do `external_db_connections`):

```sql
        -- migration 0611 — estado da sincronização da Nuvemshop. Escrita é só do
        -- servidor; a semente entra como superusuário e o caso mede a LEITURA.
        if not exists (select 1 from public.integration_sync_state where organization_id = v_org) then
          insert into public.integration_sync_state (organization_id, provider, resource)
            values (v_org, 'nuvemshop', 'orders');
        end if;
```

e em `TABLES`, antes do `] as const;`:

```ts
  // migration 0611 — estado da sincronização da Nuvemshop (cursor, contagens,
  // último erro). Leitura org-flat por qualquer membro; escrita só service_role.
  "integration_sync_state",
```

- [ ] **Step 6: Tipos** — em `lib/database.types.ts`, adicionar `integration_sync_state` em `Tables` (Row/Insert/Update/Relationships, copiando a forma de uma tabela vizinha com `organization_id`) e `fn_gravar_pedido_externo: { Args: { p_organization_id: string; p_pedido: Json }; Returns: string }` em `Functions` (ordem alfabética do arquivo).

- [ ] **Step 7: Rodar e ver passar**

```bash
pnpm test:db tests/invariants/nuvemshop-gravar-pedido.test.ts tests/invariants/rls-isolation.test.ts tests/invariants/hardening-definer-varredura.test.ts tests/invariants/rls-completude-varredura.test.ts > /tmp/ns-db.log 2>&1; echo "exit=$?"; grep -aE "Test Files|Tests " /tmp/ns-db.log | tail -2
pnpm vitest run tests/unit/baseline-constraint-reconstruida.test.ts tests/unit/kind-check-migration-x-baseline.test.ts tests/unit/manifest-x-migrations.test.ts tests/unit/baseline-no-piso-do-postgres.test.ts
pnpm checar:colisao-de-migration
```
Expected: exit 0 nos três; `checar` sem colisão.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20261008160000_0611_nuvemshop_sync_de_pedidos.sql supabase/baseline.sql lib/database.types.ts tests/invariants/nuvemshop-gravar-pedido.test.ts tests/invariants/rls-isolation.test.ts
git commit -m "feat(nuvemshop): schema da sincronização de pedidos (0611)"
```

---

### Task 2: Cliente da API — base configurável, timeout, `listOrders`, `getOrder`

**Files:**
- Modify: `lib/nuvemshop/config.ts`, `lib/nuvemshop/api-client.ts`, `lib/env.ts`, `.env.example`
- Create: `lib/nuvemshop/api-client.test.ts`

**Interfaces:**
- Produces:
  - `nuvemshopApiBase(): string` (config.ts)
  - `NuvemshopApiError` ganha `retryAfterMs: number | null` (5º parâmetro do construtor, default `null`)
  - `interface ConsultaDePedidos { updatedAtMin: string; updatedAtMax: string; page: number; perPage: number }`
  - `NuvemshopApiClient.listOrders(q: ConsultaDePedidos): Promise<unknown[]>` — 404 ⇒ `[]`
  - `NuvemshopApiClient.getOrder(id: string): Promise<unknown>` — 404 lança `NuvemshopApiError(404, "not_found")`

- [ ] **Step 1: Teste que falha**

`lib/nuvemshop/api-client.test.ts`:

```ts
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NuvemshopApiClient, NuvemshopApiError } from "./api-client";
import { nuvemshopApiBase } from "./config";

function resposta(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const cliente = () => new NuvemshopApiClient({ storeId: "123", accessToken: "tok" });

describe("nuvemshopApiBase", () => {
  it("usa o host real sem variável", () => {
    vi.stubEnv("NUVEMSHOP_API_BASE_URL", "");
    expect(nuvemshopApiBase()).toBe("https://api.tiendanube.com/v1");
  });
  it("aceita receptor local e apara a barra", () => {
    vi.stubEnv("NUVEMSHOP_API_BASE_URL", "http://127.0.0.1:3995/v1/");
    expect(nuvemshopApiBase()).toBe("http://127.0.0.1:3995/v1");
  });
  it("recusa esquema estranho e cai no host real", () => {
    vi.stubEnv("NUVEMSHOP_API_BASE_URL", "file:///etc/passwd");
    expect(nuvemshopApiBase()).toBe("https://api.tiendanube.com/v1");
  });
});

describe("listOrders", () => {
  it("monta a consulta com janela, página, status=any e o cabeçalho Authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resposta(200, "[]"));
    vi.stubGlobal("fetch", fetchMock);
    await cliente().listOrders({
      updatedAtMin: "2026-01-01T00:00:00.000Z",
      updatedAtMax: "2026-02-01T00:00:00.000Z",
      page: 3,
      perPage: 50,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.pathname).toBe("/v1/123/orders");
    expect(u.searchParams.get("updated_at_min")).toBe("2026-01-01T00:00:00.000Z");
    expect(u.searchParams.get("updated_at_max")).toBe("2026-02-01T00:00:00.000Z");
    expect(u.searchParams.get("page")).toBe("3");
    expect(u.searchParams.get("per_page")).toBe("50");
    expect(u.searchParams.get("status")).toBe("any");
    expect((init as RequestInit).headers).toMatchObject({ Authentication: "bearer tok" });
  });

  it("404 'Last page is 0' (janela vazia) vira lista vazia", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      resposta(404, '{"code":404,"message":"Not Found","description":"Last page is 0"}'),
    ));
    await expect(cliente().listOrders({ updatedAtMin: "a", updatedAtMax: "b", page: 1, perPage: 50 })).resolves.toEqual([]);
  });

  it("429 carrega retryAfterMs de x-rate-limit-reset", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(429, "{}", { "x-rate-limit-reset": "1500" })));
    const err = await cliente()
      .listOrders({ updatedAtMin: "a", updatedAtMax: "b", page: 1, perPage: 50 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NuvemshopApiError);
    expect((err as NuvemshopApiError).status).toBe(429);
    expect((err as NuvemshopApiError).retryAfterMs).toBe(1500);
  });

  it("429 sem cabeçalho deixa retryAfterMs null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(429, "{}")));
    const err = (await cliente()
      .listOrders({ updatedAtMin: "a", updatedAtMax: "b", page: 1, perPage: 50 })
      .catch((e: unknown) => e)) as NuvemshopApiError;
    expect(err.retryAfterMs).toBeNull();
  });
});

describe("getOrder", () => {
  it("404 lança not_found (pedido apagado)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(404, '{"code":404}')));
    const err = (await cliente().getOrder("55").catch((e: unknown) => e)) as NuvemshopApiError;
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });
  it("devolve o JSON do pedido", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(200, '{"id":55}')));
    await expect(cliente().getOrder("55")).resolves.toEqual({ id: 55 });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run lib/nuvemshop/api-client.test.ts`
Expected: FAIL (`nuvemshopApiBase is not a function`, `listOrders is not a function`).

- [ ] **Step 3: Implementar**

`lib/nuvemshop/config.ts` — depois de `NUVEMSHOP_API_BASE`:

```ts
import { hostAceito } from "@/lib/channels/meta/graph-base";
import { logger } from "@/lib/logger";

/**
 * A base da API desta instalação. `NUVEMSHOP_API_BASE_URL` existe para a prova
 * em tela (receptor local) e homólogo; o portão é o MESMO da Graph da Meta
 * (`hostAceito`): só http/https, barra final aparada e, em produção, `http` só
 * para destino interno. Valor recusado cai no host real e avisa no log.
 */
export function nuvemshopApiBase(): string {
  const bruto = process.env.NUVEMSHOP_API_BASE_URL?.trim();
  if (!bruto) return NUVEMSHOP_API_BASE;
  const aceito = hostAceito(bruto);
  if (!aceito) {
    logger.warn("[nuvemshop.config] NUVEMSHOP_API_BASE_URL recusada; usando o host real", { valor: bruto });
    return NUVEMSHOP_API_BASE;
  }
  return aceito;
}
```

`lib/nuvemshop/api-client.ts`:
- `NuvemshopApiError`: acrescentar `retryAfterMs: number | null;` e o parâmetro `retryAfterMs: number | null = null` após `message?`... — **ordem final do construtor:** `(status, code, body, message?, retryAfterMs = null)`.
- `url()`: trocar `NUVEMSHOP_API_BASE` por `nuvemshopApiBase()`.
- `fetch(...)`: acrescentar `signal: AbortSignal.timeout(20_000)` (sem timeout um GET pendurado prende o evento em `processing` por 10 min).
- No ramo `!res.ok`, para 429:

```ts
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      const retryAfterMs = res.status === 429 && Number.isFinite(reset) && reset > 0 ? reset : null;
      throw new NuvemshopApiError(res.status, code, text, undefined, retryAfterMs);
```

- Novos métodos:

```ts
export interface ConsultaDePedidos {
  updatedAtMin: string;
  updatedAtMax: string;
  page: number;
  perPage: number;
}

  /**
   * Uma página de pedidos de uma janela de `updated_at`. A Nuvemshop responde
   * 404 ("Last page is N") para página sem itens — inclusive a página 1 de uma
   * janela vazia —, então 404 aqui é lista vazia, não erro.
   */
  async listOrders(q: ConsultaDePedidos): Promise<unknown[]> {
    const params = new URLSearchParams({
      updated_at_min: q.updatedAtMin,
      updated_at_max: q.updatedAtMax,
      page: String(q.page),
      per_page: String(q.perPage),
      status: "any",
    });
    try {
      const data = await this.get<unknown>(`/orders?${params.toString()}`);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (err instanceof NuvemshopApiError && err.status === 404) return [];
      throw err;
    }
  }

  getOrder(id: string): Promise<unknown> {
    return this.get<unknown>(`/orders/${encodeURIComponent(id)}`);
  }
```

`lib/env.ts` — ao lado de `NUVEMSHOP_CLIENT_SECRET`:

```ts
  // Base da API da Nuvemshop. Vazia = host real. Existe para a prova em tela
  // (receptor local); o portão de valor vive em `nuvemshopApiBase()`.
  NUVEMSHOP_API_BASE_URL: z.string().optional().default(""),
```

`.env.example` — logo abaixo de `NUVEMSHOP_CLIENT_SECRET=`:

```bash
# Vazia em produção (fala com api.tiendanube.com). Só para receptor de prova.
NUVEMSHOP_API_BASE_URL=
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run lib/nuvemshop/ tests/unit/env-example*.test.ts`
Expected: PASS (se existir teste de paridade `.env.example` × `lib/env.ts`, ele também passa).

- [ ] **Step 5: Commit**

```bash
git add lib/nuvemshop/config.ts lib/nuvemshop/api-client.ts lib/nuvemshop/api-client.test.ts lib/env.ts .env.example
git commit -m "feat(nuvemshop): cliente lista e busca pedidos com timeout e rate limit"
```

---

### Task 3: `traduzirPedido` — pedido Nuvemshop → linha de `orders` (puro)

**Files:**
- Create: `lib/nuvemshop/sync/constantes.ts`, `lib/nuvemshop/sync/pedido-nuvemshop.ts`, `lib/nuvemshop/sync/traduzir-pedido.ts`, `lib/nuvemshop/sync/traduzir-pedido.test.ts`

**Interfaces:**
- Produces:
  - `constantes.ts`: `PROVEDOR = "nuvemshop"`, `PAGINA_TAMANHO = 50`, `PAGINA_MAXIMA = 200`, `MESES_DE_BACKFILL = 12`, `TRAVA_MS = 15 * 60_000`, `EVENTO_SYNC_PAGE = "nuvemshop.sync_page"`, `type OrigemDoRun = "conexao" | "reconciliacao" | "manual"`, `passoDoSyncSchema` (Zod) e `type PassoDoSync = { run_id: string; janela_ini: string; janela_fim: string; alvo_fim: string; pagina: number }`.
  - `pedido-nuvemshop.ts`: `pedidoNuvemshopSchema`, `type PedidoNuvemshop`.
  - `traduzir-pedido.ts`: `class ErroDeTraducao extends Error`, `centavosDe(valor: string | number): number | null`, `interface LinhaDePedido { external_provider: "nuvemshop"; external_id: string; customer_external_id: string | null; status: StatusDoPedido; fulfillment_status: StatusDeEnvio | null; total_cents: number; currency: string; payment_method: string | null; tracking_code: string | null; ordered_at: string; updated_at_remote: string; payload: Record<string, unknown> }`, `traduzirPedido(p: PedidoNuvemshop): LinhaDePedido` (lança `ErroDeTraducao`).

- [ ] **Step 1: Teste que falha**

`lib/nuvemshop/sync/traduzir-pedido.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pedidoNuvemshopSchema, type PedidoNuvemshop } from "./pedido-nuvemshop";
import { centavosDe, ErroDeTraducao, traduzirPedido } from "./traduzir-pedido";

function pedido(over: Partial<PedidoNuvemshop> = {}): PedidoNuvemshop {
  return pedidoNuvemshopSchema.parse({
    id: 555,
    number: 1001,
    status: "open",
    payment_status: "pending",
    shipping_status: "unpacked",
    total: "150.90",
    subtotal: "140.00",
    discount: "0.00",
    shipping_cost_customer: "10.90",
    currency: "BRL",
    gateway: "pix",
    shipping_tracking_number: null,
    created_at: "2026-09-01T10:00:00+0000",
    updated_at: "2026-09-02T11:00:00+0000",
    contact_email: "ana@ex.com",
    contact_phone: "+5511999990000",
    contact_identification: "123.456.789-09",
    contact_name: "Ana",
    billing_address: "Rua Secreta 1",
    customer: { id: 77, name: "Ana", email: "ana@ex.com", identification: "12345678909" },
    products: [{ product_id: 1, variant_id: 2, name: "Camisa", quantity: 2, price: "70.00", sku: "X" }],
    ...over,
  });
}

describe("centavosDe", () => {
  it.each([
    ["0.10", 10],
    ["1234.5", 123450],
    ["99", 9900],
    ["150.90", 15090],
    ["0", 0],
    ["10.005", 1001],
    [12.3, 1230],
  ])("%s → %s", (entrada, esperado) => {
    expect(centavosDe(entrada)).toBe(esperado);
  });
  it.each(["", "abc", "-1.00", "1,50", "NaN"])("recusa %s", (entrada) => {
    expect(centavosDe(entrada)).toBeNull();
  });
});

describe("traduzirPedido — status", () => {
  it.each([
    [{ status: "cancelled", payment_status: "paid" }, "cancelled"],
    [{ payment_status: "voided" }, "cancelled"],
    [{ payment_status: "refunded", shipping_status: "delivered" }, "refunded"],
    [{ payment_status: "paid", shipping_status: "delivered" }, "delivered"],
    [{ payment_status: "paid", shipping_status: "shipped" }, "shipped"],
    [{ payment_status: "paid", shipping_status: "unpacked" }, "paid"],
    [{ payment_status: "partially_refunded", shipping_status: "unpacked" }, "paid"],
    [{ payment_status: "authorized" }, "pending"],
    [{ payment_status: "partially_paid" }, "pending"],
    [{ payment_status: "abandoned" }, "pending"],
    [{ payment_status: "valor_novo_que_nao_existe" }, "pending"],
  ] as const)("%j → %s", (over, esperado) => {
    expect(traduzirPedido(pedido(over)).status).toBe(esperado);
  });
});

describe("traduzirPedido — envio", () => {
  it.each([
    ["unpacked", "unpacked"],
    ["partially_packed", "packed"],
    ["partially_fulfilled", "packed"],
    ["unshipped", "packed"],
    ["shipped", "shipped"],
    ["delivered", "delivered"],
    ["outra_coisa", null],
    [null, null],
  ] as const)("%s → %s", (entrada, esperado) => {
    expect(traduzirPedido(pedido({ shipping_status: entrada })).fulfillment_status).toBe(esperado);
  });
});

describe("traduzirPedido — campos", () => {
  it("mapeia ids, valores e datas", () => {
    const l = traduzirPedido(pedido());
    expect(l).toMatchObject({
      external_provider: "nuvemshop",
      external_id: "555",
      customer_external_id: "77",
      total_cents: 15090,
      currency: "BRL",
      payment_method: "pix",
      tracking_code: null,
      ordered_at: "2026-09-01T10:00:00.000Z",
      updated_at_remote: "2026-09-02T11:00:00.000Z",
    });
  });
  it("moeda ausente vira BRL", () => {
    expect(traduzirPedido(pedido({ currency: null })).currency).toBe("BRL");
  });
  it("payload é projeção: guarda produtos e status brutos, sem PII", () => {
    const { payload } = traduzirPedido(pedido());
    expect(payload).toMatchObject({
      number: 1001,
      products: [{ product_id: 1, variant_id: 2, name: "Camisa", quantity: 2, price: "70.00" }],
      origem: { status: "open", payment_status: "pending", shipping_status: "unpacked" },
    });
    const texto = JSON.stringify(payload);
    expect(texto).not.toContain("Rua Secreta");
    expect(texto).not.toContain("ana@ex.com");
    expect(texto).not.toContain("12345678909");
    expect(texto).not.toContain("sku");
  });
  it("total inválido lança ErroDeTraducao", () => {
    expect(() => traduzirPedido(pedido({ total: "abc" }))).toThrow(ErroDeTraducao);
  });
  it("data inválida lança ErroDeTraducao", () => {
    expect(() => traduzirPedido(pedido({ created_at: "ontem" }))).toThrow(ErroDeTraducao);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run lib/nuvemshop/sync/traduzir-pedido.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar**

`lib/nuvemshop/sync/constantes.ts`:

```ts
import { z } from "zod";

export const PROVEDOR = "nuvemshop" as const;
/** 50 e não 200: cada pedido custa ~4 consultas, e o evento precisa caber no dreno por cron. */
export const PAGINA_TAMANHO = 50;
/** A Nuvemshop entrega no máximo 10.000 itens por consulta. */
export const PAGINA_MAXIMA = 10_000 / PAGINA_TAMANHO;
export const MESES_DE_BACKFILL = 12;
export const TRAVA_MS = 15 * 60_000;
export const EVENTO_SYNC_PAGE = "nuvemshop.sync_page";

export type OrigemDoRun = "conexao" | "reconciliacao" | "manual";

export const passoDoSyncSchema = z.object({
  run_id: z.uuid(),
  janela_ini: z.iso.datetime(),
  janela_fim: z.iso.datetime(),
  alvo_fim: z.iso.datetime(),
  pagina: z.number().int().min(1),
});
export type PassoDoSync = z.infer<typeof passoDoSyncSchema>;
```

(Se o Zod do repo não tiver `z.iso.datetime()`, usar `z.string().datetime()` — conferir com `grep -rn "z.iso" lib | head -2`.)

`lib/nuvemshop/sync/pedido-nuvemshop.ts`:

```ts
import { z } from "zod";

/**
 * O pedido como a API devolve, TOLERANTE: só exige o que a tradução não pode
 * inventar (id, total, datas). O resto é opcional e o desconhecido passa
 * (`passthrough`) — um campo novo da Nuvemshop não pode derrubar a loja inteira.
 */
const idSchema = z.union([z.number(), z.string()]);
const valorSchema = z.union([z.string(), z.number()]);

export const pedidoNuvemshopSchema = z
  .object({
    id: idSchema,
    number: idSchema.nullish(),
    status: z.string().nullish(),
    payment_status: z.string().nullish(),
    shipping_status: z.string().nullish(),
    total: valorSchema,
    subtotal: valorSchema.nullish(),
    discount: valorSchema.nullish(),
    shipping_cost_customer: valorSchema.nullish(),
    currency: z.string().nullish(),
    gateway: z.string().nullish(),
    shipping_tracking_number: z.string().nullish(),
    shipping_option: z.unknown().optional(),
    landing_url: z.string().nullish(),
    channels: z.unknown().optional(),
    utm: z.unknown().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    contact_name: z.string().nullish(),
    contact_email: z.string().nullish(),
    contact_phone: z.string().nullish(),
    contact_identification: z.string().nullish(),
    customer: z
      .object({
        id: idSchema.nullish(),
        name: z.string().nullish(),
        email: z.string().nullish(),
        phone: z.string().nullish(),
        billing_phone: z.string().nullish(),
        identification: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    products: z
      .array(
        z
          .object({
            product_id: idSchema.nullish(),
            variant_id: idSchema.nullish(),
            name: z.unknown().optional(),
            quantity: valorSchema.nullish(),
            price: valorSchema.nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

export type PedidoNuvemshop = z.infer<typeof pedidoNuvemshopSchema>;
```

`lib/nuvemshop/sync/traduzir-pedido.ts`:

```ts
/**
 * Pedido da Nuvemshop → linha de `public.orders`. Puro.
 *
 * Valor desconhecido nunca chega ao CHECK de `orders`: cai no default da linha
 * (`pending` / `null`) e o bruto fica em `payload.origem` (spec §5.2).
 * O payload é PROJEÇÃO (spec §5.4): sem endereço, documento, e-mail ou nota.
 */
import { PROVEDOR } from "./constantes";
import type { PedidoNuvemshop } from "./pedido-nuvemshop";

export type StatusDoPedido = "pending" | "paid" | "cancelled" | "shipped" | "delivered" | "refunded";
export type StatusDeEnvio = "unpacked" | "packed" | "shipped" | "delivered";

export interface LinhaDePedido {
  external_provider: typeof PROVEDOR;
  external_id: string;
  customer_external_id: string | null;
  status: StatusDoPedido;
  fulfillment_status: StatusDeEnvio | null;
  total_cents: number;
  currency: string;
  payment_method: string | null;
  tracking_code: string | null;
  ordered_at: string;
  updated_at_remote: string;
  payload: Record<string, unknown>;
}

export class ErroDeTraducao extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "ErroDeTraducao";
  }
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** "150.90" → 15090. Por string, nunca `parseFloat * 100`. Meio centavo arredonda para cima. */
export function centavosDe(valor: string | number): number | null {
  const texto = typeof valor === "number" ? (Number.isFinite(valor) ? valor.toFixed(3) : "") : valor.trim();
  const m = DECIMAL.exec(texto);
  if (!m) return null;
  const inteiro = Number(m[1]);
  const fracao = (m[2] ?? "").padEnd(3, "0");
  const centavos = Number(fracao.slice(0, 2));
  const arredonda = Number(fracao[2]) >= 5 ? 1 : 0;
  const total = inteiro * 100 + centavos + arredonda;
  return Number.isSafeInteger(total) ? total : null;
}

function statusDe(p: PedidoNuvemshop): StatusDoPedido {
  if (p.status === "cancelled" || p.payment_status === "voided") return "cancelled";
  if (p.payment_status === "refunded") return "refunded";
  if (p.shipping_status === "delivered") return "delivered";
  if (p.shipping_status === "shipped") return "shipped";
  if (p.payment_status === "paid" || p.payment_status === "partially_refunded") return "paid";
  return "pending";
}

const ENVIO: Record<string, StatusDeEnvio> = {
  unpacked: "unpacked",
  partially_packed: "packed",
  partially_fulfilled: "packed",
  unshipped: "packed",
  shipped: "shipped",
  delivered: "delivered",
};

function isoDe(texto: string, campo: string): string {
  const ms = Date.parse(texto);
  if (!Number.isFinite(ms)) throw new ErroDeTraducao(`data_invalida:${campo}`);
  return new Date(ms).toISOString();
}

function textoOuNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function projecao(p: PedidoNuvemshop): Record<string, unknown> {
  const base: Record<string, unknown> = {
    number: p.number ?? null,
    status: p.status ?? null,
    payment_status: p.payment_status ?? null,
    shipping_status: p.shipping_status ?? null,
    gateway: p.gateway ?? null,
    subtotal: p.subtotal ?? null,
    discount: p.discount ?? null,
    shipping_cost_customer: p.shipping_cost_customer ?? null,
    shipping_option: p.shipping_option ?? null,
    landing_url: p.landing_url ?? null,
    products: (p.products ?? []).map((i) => ({
      product_id: i.product_id ?? null,
      variant_id: i.variant_id ?? null,
      name: i.name ?? null,
      quantity: i.quantity ?? null,
      price: i.price ?? null,
    })),
    origem: {
      status: p.status ?? null,
      payment_status: p.payment_status ?? null,
      shipping_status: p.shipping_status ?? null,
    },
  };
  if (p.channels !== undefined) base.channels = p.channels;
  if (p.utm !== undefined) base.utm = p.utm;
  return base;
}

export function traduzirPedido(p: PedidoNuvemshop): LinhaDePedido {
  const total = centavosDe(p.total);
  if (total === null) throw new ErroDeTraducao("total_invalido");
  return {
    external_provider: PROVEDOR,
    external_id: String(p.id),
    customer_external_id: textoOuNull(p.customer?.id),
    status: statusDe(p),
    fulfillment_status: (p.shipping_status && ENVIO[p.shipping_status]) || null,
    total_cents: total,
    currency: (textoOuNull(p.currency) ?? "BRL").toUpperCase().slice(0, 3),
    payment_method: textoOuNull(p.gateway),
    tracking_code: textoOuNull(p.shipping_tracking_number),
    ordered_at: isoDe(p.created_at, "created_at"),
    updated_at_remote: isoDe(p.updated_at, "updated_at"),
    payload: projecao(p),
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run lib/nuvemshop/sync/traduzir-pedido.test.ts`
Expected: PASS. Atenção ao caso `"10.005" → 1001` (arredondamento) e `12.3 → 1230` (número).

- [ ] **Step 5: Commit**

```bash
git add lib/nuvemshop/sync/constantes.ts lib/nuvemshop/sync/pedido-nuvemshop.ts lib/nuvemshop/sync/traduzir-pedido.ts lib/nuvemshop/sync/traduzir-pedido.test.ts
git commit -m "feat(nuvemshop): tradução pura do pedido para orders"
```

---

### Task 4: Contato do pedido — chaves, decisão (pura) e efeito

**Files:**
- Create: `lib/nuvemshop/sync/contato-do-pedido.ts`, `lib/nuvemshop/sync/contato-do-pedido.test.ts`

**Interfaces:**
- Consumes: `PedidoNuvemshop` (Task 3); `normalizePhoneBR` (`@/lib/webhooks/inbound`); `normalizeCpf`, `hashCpf`, `camposCpfParaGravar` (`@/lib/contacts/cpf`); `encontrarContatoPorTelefoneComNome` (`@/lib/channels/contato-por-telefone`).
- Produces:
  - `interface ChavesDoContato { telefone: string | null; email: string | null; cpf: string | null; nome: string | null }`
  - `extrairChaves(p: PedidoNuvemshop): ChavesDoContato`
  - `interface CandidatoDeContato { id: string; name: string | null; email: string | null; cpf_hash: string | null; via: "telefone" | "email" | "cpf" }`
  - `type DecisaoDeContato = { acao: "sem_chave" } | { acao: "usar"; contatoId: string; completar: { name?: string; email?: string; cpf?: string } } | { acao: "criar"; dados: { name: string; phone_number: string | null; email: string | null; cpf: string | null } }`
  - `decidirContato(chaves: ChavesDoContato, candidatos: CandidatoDeContato[]): DecisaoDeContato`
  - `resolverContatoDoPedido(admin: SupabaseClient, ctx: { orgId: string; storeId: string; customerId: string | null }, chaves: ChavesDoContato): Promise<string | null>`

- [ ] **Step 1: Teste que falha (parte pura + efeito com dublê mínimo)**

`lib/nuvemshop/sync/contato-do-pedido.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pedidoNuvemshopSchema } from "./pedido-nuvemshop";
import { decidirContato, extrairChaves, type ChavesDoContato } from "./contato-do-pedido";

const base = {
  id: 1, total: "1.00", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

describe("extrairChaves", () => {
  it("prefere os campos contact_* e normaliza", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({
      ...base,
      contact_phone: "(11) 99999-0000",
      contact_email: "  Ana@Ex.COM ",
      contact_identification: "123.456.789-09",
      contact_name: "Ana",
      customer: { phone: "+5521888880000", email: "outra@ex.com", name: "Outra" },
    }));
    expect(c).toEqual({ telefone: "+5511999990000", email: "ana@ex.com", cpf: "12345678909", nome: "Ana" });
  });

  it("cai para customer.* e billing_phone", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({
      ...base,
      customer: { billing_phone: "21988880000", email: "b@ex.com", identification: "98765432100", name: "Bia" },
    }));
    expect(c).toEqual({ telefone: "+5521988880000", email: "b@ex.com", cpf: "98765432100", nome: "Bia" });
  });

  it("telefone estrangeiro com + é preservado (Tiendanube AR)", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({ ...base, contact_phone: "+54 9 11 1234-5678" }));
    expect(c.telefone).toBe("+5491112345678");
  });

  it("documento que não é CPF (CNPJ, DNI) não vira chave", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({ ...base, contact_identification: "12.345.678/0001-90" }));
    expect(c.cpf).toBeNull();
  });

  it("e-mail sem @ é descartado", () => {
    expect(extrairChaves(pedidoNuvemshopSchema.parse({ ...base, contact_email: "sem-arroba" })).email).toBeNull();
  });
});

const chaves = (over: Partial<ChavesDoContato> = {}): ChavesDoContato => ({
  telefone: "+5511999990000", email: "ana@ex.com", cpf: "12345678909", nome: "Ana", ...over,
});

describe("decidirContato", () => {
  it("nenhuma chave → sem_chave", () => {
    expect(decidirContato(chaves({ telefone: null, email: null, cpf: null }), [])).toEqual({ acao: "sem_chave" });
  });

  it("telefone vence e-mail divergente", () => {
    const d = decidirContato(chaves(), [
      { id: "por-email", name: "X", email: "ana@ex.com", cpf_hash: null, via: "email" },
      { id: "por-telefone", name: "Ana", email: "outra@ex.com", cpf_hash: "h", via: "telefone" },
    ]);
    expect(d).toEqual({ acao: "usar", contatoId: "por-telefone", completar: {} });
  });

  it("completa só campos vazios", () => {
    const d = decidirContato(chaves(), [{ id: "c1", name: null, email: null, cpf_hash: null, via: "email" }]);
    expect(d).toEqual({ acao: "usar", contatoId: "c1", completar: { name: "Ana", email: "ana@ex.com", cpf: "12345678909" } });
  });

  it("só CPF casa", () => {
    const d = decidirContato(chaves({ telefone: null, email: null }), [
      { id: "c2", name: "Ana", email: "x@y.com", cpf_hash: "h", via: "cpf" },
    ]);
    expect(d).toMatchObject({ acao: "usar", contatoId: "c2" });
  });

  it("sem candidato e com chave → criar, nome cai para telefone", () => {
    expect(decidirContato(chaves({ nome: null, email: null, cpf: null }), [])).toEqual({
      acao: "criar",
      dados: { name: "+5511999990000", phone_number: "+5511999990000", email: null, cpf: null },
    });
  });
});
```

(O caso "candidato anonimizado/mesclado ignorado" é responsabilidade das consultas do efeito — filtradas por `is_merged_into is null` e `is_anonymized = false`; coberto no e2e e no Step 3 pela forma das consultas.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run lib/nuvemshop/sync/contato-do-pedido.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

`lib/nuvemshop/sync/contato-do-pedido.ts`:

```ts
/**
 * Quem é o cliente do pedido (spec §5.3).
 *
 * Telefone → e-mail → CPF, nessa ordem, e o primeiro acerto vence: WhatsApp é o
 * canal primário. Contato achado só ganha campo VAZIO; nada é sobrescrito, e
 * `is_blocked` (STOP) nunca é tocado. Sem chave nenhuma, o pedido fica sem
 * contato — inventar alguém seria pior.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { encontrarContatoPorTelefoneComNome } from "@/lib/channels/contato-por-telefone";
import { camposCpfParaGravar, hashCpf, normalizeCpf } from "@/lib/contacts/cpf";
import { logger } from "@/lib/logger";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";
import type { PedidoNuvemshop } from "./pedido-nuvemshop";

export interface ChavesDoContato {
  telefone: string | null;
  email: string | null;
  cpf: string | null;
  nome: string | null;
}

export interface CandidatoDeContato {
  id: string;
  name: string | null;
  email: string | null;
  cpf_hash: string | null;
  via: "telefone" | "email" | "cpf";
}

export type DecisaoDeContato =
  | { acao: "sem_chave" }
  | { acao: "usar"; contatoId: string; completar: { name?: string; email?: string; cpf?: string } }
  | { acao: "criar"; dados: { name: string; phone_number: string | null; email: string | null; cpf: string | null } };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PRIORIDADE: Record<CandidatoDeContato["via"], number> = { telefone: 0, email: 1, cpf: 2 };

function vazio(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === "";
}

export function extrairChaves(p: PedidoNuvemshop): ChavesDoContato {
  const telefoneBruto = p.contact_phone ?? p.customer?.phone ?? p.customer?.billing_phone ?? null;
  const emailBruto = (p.contact_email ?? p.customer?.email ?? "").trim().toLowerCase();
  const cpfBruto = normalizeCpf(p.contact_identification ?? p.customer?.identification ?? "");
  const nome = (p.contact_name ?? p.customer?.name ?? "").trim();
  return {
    telefone: normalizePhoneBR(telefoneBruto),
    email: EMAIL.test(emailBruto) ? emailBruto : null,
    cpf: cpfBruto.length === 11 ? cpfBruto : null,
    nome: nome || null,
  };
}

export function decidirContato(chaves: ChavesDoContato, candidatos: CandidatoDeContato[]): DecisaoDeContato {
  if (!chaves.telefone && !chaves.email && !chaves.cpf) return { acao: "sem_chave" };
  const [escolhido] = [...candidatos].sort((a, b) => PRIORIDADE[a.via] - PRIORIDADE[b.via]);
  if (escolhido) {
    const completar: { name?: string; email?: string; cpf?: string } = {};
    if (vazio(escolhido.name) && chaves.nome) completar.name = chaves.nome;
    if (vazio(escolhido.email) && chaves.email) completar.email = chaves.email;
    if (vazio(escolhido.cpf_hash) && chaves.cpf) completar.cpf = chaves.cpf;
    return { acao: "usar", contatoId: escolhido.id, completar };
  }
  return {
    acao: "criar",
    dados: {
      name: chaves.nome ?? chaves.telefone ?? chaves.email ?? "Cliente Nuvemshop",
      phone_number: chaves.telefone,
      email: chaves.email,
      cpf: chaves.cpf,
    },
  };
}

const COLUNAS = "id, name, email, cpf_hash";

async function ativoPorId(admin: SupabaseClient, orgId: string, id: string) {
  const { data } = await admin
    .from("contacts")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .eq("id", id)
    .is("is_merged_into", null)
    .eq("is_anonymized", false)
    .maybeSingle();
  return data as Omit<CandidatoDeContato, "via"> | null;
}

/** Busca na ordem da precedência e para no primeiro acerto. */
async function buscarCandidato(
  admin: SupabaseClient,
  orgId: string,
  chaves: ChavesDoContato,
): Promise<CandidatoDeContato | null> {
  if (chaves.telefone) {
    const porTelefone = await encontrarContatoPorTelefoneComNome(admin, orgId, chaves.telefone);
    const ativo = porTelefone ? await ativoPorId(admin, orgId, porTelefone.id) : null;
    if (ativo) return { ...ativo, via: "telefone" };
  }
  if (chaves.email) {
    const { data } = await admin
      .from("contacts")
      .select(COLUNAS)
      .eq("organization_id", orgId)
      .eq("email_normalized", chaves.email)
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      .maybeSingle();
    if (data) return { ...(data as Omit<CandidatoDeContato, "via">), via: "email" };
  }
  if (chaves.cpf) {
    const { data } = await admin
      .from("contacts")
      .select(COLUNAS)
      .eq("organization_id", orgId)
      .eq("cpf_hash", hashCpf(chaves.cpf))
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      .maybeSingle();
    if (data) return { ...(data as Omit<CandidatoDeContato, "via">), via: "cpf" };
  }
  return null;
}

export async function resolverContatoDoPedido(
  admin: SupabaseClient,
  ctx: { orgId: string; storeId: string; customerId: string | null },
  chaves: ChavesDoContato,
): Promise<string | null> {
  const candidato = await buscarCandidato(admin, ctx.orgId, chaves);
  const decisao = decidirContato(chaves, candidato ? [candidato] : []);

  if (decisao.acao === "sem_chave") return null;

  if (decisao.acao === "usar") {
    const { name, email, cpf } = decisao.completar;
    const patch: Record<string, unknown> = {};
    if (name) patch.name = name;
    if (email) patch.email = email;
    if (cpf) Object.assign(patch, await camposCpfParaGravar(admin, cpf));
    if (Object.keys(patch).length > 0) {
      const { error } = await admin
        .from("contacts")
        .update(patch)
        .eq("organization_id", ctx.orgId)
        .eq("id", decisao.contatoId);
      // 23505 = e-mail/CPF já é de OUTRO contato ativo: enriquecer é opcional.
      if (error && error.code !== "23505") {
        logger.warn("[nuvemshop.sync] completar contato falhou", { code: error.code, contact_id: decisao.contatoId });
      }
    }
    return decisao.contatoId;
  }

  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: ctx.orgId,
      name: decisao.dados.name,
      phone_number: decisao.dados.phone_number,
      email: decisao.dados.email,
      ...(decisao.dados.cpf ? await camposCpfParaGravar(admin, decisao.dados.cpf) : {}),
      source: "nuvemshop",
      source_metadata: { store_id: ctx.storeId, customer_id: ctx.customerId },
    })
    .select("id")
    .maybeSingle();
  if (!error) return (data?.id as string | undefined) ?? null;
  if (error.code !== "23505") throw new Error(`contato_nao_criado:${error.code ?? "sem_code"}`);
  // Corrida: outro evento criou o mesmo cliente. Re-seleciona o vencedor.
  return (await buscarCandidato(admin, ctx.orgId, chaves))?.id ?? null;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run lib/nuvemshop/sync/contato-do-pedido.test.ts`
Expected: PASS. Se o caso do telefone estrangeiro falhar, conferir `canonicalPhoneBR` para `+54…` e ajustar só a expectativa ao E.164 que o produto já usa (não mexer em `normalizePhoneBR`).

- [ ] **Step 5: Commit**

```bash
git add lib/nuvemshop/sync/contato-do-pedido.ts lib/nuvemshop/sync/contato-do-pedido.test.ts
git commit -m "feat(nuvemshop): contato do pedido por telefone, e-mail ou CPF"
```

---

### Task 5: `gravarPedido` — compõe validação, LGPD, contato e RPC

**Files:**
- Create: `lib/nuvemshop/sync/gravar-pedido.ts`, `lib/nuvemshop/sync/gravar-pedido.test.ts`

**Interfaces:**
- Consumes: `pedidoNuvemshopSchema` (T3), `traduzirPedido`/`ErroDeTraducao` (T3), `extrairChaves`/`resolverContatoDoPedido` (T4), RPC `fn_gravar_pedido_externo` (T1).
- Produces:
  - `type ResultadoDaGravacao = { ok: true; orderId: string | null; ignorado?: "anonimizado" } | { ok: false; motivo: string }`
  - `gravarPedido(admin: SupabaseClient, ctx: { orgId: string; storeId: string }, bruto: unknown, resolver?: typeof resolverContatoDoPedido): Promise<ResultadoDaGravacao>` — erro de infraestrutura (RPC/consulta) **lança**; dado ruim devolve `ok:false`.

- [ ] **Step 1: Teste que falha**

`lib/nuvemshop/sync/gravar-pedido.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gravarPedido } from "./gravar-pedido";

/** Dublê do admin: só o que gravarPedido toca. */
function adminFalso(opts: { anonimizado?: boolean; rpcErro?: string } = {}) {
  const rpc = vi.fn().mockResolvedValue(
    opts.rpcErro ? { data: null, error: { message: opts.rpcErro } } : { data: "order-1", error: null },
  );
  const maybeSingle = vi.fn().mockResolvedValue({
    data: opts.anonimizado === undefined ? null : { is_anonymized: opts.anonimizado },
    error: null,
  });
  const cadeia = { select: () => cadeia, eq: () => cadeia, maybeSingle };
  const admin = { rpc, from: vi.fn(() => cadeia) } as unknown as SupabaseClient;
  return { admin, rpc };
}

const bruto = {
  id: 555, total: "10.00", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z",
  contact_phone: "+5511999990000", customer: { id: 7 },
};
const ctx = { orgId: "org-1", storeId: "store-1" };

describe("gravarPedido", () => {
  it("grava com o contato resolvido e devolve o id", async () => {
    const { admin, rpc } = adminFalso();
    const resolver = vi.fn().mockResolvedValue("contato-1");
    await expect(gravarPedido(admin, ctx, bruto, resolver)).resolves.toEqual({ ok: true, orderId: "order-1" });
    expect(resolver).toHaveBeenCalledWith(admin, { orgId: "org-1", storeId: "store-1", customerId: "7" }, expect.objectContaining({ telefone: "+5511999990000" }));
    expect(rpc).toHaveBeenCalledWith("fn_gravar_pedido_externo", {
      p_organization_id: "org-1",
      p_pedido: expect.objectContaining({ external_id: "555", contact_id: "contato-1", total_cents: 1000 }),
    });
  });

  it("pedido já anonimizado: não resolve contato nem grava (LGPD)", async () => {
    const { admin, rpc } = adminFalso({ anonimizado: true });
    const resolver = vi.fn();
    await expect(gravarPedido(admin, ctx, bruto, resolver)).resolves.toEqual({ ok: true, orderId: null, ignorado: "anonimizado" });
    expect(resolver).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("formato inesperado → ok:false pedido_invalido", async () => {
    const { admin } = adminFalso();
    await expect(gravarPedido(admin, ctx, { id: 1 }, vi.fn())).resolves.toEqual({ ok: false, motivo: "pedido_invalido:1" });
  });

  it("tradução impossível → ok:false com o motivo", async () => {
    const { admin } = adminFalso();
    await expect(gravarPedido(admin, ctx, { ...bruto, total: "abc" }, vi.fn().mockResolvedValue(null)))
      .resolves.toEqual({ ok: false, motivo: "total_invalido:555" });
  });

  it("falha da RPC lança (infra, não dado)", async () => {
    const { admin } = adminFalso({ rpcErro: "boom" });
    await expect(gravarPedido(admin, ctx, bruto, vi.fn().mockResolvedValue(null))).rejects.toThrow(/fn_gravar_pedido_externo/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm vitest run lib/nuvemshop/sync/gravar-pedido.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar**

`lib/nuvemshop/sync/gravar-pedido.ts`:

```ts
/**
 * Um pedido bruto da API → `orders`. Dado ruim devolve `ok:false` (a página
 * segue: um pedido ruim não trava a loja); falha de banco LANÇA (o evento volta
 * para a fila e a página inteira é regravada — o upsert é idempotente).
 *
 * LGPD: pedido já anonimizado é pulado ANTES de resolver contato. Senão a
 * re-sincronização recriaria, a partir do pedido, o contato que o redact apagou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PROVEDOR } from "./constantes";
import { extrairChaves, resolverContatoDoPedido } from "./contato-do-pedido";
import { pedidoNuvemshopSchema } from "./pedido-nuvemshop";
import { ErroDeTraducao, traduzirPedido } from "./traduzir-pedido";

export type ResultadoDaGravacao =
  | { ok: true; orderId: string | null; ignorado?: "anonimizado" }
  | { ok: false; motivo: string };

function idDe(bruto: unknown): string {
  const id = (bruto as { id?: unknown } | null)?.id;
  return id === undefined || id === null ? "sem_id" : String(id);
}

export async function gravarPedido(
  admin: SupabaseClient,
  ctx: { orgId: string; storeId: string },
  bruto: unknown,
  resolver: typeof resolverContatoDoPedido = resolverContatoDoPedido,
): Promise<ResultadoDaGravacao> {
  const parsed = pedidoNuvemshopSchema.safeParse(bruto);
  if (!parsed.success) return { ok: false, motivo: `pedido_invalido:${idDe(bruto)}` };
  const pedido = parsed.data;

  let linha;
  try {
    linha = traduzirPedido(pedido);
  } catch (err) {
    if (err instanceof ErroDeTraducao) return { ok: false, motivo: `${err.message}:${String(pedido.id)}` };
    throw err;
  }

  const { data: existente, error: erroLeitura } = await admin
    .from("orders")
    .select("is_anonymized")
    .eq("organization_id", ctx.orgId)
    .eq("external_provider", PROVEDOR)
    .eq("external_id", linha.external_id)
    .maybeSingle();
  if (erroLeitura) throw new Error(`orders_leitura:${erroLeitura.message}`);
  if ((existente as { is_anonymized?: boolean } | null)?.is_anonymized) {
    return { ok: true, orderId: null, ignorado: "anonimizado" };
  }

  const contatoId = await resolver(
    admin,
    { orgId: ctx.orgId, storeId: ctx.storeId, customerId: linha.customer_external_id },
    extrairChaves(pedido),
  );

  const { data, error } = await admin.rpc("fn_gravar_pedido_externo", {
    p_organization_id: ctx.orgId,
    p_pedido: { ...linha, contact_id: contatoId },
  });
  if (error) throw new Error(`fn_gravar_pedido_externo:${error.message}`);
  return { ok: true, orderId: (data as string | null) ?? null };
}
```

- [ ] **Step 4: Rodar e ver passar** — `pnpm vitest run lib/nuvemshop/sync/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/nuvemshop/sync/gravar-pedido.ts lib/nuvemshop/sync/gravar-pedido.test.ts
git commit -m "feat(nuvemshop): gravação do pedido com contato e guarda LGPD"
```

---

### Task 6: Janelas e próximo passo (puro)

**Files:**
- Create: `lib/nuvemshop/sync/janelas.ts`, `lib/nuvemshop/sync/janelas.test.ts`

**Interfaces:**
- Consumes: `PassoDoSync`, `PAGINA_TAMANHO`, `PAGINA_MAXIMA`, `MESES_DE_BACKFILL` (T3).
- Produces:
  - `primeiroPasso(args: { runId: string; cursor: string | null; agora: Date }): PassoDoSync`
  - `type ProximoPasso = { tipo: "pagina"; passo: PassoDoSync; perda: boolean } | { tipo: "fim"; perda: boolean }`
  - `proximoPasso(passo: PassoDoSync, itensNaPagina: number): ProximoPasso`
  - `mesDoBackfill(janelaIni: string, alvoFim: string): number` (1..12, para a tela)

- [ ] **Step 1: Teste que falha**

`lib/nuvemshop/sync/janelas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PAGINA_MAXIMA, PAGINA_TAMANHO, type PassoDoSync } from "./constantes";
import { mesDoBackfill, primeiroPasso, proximoPasso } from "./janelas";

const RUN = "00000000-0000-4000-8000-000000000001";
const AGORA = new Date("2026-10-08T12:00:00.000Z");

describe("primeiroPasso", () => {
  it("sem cursor: backfill de 12 meses, primeira janela mensal", () => {
    expect(primeiroPasso({ runId: RUN, cursor: null, agora: AGORA })).toEqual({
      run_id: RUN,
      janela_ini: "2025-10-08T12:00:00.000Z",
      janela_fim: "2025-11-08T12:00:00.000Z",
      alvo_fim: "2026-10-08T12:00:00.000Z",
      pagina: 1,
    });
  });
  it("com cursor recente: uma janela [cursor, agora]", () => {
    expect(primeiroPasso({ runId: RUN, cursor: "2026-10-08T11:30:00.000Z", agora: AGORA })).toMatchObject({
      janela_ini: "2026-10-08T11:30:00.000Z",
      janela_fim: "2026-10-08T12:00:00.000Z",
    });
  });
});

describe("proximoPasso", () => {
  const p = (over: Partial<PassoDoSync> = {}): PassoDoSync => ({
    run_id: RUN,
    janela_ini: "2026-01-01T00:00:00.000Z",
    janela_fim: "2026-02-01T00:00:00.000Z",
    alvo_fim: "2026-10-08T12:00:00.000Z",
    pagina: 1,
    ...over,
  });

  it("página cheia → próxima página da mesma janela", () => {
    expect(proximoPasso(p({ pagina: 3 }), PAGINA_TAMANHO)).toEqual({ tipo: "pagina", passo: p({ pagina: 4 }), perda: false });
  });

  it("página incompleta → próxima janela mensal, página 1", () => {
    expect(proximoPasso(p({ pagina: 3 }), 7)).toEqual({
      tipo: "pagina",
      passo: p({ janela_ini: "2026-02-01T00:00:00.000Z", janela_fim: "2026-03-01T00:00:00.000Z", pagina: 1 }),
      perda: false,
    });
  });

  it("última janela é cortada no alvo", () => {
    const r = proximoPasso(p({ janela_ini: "2026-09-01T00:00:00.000Z", janela_fim: "2026-10-01T00:00:00.000Z" }), 0);
    expect(r).toMatchObject({ tipo: "pagina", passo: { janela_ini: "2026-10-01T00:00:00.000Z", janela_fim: "2026-10-08T12:00:00.000Z" } });
  });

  it("janela que chega ao alvo e não está cheia → fim", () => {
    expect(proximoPasso(p({ janela_fim: "2026-10-08T12:00:00.000Z" }), 10)).toEqual({ tipo: "fim", perda: false });
  });

  it("última janela indivisível e cheia no teto → fim com perda", () => {
    const ultima = p({ janela_ini: "2026-10-08T11:59:00.000Z", janela_fim: "2026-10-08T12:00:00.000Z", pagina: PAGINA_MAXIMA });
    expect(proximoPasso(ultima, PAGINA_TAMANHO)).toEqual({ tipo: "fim", perda: true });
  });

  it("página máxima cheia → divide a janela ao meio e recomeça na página 1", () => {
    expect(proximoPasso(p({ pagina: PAGINA_MAXIMA }), PAGINA_TAMANHO)).toEqual({
      tipo: "pagina",
      passo: p({ janela_fim: "2026-01-16T12:00:00.000Z", pagina: 1 }),
      perda: false,
    });
  });

  it("janela indivisível (≤ 2 min) e cheia no teto → segue e marca perda", () => {
    const curta = p({ janela_ini: "2026-01-01T00:00:00.000Z", janela_fim: "2026-01-01T00:01:00.000Z", pagina: PAGINA_MAXIMA });
    const r = proximoPasso(curta, PAGINA_TAMANHO);
    expect(r).toMatchObject({ tipo: "pagina", perda: true, passo: { janela_ini: "2026-01-01T00:01:00.000Z", pagina: 1 } });
  });

  it("encadeia 12 janelas no backfill", () => {
    let passo = primeiroPasso({ runId: RUN, cursor: null, agora: AGORA });
    let janelas = 1;
    for (;;) {
      const r = proximoPasso(passo, 0);
      if (r.tipo === "fim") break;
      passo = r.passo;
      janelas++;
    }
    expect(janelas).toBe(12);
    expect(passo.janela_fim).toBe("2026-10-08T12:00:00.000Z");
  });
});

describe("mesDoBackfill", () => {
  it("primeira janela é o mês 1, a última o 12", () => {
    expect(mesDoBackfill("2025-10-08T12:00:00.000Z", "2026-10-08T12:00:00.000Z")).toBe(1);
    expect(mesDoBackfill("2026-09-08T12:00:00.000Z", "2026-10-08T12:00:00.000Z")).toBe(12);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm vitest run lib/nuvemshop/sync/janelas.test.ts` → FAIL.

- [ ] **Step 3: Implementar**

`lib/nuvemshop/sync/janelas.ts`:

```ts
/**
 * Janelas de `updated_at` da sincronização (spec §4.2). Puro.
 *
 * Toda janela tem no máximo 1 mês: backfill começa em `alvo − 12 meses`,
 * reconciliação em `cursor`. A janela fica FIXA durante a paginação; pedido
 * alterado no meio sai dela e volta na próxima reconciliação.
 */
import { MESES_DE_BACKFILL, PAGINA_MAXIMA, PAGINA_TAMANHO, type PassoDoSync } from "./constantes";

const DOIS_MINUTOS = 2 * 60_000;

function somarMeses(iso: string, meses: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + meses);
  return d.toISOString();
}

function menor(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function janelaDesde(ini: string, alvo: string): { janela_ini: string; janela_fim: string } {
  return { janela_ini: ini, janela_fim: menor(somarMeses(ini, 1), alvo) };
}

export function primeiroPasso(args: { runId: string; cursor: string | null; agora: Date }): PassoDoSync {
  const alvo = args.agora.toISOString();
  const ini = args.cursor ? new Date(args.cursor).toISOString() : somarMeses(alvo, -MESES_DE_BACKFILL);
  return { run_id: args.runId, ...janelaDesde(menor(ini, alvo), alvo), alvo_fim: alvo, pagina: 1 };
}

export type ProximoPasso = { tipo: "pagina"; passo: PassoDoSync; perda: boolean } | { tipo: "fim"; perda: boolean };

function proximaJanela(passo: PassoDoSync, perda: boolean): ProximoPasso {
  if (Date.parse(passo.janela_fim) >= Date.parse(passo.alvo_fim)) return { tipo: "fim", perda };
  return { tipo: "pagina", passo: { ...passo, ...janelaDesde(passo.janela_fim, passo.alvo_fim), pagina: 1 }, perda };
}

export function proximoPasso(passo: PassoDoSync, itensNaPagina: number): ProximoPasso {
  const cheia = itensNaPagina >= PAGINA_TAMANHO;
  if (cheia && passo.pagina >= PAGINA_MAXIMA) {
    const ini = Date.parse(passo.janela_ini);
    const fim = Date.parse(passo.janela_fim);
    if (fim - ini <= DOIS_MINUTOS) return proximaJanela(passo, true);
    const meio = new Date(ini + Math.floor((fim - ini) / 2)).toISOString();
    return { tipo: "pagina", passo: { ...passo, janela_fim: meio, pagina: 1 }, perda: false };
  }
  if (cheia) return { tipo: "pagina", passo: { ...passo, pagina: passo.pagina + 1 }, perda: false };
  return proximaJanela(passo, false);
}

/** "Importando: mês N de 12" — N a partir de onde a janela atual começa. */
export function mesDoBackfill(janelaIni: string, alvoFim: string): number {
  const ini = new Date(janelaIni);
  const inicio = new Date(somarMeses(alvoFim, -MESES_DE_BACKFILL));
  const meses = (ini.getUTCFullYear() - inicio.getUTCFullYear()) * 12 + (ini.getUTCMonth() - inicio.getUTCMonth());
  return Math.min(MESES_DE_BACKFILL, Math.max(1, meses + 1));
}
```

- [ ] **Step 4: Rodar e ver passar** — `pnpm vitest run lib/nuvemshop/sync/janelas.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/nuvemshop/sync/janelas.ts lib/nuvemshop/sync/janelas.test.ts
git commit -m "feat(nuvemshop): janelas mensais e divisão no teto de 10 mil itens"
```

---

### Task 7: Estado do run, integração, aviso de desautorização, dependências e início

**Files:**
- Create: `lib/nuvemshop/sync/estado.ts`, `lib/nuvemshop/sync/integracao.ts`, `lib/nuvemshop/sync/desautorizada.ts`, `lib/nuvemshop/sync/deps.ts`, `lib/nuvemshop/sync/iniciar.ts`, `lib/nuvemshop/sync/iniciar.test.ts`
- Modify: `lib/agent-engine/db/repository.ts` (union `InboxKind`), `lib/ai/agent-inbox-copy.ts`, `lib/ai/inbox-destino.ts`, `lib/i18n/dicionario.ts`, `lib/audit/actions.ts`

**Interfaces:**
- Produces:
  - `estado.ts`: `interface EstadoDoSync { organization_id: string; status: "idle" | "running" | "error"; run_id: string | null; run_origem: OrigemDoRun | null; trava_ate: string | null; cursor_updated_at: string | null; janela_atual_ini: string | null; janela_atual_fim: string | null; alvo_fim: string | null; pedidos_gravados: number; pedidos_com_erro: number; ultimo_erro: string | null; ultimo_run_fim: string | null }`; `lerEstado(admin, orgId)`; `reservarRun(admin, orgId, args: { passo: PassoDoSync; origem: OrigemDoRun; agora: Date; forcar: boolean }): Promise<boolean>`; `registrarPagina(admin, estado, args: { gravados: number; comErro: number; ultimoErro: string | null; passo: PassoDoSync; agora: Date }): Promise<void>`; `fecharRun(admin, estado, agora): Promise<EstadoDoSync | null>`; `liberarRun(admin, orgId, runId: string | null): Promise<void>`.
  - `integracao.ts`: `interface IntegracaoCarregada { id: string; organizationId: string; status: string; storeId: string; accessToken: string }`; `carregarIntegracao(admin, orgId): Promise<IntegracaoCarregada | null>` (null se sem linha, sem `store_id` ou token não decifrável).
  - `desautorizada.ts`: `KIND_INTEGRACAO_DESAUTORIZADA`; `marcarIntegracaoDesautorizada(admin, integ: { id: string; organizationId: string }): Promise<void>`; `resolverAvisoDeDesautorizacao(admin, orgId, integracaoId): Promise<void>`.
  - `deps.ts`: `interface DepsDoSync` (abaixo) e `depsReais(): DepsDoSync`.
  - `iniciar.ts`: `type ResultadoDoInicio = { ok: true; runId: string } | { ok: false; motivo: "nao_conectada" | "desautorizada" | "sync_em_andamento" | "falha_ao_iniciar" }`; `iniciarSincronizacao(deps: DepsDoSync, orgId: string, origem: OrigemDoRun): Promise<ResultadoDoInicio>`.

- [ ] **Step 1: Teste que falha — `iniciarSincronizacao` com dublê de deps**

`lib/nuvemshop/sync/iniciar.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { DepsDoSync } from "./deps";
import { iniciarSincronizacao } from "./iniciar";

const AGORA = new Date("2026-10-08T12:00:00.000Z");

function deps(over: Partial<DepsDoSync> = {}): DepsDoSync {
  return {
    lerEstado: vi.fn().mockResolvedValue(null),
    carregarIntegracao: vi.fn().mockResolvedValue({ id: "integ-1", organizationId: "org-1", status: "healthy", storeId: "s1", accessToken: "t" }),
    api: vi.fn(),
    gravarPedido: vi.fn(),
    reservarRun: vi.fn().mockResolvedValue(true),
    registrarPagina: vi.fn(),
    fecharRun: vi.fn(),
    liberarRun: vi.fn(),
    emitirPasso: vi.fn().mockResolvedValue(undefined),
    desautorizar: vi.fn(),
    auditar: vi.fn(),
    novoRunId: () => "00000000-0000-4000-8000-0000000000aa",
    agora: () => AGORA,
    ...over,
  };
}

describe("iniciarSincronizacao", () => {
  it("sem cursor: reserva e emite a 1ª janela do backfill", async () => {
    const d = deps();
    await expect(iniciarSincronizacao(d, "org-1", "conexao")).resolves.toEqual({ ok: true, runId: "00000000-0000-4000-8000-0000000000aa" });
    expect(d.reservarRun).toHaveBeenCalledWith("org-1", expect.objectContaining({ origem: "conexao", forcar: true }));
    expect(d.emitirPasso).toHaveBeenCalledWith("org-1", "integ-1", expect.objectContaining({ janela_ini: "2025-10-08T12:00:00.000Z", pagina: 1 }));
  });

  it("reconciliação usa o cursor e não força", async () => {
    const d = deps({ lerEstado: vi.fn().mockResolvedValue({ cursor_updated_at: "2026-10-08T11:00:00.000Z" }) });
    await iniciarSincronizacao(d, "org-1", "reconciliacao");
    expect(d.reservarRun).toHaveBeenCalledWith("org-1", expect.objectContaining({ forcar: false }));
    expect(d.emitirPasso).toHaveBeenCalledWith("org-1", "integ-1", expect.objectContaining({ janela_ini: "2026-10-08T11:00:00.000Z" }));
  });

  it("sem integração ou desconectada → nao_conectada", async () => {
    await expect(iniciarSincronizacao(deps({ carregarIntegracao: vi.fn().mockResolvedValue(null) }), "org-1", "manual"))
      .resolves.toEqual({ ok: false, motivo: "nao_conectada" });
    await expect(iniciarSincronizacao(deps({ carregarIntegracao: vi.fn().mockResolvedValue({ id: "i", organizationId: "org-1", status: "disconnected", storeId: "s", accessToken: "t" }) }), "org-1", "manual"))
      .resolves.toEqual({ ok: false, motivo: "nao_conectada" });
  });

  it("integração em erro só recomeça pela conexão", async () => {
    const erro = vi.fn().mockResolvedValue({ id: "i", organizationId: "org-1", status: "error", storeId: "s", accessToken: "t" });
    await expect(iniciarSincronizacao(deps({ carregarIntegracao: erro }), "org-1", "manual")).resolves.toEqual({ ok: false, motivo: "desautorizada" });
  });

  it("run ativo → sync_em_andamento, nada emitido", async () => {
    const d = deps({ reservarRun: vi.fn().mockResolvedValue(false) });
    await expect(iniciarSincronizacao(d, "org-1", "manual")).resolves.toEqual({ ok: false, motivo: "sync_em_andamento" });
    expect(d.emitirPasso).not.toHaveBeenCalled();
  });

  it("emissão falhou → libera o run e devolve falha_ao_iniciar", async () => {
    const d = deps({ emitirPasso: vi.fn().mockRejectedValue(new Error("rpc")) });
    await expect(iniciarSincronizacao(d, "org-1", "manual")).resolves.toEqual({ ok: false, motivo: "falha_ao_iniciar" });
    expect(d.liberarRun).toHaveBeenCalledWith("org-1", "00000000-0000-4000-8000-0000000000aa");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm vitest run lib/nuvemshop/sync/iniciar.test.ts` → FAIL.

- [ ] **Step 3: Implementar `estado.ts`**

```ts
/**
 * `integration_sync_state` (migration 0611). Toda escrita filtra
 * `organization_id` + `provider` + `resource`, e as de um run também `run_id`:
 * um evento de run antigo nunca escreve sobre o run novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PROVEDOR, TRAVA_MS, type OrigemDoRun, type PassoDoSync } from "./constantes";

export interface EstadoDoSync {
  organization_id: string;
  status: "idle" | "running" | "error";
  run_id: string | null;
  run_origem: OrigemDoRun | null;
  trava_ate: string | null;
  cursor_updated_at: string | null;
  janela_atual_ini: string | null;
  janela_atual_fim: string | null;
  alvo_fim: string | null;
  pedidos_gravados: number;
  pedidos_com_erro: number;
  ultimo_erro: string | null;
  ultimo_run_fim: string | null;
}

const COLUNAS =
  "organization_id, status, run_id, run_origem, trava_ate, cursor_updated_at, janela_atual_ini, janela_atual_fim, alvo_fim, pedidos_gravados, pedidos_com_erro, ultimo_erro, ultimo_run_fim";
const TABELA = "integration_sync_state";
const RECURSO = "orders";

export async function lerEstado(admin: SupabaseClient, orgId: string): Promise<EstadoDoSync | null> {
  const { data, error } = await admin
    .from(TABELA)
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR)
    .eq("resource", RECURSO)
    .maybeSingle();
  if (error) throw new Error(`sync_state_leitura:${error.message}`);
  return (data as EstadoDoSync | null) ?? null;
}

/**
 * Um UPDATE só, com a condição de largada no WHERE (spec §4.3): idle, run morto
 * (trava vencida) ou erro que não seja de autorização. `forcar` (reconexão)
 * ignora a condição: a conexão nova substitui qualquer run.
 */
export async function reservarRun(
  admin: SupabaseClient,
  orgId: string,
  args: { passo: PassoDoSync; origem: OrigemDoRun; agora: Date; forcar: boolean },
): Promise<boolean> {
  const { error: erroSemente } = await admin
    .from(TABELA)
    .upsert(
      { organization_id: orgId, provider: PROVEDOR, resource: RECURSO },
      { onConflict: "organization_id,provider,resource", ignoreDuplicates: true },
    );
  if (erroSemente) throw new Error(`sync_state_semente:${erroSemente.message}`);

  const agoraIso = args.agora.toISOString();
  let q = admin
    .from(TABELA)
    .update({
      status: "running",
      run_id: args.passo.run_id,
      run_origem: args.origem,
      trava_ate: new Date(args.agora.getTime() + TRAVA_MS).toISOString(),
      alvo_fim: args.passo.alvo_fim,
      janela_atual_ini: args.passo.janela_ini,
      janela_atual_fim: args.passo.janela_fim,
      pedidos_gravados: 0,
      pedidos_com_erro: 0,
      ultimo_erro: null,
    })
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR)
    .eq("resource", RECURSO);
  if (!args.forcar) {
    q = q.or(
      // Valor entre aspas: o ISO tem `.` e `:`, que o parser do PostgREST reserva.
      `status.eq.idle,trava_ate.lt."${agoraIso}",and(status.eq.error,or(ultimo_erro.is.null,ultimo_erro.neq.auth))`,
    );
  }
  const { data, error } = await q.select("run_id");
  if (error) throw new Error(`sync_state_reserva:${error.message}`);
  return (data ?? []).length > 0;
}

export async function registrarPagina(
  admin: SupabaseClient,
  estado: EstadoDoSync,
  args: { gravados: number; comErro: number; ultimoErro: string | null; passo: PassoDoSync; agora: Date },
): Promise<void> {
  const { error } = await admin
    .from(TABELA)
    .update({
      pedidos_gravados: estado.pedidos_gravados + args.gravados,
      pedidos_com_erro: estado.pedidos_com_erro + args.comErro,
      ultimo_erro: args.ultimoErro ?? estado.ultimo_erro,
      janela_atual_ini: args.passo.janela_ini,
      janela_atual_fim: args.passo.janela_fim,
      trava_ate: new Date(args.agora.getTime() + TRAVA_MS).toISOString(),
    })
    .eq("organization_id", estado.organization_id)
    .eq("provider", PROVEDOR)
    .eq("resource", RECURSO)
    .eq("run_id", args.passo.run_id);
  if (error) throw new Error(`sync_state_pagina:${error.message}`);
}

export async function fecharRun(admin: SupabaseClient, estado: EstadoDoSync, agora: Date): Promise<EstadoDoSync | null> {
  const { data, error } = await admin
    .from(TABELA)
    .update({
      status: "idle",
      run_id: null,
      trava_ate: null,
      cursor_updated_at: estado.alvo_fim,
      ultimo_run_fim: agora.toISOString(),
    })
    .eq("organization_id", estado.organization_id)
    .eq("provider", PROVEDOR)
    .eq("resource", RECURSO)
    .eq("run_id", estado.run_id ?? "")
    .select(COLUNAS)
    .maybeSingle();
  if (error) throw new Error(`sync_state_fim:${error.message}`);
  await admin
    .from("tenant_integrations")
    .update({ last_sync_at: agora.toISOString() })
    .eq("organization_id", estado.organization_id)
    .eq("provider", PROVEDOR);
  return (data as EstadoDoSync | null) ?? null;
}

export async function liberarRun(admin: SupabaseClient, orgId: string, runId: string | null): Promise<void> {
  let q = admin
    .from(TABELA)
    .update({ status: "idle", run_id: null, trava_ate: null })
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR)
    .eq("resource", RECURSO);
  if (runId) q = q.eq("run_id", runId);
  const { error } = await q;
  if (error) throw new Error(`sync_state_liberar:${error.message}`);
}
```

- [ ] **Step 4: Implementar `integracao.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { PROVEDOR } from "./constantes";

export interface IntegracaoCarregada {
  id: string;
  organizationId: string;
  status: string;
  storeId: string;
  accessToken: string;
}

/** A integração da org com o token já decifrado. null = não há com o que falar. */
export async function carregarIntegracao(admin: SupabaseClient, orgId: string): Promise<IntegracaoCarregada | null> {
  const { data, error } = await admin
    .from("tenant_integrations")
    .select("id, organization_id, status, store_metadata, oauth_access_token_encrypted")
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR)
    .maybeSingle();
  if (error) throw new Error(`integracao_leitura:${error.message}`);
  if (!data) return null;
  const linha = data as {
    id: string; organization_id: string; status: string;
    store_metadata: { store_id?: string | number } | null; oauth_access_token_encrypted: string;
  };
  const storeId = linha.store_metadata?.store_id;
  if (storeId === undefined || storeId === null || String(storeId) === "") return null;
  const dec = await admin.rpc("fn_decrypt_oauth", { ciphertext: linha.oauth_access_token_encrypted });
  if (dec.error || !dec.data) return null;
  return { id: linha.id, organizationId: linha.organization_id, status: linha.status, storeId: String(storeId), accessToken: dec.data as string };
}
```

- [ ] **Step 5: Implementar `desautorizada.ts` e registrar o kind no TypeScript**

```ts
/**
 * A loja revogou o acesso (401/403). Três efeitos, e o laço que os desfaz:
 * integração em `error`, estado do sync em `error/auth` (a reconciliação pula),
 * e UM aviso aberto na Central. A reconexão (callback OAuth) resolve o aviso
 * e recomeça do cursor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { PROVEDOR } from "./constantes";

export const KIND_INTEGRACAO_DESAUTORIZADA = "integracao_desautorizada" as const;

export async function marcarIntegracaoDesautorizada(
  admin: SupabaseClient,
  integ: { id: string; organizationId: string },
): Promise<void> {
  await admin
    .from("tenant_integrations")
    .update({ status: "error", status_reason: "auth_revogada" })
    .eq("organization_id", integ.organizationId)
    .eq("id", integ.id);
  await admin
    .from("integration_sync_state")
    .update({ status: "error", ultimo_erro: "auth", run_id: null, trava_ate: null })
    .eq("organization_id", integ.organizationId)
    .eq("provider", PROVEDOR)
    .eq("resource", "orders");
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: integ.organizationId,
    kind: KIND_INTEGRACAO_DESAUTORIZADA,
    severity: "warn",
    title: "A Nuvemshop parou de enviar pedidos",
    body: "A loja revogou o acesso do aplicativo. Em Integrações › Nuvemshop, desconecte e conecte de novo para voltar a sincronizar.",
    ref_kind: "tenant_integration",
    ref_id: integ.id,
  });
  if (error && error.code !== "23505") {
    logger.warn("[nuvemshop.sync] aviso de desautorização não aberto", { code: error.code });
  }
  if (!error) {
    await audit({
      action: "nuvemshop.sync_failed",
      organizationId: integ.organizationId,
      resourceType: "tenant_integration",
      resourceId: integ.id,
      metadata: { motivo: "auth" },
    });
  }
}

export async function resolverAvisoDeDesautorizacao(admin: SupabaseClient, orgId: string, integracaoId: string): Promise<void> {
  await admin
    .from("agent_inbox_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("kind", KIND_INTEGRACAO_DESAUTORIZADA)
    .eq("ref_id", integracaoId)
    .eq("status", "open");
}
```

Registro do kind (o compilador cobra os três por `satisfies Record<InboxKind, …>`):
- `lib/agent-engine/db/repository.ts`: acrescentar `| 'integracao_desautorizada'` na union `InboxKind` (ao lado de `'canal_pausado'`, com comentário de uma linha "(0611) loja Nuvemshop revogou o acesso; resolve na reconexão").
- `lib/ai/agent-inbox-copy.ts`: `integracao_desautorizada: "A loja Nuvemshop revogou o acesso — os pedidos pararam de sincronizar",`
- `lib/ai/inbox-destino.ts`: em `REFERENCIAS_DE_AVISO`, `tenant_integration: { tabela: "tenant_integrations", papel: "admin", rotulo: "Revisar integração", href: () => "/app/integrations/nuvemshop" },` (sem `ativo`: a tabela não tem `archived_at`); em `POLITICAS_DE_AVISO`, `integracao_desautorizada: { refs: ["tenant_integration"], orientacao: "Abra a integração, desconecte e conecte de novo para devolver o acesso à loja." },`
- `lib/i18n/dicionario.ts`: entradas `es` para as três frases novas acima e para o título/corpo do aviso, se a Central os traduz (conferir `lib/ai/inbox-destino.test.ts:157` e `i18n-espanhol-cobre-a-tela`).
- `lib/audit/actions.ts`: após `"nuvemshop.webhook_invalid_signature",` acrescentar `"nuvemshop.sync_requested", "nuvemshop.sync_completed", "nuvemshop.sync_failed", "nuvemshop.uninstalled",`.

- [ ] **Step 6: Implementar `deps.ts`**

```ts
/**
 * O que os handlers e o início precisam do mundo. Interface para os testes
 * trocarem banco e rede por dublês; `depsReais()` liga ao Supabase e à API.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { NuvemshopApiClient } from "@/lib/nuvemshop/api-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVENTO_SYNC_PAGE, type OrigemDoRun, type PassoDoSync } from "./constantes";
import { marcarIntegracaoDesautorizada } from "./desautorizada";
import { fecharRun, lerEstado, liberarRun, registrarPagina, reservarRun, type EstadoDoSync } from "./estado";
import { gravarPedido, type ResultadoDaGravacao } from "./gravar-pedido";
import { carregarIntegracao, type IntegracaoCarregada } from "./integracao";

export interface ApiDePedidos {
  listOrders: NuvemshopApiClient["listOrders"];
  getOrder: NuvemshopApiClient["getOrder"];
}

export interface DepsDoSync {
  lerEstado(orgId: string): Promise<EstadoDoSync | null>;
  carregarIntegracao(orgId: string): Promise<IntegracaoCarregada | null>;
  api(integ: IntegracaoCarregada): ApiDePedidos;
  gravarPedido(orgId: string, storeId: string, bruto: unknown): Promise<ResultadoDaGravacao>;
  reservarRun(orgId: string, args: { passo: PassoDoSync; origem: OrigemDoRun; agora: Date; forcar: boolean }): Promise<boolean>;
  registrarPagina(estado: EstadoDoSync, args: { gravados: number; comErro: number; ultimoErro: string | null; passo: PassoDoSync; agora: Date }): Promise<void>;
  fecharRun(estado: EstadoDoSync, agora: Date): Promise<EstadoDoSync | null>;
  liberarRun(orgId: string, runId: string | null): Promise<void>;
  emitirPasso(orgId: string, integracaoId: string, passo: PassoDoSync): Promise<void>;
  desautorizar(integ: IntegracaoCarregada): Promise<void>;
  auditar(entry: Parameters<typeof audit>[0]): Promise<void>;
  novoRunId(): string;
  agora(): Date;
}

export function depsReais(admin: SupabaseClient = createAdminClient()): DepsDoSync {
  return {
    lerEstado: (orgId) => lerEstado(admin, orgId),
    carregarIntegracao: (orgId) => carregarIntegracao(admin, orgId),
    api: (integ) => new NuvemshopApiClient({ storeId: integ.storeId, accessToken: integ.accessToken }),
    gravarPedido: (orgId, storeId, bruto) => gravarPedido(admin, { orgId, storeId }, bruto),
    reservarRun: (orgId, args) => reservarRun(admin, orgId, args),
    registrarPagina: (estado, args) => registrarPagina(admin, estado, args),
    fecharRun: (estado, agora) => fecharRun(admin, estado, agora),
    liberarRun: (orgId, runId) => liberarRun(admin, orgId, runId),
    emitirPasso: async (orgId, integracaoId, passo) => {
      const { error } = await admin.rpc("emit_event", {
        p_event_type: "nuvemshop.sync_page",
        p_entity_kind: "tenant_integration",
        p_entity_id: integracaoId,
        p_payload: passo as unknown as Record<string, unknown>,
        p_metadata: { run_id: passo.run_id, pagina: passo.pagina },
        p_organization_id: orgId,
      });
      if (error) throw new Error(`emit_${EVENTO_SYNC_PAGE}:${error.message}`);
    },
    desautorizar: (integ) => marcarIntegracaoDesautorizada(admin, integ),
    auditar: (entry) => audit(entry),
    novoRunId: () => randomUUID(),
    agora: () => new Date(),
  };
}
```

`p_event_type` fica **literal** (`"nuvemshop.sync_page"`): é o que `tests/unit/evento-de-fato-nao-fica-pendente.test.ts` lê para saber que o tipo tem consumidor.

- [ ] **Step 7: Implementar `iniciar.ts`**

```ts
/**
 * Começa um run (spec §4.3): chamado pelo callback OAuth (`conexao`, força),
 * pela reconciliação e pelo botão "Sincronizar agora".
 */
import type { OrigemDoRun } from "./constantes";
import type { DepsDoSync } from "./deps";
import { primeiroPasso } from "./janelas";

export type ResultadoDoInicio =
  | { ok: true; runId: string }
  | { ok: false; motivo: "nao_conectada" | "desautorizada" | "sync_em_andamento" | "falha_ao_iniciar" };

export async function iniciarSincronizacao(deps: DepsDoSync, orgId: string, origem: OrigemDoRun): Promise<ResultadoDoInicio> {
  const integ = await deps.carregarIntegracao(orgId);
  if (!integ || integ.status === "disconnected") return { ok: false, motivo: "nao_conectada" };
  if (integ.status !== "healthy" && origem !== "conexao") return { ok: false, motivo: "desautorizada" };

  const estado = await deps.lerEstado(orgId);
  const passo = primeiroPasso({ runId: deps.novoRunId(), cursor: estado?.cursor_updated_at ?? null, agora: deps.agora() });
  const reservado = await deps.reservarRun(orgId, { passo, origem, agora: deps.agora(), forcar: origem === "conexao" });
  if (!reservado) return { ok: false, motivo: "sync_em_andamento" };

  try {
    await deps.emitirPasso(orgId, integ.id, passo);
  } catch {
    await deps.liberarRun(orgId, passo.run_id);
    return { ok: false, motivo: "falha_ao_iniciar" };
  }
  return { ok: true, runId: passo.run_id };
}
```

- [ ] **Step 8: Rodar e ver passar**

```bash
pnpm vitest run lib/nuvemshop/sync/ lib/ai/inbox-destino.test.ts
pnpm typecheck > /tmp/ns-tc.log 2>&1; echo "exit=$?"; grep -m5 "error TS" /tmp/ns-tc.log
```
Expected: PASS; typecheck exit 0.

- [ ] **Step 9: Commit**

```bash
git add lib/nuvemshop/sync/ lib/agent-engine/db/repository.ts lib/ai/agent-inbox-copy.ts lib/ai/inbox-destino.ts lib/i18n/dicionario.ts lib/audit/actions.ts
git commit -m "feat(nuvemshop): estado do run, início e aviso de acesso revogado"
```

---

### Task 8: Handlers do `event_log`

**Files:**
- Create: `lib/nuvemshop/sync/sync-page.handler.ts` (+ `.test.ts`), `lib/nuvemshop/sync/pedido.handler.ts` (+ `.test.ts`), `lib/nuvemshop/sync/desinstalacao.handler.ts` (+ `.test.ts`), `lib/nuvemshop/sync/erro-da-api.ts`
- Modify: `lib/event-log/register-handlers.ts`, `tests/unit/dispatcher-org-parada.test.ts`

**Interfaces:**
- Consumes: `DepsDoSync`/`depsReais` (T7), `passoDoSyncSchema`/`PAGINA_TAMANHO` (T3), `proximoPasso` (T6), `NuvemshopApiError` (T2), `EventRow`/`EventHandler`/`HandlerResult` (`@/lib/event-log/dispatcher`).
- Produces:
  - `processarPaginaDoSync(row: EventRow, deps: DepsDoSync): Promise<HandlerResult>`; `nuvemshopSyncHandler: EventHandler` (key `nuvemshop-sync.v1`, `pula`, events `["nuvemshop.sync_page"]`).
  - `processarPedidoDoWebhook(row, deps)`; `nuvemshopPedidoHandler` (key `nuvemshop-pedido.v1`, `pula`, events `nuvemshop.order_created|order_updated|order_paid|order_cancelled`).
  - `processarDesinstalacao(row, admin)`; `nuvemshopDesinstalacaoHandler` (key `nuvemshop-desinstalacao.v1`, `roda`, events `["nuvemshop.app_uninstalled"]`).
  - `tratarErroDaApi(err: unknown, integ: IntegracaoCarregada, deps: DepsDoSync, key: string): Promise<HandlerResult>`.

- [ ] **Step 1: Teste que falha — sync-page**

`lib/nuvemshop/sync/sync-page.handler.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { NuvemshopApiError } from "@/lib/nuvemshop/api-client";
import { PAGINA_TAMANHO } from "./constantes";
import type { DepsDoSync } from "./deps";
import type { EstadoDoSync } from "./estado";
import { processarPaginaDoSync } from "./sync-page.handler";

const RUN = "00000000-0000-4000-8000-0000000000aa";
const AGORA = new Date("2026-10-08T12:00:00.000Z");
const PASSO = { run_id: RUN, janela_ini: "2026-01-01T00:00:00.000Z", janela_fim: "2026-02-01T00:00:00.000Z", alvo_fim: "2026-10-08T12:00:00.000Z", pagina: 1 };
const INTEG = { id: "integ-1", organizationId: "org-1", status: "healthy", storeId: "s1", accessToken: "t" };
const ESTADO = { organization_id: "org-1", status: "running", run_id: RUN, pedidos_gravados: 0, pedidos_com_erro: 0 } as EstadoDoSync;

const row = (payload: Record<string, unknown> = PASSO): EventRow => ({
  id: "ev-1", organization_id: "org-1", event_type: "nuvemshop.sync_page", entity_kind: "tenant_integration",
  entity_id: "integ-1", payload, metadata: {}, consumed_by: [], attempts: 0,
});

function deps(itens: unknown[] | Error, over: Partial<DepsDoSync> = {}): DepsDoSync {
  const listOrders = itens instanceof Error ? vi.fn().mockRejectedValue(itens) : vi.fn().mockResolvedValue(itens);
  return {
    lerEstado: vi.fn().mockResolvedValue(ESTADO),
    carregarIntegracao: vi.fn().mockResolvedValue(INTEG),
    api: vi.fn(() => ({ listOrders, getOrder: vi.fn() })),
    gravarPedido: vi.fn().mockResolvedValue({ ok: true, orderId: "o" }),
    reservarRun: vi.fn(),
    registrarPagina: vi.fn().mockResolvedValue(undefined),
    fecharRun: vi.fn().mockResolvedValue({ ...ESTADO, pedidos_gravados: 3 }),
    liberarRun: vi.fn().mockResolvedValue(undefined),
    emitirPasso: vi.fn().mockResolvedValue(undefined),
    desautorizar: vi.fn().mockResolvedValue(undefined),
    auditar: vi.fn().mockResolvedValue(undefined),
    novoRunId: () => RUN,
    agora: () => AGORA,
    ...over,
  };
}

const cheia = Array.from({ length: PAGINA_TAMANHO }, (_, i) => ({ id: i }));

describe("nuvemshop-sync.v1", () => {
  it("payload inválido → skipped", async () => {
    expect((await processarPaginaDoSync(row({ x: 1 }), deps([]))).status).toBe("skipped");
  });

  it("run_id que não é o corrente → skipped run_obsoleto, sem chamar a API", async () => {
    const d = deps([], { lerEstado: vi.fn().mockResolvedValue({ ...ESTADO, run_id: "outro" }) });
    expect(await processarPaginaDoSync(row(), d)).toMatchObject({ status: "skipped", detail: "run_obsoleto" });
    expect(d.api).not.toHaveBeenCalled();
  });

  it("integração desconectada no meio → libera o run, nada encadeado", async () => {
    const d = deps([], { carregarIntegracao: vi.fn().mockResolvedValue({ ...INTEG, status: "disconnected" }) });
    expect(await processarPaginaDoSync(row(), d)).toMatchObject({ status: "skipped", detail: "integracao_inativa" });
    expect(d.liberarRun).toHaveBeenCalledWith("org-1", RUN);
    expect(d.emitirPasso).not.toHaveBeenCalled();
  });

  it("página cheia → grava todos e emite a página seguinte", async () => {
    const d = deps(cheia);
    expect((await processarPaginaDoSync(row(), d)).status).toBe("ok");
    expect(d.gravarPedido).toHaveBeenCalledTimes(PAGINA_TAMANHO);
    expect(d.emitirPasso).toHaveBeenCalledWith("org-1", "integ-1", { ...PASSO, pagina: 2 });
    expect(d.fecharRun).not.toHaveBeenCalled();
  });

  it("pedido ruim não trava a página: conta erro e segue", async () => {
    const gravar = vi.fn()
      .mockResolvedValueOnce({ ok: false, motivo: "total_invalido:1" })
      .mockResolvedValue({ ok: true, orderId: "o" });
    const d = deps([{ id: 1 }, { id: 2 }], { gravarPedido: gravar });
    await processarPaginaDoSync(row({ ...PASSO, janela_fim: PASSO.alvo_fim }), d);
    expect(d.registrarPagina).toHaveBeenCalledWith(ESTADO, expect.objectContaining({ gravados: 1, comErro: 1, ultimoErro: "total_invalido:1" }));
  });

  it("última janela incompleta → fecha o run e audita quando gravou algo", async () => {
    const d = deps([{ id: 1 }], {});
    expect(await processarPaginaDoSync(row({ ...PASSO, janela_fim: PASSO.alvo_fim }), d)).toMatchObject({ status: "ok", detail: "run_concluido" });
    expect(d.fecharRun).toHaveBeenCalled();
    expect(d.auditar).toHaveBeenCalledWith(expect.objectContaining({ action: "nuvemshop.sync_completed", organizationId: "org-1" }));
  });

  it("429 → retry com retry_at do cabeçalho", async () => {
    const d = deps(new NuvemshopApiError(429, "rate_limited", "", undefined, 1500));
    const r = await processarPaginaDoSync(row(), d);
    expect(r.status).toBe("retry");
    expect(r.retry_at).toBe(new Date(AGORA.getTime() + 1500).toISOString());
  });

  it("429 sem cabeçalho → retry em 2 s", async () => {
    const r = await processarPaginaDoSync(row(), deps(new NuvemshopApiError(429, "rate_limited", "")));
    expect(r.retry_at).toBe(new Date(AGORA.getTime() + 2000).toISOString());
  });

  it("401 → desautoriza e não pede retry", async () => {
    const d = deps(new NuvemshopApiError(401, "unauthorized", ""));
    expect(await processarPaginaDoSync(row(), d)).toMatchObject({ status: "skipped", detail: "desautorizada" });
    expect(d.desautorizar).toHaveBeenCalledWith(INTEG);
  });

  it("5xx → error (o dreno faz o backoff)", async () => {
    expect((await processarPaginaDoSync(row(), deps(new NuvemshopApiError(502, "upstream_error", "")))).status).toBe("error");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm vitest run lib/nuvemshop/sync/sync-page.handler.test.ts` → FAIL.

- [ ] **Step 3: Implementar `erro-da-api.ts` e `sync-page.handler.ts`**

`lib/nuvemshop/sync/erro-da-api.ts`:

```ts
import type { HandlerResult } from "@/lib/event-log/dispatcher";
import { NuvemshopApiError } from "@/lib/nuvemshop/api-client";
import type { DepsDoSync } from "./deps";
import type { IntegracaoCarregada } from "./integracao";

const RETRY_PADRAO_MS = 2_000;

/** Tabela da spec §4.4. Erro que não é da API sobe (o dispatcher o vira `error`). */
export async function tratarErroDaApi(
  err: unknown,
  integ: IntegracaoCarregada,
  deps: DepsDoSync,
  key: string,
): Promise<HandlerResult> {
  if (!(err instanceof NuvemshopApiError)) throw err;
  if (err.status === 429) {
    return {
      consumer_key: key,
      status: "retry",
      retry_at: new Date(deps.agora().getTime() + (err.retryAfterMs ?? RETRY_PADRAO_MS)).toISOString(),
      detail: "rate_limited",
    };
  }
  if (err.status === 401 || err.status === 403) {
    await deps.desautorizar(integ);
    return { consumer_key: key, status: "skipped", detail: "desautorizada" };
  }
  return { consumer_key: key, status: "error", detail: `api_${err.status}_${err.code}` };
}
```

`lib/nuvemshop/sync/sync-page.handler.ts`:

```ts
/**
 * `nuvemshop-sync.v1` — UMA página da API por evento (spec §4.1).
 *
 * Um handler que percorresse todas as páginas cairia na detecção de evento
 * preso do dreno e recomeçaria do zero. Aqui cada página é um evento: o dreno
 * dá retry, backoff, `retry` sem contar tentativa (429) e aviso de evento morto.
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { EVENTO_SYNC_PAGE, PAGINA_TAMANHO, passoDoSyncSchema } from "./constantes";
import { depsReais, type DepsDoSync } from "./deps";
import { tratarErroDaApi } from "./erro-da-api";
import { proximoPasso } from "./janelas";

const KEY = "nuvemshop-sync.v1";
const r = (status: HandlerResult["status"], detail: string): HandlerResult => ({ consumer_key: KEY, status, detail });

export async function processarPaginaDoSync(row: EventRow, deps: DepsDoSync): Promise<HandlerResult> {
  const parsed = passoDoSyncSchema.safeParse(row.payload);
  if (!parsed.success) return r("skipped", "payload_invalido");
  const passo = parsed.data;
  const orgId = row.organization_id;

  const estado = await deps.lerEstado(orgId);
  if (!estado || estado.status !== "running" || estado.run_id !== passo.run_id) return r("skipped", "run_obsoleto");

  const integ = await deps.carregarIntegracao(orgId);
  if (!integ || integ.status !== "healthy") {
    await deps.liberarRun(orgId, passo.run_id);
    return r("skipped", "integracao_inativa");
  }

  let itens: unknown[];
  try {
    itens = await deps.api(integ).listOrders({
      updatedAtMin: passo.janela_ini,
      updatedAtMax: passo.janela_fim,
      page: passo.pagina,
      perPage: PAGINA_TAMANHO,
    });
  } catch (err) {
    return tratarErroDaApi(err, integ, deps, KEY);
  }

  let gravados = 0;
  let comErro = 0;
  let ultimoErro: string | null = null;
  for (const bruto of itens) {
    const g = await deps.gravarPedido(orgId, integ.storeId, bruto);
    if (g.ok) gravados++;
    else {
      comErro++;
      ultimoErro = g.motivo;
    }
  }

  const prox = proximoPasso(passo, itens.length);
  if (prox.perda) {
    comErro++;
    ultimoErro = "janela_indivisivel";
  }
  await deps.registrarPagina(estado, { gravados, comErro, ultimoErro, passo, agora: deps.agora() });

  if (prox.tipo === "pagina") {
    await deps.emitirPasso(orgId, integ.id, prox.passo);
    return r("ok", `pagina_${passo.pagina}:${gravados}`);
  }

  const fechado = await deps.fecharRun({ ...estado, alvo_fim: passo.alvo_fim }, deps.agora());
  if (fechado && fechado.pedidos_gravados > 0) {
    await deps.auditar({
      action: "nuvemshop.sync_completed",
      organizationId: orgId,
      resourceType: "tenant_integration",
      resourceId: integ.id,
      metadata: { run_id: passo.run_id, pedidos_gravados: fechado.pedidos_gravados, pedidos_com_erro: fechado.pedidos_com_erro },
    });
  }
  return r("ok", "run_concluido");
}

export const nuvemshopSyncHandler: EventHandler = {
  key: KEY,
  naOrgParada: "pula",
  events: [EVENTO_SYNC_PAGE],
  handle: (row) => processarPaginaDoSync(row, depsReais()),
};
```

- [ ] **Step 4: Teste + implementação — pedido por webhook**

`lib/nuvemshop/sync/pedido.handler.test.ts` (mesmo `deps()` do arquivo anterior, com `getOrder`):

```ts
import { describe, expect, it, vi } from "vitest";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { NuvemshopApiError } from "@/lib/nuvemshop/api-client";
import type { DepsDoSync } from "./deps";
import { processarPedidoDoWebhook } from "./pedido.handler";

const INTEG = { id: "integ-1", organizationId: "org-1", status: "healthy", storeId: "s1", accessToken: "t" };
const row = (payload: Record<string, unknown>): EventRow => ({
  id: "ev", organization_id: "org-1", event_type: "nuvemshop.order_paid", entity_kind: "nuvemshop_webhook",
  entity_id: null, payload, metadata: {}, consumed_by: [], attempts: 0,
});
function deps(getOrder: ReturnType<typeof vi.fn>, over: Partial<DepsDoSync> = {}): DepsDoSync {
  return {
    lerEstado: vi.fn(), carregarIntegracao: vi.fn().mockResolvedValue(INTEG),
    api: vi.fn(() => ({ listOrders: vi.fn(), getOrder })),
    gravarPedido: vi.fn().mockResolvedValue({ ok: true, orderId: "o" }),
    reservarRun: vi.fn(), registrarPagina: vi.fn(), fecharRun: vi.fn(), liberarRun: vi.fn(), emitirPasso: vi.fn(),
    desautorizar: vi.fn(), auditar: vi.fn(), novoRunId: () => "r", agora: () => new Date("2026-10-08T12:00:00Z"),
    ...over,
  };
}

describe("nuvemshop-pedido.v1", () => {
  it("busca o pedido e grava", async () => {
    const d = deps(vi.fn().mockResolvedValue({ id: 9 }));
    expect((await processarPedidoDoWebhook(row({ store_id: "s1", id: 9 }), d)).status).toBe("ok");
    expect(d.gravarPedido).toHaveBeenCalledWith("org-1", "s1", { id: 9 });
  });
  it("sem id → skipped", async () => {
    expect((await processarPedidoDoWebhook(row({ store_id: "s1" }), deps(vi.fn()))).status).toBe("skipped");
  });
  it("404 → skipped pedido_inexistente", async () => {
    const d = deps(vi.fn().mockRejectedValue(new NuvemshopApiError(404, "not_found", "")));
    expect(await processarPedidoDoWebhook(row({ id: 9 }), d)).toMatchObject({ status: "skipped", detail: "pedido_inexistente" });
  });
  it("integração inativa → skipped sem chamar a API", async () => {
    const getOrder = vi.fn();
    const d = deps(getOrder, { carregarIntegracao: vi.fn().mockResolvedValue({ ...INTEG, status: "disconnected" }) });
    expect((await processarPedidoDoWebhook(row({ id: 9 }), d)).status).toBe("skipped");
    expect(getOrder).not.toHaveBeenCalled();
  });
  it("pedido com dado ruim → skipped com o motivo (não é falha de infra)", async () => {
    const d = deps(vi.fn().mockResolvedValue({ id: 9 }), { gravarPedido: vi.fn().mockResolvedValue({ ok: false, motivo: "total_invalido:9" }) });
    expect(await processarPedidoDoWebhook(row({ id: 9 }), d)).toMatchObject({ status: "skipped", detail: "total_invalido:9" });
  });
});
```

`lib/nuvemshop/sync/pedido.handler.ts`:

```ts
/**
 * `nuvemshop-pedido.v1` — webhook `order/*` → `GET /orders/{id}` → `orders`.
 * O webhook só traz o id; o pedido inteiro vem da API, e o upsert "mais novo
 * vence" torna seguro rodar em paralelo com o backfill (spec §4.3). Não respeita
 * a trava do run de propósito.
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { NuvemshopApiError } from "@/lib/nuvemshop/api-client";
import { depsReais, type DepsDoSync } from "./deps";
import { tratarErroDaApi } from "./erro-da-api";

const KEY = "nuvemshop-pedido.v1";
const r = (status: HandlerResult["status"], detail: string): HandlerResult => ({ consumer_key: KEY, status, detail });

export async function processarPedidoDoWebhook(row: EventRow, deps: DepsDoSync): Promise<HandlerResult> {
  const id = row.payload.id;
  if (id === undefined || id === null || String(id) === "") return r("skipped", "sem_id");

  const integ = await deps.carregarIntegracao(row.organization_id);
  if (!integ || integ.status !== "healthy") return r("skipped", "integracao_inativa");

  let bruto: unknown;
  try {
    bruto = await deps.api(integ).getOrder(String(id));
  } catch (err) {
    if (err instanceof NuvemshopApiError && err.status === 404) return r("skipped", "pedido_inexistente");
    return tratarErroDaApi(err, integ, deps, KEY);
  }

  const g = await deps.gravarPedido(row.organization_id, integ.storeId, bruto);
  return g.ok ? r("ok", g.ignorado ?? "gravado") : r("skipped", g.motivo);
}

export const nuvemshopPedidoHandler: EventHandler = {
  key: KEY,
  naOrgParada: "pula",
  events: ["nuvemshop.order_created", "nuvemshop.order_updated", "nuvemshop.order_paid", "nuvemshop.order_cancelled"],
  handle: (row) => processarPedidoDoWebhook(row, depsReais()),
};
```

- [ ] **Step 5: Teste + implementação — desinstalação**

`lib/nuvemshop/sync/desinstalacao.handler.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { processarDesinstalacao } from "./desinstalacao.handler";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

function adminFalso() {
  const chamadas: Array<{ tabela: string; patch: unknown; filtros: Array<[string, unknown]> }> = [];
  const admin = {
    from: (tabela: string) => ({
      update: (patch: unknown) => {
        const reg = { tabela, patch, filtros: [] as Array<[string, unknown]> };
        chamadas.push(reg);
        const cadeia = {
          eq: (c: string, v: unknown) => { reg.filtros.push([c, v]); return cadeia; },
          select: () => ({ maybeSingle: async () => ({ data: { id: "integ-1" }, error: null }) }),
          then: (ok: (v: { error: null }) => unknown) => ok({ error: null }),
        };
        return cadeia;
      },
    }),
  } as unknown as SupabaseClient;
  return { admin, chamadas };
}

const row: EventRow = {
  id: "ev", organization_id: "org-1", event_type: "nuvemshop.app_uninstalled", entity_kind: "nuvemshop_webhook",
  entity_id: null, payload: { store_id: "s1" }, metadata: {}, consumed_by: [], attempts: 0,
};

describe("nuvemshop-desinstalacao.v1", () => {
  it("desconecta a integração DA ORG e libera o run", async () => {
    const { admin, chamadas } = adminFalso();
    expect((await processarDesinstalacao(row, admin)).status).toBe("ok");
    const integ = chamadas.find((c) => c.tabela === "tenant_integrations")!;
    expect(integ.patch).toMatchObject({ status: "disconnected", status_reason: "app_uninstalled" });
    expect(integ.filtros).toContainEqual(["organization_id", "org-1"]);
    expect(chamadas.some((c) => c.tabela === "integration_sync_state")).toBe(true);
  });
});
```

`lib/nuvemshop/sync/desinstalacao.handler.ts`:

```ts
/**
 * `nuvemshop-desinstalacao.v1` — a loja desinstalou o app. Escrita interna
 * (`roda` em org parada): a integração vira `disconnected` e o run em curso é
 * liberado; o próximo evento de página encontra a integração inativa e para.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { PROVEDOR } from "./constantes";

const KEY = "nuvemshop-desinstalacao.v1";

export async function processarDesinstalacao(row: EventRow, admin: SupabaseClient): Promise<HandlerResult> {
  const { data, error } = await admin
    .from("tenant_integrations")
    .update({ status: "disconnected", status_reason: "app_uninstalled" })
    .eq("organization_id", row.organization_id)
    .eq("provider", PROVEDOR)
    .select("id")
    .maybeSingle();
  if (error) return { consumer_key: KEY, status: "error", detail: `integracao:${error.message}` };

  await admin
    .from("integration_sync_state")
    .update({ status: "idle", run_id: null, trava_ate: null })
    .eq("organization_id", row.organization_id)
    .eq("provider", PROVEDOR)
    .eq("resource", "orders");

  await audit({
    action: "nuvemshop.uninstalled",
    organizationId: row.organization_id,
    resourceType: "tenant_integration",
    resourceId: (data as { id?: string } | null)?.id,
    metadata: { store_id: String(row.payload.store_id ?? "") },
  });
  return { consumer_key: KEY, status: "ok", detail: "desconectada" };
}

export const nuvemshopDesinstalacaoHandler: EventHandler = {
  key: KEY,
  naOrgParada: "roda",
  events: ["nuvemshop.app_uninstalled"],
  handle: (row) => processarDesinstalacao(row, createAdminClient()),
};
```

- [ ] **Step 6: Registrar e classificar**

`lib/event-log/register-handlers.ts` — imports + registro **antes** de `avisoDeCasoAoSuporteHandler` (eles saem por rede de terceiro, mas não podem atrasar quem só escreve no banco; a desinstalação é escrita interna e vai junto dos que escrevem no banco):

```ts
import { nuvemshopDesinstalacaoHandler } from "@/lib/nuvemshop/sync/desinstalacao.handler";
import { nuvemshopPedidoHandler } from "@/lib/nuvemshop/sync/pedido.handler";
import { nuvemshopSyncHandler } from "@/lib/nuvemshop/sync/sync-page.handler";
// ...
  // Escrita interna: desinstalação da loja só desliga a integração.
  registerHandler(nuvemshopDesinstalacaoHandler);
// ... (logo antes de registerHandler(avisoDeCasoAoSuporteHandler))
  // Nuvemshop: chamam a API da loja (rede de terceiro) — depois de quem só
  // escreve no banco, antes dos avisos que saem por WhatsApp.
  registerHandler(nuvemshopPedidoHandler);
  registerHandler(nuvemshopSyncHandler);
```

`tests/unit/dispatcher-org-parada.test.ts` — importar os três e acrescentar `nuvemshopDesinstalacaoHandler` em `RODA` e `nuvemshopPedidoHandler`, `nuvemshopSyncHandler` em `PULA`.

- [ ] **Step 7: Rodar e ver passar**

```bash
pnpm vitest run lib/nuvemshop/ tests/unit/dispatcher-org-parada.test.ts tests/unit/evento-de-fato-nao-fica-pendente.test.ts tests/unit/evento-comando-tem-consumidor.test.ts
```
Expected: PASS. Se `evento-de-fato-nao-fica-pendente` reclamar que `NAMESPACE_ABERTO["nuvemshop.<evento>"]` mudou de natureza, **não** remover a entrada: `product_*` segue sem consumidor (E2). Ajustar só o texto da entrada se o teste exigir.

- [ ] **Step 8: Commit**

```bash
git add lib/nuvemshop/sync/ lib/event-log/register-handlers.ts tests/unit/dispatcher-org-parada.test.ts
git commit -m "feat(nuvemshop): consumidores de página, pedido e desinstalação"
```

---

### Task 9: Início pela conexão e reconciliação de 30 min

**Files:**
- Modify: `app/api/v1/integrations/nuvemshop/callback/route.ts`, `docker/scheduler/entrypoint.sh`
- Create: `app/api/v1/cron/nuvemshop-reconcile/route.ts`, `app/api/v1/cron/nuvemshop-reconcile/route.test.ts`

**Interfaces:**
- Consumes: `iniciarSincronizacao`, `depsReais` (T7), `resolverAvisoDeDesautorizacao` (T7), `ehOperante`, `statusDaOrgEmbutida`, `STATUS_OPERANTE` (`@/lib/organizacao/operante`), `autorizaCron` (`@/lib/auth/cron-auth`).
- Produces: `GET /api/v1/cron/nuvemshop-reconcile` → `{ data: { candidatos: number; iniciados: number } }`; exporta também `decidirQuemReconciliar(linhas, estados, agora): string[]` (puro, testável).

- [ ] **Step 1: Teste que falha (regra pura de quem reconcilia)**

`app/api/v1/cron/nuvemshop-reconcile/route.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decidirQuemReconciliar } from "./route";

const AGORA = new Date("2026-10-08T12:00:00.000Z");
const linha = (org: string, statusOrg = "active") => ({ organization_id: org, organizations: { status: statusOrg } });

describe("decidirQuemReconciliar", () => {
  it("cursor velho (> 25 min) e idle → entra", () => {
    expect(decidirQuemReconciliar([linha("a")], new Map([["a", { status: "idle", cursor_updated_at: "2026-10-08T11:00:00.000Z", trava_ate: null, ultimo_erro: null }]]), AGORA)).toEqual(["a"]);
  });
  it("cursor recente → fica de fora", () => {
    expect(decidirQuemReconciliar([linha("a")], new Map([["a", { status: "idle", cursor_updated_at: "2026-10-08T11:50:00.000Z", trava_ate: null, ultimo_erro: null }]]), AGORA)).toEqual([]);
  });
  it("sem estado (nunca sincronizou) → entra", () => {
    expect(decidirQuemReconciliar([linha("a")], new Map(), AGORA)).toEqual(["a"]);
  });
  it("run vivo → fica de fora; run morto → entra", () => {
    const vivo = { status: "running", cursor_updated_at: null, trava_ate: "2026-10-08T12:10:00.000Z", ultimo_erro: null };
    const morto = { ...vivo, trava_ate: "2026-10-08T11:00:00.000Z" };
    expect(decidirQuemReconciliar([linha("a"), linha("b")], new Map([["a", vivo], ["b", morto]]), AGORA)).toEqual(["b"]);
  });
  it("erro de autorização → fica de fora até reconectar", () => {
    expect(decidirQuemReconciliar([linha("a")], new Map([["a", { status: "error", cursor_updated_at: null, trava_ate: null, ultimo_erro: "auth" }]]), AGORA)).toEqual([]);
  });
  it("organização parada → fica de fora", () => {
    expect(decidirQuemReconciliar([linha("a", "suspended")], new Map(), AGORA)).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm vitest run app/api/v1/cron/nuvemshop-reconcile/route.test.ts` → FAIL.

- [ ] **Step 3: Implementar a rota**

`app/api/v1/cron/nuvemshop-reconcile/route.ts`:

```ts
/**
 * GET /api/v1/cron/nuvemshop-reconcile — a cada 30 min (docker/scheduler).
 *
 * Rede de segurança dos webhooks (spec §4.6): a Nuvemshop desativa o webhook
 * depois de 5 falhas seguidas, e este cron é o que garante que o pedido chega
 * em ≤ 30 min mesmo assim. Para cada integração saudável de org operante cujo
 * cursor tem mais de 25 min, inicia um run. Audita SÓ quando iniciou algo.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { depsReais } from "@/lib/nuvemshop/sync/deps";
import { iniciarSincronizacao } from "@/lib/nuvemshop/sync/iniciar";
import { ehOperante, STATUS_OPERANTE, statusDaOrgEmbutida } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const IDADE_MINIMA_MS = 25 * 60_000;

interface LinhaDeIntegracao {
  organization_id: string;
  organizations: { status?: string | null } | Array<{ status?: string | null }> | null;
}
interface EstadoResumido {
  status: string;
  cursor_updated_at: string | null;
  trava_ate: string | null;
  ultimo_erro: string | null;
}

export function decidirQuemReconciliar(
  linhas: LinhaDeIntegracao[],
  estados: Map<string, EstadoResumido>,
  agora: Date,
): string[] {
  const limite = agora.getTime() - IDADE_MINIMA_MS;
  return linhas
    .filter((l) => ehOperante(statusDaOrgEmbutida(l.organizations)))
    .filter((l) => {
      const e = estados.get(l.organization_id);
      if (!e) return true;
      if (e.status === "error" && e.ultimo_erro === "auth") return false;
      if (e.status === "running" && e.trava_ate && Date.parse(e.trava_ate) > agora.getTime()) return false;
      return !e.cursor_updated_at || Date.parse(e.cursor_updated_at) < limite;
    })
    .map((l) => l.organization_id);
}

async function executar(req: NextRequest): Promise<Response> {
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403);
  const admin = createAdminClient();

  const { data: linhas, error } = await admin
    .from("tenant_integrations")
    .select("organization_id, organizations:organization_id!inner(status)")
    .eq("provider", "nuvemshop")
    .eq("status", "healthy")
    .eq("organizations.status", STATUS_OPERANTE);
  if (error) return fail("internal_error", "Não foi possível ler as integrações.", 500);

  const orgIds = (linhas ?? []).map((l) => (l as LinhaDeIntegracao).organization_id);
  const estados = new Map<string, EstadoResumido>();
  if (orgIds.length > 0) {
    const { data: lidos, error: erroEstado } = await admin
      .from("integration_sync_state")
      .select("organization_id, status, cursor_updated_at, trava_ate, ultimo_erro")
      .eq("provider", "nuvemshop")
      .eq("resource", "orders")
      .in("organization_id", orgIds);
    if (erroEstado) return fail("internal_error", "Não foi possível ler o estado da sincronização.", 500);
    for (const e of lidos ?? []) estados.set((e as { organization_id: string }).organization_id, e as EstadoResumido);
  }

  const deps = depsReais(admin);
  let iniciados = 0;
  for (const orgId of decidirQuemReconciliar((linhas ?? []) as LinhaDeIntegracao[], estados, new Date())) {
    const r = await iniciarSincronizacao(deps, orgId, "reconciliacao");
    if (r.ok) {
      iniciados++;
      await audit({ action: "nuvemshop.sync_requested", organizationId: orgId, metadata: { origem: "reconciliacao", run_id: r.runId } });
    }
  }
  return ok({ candidatos: orgIds.length, iniciados });
}

export const GET = executar;
export const POST = executar;
```

`docker/scheduler/entrypoint.sh` — dentro de `CRONS=`, depois de `*/15 * * * *|60|api/v1/cron/risk-watcher` (comentário **fora** da string não se aplica aqui: dentro de `CRONS` linhas `#` já são usadas como comentário pelo parser — conferir que o parser ignora `#`, como as linhas existentes mostram):

```
# A RECONCILIAÇÃO da Nuvemshop: rede dos webhooks. 30 min é o prazo prometido
# na spec; o cron só inicia run de loja cujo cursor passou de 25 min.
*/30 * * * *|60|api/v1/cron/nuvemshop-reconcile
```

- [ ] **Step 4: Callback inicia o backfill e resolve o aviso**

Em `app/api/v1/integrations/nuvemshop/callback/route.ts`, imports:

```ts
import { resolverAvisoDeDesautorizacao } from "@/lib/nuvemshop/sync/desautorizada";
import { depsReais } from "@/lib/nuvemshop/sync/deps";
import { iniciarSincronizacao } from "@/lib/nuvemshop/sync/iniciar";
```

Depois do `update({ webhook_subscriptions })` e **antes** do `audit("nuvemshop.connected")`:

```ts
  // A conexão é o gatilho do backfill de 12 meses (spec §4.2). Reconexão depois
  // de acesso revogado também passa por aqui: o aviso da Central se resolve e o
  // run recomeça do cursor. Falha aqui não desfaz a conexão — a reconciliação
  // de 30 min tenta de novo.
  if (integration?.id) await resolverAvisoDeDesautorizacao(admin, state.orgId, integration.id);
  const inicio = await iniciarSincronizacao(depsReais(admin), state.orgId, "conexao").catch(() => null);
```

e no `metadata` do audit `nuvemshop.connected`, acrescentar `sync_iniciado: inicio?.ok === true,`.

- [ ] **Step 5: Rodar e ver passar**

```bash
pnpm vitest run app/api/v1/cron/nuvemshop-reconcile tests/unit/cron-routes-scheduled.test.ts tests/unit/cron-audita-so-quando-ha-efeito.test.ts tests/unit/cron-respeita-org-operante.test.ts tests/unit/oauth-retorno-vale-uma-vez.test.ts tests/unit/suporte-nuvemshop-audit.test.ts
```
Expected: PASS. Se outro teste de cron reclamar (o comentário do `entrypoint.sh` cita "mais dois" testes que leem o caminho por grep), registrar a rota onde ele pedir. Se `pnpm dev:crons` tiver lista em `scripts/dev-crons.ts`, acrescentar `nuvemshop-reconcile`.

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/cron/nuvemshop-reconcile app/api/v1/integrations/nuvemshop/callback/route.ts docker/scheduler/entrypoint.sh scripts/dev-crons.ts
git commit -m "feat(nuvemshop): backfill na conexão e reconciliação a cada 30 min"
```

---

### Task 10: Tela — bloco Pedidos, "Sincronizar agora", pedidos no painel do contato

**Files:**
- Create: `lib/nuvemshop/sync/resumo.ts`, `lib/nuvemshop/sync/resumo.test.ts`, `app/actions/integrations/syncNuvemshopNow.ts`, `app/app/integrations/nuvemshop/_components/PedidosDaLoja.tsx`, `app/app/integrations/nuvemshop/_components/SyncNowButton.tsx`
- Modify: `app/app/integrations/nuvemshop/page.tsx`, `app/api/v1/contacts/[id]/crm-summary/route.ts`, `components/inbox/CRMSidePanel.tsx`, `lib/i18n/dicionario.ts`

**Interfaces:**
- Consumes: `EstadoDoSync` (T7), `mesDoBackfill` (T6), `iniciarSincronizacao`/`depsReais` (T7).
- Produces:
  - `type ResumoDoSync = { situacao: "nunca" | "importando" | "sincronizando" | "em_dia" | "erro"; totalPedidos: number; mes?: number; ultimaSync: string | null; erro?: string; pedidosComErro: number }`
  - `resumirSync(estado: EstadoDoSync | null, totalPedidos: number): ResumoDoSync`
  - `FRASE_DO_ERRO: Record<string, string>` (`auth` → "A loja revogou o acesso. Desconecte e conecte de novo."; padrão → "A sincronização falhou. Tente sincronizar de novo.")
  - `syncNuvemshopNow(): Promise<{ ok: true } | { ok: false; error: "auth_required" | "no_active_org" | "forbidden" | "nao_conectada" | "desautorizada" | "sync_em_andamento" | "falha_ao_iniciar" }>`

- [ ] **Step 1: Teste que falha — resumo**

`lib/nuvemshop/sync/resumo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { EstadoDoSync } from "./estado";
import { resumirSync } from "./resumo";

const e = (over: Partial<EstadoDoSync>): EstadoDoSync => ({
  organization_id: "o", status: "idle", run_id: null, run_origem: null, trava_ate: null, cursor_updated_at: null,
  janela_atual_ini: null, janela_atual_fim: null, alvo_fim: null, pedidos_gravados: 0, pedidos_com_erro: 0,
  ultimo_erro: null, ultimo_run_fim: null, ...over,
});

describe("resumirSync", () => {
  it("sem estado → nunca", () => {
    expect(resumirSync(null, 0)).toMatchObject({ situacao: "nunca", totalPedidos: 0 });
  });
  it("backfill (sem cursor) em curso → importando mês N de 12", () => {
    expect(resumirSync(e({ status: "running", janela_atual_ini: "2026-02-08T12:00:00.000Z", alvo_fim: "2026-10-08T12:00:00.000Z" }), 40))
      .toMatchObject({ situacao: "importando", mes: 5, totalPedidos: 40 });
  });
  it("reconciliação em curso → sincronizando", () => {
    expect(resumirSync(e({ status: "running", cursor_updated_at: "2026-10-08T11:00:00.000Z" }), 40).situacao).toBe("sincronizando");
  });
  it("idle com cursor → em dia, carrega última sync e pedidos com erro", () => {
    expect(resumirSync(e({ cursor_updated_at: "x", ultimo_run_fim: "2026-10-08T12:00:00.000Z", pedidos_com_erro: 2 }), 40))
      .toMatchObject({ situacao: "em_dia", ultimaSync: "2026-10-08T12:00:00.000Z", pedidosComErro: 2 });
  });
  it("erro de autorização → frase de reconexão", () => {
    expect(resumirSync(e({ status: "error", ultimo_erro: "auth" }), 0)).toMatchObject({
      situacao: "erro", erro: "A loja revogou o acesso. Desconecte e conecte de novo.",
    });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm vitest run lib/nuvemshop/sync/resumo.test.ts` → FAIL.

- [ ] **Step 3: Implementar `resumo.ts`**

```ts
import type { EstadoDoSync } from "./estado";
import { mesDoBackfill } from "./janelas";

export type ResumoDoSync = {
  situacao: "nunca" | "importando" | "sincronizando" | "em_dia" | "erro";
  totalPedidos: number;
  mes?: number;
  ultimaSync: string | null;
  erro?: string;
  pedidosComErro: number;
};

export const FRASE_DO_ERRO: Record<string, string> = {
  auth: "A loja revogou o acesso. Desconecte e conecte de novo.",
};
const FRASE_PADRAO = "A sincronização falhou. Tente sincronizar de novo.";

export function resumirSync(estado: EstadoDoSync | null, totalPedidos: number): ResumoDoSync {
  const base = { totalPedidos, ultimaSync: estado?.ultimo_run_fim ?? null, pedidosComErro: estado?.pedidos_com_erro ?? 0 };
  if (!estado) return { ...base, situacao: "nunca" };
  if (estado.status === "error") {
    return { ...base, situacao: "erro", erro: FRASE_DO_ERRO[estado.ultimo_erro ?? ""] ?? FRASE_PADRAO };
  }
  if (estado.status === "running") {
    if (!estado.cursor_updated_at && estado.janela_atual_ini && estado.alvo_fim) {
      return { ...base, situacao: "importando", mes: mesDoBackfill(estado.janela_atual_ini, estado.alvo_fim) };
    }
    return { ...base, situacao: "sincronizando" };
  }
  return { ...base, situacao: estado.cursor_updated_at ? "em_dia" : "nunca" };
}
```

- [ ] **Step 4: Server action**

`app/actions/integrations/syncNuvemshopNow.ts` (mesmo molde de `disconnectNuvemshop.ts`):

```ts
"use server";

/**
 * "Sincronizar agora": inicia um run manual. Só quem administra a empresa;
 * sessão de suporte somente-leitura é recusada antes do efeito.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import { depsReais } from "@/lib/nuvemshop/sync/deps";
import { iniciarSincronizacao, type ResultadoDoInicio } from "@/lib/nuvemshop/sync/iniciar";

export type SyncNowResult =
  | { ok: true }
  | { ok: false; error: "auth_required" | "no_active_org" | "forbidden" | Extract<ResultadoDoInicio, { ok: false }>["motivo"] };

export async function syncNuvemshopNow(): Promise<SyncNowResult> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return { ok: false, error: "no_active_org" };
  if (!podeAdministrarEmpresa(user, activeOrg)) return { ok: false, error: "forbidden" };

  const r = await iniciarSincronizacao(depsReais(), activeOrg.orgId, "manual");
  if (!r.ok) return { ok: false, error: r.motivo };

  await audit({
    action: "nuvemshop.sync_requested",
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    metadata: { origem: "manual", run_id: r.runId },
  });
  revalidatePath("/app/integrations/nuvemshop");
  return { ok: true };
}
```

Conferir se `tests/unit/suporte-*.test.ts` exige lista de server actions mutantes; se exigir, registrar esta.

- [ ] **Step 5: Componentes**

`app/app/integrations/nuvemshop/_components/SyncNowButton.tsx`:

```tsx
"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { syncNuvemshopNow } from "@/app/actions/integrations/syncNuvemshopNow";
import { useT } from "@/hooks/i18n/useT";

const ERROS: Record<string, string> = {
  sync_em_andamento: "Já está sincronizando.",
  desautorizada: "A loja revogou o acesso. Desconecte e conecte de novo.",
  nao_conectada: "Integração não está conectada.",
  forbidden: "Apenas admins podem sincronizar.",
  falha_ao_iniciar: "Não foi possível iniciar a sincronização. Tente de novo.",
};

export function SyncNowButton() {
  const t = useT();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await syncNuvemshopNow();
          if (res.ok) toast.success(t("Sincronização iniciada."));
          else toast.error(t(ERROS[res.error] ?? "Não foi possível iniciar a sincronização. Tente de novo."));
        })
      }
    >
      {pending ? t("Iniciando…") : t("Sincronizar agora")}
    </Button>
  );
}
```

`app/app/integrations/nuvemshop/_components/PedidosDaLoja.tsx` (server component):

```tsx
import type { Idioma } from "@/lib/i18n/idiomas";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { ResumoDoSync } from "@/lib/nuvemshop/sync/resumo";
import { SyncNowButton } from "./SyncNowButton";

function situacao(r: ResumoDoSync, idioma: Idioma): string {
  switch (r.situacao) {
    case "importando":
      return `${traduzir("Importando: mês", idioma)} ${r.mes} ${traduzir("de", idioma)} 12`;
    case "sincronizando":
      return traduzir("Sincronizando…", idioma);
    case "em_dia":
      return traduzir("Em dia", idioma);
    case "erro":
      return `${traduzir("Erro:", idioma)} ${traduzir(r.erro ?? "", idioma)}`;
    default:
      return traduzir("Aguardando a primeira sincronização", idioma);
  }
}

export function PedidosDaLoja({ resumo, idioma, isAdmin }: { resumo: ResumoDoSync; idioma: Idioma; isAdmin: boolean }) {
  return (
    <section aria-labelledby="pedidos-da-loja" className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="pedidos-da-loja" className="font-medium">{traduzir("Pedidos", idioma)}</h2>
        {isAdmin ? <SyncNowButton /> : null}
      </div>
      <p data-testid="nuvemshop-pedidos-total">
        {traduzir("Pedidos sincronizados:", idioma)} {resumo.totalPedidos}
      </p>
      <p className="text-muted-foreground">
        {traduzir("Última sincronização:", idioma)}{" "}
        {resumo.ultimaSync ? new Date(resumo.ultimaSync).toLocaleString(tagDeIdioma(idioma)) : "—"}
      </p>
      <p data-testid="nuvemshop-pedidos-situacao">{situacao(resumo, idioma)}</p>
      {resumo.situacao === "em_dia" && resumo.pedidosComErro > 0 ? (
        <p className="text-muted-foreground">
          {resumo.pedidosComErro} {traduzir("pedidos não puderam ser importados na última sincronização.", idioma)}
        </p>
      ) : null}
    </section>
  );
}
```

`page.tsx` — carregar o resumo quando conectado e renderizar `<PedidosDaLoja />` no fim do `CardContent` do cartão "Conectado":

```tsx
import { lerEstado } from "@/lib/nuvemshop/sync/estado";
import { resumirSync } from "@/lib/nuvemshop/sync/resumo";
import { PedidosDaLoja } from "./_components/PedidosDaLoja";

async function loadResumo(orgId: string) {
  const admin = createAdminClient();
  const [estado, { count }] = await Promise.all([
    lerEstado(admin, orgId).catch(() => null),
    admin.from("orders").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("external_provider", "nuvemshop"),
  ]);
  return resumirSync(estado, count ?? 0);
}
// no componente:
  const resumo = integration && integration.status !== "disconnected" && activeOrg ? await loadResumo(activeOrg.orgId) : null;
// dentro do CardContent do cartão conectado:
            {resumo ? <PedidosDaLoja resumo={resumo} idioma={idioma} isAdmin={isAdmin} /> : null}
```

Também: o texto do cabeçalho "Sincroniza pedidos, produtos e clientes via OAuth + webhooks." passa a mentir menos se trocado por "Sincroniza os pedidos da loja e liga cada um ao contato." (produtos são a E2) — com entrada `es`.

- [ ] **Step 6: Painel do contato mostra os pedidos certos**

`app/api/v1/contacts/[id]/crm-summary/route.ts`:

```ts
const ORDER_COLS = "id, external_id, status, total_cents, currency, created_at, ordered_at, numero:payload->>number";
// e na consulta de orders:
      .order("ordered_at", { ascending: false })
```

Motivo: o backfill grava centenas de pedidos no mesmo instante; ordenar por `created_at` (hora da importação) mostrava 3 pedidos arbitrários em vez dos 3 mais recentes da loja.

`components/inbox/CRMSidePanel.tsx`: acrescentar `numero?: string | null` ao tipo `OrderRow` e trocar o rótulo por:

```tsx
                    {o.numero ? `#${o.numero}` : (o.external_id ?? o.id.slice(0, 8))}
```

- [ ] **Step 7: i18n** — entradas `es` em `lib/i18n/dicionario.ts` para: "Pedidos", "Pedidos sincronizados:", "Última sincronização:", "Importando: mês", "de", "Sincronizando…", "Em dia", "Erro:", "Aguardando a primeira sincronização", "pedidos não puderam ser importados na última sincronização.", "Sincronizar agora", "Iniciando…", "Sincronização iniciada.", "Já está sincronizando.", "Apenas admins podem sincronizar.", "Não foi possível iniciar a sincronização. Tente de novo.", "A loja revogou o acesso. Desconecte e conecte de novo.", "A sincronização falhou. Tente sincronizar de novo.", o texto novo do cabeçalho. Não duplicar chave já existente (`grep -n '"Erro:"' lib/i18n/dicionario.ts` antes).

- [ ] **Step 8: Rodar e ver passar**

```bash
pnpm vitest run lib/nuvemshop/ tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/traducao-nao-defasa.test.ts components/inbox app/api/v1/contacts
pnpm typecheck > /tmp/ns-tc.log 2>&1; echo "exit=$?"
pnpm lint > /tmp/ns-lint.log 2>&1; echo "exit=$?"
```
Expected: PASS, exit 0, exit 0.

- [ ] **Step 9: Commit**

```bash
git add lib/nuvemshop/sync/resumo.ts lib/nuvemshop/sync/resumo.test.ts app/actions/integrations/syncNuvemshopNow.ts app/app/integrations/nuvemshop "app/api/v1/contacts/[id]/crm-summary/route.ts" components/inbox/CRMSidePanel.tsx lib/i18n/dicionario.ts
git commit -m "feat(nuvemshop): pedidos sincronizados na tela da integração e no painel"
```

---

### Task 11: Prova pela tela (DoD 12) com receptor que imita a API

**Files:**
- Create: `tests/e2e/nuvemshop-sincroniza-pedidos.spec.ts`, `evidence/nuvemshop-sync-e1/` (screenshots)
- Modify: `scripts/gerar-env-e2e.sh`, `.github/workflows/e2e.yml` (uma `SPECS_PARTE_*`), `docs/testing/user-journey-map.md`

**Interfaces:**
- Consumes: tudo acima; helpers de `tests/e2e/helpers/` (login de admin, cliente admin do Supabase como em `tests/e2e/aviso-de-caso-no-whatsapp.spec.ts:71`).

- [ ] **Step 1: Ambiente** — em `scripts/gerar-env-e2e.sh`, ao lado de `JEV_API_BASE_URL`:

```bash
# A API da Nuvemshop fala com o receptor que a spec
# \`nuvemshop-sincroniza-pedidos\` sobe nesta porta (vizinha do Jev, 3996).
# As credenciais são de mentira: só ligam a tela da integração; nenhuma spec
# faz OAuth real. NUVEMSHOP_ENABLED fica de fora de propósito — ele muda os
# passos do onboarding, que a vps-fresh-onboarding mede sem a loja.
NUVEMSHOP_API_BASE_URL=http://127.0.0.1:3995/v1
NUVEMSHOP_APP_ID=e2e-app
NUVEMSHOP_CLIENT_ID=e2e-app
NUVEMSHOP_CLIENT_SECRET=e2e-placeholder-nao-e-segredo
```

Conferir antes que nada escuta na 3995 (`grep -rn 3995 scripts tests .github | head`).

- [ ] **Step 2: Escrever a spec**

`tests/e2e/nuvemshop-sincroniza-pedidos.spec.ts` — roteiro (código completo a escrever seguindo o molde de `tests/e2e/agenda-google-sync.spec.ts` para o receptor `createServer` e de `aviso-de-caso-no-whatsapp.spec.ts` para cliente admin/login):

1. `beforeAll`: sobe `createServer` em `127.0.0.1:3995` que responde
   - `GET /v1/e2e-loja/orders?…&page=1` → `[PEDIDO_A, PEDIDO_B]`; `page>=2` → `404 {"description":"Last page is 1"}`; janelas que não contêm `updated_at` dos pedidos → 404 (janela vazia);
   - `GET /v1/e2e-loja/orders/{id}` → o pedido.
   - `PEDIDO_A`: `id: 990001, number: 1001, contact_phone: <telefone do contato semeado>, payment_status: "paid", total: "150.90", updated_at: <ontem>`.
   - `PEDIDO_B`: `id: 990002, number: 1002, contact_email: "nova-cliente-e2e@ex.com", contact_name: "Nova Cliente", total: "80.00"` (cria contato).
2. Semente (admin client, org do admin de teste): contato com telefone + conversa aberta com ele; `tenant_integrations` com `provider: "nuvemshop"`, `status: "healthy"`, `store_metadata: { store_id: "e2e-loja" }`, `oauth_access_token_encrypted` e `webhook_secret_encrypted` via `rpc("fn_encrypt_oauth", { plaintext })`.
3. Login como admin → `/app/integrations/nuvemshop` → vê "Conectado" → clica **Sincronizar agora** → toast "Sincronização iniciada.".
4. Drena: chama `GET /api/v1/cron/event-log-drain` com o cabeçalho do cron (ver `lib/auth/cron-auth.ts` para o nome do segredo, valor do `.env.e2e`) em laço até `integration_sync_state.status = 'idle'` (teto 60 s).
5. Recarrega → `getByTestId("nuvemshop-pedidos-total")` contém `2`; `nuvemshop-pedidos-situacao` contém "Em dia". Screenshot `evidence/nuvemshop-sync-e1/01-integracao-em-dia.png`.
6. Abre a conversa semeada na inbox → painel "Pedidos recentes" mostra `#1001` e `R$ 150,90`. Screenshot `evidence/nuvemshop-sync-e1/02-painel-do-contato.png`.
7. Asserção de banco: existe contato `email = nova-cliente-e2e@ex.com` com `source = 'nuvemshop'`.
8. Botão de novo enquanto um run roda (inserir `status='running'` + `trava_ate` futura direto no estado) → toast "Já está sincronizando.". Screenshot `evidence/nuvemshop-sync-e1/03-ja-sincronizando.png`.
9. `afterAll`: apaga orders/contatos/estado/integração da semente; fecha o receptor.

Medidas por `getBoundingClientRect`/texto, nunca a olho. Sem `waitForTimeout` fixo: espera por estado.

- [ ] **Step 3: Registrar no CI** — acrescentar `nuvemshop-sincroniza-pedidos.spec.ts` na `SPECS_PARTE_*` mais curta de `.github/workflows/e2e.yml` (o `tests/unit/e2e-cobertura-completa.test.ts` reprova spec fora de toda lista).

- [ ] **Step 4: Rodar local em ambiente fresco**

```bash
pnpm e2e:env                       # regenera .env.e2e com as novas variáveis
pnpm playwright test tests/e2e/nuvemshop-sincroniza-pedidos.spec.ts > /tmp/ns-e2e.log 2>&1; echo "exit=$?"
pnpm vitest run tests/unit/e2e-cobertura-completa.test.ts
```
Expected: exit 0; screenshots em `evidence/nuvemshop-sync-e1/`.

- [ ] **Step 5: Mapa de jornadas** — em `docs/testing/user-journey-map.md`, caso novo na jornada de integrações: "[P1] Conectar Nuvemshop → pedidos aparecem na integração e no painel do contato", apontando a spec e a evidência.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/nuvemshop-sincroniza-pedidos.spec.ts evidence/nuvemshop-sync-e1 scripts/gerar-env-e2e.sh .github/workflows/e2e.yml docs/testing/user-journey-map.md
git commit -m "test(nuvemshop): prova pela tela da sincronização de pedidos"
```

---

### Task 12: Governança, mapa vivo e verificação completa

**Files:**
- Create: `.changes/nuvemshop-sincroniza-pedidos.md`, `docs/architecture/nuvemshop-sync.architecture.json`
- Modify: `docs/current-state.md`, `docs/stories/epics/EPIC-07-nuvemshop.md`

- [ ] **Step 1: Fragmento de release** (texto é nota pública; conferir `secao` válida em `docs/doctrine/versionamento.md`):

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: A integração com a Nuvemshop passa a trazer os pedidos da loja
---

Ao conectar uma loja Nuvemshop, o CRM importa os pedidos dos últimos 12 meses
e liga cada um ao contato pelo telefone, e-mail ou CPF — criando o contato
quando ele ainda não existe. Pedidos novos e alterados chegam em segundos pelos
avisos da loja e, se um aviso se perder, em até 30 minutos pela conferência
automática.

Em Integrações › Nuvemshop aparecem quantos pedidos foram sincronizados, o
andamento da importação e o botão "Sincronizar agora". Os pedidos aparecem no
painel do contato na conversa. Se a loja revogar o acesso, um aviso na Central
pede para conectar de novo. Quem já tem uma loja conectada recebe a importação
na próxima conferência automática, sem precisar fazer nada.
```

Run: `pnpm release:conferir` → sem erro de forma.

- [ ] **Step 2: Mapa vivo** — `docs/architecture/nuvemshop-sync.architecture.json` no formato de `agenda-google-sync.architecture.json` (lanes humano/borda/execucao/banco/externo), nós: `tela-integracao`, `callback-oauth`, `webhook-nuvemshop`, `cron-reconcile`, `event-log`, `handler-sync-page`, `handler-pedido`, `api-nuvemshop`, `fn-gravar-pedido`, `orders`, `contacts`, `integration-sync-state`, `central-avisos`, `painel-contato`, `mcp-crm-list-contact-orders`; arestas: webhook→event-log→handler-pedido→api→fn→orders→painel/MCP; callback/cron/tela→event-log→handler-sync-page→api; handler→central (401). Rodar `pnpm vitest run tests/unit/mapas-de-arquitetura.test.ts`.

- [ ] **Step 3: Afirmações de estado (DoD 16)** — `docs/current-state.md`: a Nuvemshop deixa de ser "só conexão"; pedidos sincronizam; produtos (E2), funil (E3) e relatórios (E4) seguem abertos. `EPIC-07-nuvemshop.md`: marcar o que a E1 cumpre (backfill de pedidos, consumidor de `order/*` e `app/uninstalled`, estado de sync) e reabrir o que segue faltando (`product_*`, `EcommercePlatformAdapter`, `contact_external_ids`) — o status `completed` era falso.

- [ ] **Step 4: Verificação completa (autoridade = exit code)**

```bash
pnpm typecheck > /tmp/ns-tc.log 2>&1; echo "typecheck exit=$?"
pnpm lint > /tmp/ns-lint.log 2>&1; echo "lint exit=$?"
pnpm lint:channels && pnpm lint:role-rank
pnpm test:unit > /tmp/ns-vt.log 2>&1; echo "unit exit=$?"
grep -aE "Test Files|Tests |Errors " /tmp/ns-vt.log | tail -3
grep -aE "^ *FAIL " /tmp/ns-vt.log | sed 's/ > .*//' | sort | uniq -c
pnpm test:db > /tmp/ns-db.log 2>&1; echo "test:db exit=$?"; grep -aE "Test Files|Tests " /tmp/ns-db.log | tail -2
pnpm checar:colisao-de-migration
pnpm format:check
```
Expected: todos exit 0; falhas só as pré-existentes anotadas na Task 0 (com prova de que falham igual em `upstream/main`).

- [ ] **Step 5: Revisão** — despachar `code-reviewer` (ou `superpowers:requesting-code-review`) sobre `git diff upstream/main...HEAD`, com foco em: filtro de `organization_id` em toda escrita do admin client, `security definer` revogada, LGPD (anonimizado), e a lista de Review Focus deste plano. Corrigir CRITICAL/HIGH.

- [ ] **Step 6: Commit**

```bash
git add .changes/nuvemshop-sincroniza-pedidos.md docs/architecture/nuvemshop-sync.architecture.json docs/current-state.md docs/stories/epics/EPIC-07-nuvemshop.md
git commit -m "docs(nuvemshop): estado, épico, mapa vivo e nota de release da E1"
```

- [ ] **Step 7: Prova manual com o app real** (antes de declarar pronto — spec §9): na instância de produção da Axis, conectar uma loja de teste ao app 43409 e conferir `select count(*) from orders where external_provider='nuvemshop'` contra o painel da loja. Exige a imagem nova implantada; se o deploy não fizer parte desta sessão, registrar como pendência no PR e no handoff.

---

## Cobertura da spec (autoconferência)

| Spec | Task |
|---|---|
| §1 consumidores de `order/*` e `app/uninstalled` | 8 |
| §2.1 backfill 12 meses | 6, 7, 9 |
| §2.2 webhook em segundos / reconciliação ≤ 30 min | 8, 9 |
| §2.3 ficha e tool MCP | 10 (painel); MCP já lê `orders` |
| §2.4 tela com contagem, estado, erro e botão | 10 |
| §4.2 janelas, teto 10k, janela fixa | 6 |
| §4.3 concorrência (run_id, trava, 409) | 7, 8, 10 |
| §4.4 tabela de erros da API | 2, 8 |
| §4.5 três handlers + classificação | 8 |
| §4.6 cron + audita só com efeito | 9 |
| §5.1 `fn_gravar_pedido_externo` | 1 |
| §5.2 tradução | 3 |
| §5.3 contato | 4 |
| §5.4 projeção do payload | 3 |
| §5.5 `integration_sync_state` + kind | 1 |
| §6 tela | 10 |
| §7 audit + Central | 7, 8, 9, 10 |
| §8 checklist do sistema vivo | 12 |
| §9 testes unit, `test:db`, e2e, manual | 1–12 |
| §10 governança | 12 |

Desvios conscientes da spec, para o revisor: `per_page` 50 (não 200); env nova `NUVEMSHOP_API_BASE_URL` (só para o receptor de prova); "Sincronizar agora" é Server Action com `supportWriteError` (molde das ações vizinhas), não rota `app/api/v1` com `requireSupportWrite`; 401/403 devolve `skipped` (não `error`), para o dreno não abrir um segundo aviso de evento morto em cima do aviso de acesso revogado.
