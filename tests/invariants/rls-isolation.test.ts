import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * G1-02 — RLS isolation invariant.
 *
 * Runs against the ephemeral Postgres container started by scripts/test-db.sh
 * (baseline.sql already applied). Seeds 2 orgs + 1 user each, then proves that
 * a user of org A sees ZERO rows of org B in conversations / messages /
 * contacts / crm_leads under RLS, with JWT claims simulated via
 * set_config('request.jwt.claims', ...) — the same auth.uid() /
 * fn_user_org_ids() path production policies use.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

/** Runs a SQL script in ONE psql session inside the container; returns stdout (tuples-only). */
function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

// Fixed UUIDs make the seed idempotent (on conflict do nothing).
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const USER_A = "aaaaaaaa-1111-4000-8000-000000000001";
const USER_B = "bbbbbbbb-1111-4000-8000-000000000002";
const SESS_A = "aaaaaaaa-2222-4000-8000-000000000001";
const SESS_B = "bbbbbbbb-2222-4000-8000-000000000002";

/**
 * Runs SELECTs as the `authenticated` role with the given user's JWT claims,
 * exactly how PostgREST/Supabase set them: session role + request.jwt.claims.
 */
function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  // Output lines: set_config echo, then the count (last line).
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`unexpected psql output: ${out}`);
  }
  return Number(last);
}

function seedOrg(org: string, user: string, sess: string, tag: string): string {
  // No real PII: synthetic emails/names only (LGPD).
  return `
    insert into auth.users (id, email) values ('${user}', 'rls-${tag}@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'rls-inv-${tag}', 'RLS Invariant ${tag}', 'RLS ${tag}')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${user}', '${org}', 'agent', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${sess}', '${org}', 'rls-inv-${tag}', '\\x00'::bytea)
      on conflict (id) do nothing;
  `;
}

beforeAll(() => {
  sql(seedOrg(ORG_A, USER_A, SESS_A, "a") + seedOrg(ORG_B, USER_B, SESS_B, "b"));
  // Contact → conversation → message + pipeline → stage → lead, per org.
  sql(`
    do $seed$
    declare
      v_org uuid;
      v_sess uuid;
      v_contact uuid;
      v_conv uuid;
      v_pipe uuid;
      v_stage uuid;
    begin
      foreach v_org in array array['${ORG_A}'::uuid, '${ORG_B}'::uuid] loop
        select id into v_sess from public.channel_sessions where organization_id = v_org limit 1;

        select id into v_contact from public.contacts
          where organization_id = v_org and display_name = 'RLS Invariant Contact';
        if v_contact is null then
          insert into public.contacts (organization_id, display_name)
            values (v_org, 'RLS Invariant Contact') returning id into v_contact;
        end if;

        select id into v_conv from public.conversations
          where organization_id = v_org and contact_id = v_contact;
        if v_conv is null then
          insert into public.conversations (organization_id, contact_id, channel_session_id)
            values (v_org, v_contact, v_sess) returning id into v_conv;
        end if;

        if not exists (select 1 from public.messages where organization_id = v_org) then
          insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
            values (v_org, v_conv, v_sess, v_contact, 'text', 'inbound', 'rls invariant probe');
        end if;

        select id into v_pipe from public.crm_pipelines
          where organization_id = v_org and slug = 'rls-inv';
        if v_pipe is null then
          insert into public.crm_pipelines (organization_id, name, slug)
            values (v_org, 'RLS Invariant', 'rls-inv') returning id into v_pipe;
        end if;

        select id into v_stage from public.crm_stages
          where organization_id = v_org and pipeline_id = v_pipe and slug = 'novo';
        if v_stage is null then
          insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
            values (v_org, v_pipe, 'Novo', 'novo', 1000) returning id into v_stage;
        end if;

        if not exists (select 1 from public.crm_leads where organization_id = v_org) then
          insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
            values (v_org, v_pipe, v_stage, 'RLS invariant lead');
        end if;

        if not exists (select 1 from public.org_guardrail_layers where organization_id = v_org) then
          insert into public.org_guardrail_layers (organization_id, layer, enabled)
            values (v_org, 'jailbreak', true);
        end if;

        if not exists (select 1 from public.org_memory_versions where organization_id = v_org) then
          insert into public.org_memory_versions (organization_id, version_number, content)
            values (v_org, 1, 'RLS invariant memory doc');
        end if;

        if not exists (select 1 from public.org_memory_entries where organization_id = v_org) then
          insert into public.org_memory_entries (organization_id, title, body, source)
            values (v_org, 'RLS invariant entry', 'RLS invariant body', 'manual');
        end if;

        if not exists (select 1 from public.skill_activations where organization_id = v_org) then
          insert into public.skill_activations (organization_id, skill_name, trigger)
            values (v_org, 's', 'hard');
        end if;

        if not exists (select 1 from public.ai_routers where organization_id = v_org) then
          insert into public.ai_routers (organization_id, name, channel_session_id)
            values (v_org, 'RLS Invariant Router', v_sess);
        end if;

        if not exists (select 1 from public.ai_router_decisions where organization_id = v_org) then
          insert into public.ai_router_decisions (organization_id, outcome)
            values (v_org, 'no_match');
        end if;

        if not exists (select 1 from public.knowledge_searches where organization_id = v_org) then
          insert into public.knowledge_searches (organization_id, hits, top_score, threshold)
            values (v_org, 1, 0.81, 0.72);
        end if;

        -- contact_field_proposals (migration 0123): a fila guarda e-mail e
        -- telefone que o cliente DITOU na conversa — PII crua, e a tabela nasce
        -- com CRUD inteiro para "authenticated" (o ALTER DEFAULT PRIVILEGES do
        -- baseline vale para todo objeto criado no apêndice). A única coisa
        -- entre o tenant A e o e-mail do cliente do tenant B é a policy.
        if not exists (select 1 from public.contact_field_proposals where organization_id = v_org) then
          insert into public.contact_field_proposals
            (organization_id, contact_id, campo, valor_proposto, expires_at)
            values (v_org, v_contact, 'email', 'rls-invariant@exemplo.test', now() + interval '7 days');
        end if;

        if not exists (select 1 from public.catalog_products where organization_id = v_org) then
          insert into public.catalog_products
            (organization_id, codigo, nome, preco_cents)
            values (v_org, 'RLS-' || v_org::text, 'Produto de invariante', 100);
        end if;

        if not exists (select 1 from public.push_subscriptions where organization_id = v_org) then
          insert into public.push_subscriptions
            (organization_id, user_id, endpoint, p256dh, auth)
            values (
              v_org,
              case when v_org = '${ORG_A}'::uuid then '${USER_A}'::uuid else '${USER_B}'::uuid end,
              'https://push.example.test/rls-' || v_org::text,
              'p256dh-rls',
              'auth-rls'
            );
        end if;
      end loop;
    end
    $seed$;
  `);
});

