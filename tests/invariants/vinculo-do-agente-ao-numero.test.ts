import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * O VÍNCULO VERSÃO↔NÚMERO (#2796, fatia 1) — a tabela que diz em QUAIS números
 * uma versão de agente atende.
 *
 * ═══ O que este arquivo prova, e por que ele existe ═══
 *
 * `ai_agent_version_channels` nasce nesta fatia e entra em `TABLES`
 * (`rls-isolation.test.ts`) — o isolamento cross-org de leitura já é medido lá
 * com o usuário `agent`. Aqui ficam as cercas que o molde de `TABLES` NÃO cobre:
 *
 *   1. a policy de RLS NÃO cita `conversations`. Citar a tabela de conversas
 *      dentro de uma policy de RLS é o caminho para RECURSÃO INFINITA — cada
 *      leitura de conversa dispararia a policy, que lê conversa. O molde desta
 *      cerca vem das migrations recentes de convite/participantes (0238): a
 *      tabela é só `organization_id` + FKs, e a policy isola por
 *      `fn_user_org_ids()` sem olhar para o lado;
 *   2. o índice único é por (versão, número): a MESMA versão não declara o
 *      mesmo número duas vezes (23505), e versões diferentes PODEM declarar o
 *      mesmo número (caso legítimo — dois agentes no mesmo número);
 *   3. apagar a versão apaga o vínculo (cascade na versão), mas apagar o NÚMERO
 *      vinculado é BARRADO (`on delete restrict`) — o FK espelha o de
 *      `ai_agent_versions.channel_session_id`, e desconectar número é decisão
 *      de produto em aberto;
 *   4. `anon` não tem privilégio nenhum (a anon key vai para o browser);
 *   5. a escrita cross-org por `authenticated` é barrada pela policy;
 *   6. o gate de PAPEL: escrever o vínculo exige `admin` na organização (mesmo
 *      molde de `ai_agent_versions`, migration 0150). Tabela NOVA não pode
 *      entrar com policy `ALL` só-tenancy — `rbac-config-ia-canais.test.ts`
 *      reprova, e o par de casos (papel de baixo barrado / admin passando) é o
 *      que tira a tabela da tentação da allowlist de dívida.
 *
 * `set role authenticated` + `request.jwt.claims` — o mesmo caminho da produção.
 * Sementes com e-mails sintéticos (`@invariant.test`), zero PII (LGPD).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

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

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const last = out.split("\n").pop();
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`saída inesperada do psql: ${out}`);
  }
  return Number(last);
}

/**
 * Roda um DML sob `authenticated`; devolve true se a escrita passou.
 * Negativa de RLS (row-level security / permission denied) conta como BARROU —
 * é exatamente o que a cerca mede. Qualquer outro erro sobe.
 */
