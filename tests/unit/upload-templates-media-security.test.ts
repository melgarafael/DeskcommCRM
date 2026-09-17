import { NextRequest } from "next/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { POST } from "@/app/api/v1/channels/partner/templates/media/route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("Upload de mídia para templates (POST /api/v1/channels/partner/templates/media)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recusa requisição quando o usuário não possui permissão de agente (requireRole falha)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Papel insuficiente.", 403),
    } as unknown as Awaited<ReturnType<typeof requireRole>>);

    const formData = new FormData();
    formData.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "teste.png", { type: "image/png" }));

    const req = new NextRequest("http://localhost/api/v1/channels/partner/templates/media", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden_role");
  });

  it("recusa arquivo fingindo ser PNG mas contendo SVG ou texto malicioso (spoofing de MIME)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER_ID, email: "user@test.com", idioma: "pt" },
      org: { orgId: ORG, orgName: "Org", role: "agent" },
    } as unknown as Awaited<ReturnType<typeof requireRole>>);

    const fakePng = new File(["<svg><script>alert(1)</script></svg>"], "malicious.png", {
      type: "image/png",
    });
    const formData = new FormData();
    formData.append("file", fakePng);

    const req = new NextRequest("http://localhost/api/v1/channels/partner/templates/media", {
      method: "POST",
    });
    req.formData = async () => formData;

    const res = await POST(req);
    expect(res.status).toBe(415);
    const json = await res.json();
    expect(json.error.code).toBe("unsupported_media_type");
    expect(json.error.message).toContain("SVG");
  });

  it("aceita e processa upload quando possui bytes PNG válidos e papel de agente", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER_ID, email: "user@test.com", idioma: "pt" },
      org: { orgId: ORG, orgName: "Org", role: "agent" },
    } as unknown as Awaited<ReturnType<typeof requireRole>>);

    const mockUpload = vi.fn().mockResolvedValue({ error: null });
    const mockCreateSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://storage.supabase.com/signed/teste.png" },
      error: null,
    });

    vi.mocked(createAdminClient).mockReturnValue({
      storage: {
        from: vi.fn().mockReturnValue({
          upload: mockUpload,
          createSignedUrl: mockCreateSignedUrl,
        }),
      },
    } as unknown as ReturnType<typeof createAdminClient>);

    const validPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const validFile = new File([validPngBytes], "foto.png", { type: "image/png" });

    const formData = new FormData();
    formData.append("file", validFile);

    const req = new NextRequest("http://localhost/api/v1/channels/partner/templates/media", {
      method: "POST",
    });
    req.formData = async () => formData;

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.url).toBe("https://storage.supabase.com/signed/teste.png");
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockCreateSignedUrl).toHaveBeenCalledTimes(1);
  });
});
