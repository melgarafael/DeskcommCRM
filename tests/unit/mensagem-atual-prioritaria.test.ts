import { describe, expect, it } from "vitest";

import { buildOpeningMessage, claimsCurrentInboundIsEmpty } from "@/lib/agent-engine/agent/inbound-turn";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

describe("mensagem atual do cliente", () => {
  it("fica depois da memória anterior e vence um resumo contaminado", () => {
    const contexto: LeadContext = {
      lead_id: "11111111-1111-4111-8111-111111111111",
      contact: { name: "Cristiano", phone: null, email: null, tags: [], is_blocked: false },
      conversation_id: "22222222-2222-4222-8222-222222222222",
      last_human_decision: null,
      messages: [
        {
          direction: "outbound",
          body: "Como posso ajudar?",
          sent_at: "2026-09-06T09:01:00-04:00",
        },
        {
          direction: "inbound",
          body: "Quero marcar um horário com a Drª Mara.",
          sent_at: "2026-09-06T09:03:00-04:00",
        },
      ],
    };

    const abertura = buildOpeningMessage(
      {
        commitments: [],
        objections: [],
        next_action: "aguardar a mensagem do cliente",
        rolling_summary: "A última mensagem do cliente veio em branco.",
      } as never,
      null,
      contexto,
      "sem notas",
    );

    expect(abertura).toContain("## Mensagem atual do cliente — fonte prioritária");
    expect(abertura).toContain('"texto":"Quero marcar um horário com a Drª Mara."');
    expect(abertura).toContain("NUNCA diga que veio vazia, em branco ou que não foi recebida.");
    expect(abertura.indexOf("A última mensagem do cliente veio em branco.")).toBeLessThan(
      abertura.indexOf("## Mensagem atual do cliente — fonte prioritária"),
    );
  });

  it("prefere a mensagem apontada pelo job a outra inbound no histórico", () => {
    const contexto: LeadContext = {
      lead_id: "11111111-1111-4111-8111-111111111111",
      contact: { name: "Cristiano", phone: null, email: null, tags: [], is_blocked: false },
      conversation_id: "22222222-2222-4222-8222-222222222222",
      last_human_decision: null,
      messages: [
        { direction: "inbound", body: "registro concorrente sem conteúdo", sent_at: "2026-09-06T18:10:00-04:00" },
      ],
    };

    const abertura = buildOpeningMessage(null, null, contexto, "sem notas", false, [], "", "Quero agendar com a Drª Mara.");

    expect(abertura).toContain('"texto":"Quero agendar com a Drª Mara."');
    expect(abertura).not.toContain('"texto":"registro concorrente sem conteúdo"');
  });
});

describe("barreira contra falso aviso de mensagem vazia", () => {
  const inbound = "Eu quero agendar uma consulta com a Drª Mara, já tinha dito antes.";

  it.each([
    "Recebi uma mensagem em branco.",
    "Sua última mensagem veio sem texto.",
    "Notei que a mensagem chegou vazia.",
  ])("recusa a frase falsa: %s", (candidate) => {
    expect(claimsCurrentInboundIsEmpty(candidate, inbound)).toBe(true);
  });

  it("permite uma resposta que trata o pedido real", () => {
    expect(claimsCurrentInboundIsEmpty("Claro. Qual dia e período você prefere para a consulta?", inbound)).toBe(false);
  });

  it("não arma quando a mensagem de fato não tem texto", () => {
    expect(claimsCurrentInboundIsEmpty("Recebi uma mensagem em branco.", "   ")).toBe(false);
  });
});
