import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A MENSAGEM QUE O CANAL MANDOU DESACELERAR SAI DE NOVO — UMA VEZ, NA MESMA LINHA.
 *
 * ─── Os dois defeitos (27/10/2026) ─────────────────────────────────────────
 *
 * 1. O adapter do canal intermediado só reconhecia o 131056 quando ele vinha em
 *    `code`. Na forma documentada do OpenAPI v1.370.0 ele vem em
 *    `platformError.code`, com `code: "platform_api_error"` e texto livre; e o
 *    429 `rate_limited` (changelog de 25/09, "No message was sent") também caía
 *    no genérico. Os dois viravam `failed`.
 * 2. Mesmo quando virava `queued`, ninguém mandava de novo: o comentário do
 *    envio dizia que o agent-engine reagendava, e o turno do agente lê `queued`
 *    como "aguardando o canal" e termina. O pedido de nova tentativa
 *    (`message.throttled_resend_requested`) e o consumidor dele fecham isso.
 */

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/a.jpg" }, error: null }),
      }),
    },
  }),
}));
vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveZernioCreds: async () => ({
    accountId: "acc_1",
    apiKey: "chave",
    baseUrl: "https://z.example",
    source: "session" as const,
  }),
}));

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { zernioAdapter } from "@/lib/channels/adapters/zernio";
import {
  codigoDaPlataforma,
  ehLimiteDeVelocidade,
  esperaPedidaPeloCanal,
  segundosDoRetryAfter,
} from "@/lib/channels/erro-da-plataforma";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { getRegisteredHandlers } from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  ESPERA_MAXIMA_MS,
  ESPERA_MINIMA_MS,
  ESPERA_PADRAO_MS,
  MAX_REENVIOS,
  TETO_DA_ESPERA_DA_FILA_MS,
  esperaDoPedido,
  reenvioDesaceleradoHandler,
  tratarReenvioDesacelerado,
} from "@/lib/messaging/reenvio-desacelerado.handler";
import { EVENTO_REENVIO_DESACELERADO, reenvioDesaceleradoAtende } from "@/lib/messaging/reenvio-desacelerado";
import { reenvioDaMensagem } from "@/lib/messaging/reenvio";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

function resposta(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const ENVELOPE = {
  organizationId: "org-1",
  sessionRef: "acc_1",
  to: "5511900000001",
  providerConversationId: "conv_1",
  kind: "text" as const,
  body: "olá",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("o adapter reconhece o pedido de desacelerar", () => {
  it("⭐ 131056 em `platformError.code` (a forma do OpenAPI) → código de throttle, não falha", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        resposta(400, {
          error: "Too many messages sent to this recipient",
          type: "platform_error",
          code: "platform_api_error",
          platform: "whatsapp",
          platformError: { code: 131056, fbtraceId: "abc" },
        }),
      ),
    );
    await expect(zernioAdapter.send(ENVELOPE)).rejects.toThrow(/^zernio_throttled: 400/);
  });

  it("⭐ 429 `rate_limited` → throttle, com o `Retry-After` carimbado para quem reagenda", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resposta(429, { error: "Rate limited by Meta", code: "rate_limited" }, { "retry-after": "30" })),
    );
    const erro = await zernioAdapter.send(ENVELOPE).catch((e: Error) => e);
    expect(String((erro as Error).message)).toMatch(/^zernio_throttled: 429 rate_limited/);
    expect(esperaPedidaPeloCanal((erro as Error).message)).toBe(30_000);
  });

  it("429 sem `Retry-After`: throttle sem espera carimbada — quem reagenda usa a sua", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resposta(429, { error: "slow down", code: "rate_limited" })));
    const erro = (await zernioAdapter.send(ENVELOPE).catch((e: Error) => e)) as Error;
    expect(erro.message).toMatch(/^zernio_throttled/);
    expect(esperaPedidaPeloCanal(erro.message)).toBeNull();
  });

  it("controle: outra recusa da plataforma continua sendo falha", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        resposta(400, { error: "Re-engagement message", code: "platform_api_error", platformError: { code: 131047 } }),
      ),
    );
    await expect(zernioAdapter.send(ENVELOPE)).rejects.toThrow(/^zernio_send_failed/);
  });

  it("o `Retry-After` vale em segundos e em data HTTP", () => {
    expect(segundosDoRetryAfter("45")).toBe(45);
    const agora = Date.parse("2026-10-27T12:00:00Z");
    expect(segundosDoRetryAfter("Tue, 27 Oct 2026 12:01:30 GMT", agora)).toBe(90);
    expect(segundosDoRetryAfter(null)).toBeNull();
    expect(segundosDoRetryAfter("amanhã")).toBeNull();
  });
});

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

