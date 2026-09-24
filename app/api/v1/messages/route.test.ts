/**
 * POST /api/v1/messages — por TOKEN leva teto de chamadas e o freio anti-ban do
 * número; pela SESSÃO do navegador, não leva nenhum dos dois (quem digita é uma
 * pessoa). Ver `lib/messaging/ritmo-do-envio-por-token.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({ resolveAuthDual: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));
vi.mock("./_handler", () => ({ sendMessageHandler: vi.fn() }));

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { registrarEnvioPorToken, segurarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";

import { sendMessageHandler } from "./_handler";
import { POST } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const mockedAuth = vi.mocked(resolveAuthDual);
const mockedTeto = vi.mocked(checkRateLimit);
const mockedSegurar = vi.mocked(segurarEnvioPorToken);
const mockedRegistrar = vi.mocked(registrarEnvioPorToken);
const mockedSend = vi.mocked(sendMessageHandler);

function autenticado(via: "session" | "token") {
  mockedAuth.mockResolvedValue({
    ok: true,
    organizationId: ORG_ID,
    actor: via === "token" ? { type: "api_token", id: "tok-1" } : { type: "user", id: "u1" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: {} as any,
    via,
  });
}

function pedido(): NextRequest {
  return new NextRequest("http://localhost/api/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation_id: CONVERSATION_ID, type: "text", body: "Oi!" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedTeto.mockResolvedValue({ allowed: true } as never);
  mockedSegurar.mockResolvedValue(null);
  mockedSend.mockResolvedValue({ id: "m1", status: "sent" } as never);
});

describe("POST /api/v1/messages — ritmo por token", () => {
  it("pela sessão do navegador, não aplica teto nem freio", async () => {
    autenticado("session");
    const res = await POST(pedido());
    expect(res.status).toBe(201);
    expect(mockedTeto).not.toHaveBeenCalled();
    expect(mockedSegurar).not.toHaveBeenCalled();
    expect(mockedRegistrar).not.toHaveBeenCalled();
  });

  it("por token, passa pelo freio antes de enviar e conta o envio", async () => {
    autenticado("token");
    const segurado = { channelSessionId: SESSION_ID };
    mockedSegurar.mockResolvedValue(segurado);

    const res = await POST(pedido());

    expect(res.status).toBe(201);
    expect(mockedTeto).toHaveBeenCalledWith("messages:tok:tok-1", expect.any(Number), expect.any(Number));
    expect(mockedTeto).toHaveBeenCalledWith(`messages:org:${ORG_ID}`, expect.any(Number), expect.any(Number));
    expect(mockedSegurar.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedSend.mock.invocationCallOrder[0]!,
    );
    expect(mockedRegistrar).toHaveBeenCalledWith(expect.anything(), ORG_ID, segurado, "sent");
  });

  it("por token, acima do teto de chamadas por token devolve 429 sem enviar", async () => {
    autenticado("token");
    mockedTeto.mockResolvedValueOnce({ allowed: false } as never);

    const res = await POST(pedido());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("por token, acima do teto da organização devolve 429 sem enviar", async () => {
    autenticado("token");
    mockedTeto.mockResolvedValueOnce({ allowed: true } as never); // token ok
    mockedTeto.mockResolvedValueOnce({ allowed: false } as never); // org limit

    const res = await POST(pedido());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("por token, quando o número estourou o teto diário devolve 429 com Retry-After", async () => {
    autenticado("token");
    mockedSegurar.mockRejectedValue(
      new ApiError(
        429,
        "rate_limited",
        { motivo: "teto_diario", libera_em: "2026-09-23T03:00:00.000Z", retry_after_seconds: 43_200 },
        "req",
      ),
    );

    const res = await POST(pedido());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("43200");
    const corpo = (await res.json()) as { error: { code: string; details?: { motivo?: string } } };
    expect(corpo.error.code).toBe("rate_limited");
    expect(corpo.error.details?.motivo).toBe("teto_diario");
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
