import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_ADMIN,
  GOV_CONTACT_PROBE,
  GOV_MANAGER,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_SESSION,
  GOV_VIEWER,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * Eixo 1 — RBAC (spec 13 §1; fase que fecha: G2).
 * docs/specs/13-spec-governanca-atendimento.md — dor: "atendente com
 * privilégios de owner; nível de acesso não-editável pós-atribuição;
 * enforcement só no frontend". Matriz alvo em spec 13 §4.
 */

beforeAll(() => {
  seedGov();
});

/** fn_role_at_least(GOV_ORG, threshold) for the user, as '1'/'0' per threshold. */
function roleVector(userId: string): string {
  const thresholds = ["viewer", "agent", "manager", "admin"];
  const expr = thresholds
    .map((t) => `public.fn_role_at_least('${GOV_ORG}', '${t}')::int::text`)
    .join(" || ',' || ");
  return lastLine(
    sql(`
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      select ${expr};
    `),
  );
}

describe("eixo 1 — RBAC", () => {
  it("fn_role_at_least ordena viewer < agent < manager < admin", () => {
    expect(roleVector(GOV_VIEWER)).toBe("1,0,0,0");
    expect(roleVector(GOV_AGENT_A)).toBe("1,1,0,0");
    expect(roleVector(GOV_MANAGER)).toBe("1,1,1,0");
    expect(roleVector(GOV_ADMIN)).toBe("1,1,1,1");
  });

  it("fn_user_role_in mapeia viewer→1, agent→2, manager→3, admin→4", () => {
    const rank = (userId: string): string =>
      lastLine(
        sql(`
          select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
          select public.fn_user_role_in('${GOV_ORG}')::text;
        `),
      );
    expect(rank(GOV_VIEWER)).toBe("1");
    expect(rank(GOV_AGENT_A)).toBe("2");
    expect(rank(GOV_MANAGER)).toBe("3");
    expect(rank(GOV_ADMIN)).toBe("4");
  });

  it("RLS impede agent de se auto-promover (user_orgs_update é admin-only)", () => {
    const updated = writeCountAs(
      GOV_AGENT_A,
      `update public.user_organizations set role = 'admin'
         where user_id = '${GOV_AGENT_A}' and organization_id = '${GOV_ORG}'`,
    );
    expect(updated).toBe(0);
    const role = sql(
      `select role from public.user_organizations where user_id = '${GOV_AGENT_A}' and organization_id = '${GOV_ORG}';`,
    );
    expect(role).toBe("agent");
  });

  // Listado no plano como gap conhecido ("role de membro não é editável via
  // API" → GAP G2), mas a rota JÁ existe (EPIC-09: PATCH
  // app/api/v1/team/[user_id]/role, admin-only + proteção de último admin).
  // Gap já fechado ⇒ registrado como invariante VERDE — um it.fails aqui
  // seria desonesto e quebraria a suíte.
  it("role de membro é editável via API — PATCH /api/v1/team/[user_id]/role existe com export PATCH", () => {
    const route = path.resolve(process.cwd(), "app/api/v1/team/[user_id]/role/route.ts");
    expect(existsSync(route)).toBe(true);
    expect(readFileSync(route, "utf8")).toContain("export async function PATCH");
  });

  // GAP(G2): spec 13 §4 — pipelines (config) é manager+:write, agent=none.
  // Hoje a policy tenant_isolation_crm_pipelines_all é org-flat: qualquer
  // membro (incl. agent) escreve config de pipeline.
  it.fails("agent NÃO escreve config de pipeline (spec 13 §4: manager+)", () => {
    const updated = writeCountAs(
      GOV_AGENT_A,
      `update public.crm_pipelines set name = name where id = '${GOV_PIPELINE}'`,
    );
    expect(updated).toBe(0);
  });

  // GAP(G2): spec 13 §4 — viewer é read-only em conversations. Hoje a policy
  // org-flat (WITH CHECK por org) deixa o viewer inserir/escrever.
  it.fails("viewer NÃO escreve em conversations (spec 13 §4: viewer é read-only)", () => {
    const inserted = writeCountAs(
      GOV_VIEWER,
      `insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
         values ('cccccccc-4444-4000-8000-000000000099', '${GOV_ORG}', '${GOV_CONTACT_PROBE}', '${GOV_SESSION}', 'open')
         on conflict do nothing`,
    );
    expect(inserted).toBe(0);
  });
});
