/**
 * POST /api/v1/conversations/[id]/media — teto de escrita do Bearer (#1999).
 *
 * Esta rota está em `PUBLIC_PATHS` (o proxy não decide sobre ela) e cada
 * chamada sobe até 50 MB no bucket. O teto por token e por organização é o
 * único que existe para uma integração em laço. Molde: o teste de
 * `app/api/v1/agenda/agendamentos/route.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { isPublicPath } from "@/lib/auth/public-paths";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

// Depois do vi.mock acima: pega a versão mockada.
const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONV_ID = "33333333-3333-4333-8333-333333333333";
const CAMINHO = `/api/v1/conversations/${CONV_ID}/media`;

/** Client falso: conversa inexistente → a rota responde 404 se passar do teto. */
function clientSemConversa() {
  const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  const chain = { select: () => chain, eq: () => chain, maybeSingle };
  return { from: vi.fn(() => chain) };
}

let admin: ReturnType<typeof clientSemConversa>;
let sessao: ReturnType<typeof clientSemConversa>;

function postReq(headers?: HeadersInit): NextRequest {
  return new NextRequest(`http://localhost${CAMINHO}`, { method: "POST", headers });
}
const ctx = { params: Promise.resolve({ id: CONV_ID }) };

function tokenOk(): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_ID,
    role: "agent" as never,
    actor: { type: "api_token", id: "tok-1", role: "agent" as never },
    apiTokenId: "tok-1",
    scopes: ["mcp:write"],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  admin = clientSemConversa();
  sessao = clientSemConversa();
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  vi.mocked(createClient).mockResolvedValue(sessao as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/v1/conversations/[id]/media — teto de escrita do Bearer", () => {
  it("está em PUBLIC_PATHS: o Bearer chega ao handler, e o teto daqui é o único", () => {
    expect(isPublicPath(CAMINHO)).toBe(true);
  });

  it("acima do teto do token → 429 com Retry-After, a conversa nem é consultada", async () => {
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false } as never);
    const { POST } = await import("./route");
    const res = await POST(postReq({ authorization: "Bearer dsk_abc_def" }), ctx);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(admin.from).not.toHaveBeenCalled();
    expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe("conversation_media:tok:tok-1");
  });

  it("acima do teto da organização → 429, a conversa nem é consultada", async () => {
    tokenOk();
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: true } as never)
      .mockResolvedValueOnce({ allowed: false } as never);
    const { POST } = await import("./route");
    const res = await POST(postReq({ authorization: "Bearer dsk_abc_def" }), ctx);

    expect(res.status).toBe(429);
    expect(admin.from).not.toHaveBeenCalled();
    expect(vi.mocked(checkRateLimit).mock.calls[1]?.[0]).toBe(`conversation_media:org:${ORG_ID}`);
  });

  it("dentro do teto → segue para o handler", async () => {
    tokenOk();
    const { POST } = await import("./route");
    const res = await POST(postReq({ authorization: "Bearer dsk_abc_def" }), ctx);

    expect(res.status).toBe(404);
    expect(admin.from).toHaveBeenCalledWith("conversations");
  });

  it("pela sessão do navegador não há teto: o contador nem é tocado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER_ID, idioma: "pt-BR" },
      org: { orgId: ORG_ID, name: "Org", role: "agent" },
    } as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(), ctx);

    expect(res.status).toBe(404);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(sessao.from).toHaveBeenCalledWith("conversations");
  });
});
