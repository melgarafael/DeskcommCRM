import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import type { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import type { audit } from "@/lib/audit";
import type { Message } from "@/lib/types/messaging";

type Linha = Message & { updated_at: string };
interface Chamada { table: string; op: "select" | "update"; payload?: Record<string, unknown>; eqs: Array<[string, unknown]> }

const state = vi.hoisted(() => ({
  semSessao: false,
  role: "agent" as string,
  linha: null as unknown as Linha,
  conversa: { id: "", last_inbound_at: null as string | null, channel_sessions: { provider: "waha" } as { provider: string } | null },
  travaPega: true,
  chamadas: [] as Chamada[],
  handler: vi.fn<typeof sendMessageHandler>(),
  audit: vi.fn<typeof audit>(async () => undefined),
  rate: vi.fn<typeof checkRateLimit>(async () => ({ allowed: true, limit: 20, count: 1, window_sec: 60 })),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
// O portão de papel é o de verdade em miniatura: abaixo do mínimo pedido, 403.
const ORDEM_DOS_PAPEIS = ["viewer", "agent", "manager", "admin"];
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async (minimo: string) => state.semSessao
    ? { ok: false, response: NextResponse.json({ error: { code: "unauthenticated", message: "x" } }, { status: 401 }) }
    : ORDEM_DOS_PAPEIS.indexOf(state.role) < ORDEM_DOS_PAPEIS.indexOf(minimo)
      ? { ok: false, response: NextResponse.json({ error: { code: "forbidden", message: "x" } }, { status: 403 }) }
      : { ok: true, user: { id: "eu", idioma: "pt-BR" }, org: { orgId: "org-1", role: state.role } },
}));
vi.mock("@/lib/audit", () => ({ audit: state.audit }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: state.rate }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: state.handler }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const chamada: Chamada = { table, op: "select", eqs: [] };
      state.chamadas.push(chamada);
      const q = {
        select: () => q,
        update: (payload: Record<string, unknown>) => { chamada.op = "update"; chamada.payload = payload; return q; },
        eq: (col: string, val: unknown) => { chamada.eqs.push([col, val]); return q; },
        maybeSingle: async () => {
          if (table === "conversations") return { data: state.conversa, error: null };
          if (chamada.op === "select") return { data: state.linha, error: null };
          const primeiraTrava = state.chamadas.filter((c) => c.table === "messages" && c.op === "update")[0] === chamada;
          return { data: primeiraTrava && state.travaPega ? { id: state.linha.id, updated_at: "2026-10-21T12:00:01.000001+00:00" } : null, error: null };
        },
        then: (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null }),
      };
      return q;
    },
  }),
}));

import { ApiError } from "@/lib/api/types";
import { POST } from "@/app/api/v1/messages/[id]/retry/route";

const id = "11111111-1111-4111-8111-111111111111";
const ctx = (mid = id) => ({ params: Promise.resolve({ id: mid }) });
const req = (body?: unknown) => new NextRequest(`http://localhost/api/v1/messages/${id}/retry`, {
  method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
});
const updates = () => state.chamadas.filter((c) => c.table === "messages" && c.op === "update");

beforeEach(() => {
  state.semSessao = false;
  state.role = "agent";
  state.travaPega = true;
  state.chamadas.length = 0;
  state.handler.mockReset();
  state.audit.mockClear();
  state.rate.mockClear();
  state.conversa = { id: "conversa-1", last_inbound_at: new Date().toISOString(), channel_sessions: { provider: "waha" } };
  state.linha = {
    id, organization_id: "org-1", conversation_id: "conversa-1", channel_session_id: "s-1", contact_id: "c-1",
    external_id: null, type: "text", direction: "outbound", status: "failed", ack: null,
    error_code: "channel_disabled", error_message: "Canal desativado", body: "oi", media_url: null,
    media_mime: null, media_size_bytes: null, media_storage_path: null, sent_via: "user", sent_by_user_id: "eu",
    sent_at: "2026-10-21T10:00:00.000Z", delivered_at: null, read_at: null,
    metadata: { queued_reason: "velho", outra: 1 }, edited_at: null, revoked_at: null,
    reply_to_message_id: "22222222-2222-4222-8222-222222222222", created_at: "2026-10-21T10:00:00.000Z",
    updated_at: "2026-10-21T10:00:00.123456+00:00",
  };
  state.handler.mockImplementation(async () => ({ ...state.linha, status: "queued" }));
});

