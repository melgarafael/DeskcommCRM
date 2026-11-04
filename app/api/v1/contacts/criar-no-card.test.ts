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
  it("usa uma operação atômica e não abre conversa nem emite evento de automação", async () => {
    const contact = {
      id: "contact-a",
      organization_id: "org-a",
      phone_number: input.phone_number,
      source: "manual",
    };
    const rpc = vi.fn().mockResolvedValue({ data: contact, error: null });
    const from = vi.fn();
    const result = await createContactHandler({ rpc, from } as never, ctx, input, "lead-a");
    expect(result.contact.id).toBe("contact-a");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "fn_create_contact_for_lead",
      expect.objectContaining({ p_organization_id: "org-a", p_lead_id: "lead-a" }),
    );
    expect(from).not.toHaveBeenCalled();
    expect(sessaoProntaParaEnvio).not.toHaveBeenCalled();
    expect(ensureConversation).not.toHaveBeenCalled();
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
