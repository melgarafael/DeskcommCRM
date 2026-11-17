/**
 * O formato de `voice_id`: separa id de texto colado errado, NUNCA decide se a
 * voz existe (um id fora do catálogo é o caso legítimo do #4260).
 */
import { describe, expect, it } from "vitest";

import { normalizarVoiceId, problemaNoVoiceId } from "./voice-id";

describe("problemaNoVoiceId", () => {
  it("aceita ids da ElevenLabs e ids próprios do cliente, inclusive fora do catálogo", () => {
    expect(problemaNoVoiceId("21m00Tcm4TlvDq8ikWAM")).toBeNull();
    expect(problemaNoVoiceId("vozPropriaDoCliente123")).toBeNull();
    expect(problemaNoVoiceId("voz-com_hifen-123")).toBeNull();
    expect(problemaNoVoiceId("  EXAVITQu4vr4xnSDxMaL  ")).toBeNull();
  });

  it("recusa vazio, curto demais e texto que não é um id", () => {
    expect(problemaNoVoiceId("")).toBe("vazio");
    expect(problemaNoVoiceId("   ")).toBe("vazio");
    expect(problemaNoVoiceId("abc123")).toBe("formato");
    expect(problemaNoVoiceId("minha voz")).toBe("formato");
    expect(problemaNoVoiceId("1234/5678")).toBe("formato");
  });

  it("normaliza só o espaço das pontas — nunca 'corrige' o id", () => {
    expect(normalizarVoiceId("  vozPropriaDoCliente123 ")).toBe("vozPropriaDoCliente123");
  });
});
