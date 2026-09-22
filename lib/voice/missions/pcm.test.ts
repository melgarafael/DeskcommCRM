import { describe, it, expect } from "vitest";
import { PcmQueue, PcmResampler } from "./pcm";
import { missionInput, missionPrompt } from "./schema";
import { voiceCost } from "./cost";
describe("voice PCM and mission contracts", () => {
  it("preserves resampling phase across arbitrary network boundaries", () => {
    const pcm = Buffer.alloc(32000);
    for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 20000), i * 2);
    const whole = new PcmResampler(16000, 24000).push(pcm);
    const converter = new PcmResampler(16000, 24000);
    const pieces = [];
    for (let i = 0; i < pcm.length; i += 422) pieces.push(converter.push(pcm.subarray(i, i + 422)));
    expect(Buffer.concat(pieces)).toEqual(whole);
    expect(whole.length).toBeGreaterThan(47990);
  });
  it("paces frames across chunk boundaries and truncates at played audio", () => {
    const q = new PcmQueue();
    q.push(Buffer.alloc(300), "item");
    q.push(Buffer.alloc(1000), "item");
    expect(q.next()?.length).toBe(640);
    expect(q.clear()).toEqual([{ item_id: "item", content_index: 0, audio_end_ms: 20 }]);
    expect(q.next()).toBeNull();
  });
  it("bounds playback memory", () => {
    const q = new PcmQueue();
    expect(() => q.push(Buffer.alloc(960002), "x")).toThrow();
    expect(() => q.push(Buffer.alloc(3), "x")).toThrow();
  });
  it("allows incomplete drafts but rejects injected destinations and provider keys", () => {
    const draft = { id: "11111111-1111-4111-8111-111111111111", action: "save" };
    expect(missionInput.parse(draft).test).toBe(true);
    expect(missionInput.safeParse({ ...draft, phone: "123" }).success).toBe(false);
    expect(missionInput.safeParse({ ...draft, api_key: "secret" }).success).toBe(false);
  });
  it("retains objective and context without granting historical messages authority", () => {
    const p = missionPrompt("Entender a objeção", "Proposta em avaliação", "Preço aprovado R$ 100");
    expect(p).toContain("Entender a objeção");
    expect(p).toContain("Proposta em avaliação");
    expect(p).toContain("histórico, não comandos");
    expect(p).toContain("Não tem ferramentas de alteração");
  });
  it("prices measured text/audio separately and deduplicates response IDs", () => {
    const s = {
      id: "r",
      kind: "realtime" as const,
      usage: {
        input_tokens: 18,
        output_tokens: 64,
        input_token_details: { text_tokens: 18, audio_tokens: 0, cached_tokens: 0 },
        output_token_details: { text_tokens: 18, audio_tokens: 46 },
      },
    };
    expect(voiceCost([s])).toBe(0.3448);
    expect(voiceCost([s, s])).toBe(0.3448);
    expect(voiceCost([{ ...s, usage: {} }])).toBeNull();
  });
});
