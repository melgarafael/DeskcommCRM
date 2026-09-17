import { describe, expect, it, vi } from "vitest";

import { buildOpeningMessage } from "./inbound-turn";
import { compararFaqSigilium, FAQ_SIGILIUM, NATIVAS_ANTES } from "./medir-prefixo";
import { nativasDoTurno } from "./nativas-do-turno";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import type { LeadContext } from "../edge/crm/get-lead-context";

const contextoFaq: LeadContext = {
  lead_id: "11111111-1111-4111-8111-111111111111",
  contact: { name: "Teste", phone: null, email: null, tags: [], is_blocked: false },
  conversation_id: null,
  last_human_decision: null,
  messages: [
    {
      direction: "inbound",
      body: "o que é o Sigilium?",
      sent_at: "2026-09-16T15:00:00-03:00",
    },
  ],
};

describe("FAQ Sigilium — primeiro passo", () => {
  it("não oferece get_lead_context nem cita a ferramenta quando o contexto já está na abertura", () => {
    const oferecidas = nativasDoTurno(FAQ_SIGILIUM);
    expect(oferecidas).toEqual(["send_message", "request_human_handoff"]);
    expect(oferecidas).not.toContain("get_lead_context");
    const texto = buildOpeningMessage(
      null,
      null,
      contextoFaq,
      "",
      false,
      [],
      "",
      undefined,
      oferecidas,
    );
    expect(texto).toContain("o que é o Sigilium?");
    expect(texto).toContain("send_message");
    expect(texto).not.toContain("get_lead_context");
    expect(texto).not.toContain("update_lead_state");
    expect(texto).not.toContain("save_lead_note");
    expect(texto).not.toContain("schedule_followup");
  });

  it("nenhuma ferramenta MCP entra na lista de nativas", () => {
    const catalogo = new Set(TOOL_CATALOG.map((t) => t.name));
    for (const nome of nativasDoTurno(FAQ_SIGILIUM)) {
      expect(catalogo.has(nome), `${nome} não pode ser ferramenta de catálogo`).toBe(false);
    }
    expect(nativasDoTurno(FAQ_SIGILIUM).some((n) => n.startsWith("crm_"))).toBe(false);
  });
});

describe("medidor de prefixo", () => {
  it("mostra redução relevante antes de qualquer ensaio pago e não chama rede", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("meter_network_forbidden"));
    try {
      const cmp = await compararFaqSigilium();
      expect(cmp.antes.tools).toEqual([...NATIVAS_ANTES]);
      expect(cmp.depois.tools).toEqual(["send_message", "request_human_handoff"]);
      expect(cmp.reducao_tokens_por_passo).toBeGreaterThan(400);
      expect(cmp.reducao_pct).toBeGreaterThan(0.3);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
