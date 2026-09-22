import { z } from "zod";
const n = z.number().int().nonnegative();
const realtime = z.object({
  input_tokens: n,
  output_tokens: n,
  input_token_details: z.object({
    text_tokens: n,
    audio_tokens: n,
    cached_tokens: n,
    cached_tokens_details: z.object({ text_tokens: n, audio_tokens: n }).optional(),
  }),
  output_token_details: z.object({ text_tokens: n, audio_tokens: n }),
});
const transcription = z.object({ input_tokens: n, output_tokens: n });
export type VoiceUsage = {
  id: string;
  kind: "realtime" | "transcription";
  usage: Record<string, unknown>;
};
/** USD cents. Never turn missing modality measurements into a zero charge. */
export function voiceCost(steps: VoiceUsage[]): number | null {
  if (!steps.length) return null;
  let cents = 0;
  const seen = new Set<string>();
  for (const s of steps) {
    const key = s.kind + ":" + s.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.kind === "transcription") {
      const p = transcription.safeParse(s.usage);
      if (!p.success) return null;
      cents += (p.data.input_tokens * 1.25 + p.data.output_tokens * 5) / 10000;
      continue;
    }
    const p = realtime.safeParse(s.usage);
    if (!p.success) return null;
    const i = p.data.input_token_details,
      o = p.data.output_token_details,
      c = i.cached_tokens_details;
    if (
      i.text_tokens + i.audio_tokens !== p.data.input_tokens ||
      o.text_tokens + o.audio_tokens !== p.data.output_tokens
    )
      return null;
    if (i.cached_tokens && !c) return null;
    const ct = c?.text_tokens ?? 0,
      ca = c?.audio_tokens ?? 0;
    if (ct + ca !== i.cached_tokens || ct > i.text_tokens || ca > i.audio_tokens) return null;
    cents +=
      ((i.text_tokens - ct) * 4 +
        (i.audio_tokens - ca) * 32 +
        (ct + ca) * 0.4 +
        o.text_tokens * 24 +
        o.audio_tokens * 64) /
      10000;
  }
  return Math.ceil(cents * 10000) / 10000;
}
