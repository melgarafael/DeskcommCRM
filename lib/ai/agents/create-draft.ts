import { randomUUID } from "node:crypto";
import type pg from "pg";
import { agentMcpCreateSchema, type VersionInput } from "./validation";

/** One record recipe for the REST/Supabase adapter and transactional setup. */
export function mcpAgentDraftRecords(
  context: { orgId: string; userId: string },
  raw: unknown,
  ids: { agentId?: string; versionId?: string } = {},
) {
  const input = agentMcpCreateSchema.parse(raw);
  const agentId = ids.agentId ?? randomUUID();
  const versionId = ids.versionId ?? randomUUID();
  return {
    agent: {
      id: agentId,
      organization_id: context.orgId,
      name: input.name,
      description: input.description ?? null,
      model: `${input.version.provider}/${input.version.model}`,
      system_prompt: input.version.system_prompt,
      kind: "mcp_agent" as const,
      priority: input.priority,
      is_active: true,
      is_default: false,
      created_by: context.userId,
    },
    version: {
      ...input.version,
      id: versionId,
      organization_id: context.orgId,
      agent_id: agentId,
      version_number: 1,
      status: "draft" as const,
      created_by: context.userId,
    },
  };
}

/** Canonical MCP creation, within the caller's transaction. No publication or routing. */
export async function createMcpAgentDraft(
  db: pg.PoolClient,
  context: { orgId: string; userId: string },
  raw: unknown,
  options: {
    agentId?: string;
    versionId?: string;
    pausedAt?: Date;
    config?: Record<string, unknown>;
  } = {},
) {
  const input = agentMcpCreateSchema.parse(raw);
  const v = input.version;
  const records = mcpAgentDraftRecords(context, input, options);
  const pipelines = await db.query(
    "select id from crm_pipelines where organization_id=$1 and id=any($2::uuid[]) and not is_archived",
    [context.orgId, v.pipeline_ids],
  );
  if (new Set(pipelines.rows.map((r) => r.id)).size !== new Set(v.pipeline_ids).size)
    throw new Error("pipeline_scope_invalid");
  const sources = await db.query(
    "select id from ai_knowledge_sources where organization_id=$1 and id=any($2::uuid[]) and is_active",
    [context.orgId, v.knowledge_source_ids],
  );
  if (new Set(sources.rows.map((r) => r.id)).size !== new Set(v.knowledge_source_ids).size)
    throw new Error("knowledge_scope_invalid");
  const agentId = records.agent.id;
  const versionId = records.version.id;
  const { rows: agents } = await db.query(
    `insert into ai_agents(id,organization_id,name,description,model,system_prompt,kind,priority,is_active,is_default,created_by,paused_at)
     values($1,$2,$3,$4,$5,$6,'mcp_agent',$7,true,false,$8,$9) returning *`,
    [
      agentId,
      context.orgId,
      records.agent.name,
      records.agent.description,
      records.agent.model,
      records.agent.system_prompt,
      records.agent.priority,
      context.userId,
      options.pausedAt ?? null,
    ],
  );
  // Preserve the database's normal agent defaults; setup metadata is additive.
  let agent = agents[0];
  if (options.config) {
    const updated = await db.query(
      "update ai_agents set config=config || $3::jsonb where organization_id=$1 and id=$2 returning *",
      [context.orgId, agentId, JSON.stringify(options.config)],
    );
    agent = updated.rows[0];
  }
  // Keys come only from the strict canonical schema, never from raw user input.
  const entries = Object.entries(v).filter(([, value]) => value !== undefined) as [
    keyof VersionInput,
    unknown,
  ][];
  const columns = entries.map(([key]) => key);
  const values = entries.map(([key, value]) =>
    ["followup", "trigger_config"].includes(key) ? JSON.stringify(value) : value,
  );
  const { rows: versions } = await db.query(
    `insert into ai_agent_versions(id,organization_id,agent_id,version_number,status,created_by,${columns.join(",")})
     values($1,$2,$3,1,'draft',$4,${entries.map((_, i) => `$${i + 5}`).join(",")}) returning *`,
    [versionId, context.orgId, agentId, context.userId, ...values],
  );
  return { agent, version: versions[0] };
}