/**
 * ⚠️ LISTA FIXA — tabela tenant-aware nova que NÃO entrar aqui passa verde sem
 * RLS. Não existe varredura genérica do tipo "toda tabela com organization_id
 * tem relrowsecurity = true"; quem cria tabela nova acrescenta a linha aqui, no
 * MESMO commit da migration.
 *
 * E conferir o catálogo (`relrowsecurity`, `pg_policy` contendo o nome da
 * função) NÃO substitui este percurso: policy que diga
 * `organization_id in (select fn_user_org_ids()) or true` satisfaz as duas
 * checagens de catálogo e devolve a org inteira do vizinho. Medido — ver o
 * cabeçalho do caso de `contact_field_proposals` abaixo.
 */
export const TABLES = [
  "conversations",
  "messages",
  "contacts",
  "crm_leads",
  "org_memory_versions",
  "org_memory_entries",
  "skill_activations",
  "ai_routers",
  "ai_router_decisions",
  "knowledge_searches",
  // migration 0123 (spec 17 §4b) — guarda e-mail/telefone ditos na conversa.
  "contact_field_proposals",
  // migration 0142 — a escolha de camadas de segurança da organização. Entrou aqui
  // depois de uma auditoria medir que ela NÃO tinha prova comportamental nenhuma:
  // o teste de schema dela conecta como `postgres` (rolbypassrls = t), e com a policy
  // sabotada para `... or true` a suíte seguia 31/31 verde num banco em que o vizinho
  // lia e escrevia. É o modo de falha que o aviso acima descreve, encontrado vivo.
  "org_guardrail_layers",
  "push_subscriptions",
  // migration 0204 — o catálogo de produtos da loja. A leitura é org-scoped sem
  // gate de papel (o `agent` semeado aqui precisa ler para atender), e a ESCRITA
  // exige `manager` — esse segundo eixo é medido em
  // `tests/invariants/catalogo-so-gestor-muda-preco.test.ts`, não aqui.
  "catalog_products",
  // ⚠️ `webhook_lead_captures` (migration 0174) NÃO entra nesta lista, e a
  // ausência é deliberada: a policy dela exige `manager`, e o usuário semeado
  // aqui é `agent` — o controle positivo falharia por ACERTO, e a "correção"
  // natural seria afrouxar a policy para caber no molde. A prova dela vive em
  // `tests/invariants/historico-de-captacao-rls.test.ts`, que mede as duas
  // direções MAIS o gate de papel (o `viewer` que não lê o formulário).
] as const;

describe("RLS tenant isolation (fn_user_org_ids pattern)", () => {
  for (const table of TABLES) {
    it(`user of org A reads 0 rows of org B in ${table}`, () => {
      const crossTenant = countAs(
        USER_A,
        `select count(*) from public.${table} where organization_id = '${ORG_B}';`,
      );
      expect(crossTenant).toBe(0);
    });

    it(`user of org A still reads their own org rows in ${table} (positive control)`, () => {
      const ownRows = countAs(
        USER_A,
        `select count(*) from public.${table} where organization_id = '${ORG_A}';`,
      );
      expect(ownRows).toBeGreaterThanOrEqual(1);
    });
  }

  it("superuser sees both orgs (seed sanity: cross-tenant rows really exist)", () => {
    const total = Number(
      sql(
        `select count(distinct organization_id) from public.contacts where organization_id in ('${ORG_A}','${ORG_B}');`,
      ),
    );
    expect(total).toBe(2);
  });
});
