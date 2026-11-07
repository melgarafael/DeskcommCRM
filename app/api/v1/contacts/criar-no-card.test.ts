import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContactHandler } from "./_handler";
import { audit } from "@/lib/audit";
import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/automation/start-conversation", () => ({
  ensureConversation: vi.fn(),
  sessaoProntaParaEnvio: vi.fn(),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({ encontrarContatoPorTelefone: vi.fn() }));
const ctx = {
  organization_id: "org-a",
  actor: { type: "user" as const, id: "user-a" },
  requestId: "request-a",
};
const input = {
  name: "Pessoa",
  phone_number: "+5511999998888",
  source: "manual",
  tags: [],
  custom_fields: {},
  source_metadata: {},
  consent: {},
};
beforeEach(() => vi.clearAllMocks());
describe("criar contato no card", () => {
  it("cria e vincula numa operação só e segue a regra da ficha manual", async () => {
    const contact = {
      id: "contact-a",
      organization_id: "org-a",
      phone_number: input.phone_number,
      source: "manual",
    };
    vi.mocked(sessaoProntaParaEnvio).mockResolvedValue("session-a" as never);
    vi.mocked(ensureConversation).mockResolvedValue("conversation-a" as never);
    const rpc = vi.fn(async (nome: string) =>
      nome === "fn_create_contact_for_lead"
        ? { data: contact, error: null }
        : { data: null, error: null },
    );
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ insert }));
    const comEndereco = { ...input, zip_code: "80000-000", street: "Rua XV", city: "Curitiba" };
    const result = await createContactHandler({ rpc, from } as never, ctx, comEndereco, "lead-a");
    expect(result.contact.id).toBe("contact-a");
    expect(rpc).toHaveBeenCalledWith(
      "fn_create_contact_for_lead",
      expect.objectContaining({
        p_organization_id: "org-a",
        p_lead_id: "lead-a",
        p_contact: expect.objectContaining({ zip_code: "80000-000", street: "Rua XV", city: "Curitiba" }),
      }),
    );
    // O contato NÃO é inserido fora da RPC: a única escrita por `from` é a timeline.
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("crm_lead_activities");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        lead_id: "lead-a",
        contact_id: "contact-a",
        type: "lead_edited",
        reason: "Alterou o contato",
        payload: { fields: ["contact_id"] },
      }),
    );
    // A regra única de `lib/contacts/conversa-ao-criar.ts`: ficha manual abre conversa.
    expect(ensureConversation).toHaveBeenCalledWith(
      expect.anything(),
      "org-a",
      "contact-a",
      "session-a",
    );
    expect(rpc).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "contact.created", p_entity_id: "contact-a" }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "lead.updated",
        resourceId: "lead-a",
        metadata: expect.objectContaining({
          from: { contact_id: null },
          to: { contact_id: "contact-a" },
        }),
      }),
    );
  });
  it("telefone duplicado exige revisão dentro da mesma organização", async () => {
    vi.mocked(encontrarContatoPorTelefone).mockResolvedValue({ id: "existing" } as never);
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "23505" } });
    await expect(
      createContactHandler({ rpc } as never, ctx, input, "lead-a"),
    ).rejects.toMatchObject({ status: 409, code: "contact_exists" });
    expect(encontrarContatoPorTelefone).toHaveBeenCalledWith(
      expect.anything(),
      "org-a",
      input.phone_number,
    );
    expect(audit).not.toHaveBeenCalled();
    expect(ensureConversation).not.toHaveBeenCalled();
  });
  it.each([
    ["PT404", 404],
    ["PT409", 409],
    ["42501", 403],
  ])("falha %s não deixa efeito posterior", async (code, status) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code } });
    await expect(
      createContactHandler({ rpc } as never, ctx, input, "lead-a"),
    ).rejects.toMatchObject({ status });
    expect(audit).not.toHaveBeenCalled();
    expect(ensureConversation).not.toHaveBeenCalled();
  });
});
