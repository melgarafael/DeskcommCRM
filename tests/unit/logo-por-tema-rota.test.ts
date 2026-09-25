// @vitest-environment node
/** A rota real escolhe o campo, conserva o default legado e recusa tema antes de escrever. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  user: { id: "11111111-1111-4111-8111-111111111111", is_platform_admin: false },
  role: "admin",
  rpc: vi.fn(),
  upsert: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  audit: vi.fn(),
  eq: vi.fn(),
}));
const org = "22222222-2222-4222-8222-222222222222";
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => mocks.user,
  resolveActiveOrg: async () => ({
    orgId: "22222222-2222-4222-8222-222222222222",
    role: mocks.role,
  }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/branding/instalacao", () => ({ invalidarMarcaDaInstalacao: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({
        eq: (...args: unknown[]) => {
          mocks.eq(...args);
          return { maybeSingle: async () => ({ data: { settings: { branding: {} } } }) };
        },
      }),
      upsert: mocks.upsert,
    }),
    storage: { from: () => ({ upload: mocks.upload, remove: mocks.remove }) },
  }),
}));
import { POST, DELETE } from "@/app/api/v1/marca/logo/route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.is_platform_admin = false;
  mocks.role = "admin";
  mocks.rpc.mockResolvedValue({ data: 1, error: null });
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.remove.mockResolvedValue({ error: null });
  mocks.audit.mockResolvedValue(undefined);
});
function post(tema?: string, escopo = "organizacao") {
  const form = new FormData();
  form.set("escopo", escopo);
  if (tema !== undefined) form.set("tema", tema);
  form.set(
    "file",
    new File(
      [
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        ),
      ],
      "logo.png",
      { type: "image/png" },
    ),
  );
  return POST(
    new NextRequest("http://localhost/api/v1/marca/logo", { method: "POST", body: form }),
  );
}
describe("upload por tema", () => {
  it("omitir tema continua gravando logo claro", async () => {
    expect((await post()).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fn_definir_logo_por_tema_da_organizacao",
      expect.objectContaining({ p_org: org, p_tema: "claro" }),
    );
  });
  it("escuro grava somente o campo da instalação e audita o tema", async () => {
    mocks.user.is_platform_admin = true;
    expect((await post("escuro", "instalacao")).status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, logo_dark_path: expect.stringMatching(/^platform\//) }),
      { onConflict: "id" },
    );
    expect(mocks.upsert.mock.calls[0]![0]).not.toHaveProperty("logo_path");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ fields_changed: ["logo_dark_path"], tema: "escuro" }),
      }),
    );
  });
  it("recusa tema desconhecido antes de upload, banco ou remoção", async () => {
    expect((await post("inventado")).status).toBe(422);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("recusa trocar logo da instalação por admin de organização", async () => {
    expect((await post("escuro", "instalacao")).status).toBe(403);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("viewer não pode trocar o logo escuro", async () => {
    mocks.role = "viewer";
    expect((await post("escuro")).status).toBe(403);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("remover escuro usa só o tenant da sessão e o tema pedido", async () => {
    const response = await DELETE(
      new NextRequest("http://localhost/api/v1/marca/logo?escopo=organizacao&tema=escuro"),
    );
    expect(response.status).toBe(200);
    expect(mocks.eq).toHaveBeenCalledWith("id", org);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_definir_logo_por_tema_da_organizacao", {
      p_org: org,
      p_actor: mocks.user.id,
      p_path: null,
      p_tema: "escuro",
    });
  });
});
