import { describe, expect, it } from "vitest";

import { __test_fitToBudget } from "@/lib/agent-engine/edge/crm/get-lead-context";

// Achado #532, item 1: `lib/tempo/agora.test.ts` cobre `isoLocalComOffset` isolada,
// mas nenhum teste prendia o CALL SITE (`get-lead-context.ts:359`). Reverter esse
// call site para `new Date(m.sent_at).toISOString()` — literalmente o defeito de
// produção que `isoLocalComOffset` existe para consertar — deixava a suíte inteira
// verde. Este teste prende o resultado que o PRODUTOR entrega ao modelo, não só a
// função pura.
describe("fitToBudget — sent_at chega com o offset do fuso do tenant, não UTC cru", () => {
  const base = { lead_id: "l1", contact: { name: "x", phone: null, email: null, tags: [], is_blocked: false }, conversation_id: "c1", last_human_decision: null };

  it("mensagem em UTC vira hora de parede de São Paulo, com offset -03:00", () => {
    const ctx = __test_fitToBudget(base, [
      { direction: "inbound", type: "text", body: "oi", media_url: null, media_storage_path: null, media_mime: null, media_derived_text: null, sent_at: new Date("2026-09-02T18:45:38Z") },
    ], 100000, "America/Sao_Paulo");
    expect(ctx.messages[0]!.sent_at).toBe("2026-09-02T15:45:38-03:00");
  });

  it("nunca ISO em Z — offset explícito de duas casas", () => {
    const ctx = __test_fitToBudget(base, [
      { direction: "inbound", type: "text", body: "oi", media_url: null, media_storage_path: null, media_mime: null, media_derived_text: null, sent_at: new Date("2026-09-02T18:45:38Z") },
    ], 100000, "America/Sao_Paulo");
    expect(ctx.messages[0]!.sent_at).not.toMatch(/Z$/);
    expect(ctx.messages[0]!.sent_at).toMatch(/[+-]\d{2}:\d{2}$/);
  });
});
