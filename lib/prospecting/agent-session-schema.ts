import { z } from "zod";
import { agentChatDraftSchema } from "./agent-chat-schema";
import { prospectingAgentSetupSchema } from "./agent-setup-schema";

export const agentSessionLock = (orgId: string, campaignId: string) =>
  `prospecting-agent-session:${orgId}:${campaignId}`;

export const agentSetupResultSchema = z
  .object({
    agent: z.object({ id: z.string().uuid(), name: z.string() }).strict(),
    version_id: z.string().uuid(),
    model_label: z.string(),
  })
  .strict();

export const agentSessionWriteSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().trim().min(1).max(3000),
          })
          .strict(),
      )
      .max(100),
    draft: agentChatDraftSchema,
    input: z.string().max(3000).default(""),
    enable_router_continuity: z.boolean().default(false),
    uncertain: z.boolean().default(false),
    attempt: prospectingAgentSetupSchema.optional(),
    attempt_action: z.enum(["prepare", "publish"]).optional(),
  })
  .strict()
  .refine(
    (s) => s.messages.reduce((total, message) => total + message.content.length, 0) <= 80000,
    "O histórico atingiu o limite. Continue a partir do resumo.",
  );

/** Configuration belongs to its campaign, never to customer conversations. */
export const agentSetupSessionSchema = agentSessionWriteSchema.safeExtend({
  ready: z.boolean().default(false),
  choices: z
    .array(z.object({ label: z.string().max(200), value: z.string().max(500) }).strict())
    .max(150)
    .default([]),
  model_label: z.string().max(200).default(""),
  needs_continuity: z.boolean().default(false),
  prepared: agentSetupResultSchema.optional(),
  completed: agentSetupResultSchema.optional(),
});

export const agentSessionPatchSchema = z
  .object({
    campaign_id: z.string().uuid(),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    session: agentSessionWriteSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    const attempt = input.session.attempt;
    if (!attempt) return;
    if (
      attempt.campaign_id !== input.campaign_id ||
      Object.entries(attempt).some(
        ([key, value]) =>
          !["request_id", "campaign_id", "enable_router_continuity"].includes(key) &&
          input.session.draft[key as keyof typeof input.session.draft] !== value,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "A tentativa deve corresponder ao resumo e à campanha.",
        path: ["session", "attempt"],
      });
  });

export type AgentSessionWrite = z.infer<typeof agentSessionWriteSchema>;
export type AgentSetupSession = z.infer<typeof agentSetupSessionSchema>;
export type AgentSessionResponse = { revision: number; session: AgentSetupSession };
export type AgentSetupResult = z.infer<typeof agentSetupResultSchema>;
