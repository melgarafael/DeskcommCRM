import { randomUUID } from "node:crypto";
import type pg from "pg";
import { GOV_AGENT_A, GOV_AGENT_B, GOV_VIEWER } from "../invariants/gov-helpers";
import { criarOrigemDeFollowup } from "../invariants/followup-service-origin";
export async function replyFixture(pool: pg.Pool) {
  const org = randomUUID(),
    contact = randomUUID(),
    agent = randomUUID(),
    version = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Replies','Replies')",
    [org],
  );
  for (const [user, role] of [
    [GOV_AGENT_A, "agent"],
    [GOV_AGENT_B, "agent"],
    [GOV_VIEWER, "viewer"],
  ])
    await pool.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,$3,now())",
      [org, user, role],
    );
  await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Contato')", [
    contact,
    org,
  ]);
  const boundary = await criarOrigemDeFollowup(pool, org, contact),
    conversation = boundary.conversation_id;
  await pool.query(
    "update conversations set assigned_to_user_id=$1 where organization_id=$2 and id=$3",
    [GOV_AGENT_A, org, conversation],
  );
  const channel = (
    await pool.query(
      "select channel_session_id from conversations where organization_id=$1 and id=$2",
      [org, conversation],
    )
  ).rows[0].channel_session_id;
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt,operation_mode) values($1,$2,'Assistente','Ajude com informações confirmadas.','assisted')",
    [agent, org],
  );
  await pool.query(
    "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status) values($1,$2,$3,1,'Ajude com informações confirmadas.','anthropic','test-model',$4,'published')",
    [version, org, agent, channel],
  );
  await pool.query(
    "update ai_agents set published_version_id=$1 where organization_id=$2 and id=$3",
    [version, org, agent],
  );
  return { org, contact, agent, version, conversation, channel, boundary };
}
