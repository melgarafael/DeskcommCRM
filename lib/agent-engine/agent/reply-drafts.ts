import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { loadConversationAgentConfig, type PublishedAgentConfig } from "./agent-config";
import { getLeadContext } from "../edge/crm/get-lead-context";
import { fusoDaOrganizacao } from "./fuso-da-org";
import { latestCheckpoint, runAgentPreview, type InboundTurnDeps } from "./inbound-turn";
import { newPreviewResult } from "./preview";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { parseServiceBoundary, assertCurrentServiceBoundary } from "@/lib/atendimento/fronteira";
import {
  readCurrentServiceBoundary,
  withServiceBoundary,
} from "@/lib/atendimento/fronteira-server";

export const replyDraftSchema = z
  .object({
    id: z.uuid(),
    status: z.string(),
    revision: z.coerce.string(),
    generation_token: z.uuid(),
    original_body: z.string().nullable(),
    agent_version_id: z.uuid(),
    service_boundary: z.unknown(),
  })
  .passthrough();
export type ReplyDraft = z.infer<typeof replyDraftSchema>;
export async function generateReplyDraft(
  pool: pg.Pool,
  deps: InboundTurnDeps,
  input: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelId: string;
    boundary?: ServiceBoundary;
    agent?: PublishedAgentConfig;
  },
) {
  const agent =
    input.agent ??
    (await loadConversationAgentConfig(
      pool,
      input.organizationId,
      input.conversationId,
      input.channelId,
    ));
  if (!agent) throw new Error("reply_no_agent");
  const observed = await readCurrentServiceBoundary(
    pool,
    input.organizationId,
    input.conversationId,
  );
  const boundary = input.boundary ?? parseServiceBoundary(observed);
  assertCurrentServiceBoundary(boundary, observed);
  return withServiceBoundary(pool, boundary, async () => {
    const token = randomUUID();
    const { rows } = await pool.query("select * from fn_reply_begin($1,$2,$3,$4,$5)", [
      input.organizationId,
      input.conversationId,
      agent.agentId,
      agent.versionId,
      token,
    ]);
    const draft = replyDraftSchema.parse(rows[0]);
    assertCurrentServiceBoundary(parseServiceBoundary(draft.service_boundary), observed);
    if (draft.generation_token !== token || draft.status !== "generating") return draft;
    try {
      const context = await getLeadContext(
        pool,
        deps.crmCfg,
        {
          tenantId: input.organizationId,
          leadId: input.contactId,
          conversationId: input.conversationId,
          fuso: await fusoDaOrganizacao(pool, input.organizationId),
        },
        { historyLimit: agent.historyMessageWindow, maxTokens: agent.historyTokenWindow },
      );
      if (!context.ok || context.context.contact.is_blocked || context.lgpd.isAnonymized)
        throw new Error("reply_context_unavailable");
      const { rows: notes } = await pool.query<{ headline: string; body: string }>(
        "select headline,body from lead_notes where organization_id=$1 and contact_id=$2",
        [input.organizationId, input.contactId],
      );
      const { rows: feedback } = await pool.query<{ feedback: unknown }>(
        "select feedback from ai_reply_drafts where organization_id=$1 and conversation_id=$2 and service_boundary=$3 and feedback is not null order by updated_at desc limit 3",
        [input.organizationId, input.conversationId, boundary],
      );
      const result = newPreviewResult();
      await runAgentPreview(deps, pool, {
        kind: "assisted",
        organizationId: input.organizationId,
        runId: draft.id,
        agent,
        context,
        previous: await latestCheckpoint(pool, input.organizationId, input.contactId),
        notes,
        feedback: JSON.stringify(feedback.map((r) => r.feedback)),
        contactId: input.contactId,
        channelId: input.channelId,
        result,
      });
      const body = result.candidates.map((c) => c.body).join("\n\n");
      const { rows: finished } = await pool.query(
        `update ai_reply_drafts set status=case when not fn_reply_context_current($1,id) then 'stale' when $4='' then 'failed' else 'pending' end,
 original_body=$4,edited_body=$4,proposals=$5,trace=$6,error_code=$7,updated_at=now()
 where organization_id=$1 and id=$2 and generation_token=$3 and status='generating' returning *`,
        [
          input.organizationId,
          draft.id,
          token,
          body,
          JSON.stringify(result.proposals),
          JSON.stringify(result.candidates.flatMap((c) => c.trace)),
          result.impediments[0]?.code ?? null,
        ],
      );
      return replyDraftSchema.parse(finished[0] ?? draft);
    } catch (error) {
      await pool.query(
        "update ai_reply_drafts set status='failed',error_code='generation_failed',updated_at=now() where organization_id=$1 and id=$2 and generation_token=$3 and status='generating'",
        [input.organizationId, draft.id, token],
      );
      throw error;
    }
  });
}