function conversa() {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: "6a76a2dc4b8fe115e5f6c300",
    last_inbound_at: new Date(Date.now() - 3_600_000).toISOString(),
    contacts: { phone_number: "+5511900000001", wa_identity: null, wa_lid: null, is_blocked: false },
    channel_sessions: {
      id: SESSION,
      organization_id: ORG,
      provider: "zernio",
      waha_session_name: null,
      zernio_account_id: "acc_1",
      status: "WORKING",
      archived_at: null,
    },
  };
}

describe("o envio grava `queued` e PEDE a nova tentativa", () => {
  it("⭐ 429 com Retry-After: a linha fica `queued` com o motivo, e sai o pedido com a espera", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resposta(429, { error: "Rate limited", code: "rate_limited" }, { "retry-after": "120" })),
    );
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversa() });
    const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };

    const msg = await sendMessageHandler(supabase, ctx, { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput);

    expect((msg as { status: string }).status).toBe("queued");
    expect((msg as { metadata?: Record<string, unknown> }).metadata).toMatchObject({ queued_reason: "zernio_throttled" });
    const pedidos = capturas.rpcs.filter((r) => r.nome === "emit_event" && r.args.p_event_type === EVENTO_REENVIO_DESACELERADO);
    expect(pedidos, "um desacelerar, um pedido").toHaveLength(1);
    expect(pedidos[0]!.args).toMatchObject({
      p_entity_kind: "message",
      p_organization_id: ORG,
      p_payload: { queued_reason: "zernio_throttled", espera_ms: 120_000 },
    });
    // Não é falha: nada de `message.failed` para o integrador.
    expect(capturas.rpcs.some((r) => r.args.p_event_type === "message.failed")).toBe(false);
  });

  it("⭐ campanha (laço próprio): o 429 segue `failed`, com o texto que a campanha reconhece, e nenhum pedido sai", async () => {
    // A campanha lê `failed` e devolve a pessoa à fila pelo `ehLimiteDeVelocidade`
    // (`lib/campanhas/rodada.ts`). Gravar `queued` aqui deixaria a linha sem dono
    // — o consumidor pula `automation` — e o destinatário contado como enviado.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resposta(429, { error: "Rate limited", code: "rate_limited" }, { "retry-after": "120" })),
    );
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversa() });
    const ctx: HandlerCtx = {
      organization_id: ORG,
      actor: { type: "webhook_source", id: "campaign:c-1" },
      requestId: "req-2",
    };

    const msg = await sendMessageHandler(supabase, ctx, { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput);

    expect((msg as { status: string }).status).toBe("failed");
    const erro = String((msg as { error_message?: string }).error_message ?? "");
    expect(ehLimiteDeVelocidade(codigoDaPlataforma(null, erro), erro), "a campanha precisa ler o 429").toBe(true);
    expect(capturas.rpcs.some((r) => r.args.p_event_type === EVENTO_REENVIO_DESACELERADO)).toBe(false);
    expect(reenvioDesaceleradoAtende("automation")).toBe(false);
    expect(reenvioDesaceleradoAtende("system")).toBe(false);
  });

  it("o consumidor do pedido está no barramento — sem ele o pedido fica `pending` para sempre", () => {
    ensureHandlersRegistered();
    const consumidores = getRegisteredHandlers().filter((h) => h.events.includes(EVENTO_REENVIO_DESACELERADO));
    expect(consumidores.map((h) => h.key)).toEqual([reenvioDesaceleradoHandler.key]);
    expect(reenvioDesaceleradoHandler.naOrgParada, "reenviar é falar com o cliente").toBe("pula");
  });
});

