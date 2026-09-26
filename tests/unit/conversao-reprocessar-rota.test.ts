import { beforeEach, describe, expect, it, vi } from "vitest";
import { fail } from "@/lib/api/wrappers";
import { POST } from "@/app/api/v1/leads/[id]/conversion/retry/route";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const id = "12345678-1234-4234-8234-123456789012";
const rpc = vi.fn();
const chamar = () =>
  POST(
    new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify({ organization_id: "atacante" }),
    }),
    { params: Promise.resolve({ id }) },
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: "org-da-sessao" },
    user: { id: "admin" },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
  rpc.mockResolvedValue({ data: true, error: null });
});
describe("reprocessamento autorizado", () => {
  it("usa a organização da sessão, exige admin e audita o agendamento", async () => {
    expect((await chamar()).status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
    expect(rpc).toHaveBeenCalledWith("fn_solicitar_reenvio_conversao", {
      p_org: "org-da-sessao",
      p_lead: id,
    });
    expect(audit).toHaveBeenCalledOnce();
  });
  it("seleciona qualificação sem repetir o evento de compra", async () => {
    const resposta = await POST(
      new Request("https://example.test?event_name=QualifiedLead", { method: "POST" }),
      { params: Promise.resolve({ id }) },
    );
    expect(resposta.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_solicitar_reenvio_conversao", {
      p_org: "org-da-sessao",
      p_lead: id,
      p_event: "QualifiedLead",
    });
  });
  it("recusa evento arbitrário antes de acessar o banco", async () => {
    expect(
      (
        await POST(new Request("https://example.test?event_name=Inventado", { method: "POST" }), {
          params: Promise.resolve({ id }),
        })
      ).status,
    ).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("repetição sem efeito não gera auditoria", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect((await chamar()).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });
  it("suporte somente leitura não escreve", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("forbidden_role", "Sem permissão", 403));
    expect((await chamar()).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("papel insuficiente não alcança a RPC", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Sem permissão", 403),
    });
    expect((await chamar()).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("erro de persistência não informa agendamento", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "erro privado" } });
    const response = await chamar();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("erro privado");
  });
});
