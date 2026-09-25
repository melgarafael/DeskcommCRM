import type pg from "pg";

export interface RouterMemberInput {
  agent_id: string;
  intent_name: string;
  intent_description: string;
  examples: string[];
  /** Roteiro de atendimento que a intenção começa (surface `atendimento`, mesma empresa). */
  flow_pointer_id?: string | null;
}

/**
 * Os roteiros que as intenções apontam, distintos. A FK composta (0394) já
 * impede fluxo de outra empresa; a superfície só se confere aqui — um
 * follow-up comum amarrado à intenção nunca começaria.
 */
export function roteirosApontados(members: readonly RouterMemberInput[]): string[] {
  return [...new Set(members.flatMap((m) => (m.flow_pointer_id ? [m.flow_pointer_id] : [])))];
}

/** Both additive setup and full editor replacement take this same row lock. Caller owns transaction. */
export async function lockRouter(db: pg.PoolClient, orgId: string, routerId: string) {
  const { rows } = await db.query(
    "select id,config,is_active,channel_session_id from ai_routers where organization_id=$1 and id=$2 for update",
    [orgId, routerId],
  );
  if (!rows[0]) throw new Error("router_not_found");
  return rows[0];
}

export async function writeRouterMembers(
  db: pg.PoolClient,
  orgId: string,
  routerId: string,
  members: RouterMemberInput[],
  mode: "append" | "replace",
) {
  await lockRouter(db, orgId, routerId);
  const ids = [...new Set(members.map((m) => m.agent_id))];
  const agents = await db.query(
    "select id from ai_agents where organization_id=$1 and id=any($2::uuid[]) and archived_at is null",
    [orgId, ids],
  );
  if (agents.rows.length !== ids.length) throw new Error("member_agent_not_found");
  if (new Set(members.map((m) => m.intent_name)).size !== members.length)
    throw new Error("duplicate_intent_name");
  const roteiros = roteirosApontados(members);
  if (roteiros.length > 0) {
    const achados = await db.query(
      "select id from followup_flow_pointers where organization_id=$1 and id=any($2::uuid[]) and surface='atendimento'",
      [orgId, roteiros],
    );
    if (achados.rows.length !== roteiros.length) throw new Error("member_flow_not_found");
  }
  if (mode === "replace")
    await db.query("delete from ai_router_members where organization_id=$1 and router_id=$2", [
      orgId,
      routerId,
    ]);
  for (const member of members) {
    if (mode === "append") {
      const existing = await db.query(
        "select id from ai_router_members where organization_id=$1 and router_id=$2 and agent_id=$3",
        [orgId, routerId, member.agent_id],
      );
      if (existing.rows.length) continue;
    }
    await db.query(
      `insert into ai_router_members(organization_id,router_id,agent_id,intent_name,intent_description,examples,flow_pointer_id,position)
       select $1,$2,$3,$4,$5,$6,$7,coalesce(max(position)+1,0) from ai_router_members where organization_id=$1 and router_id=$2`,
      [
        orgId,
        routerId,
        member.agent_id,
        member.intent_name,
        member.intent_description,
        member.examples,
        member.flow_pointer_id ?? null,
      ],
    );
  }
}
