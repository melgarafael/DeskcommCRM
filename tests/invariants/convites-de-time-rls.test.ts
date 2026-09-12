import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * OS CONVITES DE TIME NÃO VAZAM ENTRE ORGANIZAÇÕES — NEM PARA DENTRO DA PRÓPRIA.
 *
 * ═══ Por que um arquivo próprio, e não uma linha em rls-isolation.test.ts ═══
 *
 * O mesmo motivo de `historico-de-captacao-rls.test.ts`: aquele molde semeia um
 * usuário `agent` por organização, e `team_invites_select` (migration 0238)
 * exige `manager`. O controle positivo — "lê ≥1 linha própria" — falharia por
 * acerto, e a "correção" natural seria afrouxar a policy para o padrão org-flat.
 *
 * ═══ O que este arquivo prova ═══
 *
 * `team_invites.email` é o e-mail de alguém que ainda nem entrou no sistema. A
 * tabela nasce com CRUD inteiro para `authenticated` (o `ALTER DEFAULT
 * PRIVILEGES` do baseline), então a única coisa entre um `viewer` do tenant A e
 * o e-mail convidado pelo tenant B são as duas policies. As asserções:
 *   - manager de A lê os convites de A e ZERO de B (isolamento);
 *   - sem filtro de org, o total que A vê é exatamente o de A (sem porta dos fundos);
 *   - viewer e agent de A leem ZERO — o gate de papel de `team_invites_select`;
 *   - manager de A NÃO consegue revogar (write exige admin); admin de A consegue.
 *
 * `set role authenticated` + `request.jwt.claims` — o mesmo caminho da produção.
 * Conectar como `postgres` mediria nada (rolbypassrls = t).
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

const ORG_A = "d1d1d1d1-0000-4000-8000-00000000000a";
const ORG_B = "d1d1d1d1-0000-4000-8000-00000000000b";
const ADMIN_A = "d1d1d1d1-1111-4000-8000-00000000000a";
const MANAGER_A = "d1d1d1d1-1111-4000-8000-00000000000c";
const AGENT_A = "d1d1d1d1-1111-4000-8000-00000000000d";
const VIEWER_A = "d1d1d1d1-1111-4000-8000-00000000000e";
const ADMIN_B = "d1d1d1d1-1111-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}',   'convites-admin-a@invariant.test'),
      ('${MANAGER_A}', 'convites-mgr-a@invariant.test'),
      ('${AGENT_A}',   'convites-agent-a@invariant.test'),
      ('${VIEWER_A}',  'convites-viewer-a@invariant.test'),
      ('${ADMIN_B}',   'convites-admin-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'convites-inv-a', 'Convites Invariant A', 'Convites A'),
      ('${ORG_B}', 'convites-inv-b', 'Convites Invariant B', 'Convites B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}',   '${ORG_A}', 'admin',   now()),
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${VIEWER_A}',  '${ORG_A}', 'viewer',  now()),
      ('${ADMIN_B}',   '${ORG_B}', 'admin',   now())
      on conflict do nothing;

    insert into public.team_invites (organization_id, email, role, invited_by, expires_at)
    select v.org, 'convidado-' || v.org::text || '@invariant.test', 'agent', null,
           now() + interval '24 hours'
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
     where not exists (
       select 1 from public.team_invites t where t.organization_id = v.org
     );
  `);
});

describe("team_invites — isolamento e gate de papel", () => {
  it("o manager da org A lê os convites da PRÓPRIA org (controle positivo)", () => {
    expect(
      countAs(
        MANAGER_A,
        `select count(*) from public.team_invites where organization_id = '${ORG_A}';`,
      ),
    ).toBeGreaterThan(0);
  });

  it("o manager da org A lê ZERO convites da org B", () => {
    expect(
      countAs(
        MANAGER_A,
        `select count(*) from public.team_invites where organization_id = '${ORG_B}';`,
      ),
    ).toBe(0);
  });

  it("sem filtro de organização, o total que A vê é exatamente o de A", () => {
    const total = countAs(MANAGER_A, `select count(*) from public.team_invites;`);
    const proprias = countAs(
      MANAGER_A,
      `select count(*) from public.team_invites where organization_id = '${ORG_A}';`,
    );
    expect(total).toBe(proprias);
  });

  it("o AGENT da própria org lê ZERO — team_invites_select exige manager+", () => {
    expect(
      countAs(
        AGENT_A,
        `select count(*) from public.team_invites where organization_id = '${ORG_A}';`,
      ),
    ).toBe(0);
  });

  it("o VIEWER da própria org lê ZERO", () => {
    expect(
      countAs(
        VIEWER_A,
        `select count(*) from public.team_invites where organization_id = '${ORG_A}';`,
      ),
    ).toBe(0);
  });

  it("o admin da org B lê os dele (controle positivo do outro lado)", () => {
    expect(
      countAs(
        ADMIN_B,
        `select count(*) from public.team_invites where organization_id = '${ORG_B}';`,
      ),
    ).toBeGreaterThan(0);
  });

  it("o MANAGER não consegue revogar — a escrita exige admin", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
      do $$
      begin
        update public.team_invites set revoked_at = now()
         where organization_id = '${ORG_A}';
      exception when others then null;
      end
      $$;
    `);
    const revogados = sql(`
      reset role;
      select count(*) from public.team_invites
       where organization_id = '${ORG_A}' and revoked_at is not null;
    `);
    expect(revogados.split("\n").pop()).toBe("0");
  });

  it("o ADMIN consegue revogar o convite da própria org", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${ADMIN_A}"}', false);
      update public.team_invites set revoked_at = now(), revoked_by = '${ADMIN_A}'
       where organization_id = '${ORG_A}';
    `);
    const revogados = sql(`
      reset role;
      select count(*) from public.team_invites
       where organization_id = '${ORG_A}' and revoked_at is not null;
    `);
    expect(Number(revogados.split("\n").pop())).toBeGreaterThan(0);
  });

  it("o ADMIN da org A não revoga nada da org B", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${ADMIN_A}"}', false);
      do $$
      begin
        update public.team_invites set revoked_at = now()
         where organization_id = '${ORG_B}';
      exception when others then null;
      end
      $$;
    `);
    const revogados = sql(`
      reset role;
      select count(*) from public.team_invites
       where organization_id = '${ORG_B}' and revoked_at is not null;
    `);
    expect(revogados.split("\n").pop()).toBe("0");
  });
});
