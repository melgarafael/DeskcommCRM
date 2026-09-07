import { describe, expect, it } from "vitest";

import { createSupabaseSilenceSweepDb } from "./silence-sweep";

function supabaseComConversas(data: unknown[]) {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (value: unknown) => unknown) => resolve({ data, error: null });
        }
        return () => chain;
      },
    },
  );
  return { from: () => chain } as never;
}

const metadata = {
  ai_gate: "allowlist",
  ai_gate_mode: "pre_go_live",
  ai_test_phone_numbers: ["+5585987654321"],
};

function conversa(contactId: string, phoneNumber: string) {
  const conversationId = `conversation-${contactId}`;
  return {
    id: conversationId,
    service_revision: 1,
    current_demanda_id: null,
    demandas: null,
    status: "open",
    contact_id: contactId,
    last_inbound_at: "2026-09-01T10:00:00.000Z",
    // O candidato conserva a origem do inbound no atendimento ainda vigente.
    messages: [{
      organization_id: "org",
      contact_id: contactId,
      conversation_id: conversationId,
      service_revision: 1,
      demanda_id: null,
      demanda_revision: null,
      sent_at: "2026-09-01T10:00:00.000Z",
    }],
    contacts: {
      tags: [],
      is_blocked: false,
      // Prova que um carimbo global não fura o pré-go-live.
      ai_authorized_at: "2026-09-04T10:00:00.000Z",
      phone_number: phoneNumber,
    },
    sessao: { metadata },
  };
}

describe("sweep de silêncio no pré-go-live", () => {
  it("só cria candidato para o número de teste do canal", async () => {
    const db = createSupabaseSilenceSweepDb(
      supabaseComConversas([
        conversa("tester", "+5585987654321"),
        conversa("publico", "+5585987654000"),
      ]),
    );

    await expect(
      db.loadSilentContactIds("org", "2026-09-02T10:00:00.000Z", []),
    ).resolves.toEqual(["tester"]);
  });
});
