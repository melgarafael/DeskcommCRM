import { z } from "zod";

export const voiceSettingsSchema = z
  .object({
    voice_id: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]{8,100}$/),
    language: z.enum(["pt", "en", "es"]),
    first_message: z.string().trim().min(5).max(1000),
    system_prompt: z.string().trim().min(20).max(15000),
    max_duration_seconds: z.number().int().min(60).max(600),
  })
  .strict();
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

export const voiceActionSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("credential"), api_key: z.string().trim().min(10).max(500) })
    .strict(),
  z.object({ action: z.literal("configure"), settings: voiceSettingsSchema }).strict(),
  z.object({ action: z.literal("test") }).strict(),
]);
export type VoiceAction = z.infer<typeof voiceActionSchema>;

export const voiceStateSchema = z.object({
  marker: z.string().regex(/^crm-voice-[a-f0-9-]{36}$/),
  remote_agent_id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{8,100}$/)
    .nullable(),
  status: z.enum(["creating", "syncing", "ready", "rejected"]),
  settings: voiceSettingsSchema,
  updated_at: z.string(),
});
export type VoiceState = z.infer<typeof voiceStateSchema>;
export interface VoiceOption {
  id: string;
  name: string;
}
export interface VoicePanelData {
  provider_label: string;
  credential_configured: boolean;
  settings: VoiceSettings;
  configured: boolean;
  status: VoiceState["status"] | null;
  voices: VoiceOption[];
  voices_error: string | null;
}

export class VoiceAssistantError extends Error {
  constructor(
    message: string,
    public readonly status = 422,
  ) {
    super(message);
    this.name = "VoiceAssistantError";
  }
}
