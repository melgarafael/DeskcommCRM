import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { fail } from "@/lib/api/wrappers";
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ cookieClient: true })),
}));
vi.mock("@/lib/legal/perfil-do-pais", async () => {
  const actual = await vi.importActual<typeof import("@/lib/legal/perfil-do-pais")>(
    "@/lib/legal/perfil-do-pais",
  );
  return { ...actual, perfilDaOrganizacao: vi.fn(async () => actual.perfilDoPais("BR")) };
});
vi.mock("@/app/api/v1/contacts/_handler", () => ({ createContactHandler: vi.fn() }));
const id = "44444444-4444-4444-8444-444444444444";
const ctx = { params: Promise.resolve({ id }) };
const req = (body: object) =>
  new NextRequest("http://localhost/api/v1/leads/" + id + "/contact", {
    method: "POST",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "user-a", idioma: "pt-BR" },
    org: { orgId: "org-a", role: "agent" },
  } as never);
  vi.mocked(createContactHandler).mockResolvedValue({
    contact: { id: "contact-a" },
    action: "created",
  } as never);
});
describe("criar contato no negócio · autorização", () => {
  it("ignora a organização e vínculo do corpo; usa sessão e card do path", async () => {
    const res = await POST(
      req({
        name: "Pessoa",
        phone_number: "+5511999998888",
        organization_id: "org-alheia",
        contact_id: "existing",
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(createContactHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organization_id: "org-a", actor: { type: "user", id: "user-a" } }),
      expect.not.objectContaining({ organization_id: "org-alheia" }),
      id,
    );
  });
  it("readonly interrompe antes de criar", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("forbidden", "Somente leitura", 403));
    expect((await POST(req({ phone_number: "+5511999998888" }), ctx)).status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createContactHandler).not.toHaveBeenCalled();
  });
  it("viewer sem permissão não cria", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Sem permissão", 403),
    });
    expect((await POST(req({ phone_number: "+5511999998888" }), ctx)).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
    expect(createContactHandler).not.toHaveBeenCalled();
  });
  it("telefone sem DDD não passa na validação", async () => {
    expect((await POST(req({ name: "Pessoa", phone_number: "2655-9389" }), ctx)).status).toBe(422);
    expect(createContactHandler).not.toHaveBeenCalled();
  });
});