describe("POST /api/v1/messages/{id}/retry", () => {
  it("autoriza antes de validar: id inválido sem sessão dá 401, não 422", async () => {
    state.semSessao = true;
    const res = await POST(req(), ctx("nao-e-uuid"));
    expect(res.status).toBe(401);
  });

  it("valida o id depois da autorização", async () => {
    const res = await POST(req(), ctx("nao-e-uuid"));
    expect(res.status).toBe(422);
  });

  it("agent não reenvia mensagem alheia (403), manager reenvia", async () => {
    state.linha = { ...state.linha, sent_by_user_id: "colega" };
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(state.handler).not.toHaveBeenCalled();
    state.role = "manager";
    expect((await POST(req(), ctx())).status).toBe(200);
  });

  it("viewer não reenvia nem a própria mensagem: o portão é agent", async () => {
    state.role = "viewer";
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(state.handler).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it("mensagem que não é desta organização: 404, sem envio", async () => {
    state.linha = null as unknown as Linha;
    expect((await POST(req(), ctx())).status).toBe(404);
    expect(state.handler).not.toHaveBeenCalled();
  });

  it("caso ambíguo sem confirmação: 409 confirmacao_necessaria, sem tocar na linha", async () => {
    state.linha = { ...state.linha, error_code: "send_timeout" };
    const res = await POST(req({}), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("confirmacao_necessaria");
    expect(updates()).toHaveLength(0);
    expect((await POST(req({ confirmado: true }), ctx())).status).toBe(200);
  });

  it("janela de 24h fechada no canal oficial: 422", async () => {
    state.conversa = { ...state.conversa, last_inbound_at: "2026-01-01T00:00:00.000Z", channel_sessions: { provider: "meta_cloud" } };
    const res = await POST(req(), ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("janela_fechada");
    expect(state.handler).not.toHaveBeenCalled();
  });

  it("trava pelo updated_at lido; 0 linhas dá 409 reenvio_em_curso e nada é enviado", async () => {
    state.travaPega = false;
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("reenvio_em_curso");
    expect(state.handler).not.toHaveBeenCalled();
    const [trava] = updates();
    expect(trava!.eqs).toEqual(expect.arrayContaining([
      ["id", id], ["organization_id", "org-1"], ["status", "failed"], ["updated_at", "2026-10-21T10:00:00.123456+00:00"],
    ]));
    expect(trava!.payload).toMatchObject({ status: "queued", error_code: null, error_message: null, external_id: null, metadata: { outra: 1 } });
    expect(trava!.payload!.metadata).not.toHaveProperty("queued_reason");
    expect(trava!.payload, "a trava mudou a hora antes de saber se a mensagem sai").not.toHaveProperty("sent_at");
  });

  it("chama o handler com internalMessageId e o input montado da linha", async () => {
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(state.handler).toHaveBeenCalledTimes(1);
    const [, hctx, input] = state.handler.mock.calls[0]!;
    expect(hctx).toMatchObject({ organization_id: "org-1", actor: { type: "user", id: "eu" }, internalMessageId: id });
    expect(input).toEqual({
      conversation_id: "conversa-1", type: "text", body: "oi", media_storage_path: undefined,
      media_mime: undefined, media_size_bytes: undefined, reply_to_message_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("ApiError do handler devolve o estado lido, pela trava, e repassa o erro", async () => {
    state.linha = { ...state.linha, external_id: "id-do-canal-velho" };
    state.handler.mockRejectedValueOnce(new ApiError(403, "forbidden", undefined, "r", "Contato bloqueou o atendimento."));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    const [, volta] = updates();
    expect(volta!.payload).toEqual({
      status: "failed", external_id: "id-do-canal-velho", error_code: "channel_disabled", error_message: "Canal desativado",
      metadata: { queued_reason: "velho", outra: 1 },
    });
    expect(volta!.eqs).toEqual(expect.arrayContaining([["status", "queued"], ["updated_at", "2026-10-21T12:00:01.000001+00:00"]]));
    expect(state.audit).not.toHaveBeenCalled();
  });

  it("erro que não é ApiError também devolve o estado lido, e é relançado", async () => {
    state.handler.mockRejectedValueOnce(new Error("rede do banco caiu"));
    await expect(POST(req(), ctx())).rejects.toThrow("rede do banco caiu");
    const [, volta] = updates();
    expect(volta, "a linha ficou queued sem motivo nem marca de falha").toBeDefined();
    expect(volta!.payload).toMatchObject({ status: "failed", error_code: "channel_disabled" });
    expect(volta!.eqs).toEqual(expect.arrayContaining([["status", "queued"], ["updated_at", "2026-10-21T12:00:01.000001+00:00"]]));
    expect(state.audit).not.toHaveBeenCalled();
  });

  it("audita message.retried", async () => {
    await POST(req({ confirmado: true }), ctx());
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "message.retried", organizationId: "org-1", resourceId: id,
      metadata: expect.objectContaining({
        status_anterior: "failed", error_code_anterior: "channel_disabled", sent_at_anterior: "2026-10-21T10:00:00.000Z", confirmado: true,
      }),
    }));
  });

  it("envio aceito vai para o fim do fio: a hora muda só depois que o canal aceitou", async () => {
    state.handler.mockImplementation(async () => ({ ...state.linha, status: "sent" }));
    const res = await POST(req(), ctx());
    const corpo = await res.json();
    const [, move] = updates();
    expect(move!.payload).toEqual({ sent_at: expect.any(String) });
    expect(move!.eqs).toEqual(expect.arrayContaining([["id", id], ["organization_id", "org-1"]]));
    expect(corpo.data.sent_at).toBe(move!.payload!.sent_at);
    expect(corpo.data.sent_at).not.toBe("2026-10-21T10:00:00.000Z");
  });

  it("o que ficou na fila de novo mantém a hora e o lugar", async () => {
    const res = await POST(req(), ctx());
    expect((await res.json()).data.sent_at).toBe("2026-10-21T10:00:00.000Z");
    expect(updates(), "só a trava; nenhuma escrita de hora").toHaveLength(1);
  });

  it("filtra organization_id na leitura da mensagem, na da conversa e na trava", async () => {
    await POST(req(), ctx());
    const doBanco = state.chamadas.filter((c) => c.table === "messages" || c.table === "conversations");
    expect(doBanco.length).toBeGreaterThanOrEqual(3);
    for (const c of doBanco) expect(c.eqs).toContainEqual(["organization_id", "org-1"]);
  });

  it("teto por pessoa: 429 com Retry-After", async () => {
    state.rate.mockResolvedValueOnce({ allowed: false, limit: 20, count: 21, window_sec: 60 });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});