// ─── o consumidor ──────────────────────────────────────────────────────────

const CRIADO = Date.parse("2026-10-27T12:00:00Z");

function evento(payload: Record<string, unknown> = {}): EventRow {
  return {
    id: "ev-1",
    organization_id: ORG,
    event_type: EVENTO_REENVIO_DESACELERADO,
    entity_kind: "message",
    entity_id: "msg-1",
    payload: { message_id: "msg-1", queued_reason: "zernio_throttled", espera_ms: null, ...payload },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date(CRIADO).toISOString(),
  } as unknown as EventRow;
}

interface Estado {
  mensagem: Record<string, unknown> | null;
  /** A `metadata` da mensagem escrita antes, ainda `queued`, na mesma conversa — `null` = não há. */
  naFrente: Record<string, unknown> | null;
  jobDoTurno: string | null;
  /** Leitura congelada: o que os dois consumidores leram ANTES de qualquer trava. */
  leitura?: Record<string, unknown>;
}

/** Banco de mentira só com o que o consumidor lê e escreve: a linha, a fila da conversa e o turno do agente. */
function bancoFalso(estado: Estado) {
  const updates: { patch: Record<string, unknown>; filtros: Record<string, unknown> }[] = [];
  let versao = 1;
  const from = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const exec = () => {
      if (tabela === "messages" && patch) {
        const m = estado.mensagem;
        const casa =
          m &&
          (filtros.status === undefined || m.status === filtros.status) &&
          (filtros.updated_at === undefined || m.updated_at === filtros.updated_at);
        updates.push({ patch, filtros: { ...filtros } });
        if (!casa) return { data: null, error: null };
        Object.assign(m!, patch, { updated_at: `v${++versao}` });
        return { data: { id: m!.id, updated_at: m!.updated_at }, error: null };
      }
      if (tabela === "messages" && filtros.conversation_id) {
        return { data: estado.naFrente ? [{ id: "msg-0", metadata: estado.naFrente }] : [], error: null };
      }
      if (tabela === "messages") {
        const lida = estado.leitura ?? estado.mensagem;
        return { data: lida ? structuredClone(lida) : null, error: null };
      }
      if (tabela === "send_ledger") return { data: estado.jobDoTurno ? { job_id: "job-1" } : null, error: null };
      if (tabela === "job_queue") return { data: estado.jobDoTurno ? { status: estado.jobDoTurno } : null, error: null };
      return { data: null, error: null };
    };
    const cadeia: Record<string, unknown> = {
      select: () => cadeia,
      update: (p: Record<string, unknown>) => {
        patch = p;
        return cadeia;
      },
      eq: (c: string, v: unknown) => {
        filtros[c] = v;
        return cadeia;
      },
      neq: () => cadeia,
      lt: () => cadeia,
      gt: () => cadeia,
      limit: () => cadeia,
      maybeSingle: async () => exec(),
      then: (ok: (v: unknown) => unknown) => {
        const r = exec();
        const data = r.data === null ? [] : Array.isArray(r.data) ? r.data : [r.data];
        return Promise.resolve(ok({ data, error: null }));
      },
    };
    return cadeia;
  };
  const rpcs: { nome: string; args: Record<string, unknown> }[] = [];
  return {
    admin: { from, rpc: async (nome: string, args: Record<string, unknown>) => (rpcs.push({ nome, args }), { error: null }) },
    updates,
    rpcs,
  };
}