function writeAs(userId: string, dml: string): boolean {
  try {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      with w as (${dml} returning 1) select count(*) from w;
    `);
    return Number(out.split("\n").pop()) > 0;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr.includes("row-level security") || stderr.includes("permission denied")) return false;
    throw err;
  }
}

const ORG_A = "e0e0e0e0-0000-4000-8000-00000000000a";
const ORG_B = "e0e0e0e0-0000-4000-8000-00000000000b";
const USER_A = "e0e0e0e0-1111-4000-8000-00000000000a";
const USER_B = "e0e0e0e0-1111-4000-8000-00000000000b";
const SESS_A = "e0e0e0e0-2222-4000-8000-00000000000a";
const SESS_B = "e0e0e0e0-2222-4000-8000-00000000000b";
const AGENT_A = "e0e0e0e0-3333-4000-8000-00000000000a";
const AGENT_B = "e0e0e0e0-3333-4000-8000-00000000000b";
const VERSION_A = "e0e0e0e0-4444-4000-8000-00000000000a";
const VERSION_A_2 = "e0e0e0e0-4444-4000-8000-00000000001a";
const VERSION_A_3 = "e0e0e0e0-4444-4000-8000-00000000002a";
const VERSION_B = "e0e0e0e0-4444-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'vinculo-agent-a@invariant.test'),
      ('${USER_B}', 'vinculo-agent-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'vinculo-inv-a', 'Vinculo Invariant A', 'Vinculo A'),
      ('${ORG_B}', 'vinculo-inv-b', 'Vinculo Invariant B', 'Vinculo B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'admin', now()),
      ('${USER_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;

    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESS_A}', '${ORG_A}', 'vinculo-inv-a', '\\x00'::bytea),
      ('${SESS_B}', '${ORG_B}', 'vinculo-inv-b', '\\x00'::bytea)
      on conflict (id) do nothing;

    insert into public.ai_agents (id, organization_id, name, system_prompt, operation_mode)
      values ('${AGENT_A}', '${ORG_A}', 'Vinculo Invariant Agent', 'prompt de invariante', 'assisted')
      on conflict (id) do nothing;

    insert into public.ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
      values
        ('${VERSION_A}',   '${ORG_A}', '${AGENT_A}', 1, 'prompt de invariante', 'anthropic', 'rls-test-model', '${SESS_A}', 'published'),
        ('${VERSION_A_2}', '${ORG_A}', '${AGENT_A}', 2, 'prompt de invariante 2', 'anthropic', 'rls-test-model', '${SESS_A}', 'draft'),
        ('${VERSION_A_3}', '${ORG_A}', '${AGENT_A}', 3, 'prompt de invariante 3', 'anthropic', 'rls-test-model', '${SESS_A}', 'draft')
      on conflict (id) do nothing;

    -- Versão da organização B: só para o caso do gate de PAPEL (usuário de
    -- baixo papel tentando escrever na PRÓPRIA organização) e para o controle
    -- positivo do admin logo abaixo. O agente de B não participa das cercas de
    -- isolamento do arquivo; ali o vizinho é sempre o A.
    insert into public.ai_agents (id, organization_id, name, system_prompt, operation_mode)
      values ('${AGENT_B}', '${ORG_B}', 'Vinculo Invariant Agent B', 'prompt de invariante', 'assisted')
      on conflict (id) do nothing;

    insert into public.ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
      values ('${VERSION_B}', '${ORG_B}', '${AGENT_B}', 1, 'prompt de invariante', 'anthropic', 'rls-test-model', '${SESS_B}', 'published')
      on conflict (id) do nothing;

    insert into public.ai_agent_version_channels
      (organization_id, agent_version_id, channel_session_id)
      values ('${ORG_A}', '${VERSION_A}', '${SESS_A}')
      on conflict (agent_version_id, channel_session_id) do nothing;
  `);
});

