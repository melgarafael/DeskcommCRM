import { describe, expect, it } from "vitest";
import {
  agentSessionPatchSchema,
  agentSessionWriteSchema,
  agentSetupSessionSchema,
} from "@/lib/prospecting/agent-session-schema";

const campaign = "10000000-0000-4000-8000-000000000001";
const session = { messages: [], draft: {}, input: "" };

describe("durable agent setup input", () => {
  it("stores bounded plain text and rejects forged ready/completed flags", () => {
    expect(agentSessionWriteSchema.safeParse(session).success).toBe(true);
    expect(agentSessionWriteSchema.safeParse({ ...session, ready: true }).success).toBe(false);
    expect(agentSessionWriteSchema.safeParse({ ...session, completed: {} }).success).toBe(false);
    expect(agentSessionWriteSchema.safeParse({ ...session, input: "x".repeat(3001) }).success).toBe(
      false,
    );
    expect(
      agentSessionWriteSchema.safeParse({
        ...session,
        messages: Array.from({ length: 30 }, () => ({ role: "user", content: "x".repeat(3000) })),
      }).success,
    ).toBe(false);
    expect(agentSetupSessionSchema.parse(session)).toMatchObject({
      ready: false,
      uncertain: false,
      needs_continuity: false,
    });
  });
  it("rejects invalid revisions and server-owned tenant input", () => {
    expect(
      agentSessionPatchSchema.safeParse({ campaign_id: campaign, revision: 0, session }).success,
    ).toBe(true);
    expect(
      agentSessionPatchSchema.safeParse({ campaign_id: campaign, revision: -1, session }).success,
    ).toBe(false);
    expect(
      agentSessionPatchSchema.safeParse({
        campaign_id: campaign,
        revision: 0,
        organization_id: campaign,
        session,
      }).success,
    ).toBe(false);
  });
  it("persists the action so recovering preview cannot imply publication", () => {
    expect(
      agentSessionWriteSchema.parse({ ...session, attempt_action: "prepare" }).attempt_action,
    ).toBe("prepare");
    expect(
      agentSessionWriteSchema.parse({ ...session, attempt_action: "publish" }).attempt_action,
    ).toBe("publish");
    expect(
      agentSessionWriteSchema.safeParse({ ...session, attempt_action: "start_campaign" }).success,
    ).toBe(false);
  });
  it("requires a full proposal to match the saved attempt and its campaign", () => {
    const draft = {
      name: "Assistente",
      tone: "cordial",
      instruction: "Oferecer diagnóstico",
      qualification: "Confirmar interesse e necessidade",
      channel_session_id: campaign,
      pipeline_id: campaign,
      stage_id: campaign,
      qualified_stage_id: "10000000-0000-4000-8000-000000000002",
    };
    const attempt = {
      ...draft,
      request_id: campaign,
      campaign_id: campaign,
      enable_router_continuity: false,
    };
    const input = { campaign_id: campaign, revision: 0, session: { ...session, draft, attempt } };
    expect(agentSessionPatchSchema.safeParse(input).success).toBe(true);
    expect(
      agentSessionPatchSchema.safeParse({
        ...input,
        session: { ...input.session, draft: { ...draft, instruction: "Uma oferta diferente" } },
      }).success,
    ).toBe(false);
    expect(
      agentSessionPatchSchema.safeParse({ ...input, session: { ...input.session, draft: {} } })
        .success,
    ).toBe(false);
    expect(
      agentSessionPatchSchema.safeParse({ ...input, campaign_id: draft.qualified_stage_id })
        .success,
    ).toBe(false);
  });
});
