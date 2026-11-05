import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ allowed: true, handler: vi.fn(), schema: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    m.allowed
      ? {
          ok: true,
          user: { id: "synthetic-user", idioma: "pt-BR" },
          org: { orgId: "synthetic-trusted-org" },
        }
      : { ok: false, response: new Response("{}", { status: 403 }) },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/legal/perfil-do-pais", () => ({ perfilDaOrganizacao: async () => ({}) }));
vi.mock("@/lib/schemas", () => ({
  contactCreateSchemaDoPais: vi.fn(),
  validateRequest: async () => ({ name: "Sintético", phone_number: "+5511999999999" }),
}));
vi.mock("@/app/api/v1/contacts/_handler", () => ({ createContactHandler: m.handler }));
import { POST } from "@/app/api/v1/leads/[id]/contact/route";
const lead = "00000000-0000-4000-8000-000000000001";
const req = () => new NextRequest("http://localhost/test", { method: "POST", body: "{}" });
beforeEach(() => {
  vi.clearAllMocks();
  m.allowed = true;
  m.handler.mockResolvedValue({ contact: { id: "synthetic-contact" }, action: "created" });
});
it("usa a empresa autorizada pelo guard e o ID do negócio da rota", async () => {
  expect((await POST(req(), { params: Promise.resolve({ id: lead }) })).status).toBe(201);
  const [, ctx, , leadId] = m.handler.mock.calls[0]!;
  expect(ctx.organization_id).toBe("synthetic-trusted-org");
  expect(leadId).toBe(lead);
});
it("não chama o handler com usuário sem escrita ou ID inválido", async () => {
  m.allowed = false;
  expect((await POST(req(), { params: Promise.resolve({ id: lead }) })).status).toBe(403);
  expect((await POST(req(), { params: Promise.resolve({ id: "bad" }) })).status).toBe(422);
  expect(m.handler).not.toHaveBeenCalled();
});