describe("ai_agent_version_channels — cercas da fatia 1", () => {
  it("RLS ligada, com leitura por organização e escrita sob fn_role_at_least", () => {
    expect(
      sql(
        `select relrowsecurity::text from pg_class
          where relname = 'ai_agent_version_channels' and relnamespace = 'public'::regnamespace;`,
      ),
    ).toBe("true");
    // Morre a policy `ALL` só-tenancy do primeiro desenho: ela reprovava em
    // `rbac-config-ia-canais.test.ts` ("nenhuma tabela NOVA entra com policy
    // ALL só-tenancy"). O par select/write é o MESMO molde da 0150 para
    // `ai_agent_versions`.
    expect(
      Number(
        sql(
          `select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'ai_agent_version_channels'
              and policyname = 'tenant_isolation_ai_agent_version_channels_all';`,
        ),
      ),
    ).toBe(0);
    expect(
      Number(
        sql(
          `select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'ai_agent_version_channels'
              and policyname = 'tenant_isolation_ai_agent_version_channels_select'
              and cmd = 'SELECT';`,
        ),
      ),
    ).toBe(1);
    expect(
      Number(
        sql(
          `select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'ai_agent_version_channels'
              and policyname = 'tenant_isolation_ai_agent_version_channels_write'
              and cmd = 'ALL'
              and (coalesce(qual, '') || coalesce(with_check, '')) like '%role_at_least%';`,
        ),
      ),
    ).toBe(1);
  });

  it("a policy NÃO cita `conversations` (evita a recursão infinita de RLS)", () => {
    const citacao = sql(
      `select coalesce(string_agg(d, ' '), '')
         from (
           select coalesce(qual, '') || ' ' || coalesce(with_check, '') as d
             from pg_policies
            where schemaname = 'public' and tablename = 'ai_agent_version_channels'
         ) t
        where d ilike '%conversations%';`,
    );
    expect(citacao).toBe("");
  });

  it("anon não tem privilégio nenhum sobre a tabela", () => {
    expect(
      Number(
        sql(
          `select count(*) from information_schema.role_table_grants
            where table_schema = 'public' and table_name = 'ai_agent_version_channels'
              and grantee = 'anon';`,
        ),
      ),
    ).toBe(0);
  });

  it("o agent de A lê o próprio vínculo (controle positivo) e ZERO do vizinho B", () => {
    expect(
      countAs(USER_A, `select count(*) from public.ai_agent_version_channels where organization_id = '${ORG_A}';`),
    ).toBeGreaterThanOrEqual(1);
    expect(
      countAs(USER_A, `select count(*) from public.ai_agent_version_channels where organization_id = '${ORG_B}';`),
    ).toBe(0);
  });

  it("a MESMA versão não declara o mesmo número duas vezes (único por versão+número)", () => {
    const resultado = sql(`
      do $$
      begin
        insert into public.ai_agent_version_channels
          (organization_id, agent_version_id, channel_session_id)
          values ('${ORG_A}', '${VERSION_A}', '${SESS_A}');
        raise exception 'NAO_DEVERIA';
      exception
        when unique_violation then raise notice 'BLOQUEADO';
      end $$;
      select 1;
    `);
    expect(resultado).toContain("1");
  });

  it("versões DIFERENTES podem declarar o mesmo número (não é único por número)", () => {
    const inseridas = sql(`
      insert into public.ai_agent_version_channels
        (organization_id, agent_version_id, channel_session_id)
        values ('${ORG_A}', '${VERSION_A_2}', '${SESS_A}')
        on conflict (agent_version_id, channel_session_id) do nothing
      returning 1;
    `);
    expect(inseridas.split("\n").filter((l) => l.trim() !== "").length).toBeGreaterThanOrEqual(1);
  });

  it("apagar a VERSÃO apaga o vínculo (cascade)", () => {
    const antes = Number(
      sql(`select count(*) from public.ai_agent_version_channels where agent_version_id = '${VERSION_A_2}';`),
    );
    expect(antes).toBe(1);
    sql(`delete from public.ai_agent_versions where id = '${VERSION_A_2}';`);
    const depois = Number(
      sql(`select count(*) from public.ai_agent_version_channels where agent_version_id = '${VERSION_A_2}';`),
    );
    expect(depois).toBe(0);
  });

  it("apagar o NÚMERO vinculado é BARRADO (on delete restrict)", () => {
    const resultado = sql(`
      do $$
      begin
        delete from public.channel_sessions where id = '${SESS_A}';
        raise exception 'NAO_DEVERIA';
      exception
        when foreign_key_violation then raise notice 'BLOQUEADO';
      end $$;
      select 1;
    `);
    expect(resultado).toContain("1");
  });

  it("CONTROLE POSITIVO: o admin da organização escreve o próprio vínculo", () => {
    const passou = writeAs(
      USER_A,
      `insert into public.ai_agent_version_channels
         (organization_id, agent_version_id, channel_session_id)
         values ('${ORG_A}', '${VERSION_A_3}', '${SESS_A}')`,
    );
    expect(passou).toBe(true);
  });

  it("o papel de baixo (agent) é BARRADO de escrever na PRÓPRIA organização", () => {
    const passou = writeAs(
      USER_B,
      `insert into public.ai_agent_version_channels
         (organization_id, agent_version_id, channel_session_id)
         values ('${ORG_B}', '${VERSION_B}', '${SESS_B}')`,
    );
    expect(passou).toBe(false);
  });

  it("a escrita de authenticated para OUTRA organização é barrada pela policy", () => {
    const passou = writeAs(
      USER_A,
      `insert into public.ai_agent_version_channels
         (organization_id, agent_version_id, channel_session_id)
         values ('${ORG_B}', '${VERSION_B}', '${SESS_B}')`,
    );
    expect(passou).toBe(false);
  });

  // FK composta (organization_id, id): a checagem de FK não passa pela RLS, então
  // só ela amarra a versão e o número à MESMA organização da linha. O admin de A
  // passa na policy (organization_id = A); o que barra é o banco.
  it.each([
    ["o número", VERSION_A, SESS_B],
    ["a versão", VERSION_B, SESS_A],
  ])("a linha de A não aponta para %s de OUTRA organização (FK composta)", (_o, versao, numero) => {
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
        insert into public.ai_agent_version_channels
          (organization_id, agent_version_id, channel_session_id)
          values ('${ORG_A}', '${versao}', '${numero}');
      `),
    ).toThrow(/violates foreign key constraint "ai_agent_version_channels_(versao|numero)_da_org_fk"/);
  });
});
