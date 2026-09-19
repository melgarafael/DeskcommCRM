import type pg from "pg";
import { audit } from "@/lib/audit";
import { AgentSetupError, setupAgentId, setupProposalHash } from "./agent-setup";
import {
  agentProposalSchema,
  type AgentChatInput,
  type AgentChatResponse,
} from "./agent-chat-schema";
import {
  agentSetupSessionSchema,
  agentSessionLock,
  type AgentSetupSession,
  type AgentSessionResponse,
  type AgentSessionWrite,
} from "./agent-session-schema";

type Actor = { orgId: string; userId: string; requestId: string };
type SessionRow = {
  name: string;
  agent_setup: unknown;
  agent_setup_revision: string | number;
  status: string;
  search_status: string;
  config: unknown;
};
type Database = Pick<pg.Pool, "query">;

async function sessionRow(db: Database, orgId: string, campaignId: string) {
  const result = await db.query<SessionRow>(
    "select name,agent_setup,agent_setup_revision,status,search_status,config from prospecting_campaigns where organization_id=$1 and id=$2",
    [orgId, campaignId],
  );
  if (!result.rows[0]) throw new AgentSetupError("Campanha não encontrada.", 404);
  return result.rows[0];
}

function decodeSession(row: SessionRow): AgentSessionResponse {
  const empty = !row.agent_setup || Object.keys(row.agent_setup).length === 0;
  const session = agentSetupSessionSchema.parse(
    empty
      ? {
          messages: [],
          draft: { name: row.name.slice(0, 120), tone: "cordial" },
        }
      : row.agent_setup,
  );
  return { revision: Number(row.agent_setup_revision), session };
}

/** Resolve saved attempt from canonical agent state, including a lost HTTP response. */
export async function getAgentSession(
  pool: Database,
  orgId: string,
  campaignId: string,
): Promise<AgentSessionResponse> {
  const result = decodeSession(await sessionRow(pool, orgId, campaignId));
  const attempt = result.session.attempt;
  if (!attempt) return result;
  const agentId = setupAgentId(orgId, campaignId, attempt.request_id);
  const { rows } = await pool.query(
    "select id,name,config,published_version_id,paused_at,archived_at from ai_agents where organization_id=$1 and id=$2",
    [orgId, agentId],
  );
  const agent = rows[0],
    metadata = agent?.config?.prospecting_setup;
  if (!agent || agent.archived_at || metadata?.proposal_hash !== setupProposalHash(attempt))
    return result;
  const prepared = {
    agent: { id: agent.id, name: agent.name },
    version_id: metadata.version_id,
    model_label: metadata.model_label,
  };
  if (
    metadata.state === "ready" &&
    agent.published_version_id === metadata.version_id &&
    !agent.paused_at
  ) {
    result.session.completed = prepared;
    result.session.uncertain = false;
  } else if (metadata.state === "draft" && !agent.published_version_id && agent.paused_at) {
    result.session.prepared = prepared;
    // A publication may still be in flight after its paused draft was committed.
    // Observing that draft does not prove that the publication has stopped.
    if (result.session.attempt_action !== "publish") result.session.uncertain = false;
  }
  return result;
}

