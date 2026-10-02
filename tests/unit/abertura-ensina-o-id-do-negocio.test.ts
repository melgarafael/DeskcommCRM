import { describe, expect, it } from "vitest";

import { buildOpeningMessage } from "@/lib/agent-engine/agent/inbound-turn";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

/**
 * Ter o id no JSON não basta: o mesmo JSON tem um campo chamado `lead_id` que é
 * a PESSOA. A abertura diz qual dos dois as ferramentas querem.
 */
function contexto(negocio: LeadContext["negocio"]): LeadContext {
  return {
    lead_id: "contato-9c9e",
    contact_id: "contato-9c9e",
    negocio,
    contact: { name: "Régis", phone: null, email: null, tags: [], is_blocked: false },
    conversation_id: "conv-d881",
    last_human_decision: null,
    messages: [{ direction: "inbound", body: "agora em outubro msm", sent_at: "2026-10-01T20:42:55-03:00" }],
  };
}

const NEGOCIO = { id: "negocio-aa12", funil: "Vendas", etapa: "1. Entrada Lead" };

describe("a abertura ensina o id do negócio", () => {
  it('com negócio: manda usar negocio.id como lead_id, e diz que lead_id do contexto é a pessoa', () => {
    const abertura = buildOpeningMessage(null, null, contexto(NEGOCIO), "sem notas", false);
    expect(abertura).toContain('use negocio.id = "negocio-aa12"');
    expect(abertura).toContain("são o ID da PESSOA");
  });

  it("sem negócio: não instrui nada", () => {
    const abertura = buildOpeningMessage(null, null, contexto(null), "sem notas", false);
    expect(abertura).not.toContain("use negocio.id");
  });

  it("projetado (turno sem ferramentas): o id do negócio não aparece em lugar nenhum", () => {
    const abertura = buildOpeningMessage(null, null, contexto(NEGOCIO), "sem notas", true);
    expect(abertura).not.toContain("negocio-aa12");
  });
});
