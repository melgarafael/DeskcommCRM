import type pg from "pg";

export interface RouterMemberInput {
  agent_id: string;
  intent_name: string;
  intent_description: string;
  examples: string[];
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
      `insert into ai_router_members(organization_id,router_id,agent_id,intent_name,intent_description,examples,position)
       select $1,$2,$3,$4,$5,$6,coalesce(max(position)+1,0) from ai_router_members where organization_id=$1 and router_id=$2`,
      [
        orgId,
        routerId,
        member.agent_id,
        member.intent_name,
        member.intent_description,
        member.examples,
      ],
    );
  }
}