/** A campaign lock also serializes edits with its explicit preparation/publication. */
export async function mutateAgentSession(
  pool: pg.Pool,
  actor: Actor,
  campaignId: string,
  revision: number,
  change: (current: AgentSetupSession) => AgentSetupSession,
): Promise<AgentSessionResponse> {
  const db = await pool.connect();
  let result: AgentSessionResponse;
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      agentSessionLock(actor.orgId, campaignId),
    ]);
    const row = await sessionRow(db, actor.orgId, campaignId);
    const current = decodeSession(row);
    if (current.revision !== revision)
      throw new AgentSetupError(
        "A configuração mudou em outra janela. Recarregue a conversa para continuar.",
        409,
      );
    if (row.status !== "draft" || row.config || row.search_status !== "succeeded")
      throw new AgentSetupError(
        "A preparação desta campanha já começou ou a busca ainda não terminou.",
        409,
      );
    const next = agentSetupSessionSchema.parse(change(current.session));
    // These pointers are observations of canonical agent state, never browser input.
    delete next.prepared;
    delete next.completed;
    const updated = await db.query<{ agent_setup_revision: string }>(
      `update prospecting_campaigns set agent_setup=$4::jsonb,agent_setup_revision=agent_setup_revision+1,updated_at=now()
       where organization_id=$1 and id=$2 and agent_setup_revision=$3 returning agent_setup_revision`,
      [actor.orgId, campaignId, revision, JSON.stringify(next)],
    );
    if (!updated.rows[0])
      throw new AgentSetupError("A configuração mudou. Recarregue a conversa.", 409);
    await db.query("commit");
    result = { revision: Number(updated.rows[0].agent_setup_revision), session: next };
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
  await audit({
    action: "prospecting.changed",
    actorUserId: actor.userId,
    organizationId: actor.orgId,
    resourceType: "prospecting_campaign",
    resourceId: campaignId,
    requestId: actor.requestId,
    metadata: { operation: "agent_setup_saved", revision: result.revision },
  });
  return result;
}

export async function saveAgentSession(
  pool: pg.Pool,
  actor: Actor,
  campaignId: string,
  revision: number,
  next: AgentSessionWrite,
) {
  return mutateAgentSession(pool, actor, campaignId, revision, (current) => {
    const sameDraft = JSON.stringify(current.draft) === JSON.stringify(next.draft);
    const sameChannel = current.draft.channel_session_id === next.draft.channel_session_id;
    return {
      ...next,
      ready: sameDraft && current.ready && agentProposalSchema.safeParse(next.draft).success,
      choices: sameDraft ? current.choices : [],
      model_label: current.model_label,
      needs_continuity: sameChannel && current.needs_continuity,
    };
  });
}

function recentTranscript(messages: AgentSetupSession["messages"]) {
  const bounded = messages.slice(-100);
  while (bounded.length > 1 && bounded.reduce((n, m) => n + m.content.length, 0) > 80000)
    bounded.shift();
  return bounded;
}

function mergeTranscript(
  history: AgentSetupSession["messages"],
  recent: AgentChatInput["messages"],
) {
  // The API carries only the model's recent window; retain older persisted turns.
  for (let overlap = Math.min(history.length, recent.length); overlap > 0; overlap--) {
    if (JSON.stringify(history.slice(-overlap)) === JSON.stringify(recent.slice(0, overlap)))
      return recentTranscript([...history, ...recent.slice(overlap)]);
  }
  return recentTranscript(history.length ? [...history, recent[recent.length - 1]!] : recent);
}

export async function beginAgentChat(pool: pg.Pool, actor: Actor, input: AgentChatInput) {
  return mutateAgentSession(pool, actor, input.campaign_id, input.revision!, (current) => ({
    ...current,
    messages: mergeTranscript(current.messages, input.messages),
    draft: input.draft ?? current.draft,
    input: input.messages.at(-1)!.content,
    ready: false,
    choices: [],
    attempt: undefined,
    attempt_action: undefined,
    uncertain: false,
    enable_router_continuity: false,
  }));
}

export async function finishAgentChat(
  pool: pg.Pool,
  actor: Actor,
  campaignId: string,
  revision: number,
  response: AgentChatResponse,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return mutateAgentSession(pool, actor, campaignId, revision, (current) => {
    signal?.throwIfAborted();
    return {
      ...current,
      messages: recentTranscript([
        ...current.messages,
        { role: "assistant", content: response.message },
      ]),
      draft: response.draft,
      input: "",
      ready: response.ready,
      choices: response.choices,
      model_label: response.model_label,
      needs_continuity: response.needs_continuity,
      enable_router_continuity: false,
    };
  });
}
