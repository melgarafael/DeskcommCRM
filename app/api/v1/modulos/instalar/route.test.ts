/**
 * POST /api/v1/modulos/instalar — só o administrador da instalação (ADR-0002, D3), nunca por
 * organização. Reaproveita o gate e o formato de erro das extensões: "gerenciar os pacotes
 * disponíveis" é a mesma frase para os dois mecanismos.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireExtensionPlatform } from "@/lib/extensions/http";
import { instalarModulo } from "@/lib/modulos/service";

vi.mock("@/lib/extensions/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extensions/http")>()),
  requireExtensionPlatform: vi.fn(),
}));
vi.mock("@/lib/modulos/service", () => ({ instalarModulo: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ACTOR = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";

function req(body: unknown, headers: HeadersInit = { "Idempotency-Key": OPERATION }): Request {
  return new Request("http://localhost/api/v1/modulos/instalar", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/modulos/instalar", () => {
  it("administrador da instalação instala um módulo do catálogo", async () => {
    vi.mocked(requireExtensionPlatform).mockResolvedValue({
      ok: true,
      user: { id: ACTOR } as never,
    });
    vi.mocked(instalarModulo).mockResolvedValue({ operationId: OPERATION, appliedNow: true });

    const { POST } = await import("./route");
    const res = await POST(req({ modulo: "honorarios" }));

    expect(res.status).toBe(200);
    expect(instalarModulo).toHaveBeenCalledWith(ACTOR, OPERATION, "honorarios");
  });

  it("quem não é administrador da instalação recebe o 403 do gate, sem chamar o serviço", async () => {
    vi.mocked(requireExtensionPlatform).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "Só o administrador da instalação pode gerenciar os pacotes.", 403),
    });

    const { POST } = await import("./route");
    const res = await POST(req({ modulo: "honorarios" }));

    expect(res.status).toBe(403);
    expect(instalarModulo).not.toHaveBeenCalled();
  });

  it("sem Idempotency-Key → 422, nunca chega a instalar", async () => {
    vi.mocked(requireExtensionPlatform).mockResolvedValue({
      ok: true,
      user: { id: ACTOR } as never,
    });

    const { POST } = await import("./route");
    const res = await POST(req({ modulo: "honorarios" }, {}));

    expect(res.status).toBe(422);
    expect(instalarModulo).not.toHaveBeenCalled();
  });
});
