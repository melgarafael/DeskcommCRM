import { describe, expect, it } from "vitest";

import { __test_fitToBudget } from "@/lib/agent-engine/edge/crm/get-lead-context";

// fitToBudget é interno; exportar como __test_fitToBudget (ver Step 3).
describe("fitToBudget — mídia no contexto", () => {
  const base = { lead_id: "l1", contact: { name: "x", phone: null, email: null, tags: [], is_blocked: false }, conversation_id: "c1" };

  it("mídia com derivado: conteúdo presente + enquadrado (agente não nega a mídia)", () => {
    const ctx = __test_fitToBudget(base, [
      { direction: "inbound", type: "audio", body: null, media_url: "u", media_storage_path: "p", media_mime: "audio/ogg", media_derived_text: "quero o tênis 42", sent_at: "2026-07-22T10:00:00Z" },
    ], 100000);
    const body = ctx.messages[0]!.body;
    expect(body).toContain("quero o tênis 42"); // conteúdo derivado presente
    expect(body).toContain("um áudio"); // enquadrado pelo tipo
    expect(body).toMatch(/não.*ver\/ouvir mídia/i); // instrução anti-reflexo de negação
    expect(ctx.messages[0]!.type).toBe("audio");
    expect(ctx.messages[0]!.media_storage_path).toBe("p");
  });

  it("mídia SEM derivado ainda cai no marcador [tipo]", () => {
    const ctx = __test_fitToBudget(base, [
      { direction: "inbound", type: "image", body: null, media_url: "u", media_storage_path: "p", media_mime: "image/jpeg", media_derived_text: null, sent_at: "2026-07-22T10:00:00Z" },
    ], 100000);
    expect(ctx.messages[0]!.body).toBe("[image]");
  });

  it("texto puro inalterado", () => {
    const ctx = __test_fitToBudget(base, [
      { direction: "inbound", type: "text", body: "oi", media_url: null, media_storage_path: null, media_mime: null, media_derived_text: null, sent_at: "2026-07-22T10:00:00Z" },
    ], 100000);
    expect(ctx.messages[0]!.body).toBe("oi");
  });

  it("mídia com LEGENDA e derivado — os dois coexistem, legenda não mascara a descrição", () => {
    const ctx = __test_fitToBudget(base, [
      { direction: "inbound", type: "image", body: "quero esse", media_url: "u", media_storage_path: "p", media_mime: "image/jpeg", media_derived_text: "tênis vermelho tamanho 42", sent_at: "2026-07-22T10:00:00Z" },
    ], 100000);
    expect(ctx.messages[0]!.body).toContain("quero esse");
    expect(ctx.messages[0]!.body).toContain("tênis vermelho");
  });
});
