import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { DELETE, POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/channels/quarentena", () => ({
  marcarMensagemEmQuarentena: vi.fn(),
  liberarMensagemDaQuarentena: vi.fn(),
  normalizarMotivo: (motivo: unknown) =>
    typeof motivo === "string" && motivo.trim().length >= 4 ? motivo.trim() : null,
  MOTIVO_MINIMO: 4,
  MOTIVO_MAXIMO: 500,
}));
vi.mock("@/lib/channels/retomada-da-quarentena", () => ({
  retomarFluxoDaMensagemLiberada: vi.fn(async () => ({ retomou: true })),
}));

import { audit } from "@/lib/audit";
import { marcarMensagemEmQuarentena, liberarMensagemDaQuarentena } from "@/lib/channels/quarentena";
import { retomarFluxoDaMensagemLiberada } from "@/lib/channels/retomada-da-quarentena";

/**
 * A ROTA DA QUARENTENA (#4026, fatia 1) — quem entra, quem sai e o que cada
 * recusa diz.
 *
 * ─── Por que estes casos ───────────────────────────────────────────────────
 *
 * A rota é o caminho EXPLÍCITO da fatia (não há detecção ainda). Ela precisa de
 * quatro garantias que o teste da regra de negócio não dá:
 *
 * · a guarda de suporte vem ANTES do papel — em modo leitura, quem recusa é o
 *   acompanhamento administrativo, e o RBAC nem é consultado;
 * · sem permissão a resposta é recusa, não 200 silencioso;
 * · mensagem de outra organização/conversa é 404, e nada é escrito;
 * · liberar devolve ao fluxo, mas só quando havia o que liberar.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 *
 * · mover `requireSupportWrite` para depois do `requireRole`: o primeiro caso
 *   acusa (o papel é consultado em modo leitura);
 * · trocar o 403 por 200: o segundo caso acusa;
 * · deixar a rota aceitar mensagem de outra conversa: o caso do 404 acusa;
 * · chamar a retomada sempre (mesmo sem quarentena): o último caso acusa.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const MENSAGEM = "55555555-5555-4555-8555-555555555555";

const ctx = { params: Promise.resolve({ id: CONVERSA, messageId: MENSAGEM }) };

const chamarPost = (corpo: unknown = { motivo: "link de golpe" }) =>
  POST(
    new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/messages/${MENSAGEM}/quarentena`, {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    ctx,
  );

const chamarDelete = () =>
  DELETE(
    new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/messages/${MENSAGEM}/quarentena`, {
      method: "DELETE",
    }),
    ctx,
  );

/** O pedaço de client que a rota usa antes de escrever: "a mensagem é desta conversa?". */
function clientComMensagem(existe: boolean) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.maybeSingle = async () => ({ data: existe ? { id: MENSAGEM } : null, error: null });
  return { from: () => b } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "usuario-1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createClient).mockResolvedValue(clientComMensagem(true));
  vi.mocked(createAdminClient).mockReturnValue({} as ReturnType<typeof createAdminClient>);
  vi.mocked(marcarMensagemEmQuarentena).mockResolvedValue({
    ok: true,
    jaEstava: false,
    em: "2026-11-05T12:00:00.000Z",
  });
  vi.mocked(liberarMensagemDaQuarentena).mockResolvedValue({
    ok: true,
    estava: true,
    motivo: "link de golpe",
  });
  vi.mocked(retomarFluxoDaMensagemLiberada).mockResolvedValue({ retomou: true });
});

describe("guarda de suporte e permissão", () => {
  it("modo leitura: a guarda recusa ANTES do RBAC", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);

    const res = await chamarPost();

    expect(res.status).toBe(403);
    expect(requireRole, "o RBAC foi consultado antes da guarda de suporte").not.toHaveBeenCalled();
    expect(marcarMensagemEmQuarentena).not.toHaveBeenCalled();
  });

  it("sem o papel exigido a resposta é recusa, não 200 silencioso", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }),
    } as Awaited<ReturnType<typeof requireRole>>);

    expect((await chamarPost()).status).toBe(403);
    expect((await chamarDelete()).status).toBe(403);
    expect(marcarMensagemEmQuarentena).not.toHaveBeenCalled();
    expect(liberarMensagemDaQuarentena).not.toHaveBeenCalled();
  });
});

describe("POST — marcar", () => {
  it("grava com o motivo normalizado e registra a auditoria", async () => {
    const res = await chamarPost({ motivo: "  link de golpe  " });
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data).toMatchObject({ em_quarentena: true, ja_estava: false, motivo: "link de golpe" });
    expect(marcarMensagemEmQuarentena).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      messageId: MENSAGEM,
      motivo: "link de golpe",
      porUserId: "usuario-1",
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "message.quarantined",
        resourceType: "message",
        resourceId: MENSAGEM,
      }),
    );
  });

  it("marcar duas vezes é idempotente: 200 com ja_estava", async () => {
    vi.mocked(marcarMensagemEmQuarentena).mockResolvedValue({
      ok: true,
      jaEstava: true,
      em: "2026-11-05T12:00:00.000Z",
    });

    const res = await chamarPost();
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.ja_estava).toBe(true);
  });

  it("motivo vazio ou curto é 422 e não escreve nada", async () => {
    const res = await chamarPost({ motivo: "  " });

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_reason");
    expect(marcarMensagemEmQuarentena).not.toHaveBeenCalled();
  });

  it("mensagem de outra conversa/organização é 404 e não escreve", async () => {
    vi.mocked(createClient).mockResolvedValue(clientComMensagem(false));

    const res = await chamarPost();

    expect(res.status).toBe(404);
    expect(marcarMensagemEmQuarentena).not.toHaveBeenCalled();
  });

  it("falha do banco é 500 — nunca sucesso sem marca", async () => {
    vi.mocked(marcarMensagemEmQuarentena).mockResolvedValue({ ok: false, erro: "falha" });

    const res = await chamarPost();

    expect(res.status).toBe(500);
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "message.quarantined" }));
  });
});

describe("DELETE — liberar", () => {
  it("libera e devolve a mensagem ao fluxo normal", async () => {
    const res = await chamarDelete();
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data).toMatchObject({ em_quarentena: false, estava_em_quarentena: true, retomou: true });
    expect(retomarFluxoDaMensagemLiberada).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      messageId: MENSAGEM,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "message.quarantine_released",
        metadata: expect.objectContaining({ motivo_anterior: "link de golpe", retomou: true }),
      }),
    );
  });

  it("quem não estava em quarentena: 200 sem retomada (nada a reenviar)", async () => {
    vi.mocked(liberarMensagemDaQuarentena).mockResolvedValue({
      ok: true,
      estava: false,
      motivo: null,
    });

    const res = await chamarDelete();

    expect(res.status).toBe(200);
    expect(retomarFluxoDaMensagemLiberada).not.toHaveBeenCalled();
  });

  it("mensagem já respondida: libera, mas NÃO re-despacha (sem reenvio retroativo)", async () => {
    vi.mocked(retomarFluxoDaMensagemLiberada).mockResolvedValue({
      retomou: false,
      motivo: "ja_respondida",
    });

    const res = await chamarDelete();
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data).toMatchObject({ em_quarentena: false, retomou: false, retomada: "ja_respondida" });
  });

  it("mensagem de outra organização é 404 e não libera nada", async () => {
    vi.mocked(createClient).mockResolvedValue(clientComMensagem(false));

    expect((await chamarDelete()).status).toBe(404);
    expect(liberarMensagemDaQuarentena).not.toHaveBeenCalled();
  });
});
