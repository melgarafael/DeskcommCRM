import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  seedGov,
  GOV_ORG as org,
  GOV_AGENT_A as ana,
  GOV_AGENT_B as bruno,
  GOV_MANAGER as manager,
  GOV_VIEWER as viewer,
  GOV_PIPELINE as pipeline,
  GOV_STAGE as stage,
} from "./gov-helpers";

/**
 * Rodízio de leads por grupo (migration 0541, issue #2041).
 *
 * O lead de formulário nasce SEM conversa; o gatilho `trg_lead_routing_on_insert`
 * dá o dono pelo próximo membro ativo do grupo da regra que casa a origem. O dono
 * entra por UPDATE logo depois do INSERT — é o UPDATE que faz
 * `fn_emit_event_on_lead_change` emitir `lead.assigned` (o push).
 */
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 8,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

async function asUser(user: string, text: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal: "aal1" })]);
    const result = await c.query(text, args);
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

const SOURCE = "src-rodizio-invariante";
const OTHER_ORG = "cccccccc-0000-4000-8000-0000000000f1";

async function novoGrupo(members: Array<[string, number]>, matchValue = SOURCE, matchType = "webhook_source") {
  const g = await query("insert into lead_routing_groups(organization_id,name) values($1,'grupo de teste') returning id", [org]);
  const group = g.rows[0].id as string;
  for (const [user, position] of members) {
    await query("insert into lead_routing_group_members(organization_id,group_id,user_id,position) values($1,$2,$3,$4)", [org, group, user, position]);
  }
  await query("insert into lead_routing_rules(organization_id,group_id,match_type,match_value) values($1,$2,$3,$4)", [org, group, matchType, matchValue]);
  return group;
}

async function novoLead(metadata: Record<string, unknown> = { webhook_source_id: SOURCE }, owner: string | null = null) {
  const r = await query(
    `insert into crm_leads(organization_id,pipeline_id,stage_id,title,source,source_metadata,owner_user_id,owner_kind)
     values($1,$2,$3,'lead-rodizio',$4,$5::jsonb,$6,$7) returning id`,
    [org, pipeline, stage, "webhook", JSON.stringify(metadata), owner, owner ? "user" : null],
  );
  const id = r.rows[0].id as string;
  const o = await query("select owner_user_id from crm_leads where id=$1", [id]);
  return { id, owner: o.rows[0].owner_user_id as string | null };
}

beforeAll(() => seedGov());
afterAll(() => pool.end());
beforeEach(async () => {
  await query("delete from crm_leads where organization_id=$1 and title='lead-rodizio'", [org]);
  await query("delete from lead_routing_groups where organization_id=$1", [org]);
  await query("update user_organizations set revoked_at=null,role='agent' where organization_id=$1 and user_id=any($2)", [org, [ana, bruno]]);
});

