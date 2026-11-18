import { describe, expect, it } from "vitest";

import { createSupabaseSilenceSweepDb } from "./silence-sweep";

/**
 * #4311 (resíduo): `organizations.status` deixou de vir embutido na linha de
 * conversa e é lida UMA vez por organização no tick — por isso o dublê roteia a
 * tabela `organizations` à parte (antes o status era sobrescrito por conversa).
 */
function supabaseComConversas(data: unknown[], org: { status: string } = { status: "active" }) {
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
  const orgChain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "single" || prop === "maybeSingle") {
          return async () => ({ data: { id: "org", settings: {}, ...org }, error: null });
        }
        if (prop === "then") {
          return (resolve: (value: unknown) => unknown) => resolve({ data: [{ id: "org", settings: {}, ...org }], error: null });
        }
        return () => orgChain;
      },
    },
  );
  return { from: (tabela: string) => (tabela === "organizations" ? orgChain : chain) } as never;
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
    organizations: { status: "active" },
  };
}

describe("sweep de silêncio no pré-go-live", () => {
  it("org não operante: nenhum candidato, nem o número de teste", async () => {
    const parada = conversa("tester", "+5585987654321");
    const db = createSupabaseSilenceSweepDb(supabaseComConversas([parada], { status: "suspended" }));
    await expect(db.loadSilentContactIds("org", "2026-09-02T10:00:00.000Z", [])).resolves.toEqual([]);
  });

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

  it("canal social: só a conta da lista social vira candidato, nunca a mesma pessoa por outra conta", async () => {
    const testador = "instagram:6af9e0ef28984e27de07bef4:1011223655361506";
    const social = (contactId: string, identidade: string) => {
      const c = conversa(contactId, "");
      return {
        ...c,
        contacts: { ...c.contacts, phone_number: null, social_identity: identidade },
        sessao: { metadata: { ...metadata, ai_test_phone_numbers: [], ai_test_social_identities: [testador] } },
      };
    };
    const db = createSupabaseSilenceSweepDb(
      supabaseComConversas([
        social("testador", testador),
        social("outra-conta", "instagram:0123456789abcdef01234567:1011223655361506"),
      ]),
    );

    await expect(
      db.loadSilentContactIds("org", "2026-09-02T10:00:00.000Z", []),
    ).resolves.toEqual(["testador"]);
  });
});
