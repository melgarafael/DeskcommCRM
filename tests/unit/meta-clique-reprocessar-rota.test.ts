import { beforeEach, describe, expect, it, vi } from "vitest";
import { fail } from "@/lib/api/wrappers";
import { POST } from "@/app/api/v1/conversions/meta-clicks/[id]/retry/route";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ID = "12345678-1234-4234-8234-123456789012";
const rpc = vi.fn();
const chamar = (id = ID) =>
  POST(new Request("https://example.test", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

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

describe("retry do LeadSubmitted por clique", () => {
  it("usa somente o tenant autenticado e audita o pedido", async () => {
    expect((await chamar()).status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
    expect(rpc).toHaveBeenCalledWith("fn_solicitar_reenvio_meta_ctwa_click", {
      p_org: "org-da-sessao",
      p_click: ID,
    });
    expect(audit).toHaveBeenCalledOnce();
  });
  it("recusa ID invalido antes de acessar banco", async () => {
    expect((await chamar("forjado")).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("nao audita uma tentativa sem efeito", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect((await chamar()).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });
  it("suporte somente leitura e papel insuficiente nao alcançam a RPC", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(
      fail("forbidden_role", "Sem permissão", 403),
    );
    expect((await chamar()).status).toBe(403);
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: fail("forbidden_role", "Sem permissão", 403),
    });
    expect((await chamar()).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});
