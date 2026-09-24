import { z } from "zod";

import { CAMPAIGN_MIN_INTERVAL_FLOOR_SEC } from "@/lib/whatsapp-campaigns/pacing";

export const replyStopModeSchema = z.enum(["none", "person", "company"]);

export const campaignCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional().nullable(),
    message_text: z.string().trim().min(1).max(4000),
    /** Legado / primário — se channel_session_ids vier, usa o primeiro. */
    channel_session_id: z.string().uuid().optional(),
    channel_session_ids: z.array(z.string().uuid()).min(1).max(20).optional(),
    reply_stop_mode: replyStopModeSchema.default("person"),
    create_lead_on_reply: z.boolean().default(false),
    min_interval_seconds: z.number().int().min(CAMPAIGN_MIN_INTERVAL_FLOOR_SEC).max(3600).default(20),
    max_interval_seconds: z.number().int().min(CAMPAIGN_MIN_INTERVAL_FLOOR_SEC).max(7200).default(45),
    send_window_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
    send_window_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
    timezone: z.string().min(1).max(64).default("America/Sao_Paulo"),
    daily_limit: z.number().int().positive().optional().nullable(),
    scheduled_at: z.string().datetime().optional().nullable(),
  })
  .refine((v) => v.max_interval_seconds >= v.min_interval_seconds, {
    message: "max_interval_seconds deve ser >= min_interval_seconds",
  })
  .refine(
    (v) =>
      Boolean(v.channel_session_id) ||
      (Array.isArray(v.channel_session_ids) && v.channel_session_ids.length > 0),
    { message: "Informe ao menos uma conexão WhatsApp" },
  );

export const campaignPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional().nullable(),
    message_text: z.string().trim().min(1).max(4000).optional(),
    channel_session_id: z.string().uuid().optional(),
    channel_session_ids: z.array(z.string().uuid()).min(1).max(20).optional(),
    reply_stop_mode: replyStopModeSchema.optional(),
    create_lead_on_reply: z.boolean().optional(),
    min_interval_seconds: z.number().int().min(CAMPAIGN_MIN_INTERVAL_FLOOR_SEC).max(3600).optional(),
    max_interval_seconds: z.number().int().min(CAMPAIGN_MIN_INTERVAL_FLOOR_SEC).max(7200).optional(),
    send_window_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
    send_window_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
    timezone: z.string().min(1).max(64).optional(),
    daily_limit: z.number().int().positive().optional().nullable(),
    scheduled_at: z.string().datetime().optional().nullable(),
  })
  .refine(
    (v) =>
      v.max_interval_seconds === undefined ||
      v.min_interval_seconds === undefined ||
      v.max_interval_seconds >= v.min_interval_seconds,
    { message: "max_interval_seconds deve ser >= min_interval_seconds" },
  );

export const audienceSelectionSchema = z.object({
  contact_ids: z.array(z.string().uuid()).max(5000).optional(),
  person_ids: z.array(z.string().uuid()).max(2000).optional(),
  company_ids: z.array(z.string().uuid()).max(2000).optional(),
  import_batch_id: z.string().uuid().optional(),
});

export type CampaignCreate = z.infer<typeof campaignCreateSchema>;
export type AudienceSelectionInput = z.infer<typeof audienceSelectionSchema>;

export function resolveSessionIds(input: {
  channel_session_id?: string | null;
  channel_session_ids?: string[] | null;
}): string[] {
  const fromArr = input.channel_session_ids?.filter(Boolean) ?? [];
  if (fromArr.length > 0) return [...new Set(fromArr)];
  if (input.channel_session_id) return [input.channel_session_id];
  return [];
}