describe("rodízio de leads por grupo", () => {
  it("reveza os membros na ordem e volta ao primeiro", async () => {
    await novoGrupo([[ana, 0], [bruno, 1]]);
    const owners = [(await novoLead()).owner, (await novoLead()).owner, (await novoLead()).owner];
    expect(owners).toEqual([ana, bruno, ana]);
  });

  it("o dono entra por UPDATE: cada lead roteado emite lead.assigned (é o que dá o push)", async () => {
    await novoGrupo([[ana, 0], [bruno, 1]]);
    const a = await novoLead();
    const b = await novoLead();
    const ev = await query(
      "select (payload->>'lead_id')::uuid lead_id, payload->>'to_user_id' to_user from event_log where organization_id=$1 and event_type='lead.assigned' and (payload->>'lead_id')::uuid = any($2)",
      [org, [a.id, b.id]],
    );
    expect(ev.rows).toHaveLength(2);
    expect(ev.rows.find((r) => r.lead_id === a.id)?.to_user).toBe(ana);
    expect(ev.rows.find((r) => r.lead_id === b.id)?.to_user).toBe(bruno);
    const row = await query("select owner_kind, assigned_at from crm_leads where id=$1", [a.id]);
    expect(row.rows[0].owner_kind).toBe("user");
    expect(row.rows[0].assigned_at).not.toBeNull();
  });

  it("membro pausado no grupo é pulado, sem sair dele", async () => {
    const g = await novoGrupo([[ana, 0], [bruno, 1]]);
    await query("update lead_routing_group_members set active=false where group_id=$1 and user_id=$2", [g, bruno]);
    expect([(await novoLead()).owner, (await novoLead()).owner]).toEqual([ana, ana]);
    await query("update lead_routing_group_members set active=true where group_id=$1 and user_id=$2", [g, bruno]);
    expect((await novoLead()).owner).toBe(bruno);
  });

  it("membro revogado da organização não recebe lead", async () => {
    await novoGrupo([[ana, 0], [bruno, 1]]);
    await query("update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2", [org, bruno]);
    expect([(await novoLead()).owner, (await novoLead()).owner]).toEqual([ana, ana]);
  });

  it("papel viewer não recebe lead mesmo estando no grupo", async () => {
    await novoGrupo([[viewer, 0], [ana, 1]]);
    expect((await novoLead()).owner).toBe(ana);
  });

  it("remover o último da fila não perde o ponteiro (a posição mora no log)", async () => {
    const g = await novoGrupo([[ana, 0], [bruno, 1], [manager, 2]]);
    await novoLead(); // ana
    await novoLead(); // bruno
    await query("delete from lead_routing_group_members where group_id=$1 and user_id=$2", [g, bruno]);
    expect((await novoLead()).owner).toBe(manager); // posição 2 > 1, e não recomeça em ana
  });

  it("origem sem regra: lead nasce sem dono", async () => {
    await novoGrupo([[ana, 0]]);
    expect((await novoLead({ webhook_source_id: "outra-origem" })).owner).toBeNull();
  });

  it("lead que já nasce com dono não é tocado e não entra no log", async () => {
    await novoGrupo([[ana, 0], [bruno, 1]]);
    const l = await novoLead({ webhook_source_id: SOURCE }, bruno);
    expect(l.owner).toBe(bruno);
    const log = await query("select count(*)::int n from lead_routing_assignments where lead_id=$1", [l.id]);
    expect(log.rows[0].n).toBe(0);
  });

  it("grupo sem ninguém elegível não derruba a captação", async () => {
    const g = await novoGrupo([[ana, 0]]);
    await query("update lead_routing_group_members set active=false where group_id=$1", [g]);
    const l = await novoLead();
    expect(l.owner).toBeNull();
  });

  it("regra por utm_campaign e por pipeline também casam; prioridade menor ganha", async () => {
    const g = await novoGrupo([[ana, 0]], "camp-x", "utm_campaign");
    expect((await novoLead({ utm_campaign: "camp-x" })).owner).toBe(ana);
    await query("insert into lead_routing_rules(organization_id,group_id,match_type,match_value,priority) values($1,$2,'pipeline',$3,10)", [org, g, pipeline]);
    expect((await novoLead({})).owner).toBe(ana);
  });

  it("grupo escopado a um funil só atende lead daquele funil", async () => {
    const g = await novoGrupo([[ana, 0]]);
    await query("update lead_routing_groups set pipeline_id=$1 where id=$2", [pipeline, g]);
    expect((await novoLead()).owner).toBe(ana);
    const outro = await query("insert into crm_pipelines(organization_id,name,slug) values($1,'outro funil','outro-funil-rodizio') on conflict do nothing returning id", [org]);
    if (outro.rows[0]) {
      await query("update lead_routing_groups set pipeline_id=$1 where id=$2", [outro.rows[0].id, g]);
      expect((await novoLead()).owner).toBeNull();
    }
  });

  it("leads simultâneos se repartem sem repetir o mesmo membro (lock por grupo)", async () => {
    await novoGrupo([[ana, 0], [bruno, 1]]);
    const owners = (await Promise.all([novoLead(), novoLead(), novoLead(), novoLead()])).map((l) => l.owner);
    expect(owners.filter((o) => o === ana)).toHaveLength(2);
    expect(owners.filter((o) => o === bruno)).toHaveLength(2);
  });

  it("falha do rodízio nunca derruba o INSERT do lead", async () => {
    await novoGrupo([[ana, 0]]);
    await query("alter table lead_routing_assignments rename to lead_routing_assignments_off");
    try {
      const l = await novoLead();
      expect(l.id).toBeTruthy();
      expect(l.owner).toBeNull();
    } finally {
      await query("alter table lead_routing_assignments_off rename to lead_routing_assignments");
    }
  });
});

describe("isolamento e permissões", () => {
  it("manager cria grupo; agent não; quem é de fora não enxerga", async () => {
    const ok = await asUser(manager, "insert into lead_routing_groups(organization_id,name) values($1,'do manager') returning id", [org]);
    expect(ok.rows).toHaveLength(1);
    await expect(asUser(ana, "insert into lead_routing_groups(organization_id,name) values($1,'do agent')", [org])).rejects.toThrow();
    const fora = await asUser("cccccccc-1111-4000-8000-0000000000ff", "select count(*)::int n from lead_routing_groups");
    expect(fora.rows[0].n).toBe(0);
    const dentro = await asUser(ana, "select count(*)::int n from lead_routing_groups");
    expect(dentro.rows[0].n).toBeGreaterThan(0);
  });

  it("o histórico não é gravável por REST, nem por manager", async () => {
    const g = await novoGrupo([[ana, 0]]);
    const l = await novoLead();
    await expect(
      asUser(manager, "insert into lead_routing_assignments(organization_id,group_id,lead_id,user_id,member_position) values($1,$2,$3,$4,0)", [org, g, l.id, ana]),
    ).rejects.toThrow();
  });

  it("membro não pode apontar para grupo de outra organização (FK composta)", async () => {
    await query("insert into organizations(id,slug,legal_name,display_name) values($1,'outra-org-rodizio','Outra','Outra') on conflict do nothing", [OTHER_ORG]);
    const g = await novoGrupo([[ana, 0]]);
    await expect(
      query("insert into lead_routing_group_members(organization_id,group_id,user_id,position) values($1,$2,$3,0)", [OTHER_ORG, g, bruno]),
    ).rejects.toThrow();
  });

  it("anon não alcança as tabelas novas", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role anon");
      await expect(c.query("select 1 from lead_routing_groups limit 1")).rejects.toThrow();
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
