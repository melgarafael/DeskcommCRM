import { z } from "zod";

export const prospectingAgentSetupSchema = z
  .object({
    request_id: z.string().uuid(),
    campaign_id: z.string().uuid(),
    name: z.string().trim().min(2).max(120),
    tone: z.enum(["cordial", "professional", "direct"]),
    enable_router_continuity: z.boolean().default(false),
    instruction: z.string().trim().min(10).max(2000),
    qualification: z.string().trim().min(10).max(2000),
    channel_session_id: z.string().uuid(),
    pipeline_id: z.string().uuid(),
    stage_id: z.string().uuid(),
    qualified_stage_id: z.string().uuid(),
  })
  .strict();
export type ProspectingAgentSetupInput = z.infer<typeof prospectingAgentSetupSchema>;
