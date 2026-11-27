/**
 * Rota POST /api/v1/messages no modo institucional (PR 02):
 *
 * Testa autenticação, escopo `messages:institutional`, bloqueio de `ai_agent`,
 * bloqueio de sessão de navegador, bloqueio de `phone_number` (sem abrir/reabrir
 * conversa), bloqueio de `on_behalf_of_user_id`, preservação do
 * `assumirConversaAposEnvio`, isolamento multi-tenant via token e
 * idempotência real com `comIdempotencia` (replay, conflito e recuperação
 * após falha sem travar nova tentativa).
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_TOKEN = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const USER = "55555555-5555-4555-8555-555555555555";
const TOKEN_ID = "77777777-7777-4777-8777-777777777777";
const KEY_1 = "88888888-8888-4888-8888-888888888888";
const KEY_2 = "99999888-8888-4888-8888-999999999999";

const mocks = vi.hoisted(() => ({
  authDual: vi.fn(),
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 50,
    resetAt: Date.now() + 60_000,
  })),
  openShared: vi.fn(),
  segurarRitmo: vi.fn(async () => null),
  registrarRitmo: vi.fn(async () => {}),
  assumir: vi.fn(async () => {}),
  sendHandler: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: mocks.authDual,
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/messaging/open-shared-contact-conversation", () => ({
  openSharedContactConversation: mocks.openShared,
}));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: mocks.segurarRitmo,
  registrarEnvioPorToken: mocks.registrarRitmo,
}));
vi.mock("@/lib/inbox/assumir-conversa-apos-envio", () => ({
  assumirConversaAposEnvio: mocks.assumir,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({})),
}));
vi.mock("./_handler", () => ({
  sendMessageHandler: mocks.sendHandler,
}));

import { hashDaColuna, hashDoCorpo } from "@/lib/api/idempotency";
import { ApiError } from "@/lib/api/types";
import { deriveActor } from "@/lib/mcp/auth";
import { bancoFalso } from "@/tests/helpers/banco-falso-do-status";
import { POST } from "./route";

function armarToken(scopes: string[], db: unknown = {}) {
  mocks.authDual.mockResolvedValue({
    ok: true,
    organizationId: ORG_TOKEN,
    actor: deriveActor(scopes, TOKEN_ID),
    supabase: db,
    via: "token",
    scopes,
    apiTokenId: TOKEN_ID,
  });
}

function requisicao(body: Record<string, unknown>, idempotencyKey?: string) {
  return new NextRequest("http://localhost:3000/api/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.authDual.mockReset();
  mocks.checkRateLimit.mockClear();
  mocks.openShared.mockReset();
  mocks.segurarRitmo.mockClear();
  mocks.registrarRitmo.mockClear();
  mocks.assumir.mockClear();
  mocks.sendHandler.mockReset();
});

describe("POST /api/v1/messages — envio institucional (PR 02)", () => {
  it("token sem messages:institutional recebe 403 ANTES de rate limit, idempotência e handler", async () => {
    const { db, idem } = bancoFalso();
    armarToken(["mcp:write"], db);

    const res = await POST(
      requisicao({ conversation_id: CONV, body: "Aviso", dispatch_mode: "institutional" }, KEY_1),
    );

    expect(res.status).toBe(403);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.sendHandler).not.toHaveBeenCalled();
    expect(idem.size).toBe(0);
  });

  it("sessão de navegador com dispatch_mode='institutional' recebe 403", async () => {
    mocks.authDual.mockResolvedValue({
      ok: true,
      organizationId: ORG_TOKEN,
      actor: { type: "user", id: USER },
      supabase: {},
      via: "session",
    });

    const res = await POST(
      requisicao({ conversation_id: CONV, body: "Aviso", dispatch_mode: "institutional" }),
    );

    expect(res.status).toBe(403);
    expect(mocks.sendHandler).not.toHaveBeenCalled();
  });

  it("token de ai_agent mesmo com escopo messages:institutional recebe 403", async () => {
    armarToken(["mcp:write", "actor:ai_agent", "messages:institutional"]);

    const res = await POST(
      requisicao({
        conversation_id: CONV,
        body: "IA tentando aviso",
        dispatch_mode: "institutional",
      }),
    );

    expect(res.status).toBe(403);
    expect(mocks.sendHandler).not.toHaveBeenCalled();
  });

  it("recusa dispatch_mode='institutional' com phone_number (422) sem tentar abrir ou reabrir conversa", async () => {
    armarToken(["mcp:write", "messages:institutional"]);

    const res = await POST(
      requisicao({ phone_number: "+5531999998888", body: "Aviso", dispatch_mode: "institutional" }),
    );

    expect(res.status).toBe(422);
    expect(mocks.openShared).not.toHaveBeenCalled();
    expect(mocks.sendHandler).not.toHaveBeenCalled();
  });

  it("recusa dispatch_mode='institutional' combinado com on_behalf_of_user_id (422)", async () => {
    armarToken(["mcp:write", "messages:on_behalf", "messages:institutional"]);

    const res = await POST(
      requisicao({
        conversation_id: CONV,
        body: "Aviso",
        dispatch_mode: "institutional",
        on_behalf_of_user_id: USER,
      }),
    );

    expect(res.status).toBe(422);
    expect(mocks.sendHandler).not.toHaveBeenCalled();
  });

  it("token autorizado entrega dispatchMode='institutional', pula assumirConversaAposEnvio e respeita org do token", async () => {
    const { db } = bancoFalso();
    armarToken(["mcp:write", "messages:institutional"], db);
    mocks.sendHandler.mockResolvedValue({
      id: "m-inst-1",
      conversation_id: CONV,
      status: "sent",
      sent_via: "system",
    });

    const res = await POST(
      requisicao({
        conversation_id: CONV,
        body: "Fatura disponível",
        dispatch_mode: "institutional",
      }),
    );

    expect(res.status).toBe(201);
    expect(mocks.sendHandler).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        organization_id: ORG_TOKEN,
        dispatchMode: "institutional",
      }),
      expect.objectContaining({
        conversation_id: CONV,
        dispatch_mode: "institutional",
      }),
    );
    expect(mocks.assumir).not.toHaveBeenCalled();
  });

  it("idempotência: replay após sucesso não reenvia; falha libera chave; conflito de dispatch_mode retorna 409", async () => {
    const { db, idem } = bancoFalso();
    armarToken(["mcp:write", "messages:institutional"], db);

    // 1. Falha (ex.: conversa encerrada 409) NÃO grava recibo terminal (reserva é expirada na hora).
    mocks.sendHandler.mockRejectedValueOnce(
      new ApiError(409, "state_conflict", undefined, "req-1", "Fechada"),
    );
    const failRes = await POST(
      requisicao({ conversation_id: CONV, body: "Aviso", dispatch_mode: "institutional" }, KEY_1),
    );
    expect(failRes.status).toBe(409);
    expect(idem.size).toBe(1);
    expect([...idem.values()][0]?.status_code).toBeNull();

    // 2. Retry na MESMA chave após reabertura funciona e grava recibo.
    mocks.sendHandler.mockResolvedValueOnce({
      id: "m-ok-1",
      conversation_id: CONV,
      status: "sent",
    });
    const okRes = await POST(
      requisicao({ conversation_id: CONV, body: "Aviso", dispatch_mode: "institutional" }, KEY_1),
    );
    expect(okRes.status).toBe(201);
    expect(idem.size).toBe(1);

    // 3. Replay devolve recibo sem chamar handler de novo.
    const replayRes = await POST(
      requisicao({ conversation_id: CONV, body: "Aviso", dispatch_mode: "institutional" }, KEY_1),
    );
    expect(replayRes.status).toBe(201);
    expect(mocks.sendHandler).toHaveBeenCalledTimes(2);

    // 4. Mesma chave com outro dispatch_mode devolve 409 idempotency_conflict.
    const conflictRes = await POST(
      requisicao({ conversation_id: CONV, body: "Aviso", dispatch_mode: "operational" }, KEY_1),
    );
    expect(conflictRes.status).toBe(409);
  });

  it("compatibilidade retroativa: omissão de dispatch_mode mantém o mesmo SHA-256 legado da Idempotency-Key", async () => {
    const { db, idem } = bancoFalso();
    armarToken(["mcp:write"], db);
    mocks.sendHandler.mockResolvedValueOnce({
      id: "m-leg-1",
      conversation_id: CONV,
      status: "sent",
    });

    const res = await POST(requisicao({ conversation_id: CONV, body: "Oi legado" }, KEY_2));
    expect(res.status).toBe(201);

    const hashEsperado = hashDaColuna(
      hashDoCorpo({
        body: "Oi legado",
        conversation_id: CONV,
        type: "text",
      }),
    );
    const hashCanonicoOrdenado =
      "\\x" +
      createHash("sha256")
        .update(JSON.stringify({ body: "Oi legado", conversation_id: CONV, type: "text" }))
        .digest("hex");
    const linha = [...idem.values()][0]!;
    expect(linha.request_hash).toBe(hashEsperado);
    expect(linha.request_hash).toBe(hashCanonicoOrdenado);
  });
});
