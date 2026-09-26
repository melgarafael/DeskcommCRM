/**
 * A janela de 24h vista de QUEM INTEGRA POR TOKEN (#1614).
 *
 * O servidor não olhava a janela: para canal com hetero-restrição, texto livre
 * com a janela fechada recebia 201, a linha virava `sent` e a Meta recusava a
 * ENTREGA depois, pelo webhook, com 131047 — o integrador registrava "cobrança
 * enviada" e o cliente nunca recebia. Aqui estão os quatro desfechos do conserto:
 *
 *   1. janela fechada + texto livre + token → 422 `janela_fechada`, com o
 *      detalhe que a rota promete (`use`, `codigo_plataforma`) e SEM linha
 *      gravada — nada nasce para depois virar `sent` mentindo;
 *   2. janela ABERTA + texto livre + token → segue aceitando como antes;
 *   3. modelo aprovado com a janela fechada → segue saindo (é a saída que o
 *      422 manda usar);
 *   4. canal por QR (sem janela) e quem digita na tela → intocados.
 *
 * Dublê compartilhado (`tests/helpers/duble-do-handler`): um sexto dublê local
 * é exatamente o que o gate `send-message-handler-nao-ganha-novo-duble` proíbe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { deriveActor } from "@/lib/mcp/auth";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

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

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TELEFONE = "+5531999998888";
const TOKEN_ID = "77777777-7777-4777-8777-777777777777";

const token = deriveActor(["mcp:write"], TOKEN_ID);
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** O ator é o da integração: o gate existe PARA ESTE caso. */
const ctxToken: HandlerCtx = { organization_id: ORG, actor: token, requestId: "req-1614" };
const ctxTela: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "55555555-5555-4555-8555-555555555555" },
  requestId: "req-tela",
};

function conversa(opts: { provider?: string; lastInboundAt?: string | null } = {}) {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: null,
    last_inbound_at: opts.lastInboundAt === undefined ? null : opts.lastInboundAt,
    contacts: { phone_number: TELEFONE, wa_identity: null, wa_lid: null, is_blocked: false },
    channel_sessions: {
      id: SESSION,
      organization_id: ORG,
      provider: opts.provider ?? "meta_cloud",
      waha_session_name: opts.provider === "waha" || !opts.provider ? "default" : null,
      status: "WORKING",
      archived_at: null,
    },
  };
}

function texto(): SendMessageInput {
  return { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput;
}

function metaAceita() {
  vi.stubEnv("META_PHONE_NUMBER_ID", "1103328999528818");
  vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.OK" }] }),
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("envio por token respeita a janela de 24h", () => {
  it("texto livre fora da janela: 422 janela_fechada, com o detalhe, e NADA é gravado", async () => {
    const ultima = horasAtras(30);
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: ultima }),
    });

    const erro = await sendMessageHandler(supabase, ctxToken, texto()).catch((e) => e);

    expect(erro, "o envio não foi recusado — voltou 201 para a plataforma recusar depois").toBeInstanceOf(
      ApiError,
    );
    expect((erro as ApiError).status).toBe(422);
    expect((erro as ApiError).code).toBe("janela_fechada");
    expect((erro as ApiError).details).toMatchObject({
      codigo: "janela_fechada",
      ultima_mensagem_do_cliente: ultima,
      use: "template",
      codigo_plataforma: "131047",
    });
    expect(
      capturas.inserts.messages,
      "uma linha nasceu para um envio que já se sabia recusado",
    ).toHaveLength(0);
    expect(capturas.patches.messages, "nada foi marcado `sent`").toHaveLength(0);
  });

  it("cliente que NUNCA escreveu também é recusado — a janela nunca abriu", async () => {
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: null }),
    });

    const erro = await sendMessageHandler(supabase, ctxToken, texto()).catch((e) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).code).toBe("janela_fechada");
    expect((erro as ApiError).details).toMatchObject({ ultima_mensagem_do_cliente: null });
    expect(capturas.inserts.messages).toHaveLength(0);
  });

  it("dentro da janela, o texto livre segue aceitando como antes", async () => {
    metaAceita();
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: horasAtras(1) }),
    });

    const msg = await sendMessageHandler(supabase, ctxToken, texto());

    expect(capturas.inserts.messages).toHaveLength(1);
    expect((msg as { status: string }).status).toBe("sent");
  });

  it("modelo aprovado com a janela fechada continua saindo — é a saída que o 422 indica", async () => {
    metaAceita();
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: horasAtras(48) }),
      templateRow: {
        name: "pedido_confirmado",
        language: "pt_BR",
        status: "APPROVED",
        contract_hash: "h",
        components: [{ type: "BODY", text: "Ola {{1}}" }],
      },
    });

    const msg = await sendMessageHandler(supabase, ctxToken, {
      conversation_id: CONV,
      type: "template",
      template_name: "pedido_confirmado",
      template_language: "pt_BR",
      template_values: { "1": "Rafael" },
    } as SendMessageInput);

    expect(capturas.inserts.messages).toHaveLength(1);
    expect((msg as { status: string }).status).toBe("sent");
  });

  it("canal por QR, sem janela: nada muda (o texto segue sendo aceito)", async () => {
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ provider: "waha", lastInboundAt: null }),
    });

    const msg = await sendMessageHandler(supabase, ctxToken, texto());

    expect(capturas.inserts.messages).toHaveLength(1);
    // Sem WAHA configurado ele nasce em fila — o desfecho de SEMPRE, o que
    // prova que o gate novo não alcançou o canal sem restrição.
    expect((msg as { status: string }).status).toBe("queued");
  });

  it("quem digita na tela não passa por aqui: a tela já barre o composer", async () => {
    // Escopo da #1614: quem integra por token. O operador é barrado no cliente
    // com a MESMA régua (estadoDaJanela), então o contrato dele não muda.
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: horasAtras(30) }),
    });

    const msg = await sendMessageHandler(supabase, ctxTela, texto());

    expect(capturas.inserts.messages).toHaveLength(1);
    expect((msg as { status: string }).status).not.toBe("failed");
  });
});