function linha(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg-1",
    conversation_id: CONV,
    contact_id: CONTACT,
    direction: "outbound",
    status: "queued",
    type: "text",
    body: "Oi, de qual cidade você é?",
    media_storage_path: null,
    media_mime: null,
    media_size_bytes: null,
    reply_to_message_id: null,
    sent_via: "ai",
    sent_by_user_id: null,
    metadata: { queued_reason: "zernio_throttled", ai_actor_id: "agente-1" },
    created_at: new Date(CRIADO - 1_000).toISOString(),
    updated_at: "v1",
    ...over,
  };
}

describe("o consumidor manda de novo — uma vez, na mesma linha", () => {
  let estado: Estado;
  beforeEach(() => {
    estado = { mensagem: linha(), naFrente: null, jobDoTurno: "done" };
  });

  it("espera o que o canal pediu, dentro da faixa", async () => {
    const banco = bancoFalso(estado);
    const r = await tratarReenvioDesacelerado(evento({ espera_ms: 120_000 }), {
      admin: banco.admin as never,
      agora: () => CRIADO + 1_000,
      enviar: vi.fn(),
    });
    expect(r).toMatchObject({ status: "retry", retry_at: new Date(CRIADO + 120_000).toISOString() });
    expect(banco.updates).toHaveLength(0);
    expect(esperaDoPedido(null)).toBe(ESPERA_PADRAO_MS);
    expect(esperaDoPedido(1_000)).toBe(ESPERA_MINIMA_MS);
    expect(esperaDoPedido(86_400_000)).toBe(ESPERA_MAXIMA_MS);
  });

  it("⭐ chegada a hora: trava a linha, manda pelo handler de envio com a MESMA linha e o mesmo autor", async () => {
    const banco = bancoFalso(estado);
    const enviar = vi.fn(async () => ({ id: "msg-1", status: "sent" }));
    const r = await tratarReenvioDesacelerado(evento(), {
      admin: banco.admin as never,
      agora: () => CRIADO + ESPERA_PADRAO_MS,
      enviar: enviar as never,
    });

    expect(r).toMatchObject({ status: "ok", detail: "reenvio_sent" });
    expect(enviar).toHaveBeenCalledOnce();
    const [, ctx, corpo] = enviar.mock.calls[0] as unknown as [unknown, HandlerCtx, SendMessageInput];
    expect(ctx).toMatchObject({
      organization_id: ORG,
      internalMessageId: "msg-1",
      actor: { type: "ai_agent", id: "agente-1" },
    });
    expect(corpo).toMatchObject({ conversation_id: CONV, type: "text", body: "Oi, de qual cidade você é?" });
    // A trava tirou o motivo e contou a tentativa — antes de enviar.
    const trava = banco.updates[0]!;
    expect(trava.filtros).toMatchObject({ status: "queued", updated_at: "v1" });
    expect(trava.patch.metadata).toEqual({ ai_actor_id: "agente-1", reenvios_automaticos: 1 });
  });

  it("⭐ dois consumidores que leram a linha ao mesmo tempo: só UM envio (a trava pelo updated_at)", async () => {
    // Os dois leem a MESMA versão (`v1`, ainda com o motivo); o primeiro trava e
    // a linha viva passa a `v2` — a trava do segundo não pega.
    estado.leitura = structuredClone(estado.mensagem!);
    const banco = bancoFalso(estado);
    const enviar = vi.fn(async () => ({ id: "msg-1", status: "sent" }));
    const deps = { admin: banco.admin as never, agora: () => CRIADO + ESPERA_PADRAO_MS, enviar: enviar as never };

    const a = await tratarReenvioDesacelerado(evento(), deps);
    const b = await tratarReenvioDesacelerado(evento(), deps);

    expect(a).toMatchObject({ status: "ok", detail: "reenvio_sent" });
    expect(b).toMatchObject({ status: "skipped", detail: "outro_reenvio_em_curso" });
    expect(enviar).toHaveBeenCalledOnce();
  });

  it("depois que saiu, um pedido atrasado não reenvia", async () => {
    estado.mensagem = linha({ status: "sent" });
    const enviar = vi.fn();
    const r = await tratarReenvioDesacelerado(evento(), {
      admin: bancoFalso(estado).admin as never,
      agora: () => CRIADO + ESPERA_PADRAO_MS,
      enviar,
    });
    expect(r).toMatchObject({ status: "skipped", detail: "ja_nao_espera" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("depois do toque da pessoa em Reenviar (que tira o motivo), o consumidor não reenvia", async () => {
    estado.mensagem = linha({ metadata: { ai_actor_id: "agente-1" } });
    const enviar = vi.fn();
    const r = await tratarReenvioDesacelerado(evento(), {
      admin: bancoFalso(estado).admin as never,
      agora: () => CRIADO + ESPERA_PADRAO_MS,
      enviar,
    });
    expect(r).toMatchObject({ status: "skipped", detail: "ja_nao_espera" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("a trava deixa o botão de reenvio da pessoa ler 'em voo' — não 'seguro'", () => {
    const base = { organization_id: ORG, conversation_id: CONV, direction: "outbound", sent_via: "user", sent_by_user_id: USER, type: "text", body: "oi", status: "queued", error_code: null, media_storage_path: null };
    const quem = { userId: USER, podeReenviarDeOutros: false, agora: Date.parse("2026-10-27T12:01:00Z") };
    expect(reenvioDaMensagem({ ...base, metadata: { queued_reason: "zernio_throttled" } }, quem)).toBe("seguro");
    expect(
      reenvioDaMensagem({ ...base, metadata: { reenvios_automaticos: 1 }, updated_at: "2026-10-27T12:00:59Z" }, quem),
    ).toBe("nenhum");
  });

  it("mensagem do agente cujo turno ainda vive: o turno é dono, espera", async () => {
    estado.jobDoTurno = "running";
    const enviar = vi.fn();
    const r = await tratarReenvioDesacelerado(evento(), {
      admin: bancoFalso(estado).admin as never,
      agora: () => CRIADO + ESPERA_PADRAO_MS,
      enviar,
    });
    expect(r).toMatchObject({ status: "retry", detail: "turno_ainda_e_dono" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it.each([
    ["ainda com o motivo", { queued_reason: "zernio_throttled" }],
    ["travada por outra nova tentativa", { reenvios_automaticos: 1 }],
  ])("a de trás espera a da frente (%s) — saem na ordem em que foram escritas", async (_caso, metadata) => {
    estado.naFrente = metadata;
    const enviar = vi.fn();
    const r = await tratarReenvioDesacelerado(evento(), {
      admin: bancoFalso(estado).admin as never,
      agora: () => CRIADO + ESPERA_PADRAO_MS,
      enviar,
    });
    expect(r).toMatchObject({ status: "retry", detail: "espera_a_da_frente" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("⭐ a da frente presa por OUTRO motivo (canal sem credencial) não trava a conversa", async () => {
    estado.naFrente = { queued_reason: "zernio_not_configured" };
    const enviar = vi.fn(async () => ({ id: "msg-1", status: "sent" }));
    const r = await tratarReenvioDesacelerado(evento(), {
      admin: bancoFalso(estado).admin as never,
      agora: () => CRIADO + ESPERA_PADRAO_MS,
      enviar: enviar as never,
    });
    expect(r).toMatchObject({ status: "ok", detail: "reenvio_sent" });
  });

  it("e a espera pela da frente tem teto: passado ele, a de trás segue sozinha", async () => {
    estado.naFrente = { queued_reason: "zernio_throttled" };
    const enviar = vi.fn(async () => ({ id: "msg-1", status: "sent" }));
    const r = await tratarReenvioDesacelerado(evento(), {
      admin: bancoFalso(estado).admin as never,
      agora: () => CRIADO + TETO_DA_ESPERA_DA_FILA_MS,
      enviar: enviar as never,
    });
    expect(r).toMatchObject({ status: "ok", detail: "reenvio_sent" });
  });

  it.each(["automation", "system"])(
    "origem `%s` tem o próprio laço de nova tentativa — o consumidor não entra (dois donos, duas mensagens)",
    async (sentVia) => {
      estado.mensagem = linha({ sent_via: sentVia });
      const enviar = vi.fn();
      const r = await tratarReenvioDesacelerado(evento(), {
        admin: bancoFalso(estado).admin as never,
        agora: () => CRIADO + ESPERA_PADRAO_MS,
        enviar,
      });
      expect(r).toMatchObject({ status: "skipped", detail: "tem_outro_dono" });
      expect(enviar).not.toHaveBeenCalled();
    },
  );

  it("a pessoa que escreveu continua sendo a autora da nova tentativa", async () => {
    estado.mensagem = linha({ sent_via: "user", sent_by_user_id: USER, metadata: { queued_reason: "zernio_throttled" } });
    const enviar = vi.fn(async () => ({ id: "msg-1", status: "sent" }));
    await tratarReenvioDesacelerado(evento(), {
      admin: bancoFalso(estado).admin as never,
      agora: () => CRIADO + ESPERA_PADRAO_MS,
      enviar: enviar as never,
    });
    expect((enviar.mock.calls[0] as unknown as [unknown, HandlerCtx])[1].actor).toEqual({ type: "user", id: USER });
  });

  it("⭐ esgotadas as tentativas: `failed` com o motivo, e a falha vira `message.failed`", async () => {
    estado.mensagem = linha({ metadata: { queued_reason: "zernio_throttled", reenvios_automaticos: MAX_REENVIOS } });
    const banco = bancoFalso(estado);
    const enviar = vi.fn();
    const r = await tratarReenvioDesacelerado(evento(), { admin: banco.admin as never, agora: () => CRIADO + ESPERA_PADRAO_MS, enviar });
    expect(r).toMatchObject({ status: "ok", detail: "desistiu" });
    expect(enviar).not.toHaveBeenCalled();
    expect(estado.mensagem).toMatchObject({ status: "failed", error_code: "zernio_throttled" });
    expect(banco.rpcs.find((x) => x.args.p_event_type === "message.failed")?.args).toMatchObject({
      p_payload: { message_id: "msg-1", erro: { codigo: "zernio_throttled" } },
    });
  });

  it("recusa do envio antes do canal (ex.: janela fechada): `failed` com o código, nunca esperando para sempre", async () => {
    const banco = bancoFalso(estado);
    const enviar = vi.fn(async () => {
      throw new ApiError(422, "janela_fechada", undefined, "req", "Janela de 24 horas fechada");
    });
    const r = await tratarReenvioDesacelerado(evento(), { admin: banco.admin as never, agora: () => CRIADO + ESPERA_PADRAO_MS, enviar: enviar as never });
    expect(r).toMatchObject({ status: "ok", detail: "recusado_janela_fechada" });
    expect(estado.mensagem).toMatchObject({ status: "failed", error_code: "janela_fechada" });
  });

  it("erro inesperado: devolve o motivo à linha e tenta no próximo tique", async () => {
    const banco = bancoFalso(estado);
    const enviar = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const r = await tratarReenvioDesacelerado(evento(), { admin: banco.admin as never, agora: () => CRIADO + ESPERA_PADRAO_MS, enviar: enviar as never });
    expect(r).toMatchObject({ status: "retry", detail: "falha_transitoria" });
    expect(estado.mensagem).toMatchObject({ status: "queued", metadata: { queued_reason: "zernio_throttled", reenvios_automaticos: 1 } });
  });

  it("mídia fora da pasta da conversa não é reconstruída — o handler a recusaria e a espera viraria falha", async () => {
    estado.mensagem = linha({ type: "image", body: null, media_storage_path: "org/outra/coisa.jpg" });
    const enviar = vi.fn();
    const r = await tratarReenvioDesacelerado(evento(), { admin: bancoFalso(estado).admin as never, agora: () => CRIADO + ESPERA_PADRAO_MS, enviar });
    expect(r).toMatchObject({ status: "skipped", detail: "conteudo_nao_reenviavel" });
  });
});
