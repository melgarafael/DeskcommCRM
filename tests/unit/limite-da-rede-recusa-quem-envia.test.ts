/**
 * O limite de resposta do TikTok visto de QUEM ENVIA (A21).
 *
 * A cadeia `before_send` aplica o limite à IA; esta é a porta de saída de quem digita
 * na tela e de quem integra por token (`sendMessageHandler`). O que se prova aqui, e
 * por quê:
 *
 *  1. as 10 respostas já saíram → 422 `limite_da_rede` com a SAÍDA no texto, e NADA é
 *     gravado: sem isto a linha nascia `queued`, saía e voltava `failed` com o erro
 *     cru do TikTok;
 *  2. o agente por token respeita a reserva: com 8 já enviadas, a IA é recusada e a
 *     equipe (que usa as 2 últimas) não;
 *  3. a janela de 48 h vale para quem DIGITA na tela — a de 24 h do servidor só olha
 *     token, então sem esta régua o operador mandava fora da janela da rede.
 *
 * A contagem (`contarRespostasNaJanela`) é dublada: é uma leitura de `messages` que o
 * dublê compartilhado do handler não conhece, e a conta em si tem teste próprio.
 */
import { describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { contarRespostasNaJanela } from "@/lib/channels/social/respostas-na-janela";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/social/respostas-na-janela", () => ({
  contarRespostasNaJanela: vi.fn(),
}));

const mockedContar = vi.mocked(contarRespostasNaJanela);

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const ctxEquipe: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "55555555-5555-4555-8555-555555555555" },
  requestId: "req-tiktok-equipe",
};
const ctxAgente = {
  organization_id: ORG,
  actor: { type: "ai_agent", id: "66666666-6666-4666-8666-666666666666" },
  requestId: "req-tiktok-agente",
} as unknown as HandlerCtx;

function conversaDoTiktok(lastInboundAt: string | null) {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: "tiktok-thread-1",
    last_inbound_at: lastInboundAt,
    contacts: {
      phone_number: null,
      wa_identity: null,
      wa_lid: null,
      social_identity: "tiktok:conta:participante",
      is_blocked: false,
      is_personal: false,
    },
    channel_sessions: {
      id: SESSION,
      organization_id: ORG,
      provider: "zernio_social",
      waha_session_name: null,
      status: "WORKING",
      archived_at: null,
      metadata: { social_platform: "tiktok" },
    },
  };
}

function texto(): SendMessageInput {
  return { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput;
}

async function recusa(ctx: HandlerCtx, lastInboundAt: string | null, respostas: number | null) {
  mockedContar.mockResolvedValue(respostas);
  const { supabase, capturas } = criarDubleDoHandler({ conversation: conversaDoTiktok(lastInboundAt) });
  const erro = await sendMessageHandler(supabase, ctx, texto()).catch((e) => e);
  return { erro, capturas };
}

describe("envio no TikTok respeita o limite da rede", () => {
  it("10 respostas já saíram: 422 limite_da_rede com o detalhe, e NADA é gravado", async () => {
    const { erro, capturas } = await recusa(ctxEquipe, horasAtras(2), 10);

    expect(erro, "o envio não foi recusado — o TikTok recusaria depois com o erro cru").toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(422);
    expect((erro as ApiError).code).toBe("limite_da_rede");
    expect((erro as ApiError).details).toMatchObject({
      codigo: "teto_da_rede",
      rede: "tiktok",
      respostas_na_janela: 10,
    });
    expect((erro as ApiError).message).toMatch(/10 respostas em 48 h/);
    expect(capturas.inserts.messages, "uma linha nasceu para um envio já recusado").toHaveLength(0);
  });

  it("o agente por token com 8 enviadas é recusado (reserva da equipe)", async () => {
    const { erro } = await recusa(ctxAgente, horasAtras(2), 8);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).code).toBe("limite_da_rede");
    expect((erro as ApiError).details).toMatchObject({ codigo: "reserva_da_equipe" });
  });

  it("a equipe com 8 enviadas NÃO é recusada por este limite — usa as 2 últimas", async () => {
    const { erro } = await recusa(ctxEquipe, horasAtras(2), 8);
    // o envio segue além desta régua; o que importa é que NÃO é `limite_da_rede`
    expect(erro instanceof ApiError && erro.code === "limite_da_rede").toBe(false);
  });

  it("quem digita na tela fora das 48 h é recusado com a janela da rede", async () => {
    const { erro } = await recusa(ctxEquipe, horasAtras(50), 0);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).code).toBe("limite_da_rede");
    expect((erro as ApiError).details).toMatchObject({ codigo: "janela_da_rede_fechada" });
  });

  it("cliente que nunca escreveu: janela fechada, e a contagem nem é lida", async () => {
    mockedContar.mockClear();
    const { erro } = await recusa(ctxEquipe, null, 0);
    expect((erro as ApiError).details).toMatchObject({ codigo: "janela_da_rede_fechada" });
    expect(mockedContar).not.toHaveBeenCalled();
  });

  it("leitura da contagem falhou (null): fail-open — não é recusa por este limite", async () => {
    const { erro } = await recusa(ctxEquipe, horasAtras(2), null);
    expect(erro instanceof ApiError && erro.code === "limite_da_rede").toBe(false);
  });
});
