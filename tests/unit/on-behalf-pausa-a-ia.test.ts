/**
 * Envio com `on_behalf_of_user_id` pausa a IA como a resposta da TELA (#3421).
 *
 * ─── O defeito, medido na main de 25/10/2026 ───────────────────────────────
 *
 * `app/api/v1/messages/_handler.ts` só estende o carimbo `bot_silenced_until`
 * quando `ctx.actor.type === "user"`. O envio em nome de uma pessoa
 * (`on_behalf_of_user_id` — escopo `messages:on_behalf` + membership validados
 * em `app/api/v1/messages/route.ts:103-179`) chega com ator `api_token`: a
 * linha nasce `sent_via 'system'` (o vocabulário da #866, intocado) e a IA
 * seguia respondendo a conversa junto com o atendente — embora a decisão tenha
 * sido de gente da equipe, exatamente o caso em que ela DIGITA na tela.
 *
 * ─── O que aqui é medido, critério a critério ──────────────────────────────
 *
 * (A) o carimbo do envio em nome de é a MESMA string — mesmo valor, mesmo
 *     tamanho — que a resposta da tela grava no MESMO instante (relógio
 *     travado); com ele vêm (D) a duração: `now + 5min`
 *     (`HUMAN_REPLY_SILENCE_MS`, `_handler.ts:415`), finita, nunca 'infinity';
 * (B) a linha continua nascendo como sempre: `sent_via 'system'` e
 *     `sent_on_behalf_of_user_id` preenchido — sem reescrever a história;
 * (C) envio SEM `on_behalf` (automação e token puro) NÃO grava o carimbo —
 *     regressão zero medida nos dois atores que o ramo novo alcança;
 * (D) a régua é a da tela: silêncio já maior não é encurtado;
 * (E) o espelho do MOTOR (`comandoDaConversa`,
 *     `lib/inbox/comando-da-conversa.ts:216`) lê o carimbo e devolve
 *     `automaticoAtivo: true` no instante do fim — a IA volta sozinha;
 * (F) sem o ramo novo, o cenário A fica VERMELHO (é a sabotagem da PR).
 *
 * Dublê COMPARTILHADO (`tests/helpers/duble-do-handler.ts`): um dublê local é
 * o que a catraca `send-message-handler-nao-ganha-novo-duble` proíbe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import {
  comandoDaConversa,
  type FatosDoComando,
} from "@/lib/inbox/comando-da-conversa";
import { deriveActor } from "@/lib/mcp/auth";
import type { SendMessageInput } from "@/lib/schemas";
import {
  criarDubleDoHandler,
  type CapturasDoDubleDoHandler,
} from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const TOKEN_ID = "77777777-7777-4777-8777-777777777777";
const BARE = "3EB0ABCDEF0123456789";

/** A janela da TELA: `HUMAN_REPLY_SILENCE_MS` (_handler.ts:415). */
const JANELA_MS = 5 * 60 * 1000;
/** Relógio travado: sem isto "mesmo carimbo da tela" viraria comparação de tolerância. */
const AGORA = new Date("2026-10-25T15:00:00.000Z");
/** O instante exato até onde a tela cala a IA no relógio travado. */
const ESPERA_DA_TELA = new Date(AGORA.getTime() + JANELA_MS).toISOString();

/** O ator do envio em nome de: token com o escopo, como a rota o entrega. */
const ctxEmNomeDe: HandlerCtx = {
  organization_id: ORG,
  actor: deriveActor(["mcp:write", "messages:on_behalf"], TOKEN_ID),
  onBehalfOf: { userId: USER, userName: "Fulano da Silva", tokenName: "ERP Externo" },
  requestId: "req-3421-em-nome-de",
};
const ctxTela: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USER },
  requestId: "req-3421-tela",
};
const ctxAutomacao: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "webhook_source", id: "regra-1" },
  requestId: "req-3421-regra",
};
const ctxTokenPuro: HandlerCtx = {
  organization_id: ORG,
  actor: deriveActor(["mcp:write"], TOKEN_ID),
  requestId: "req-3421-token",
};

const input = {
  conversation_id: CONV,
  type: "text",
  body: "Boa tarde! Retorno do seu caso conforme combinado.",
} as SendMessageInput;
const inputEmNomeDe = { ...input, on_behalf_of_user_id: USER } as SendMessageInput;

/** WAHA por QR: sem janela de 24h — o gate da #1614 é do canal com hetero-restrição. */
function conversa(botSilencedUntil: string | null) {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: botSilencedUntil,
    provider_conversation_id: null,
    last_inbound_at: new Date(AGORA.getTime() - 3 * 3_600_000).toISOString(),
    contacts: { phone_number: "+553****8888", wa_identity: null, wa_lid: null, is_blocked: false },
    channel_sessions: {
      provider: "waha",
      waha_session_name: "default",
      status: "WORKING",
      archived_at: null,
      metadata: {},
    },
  };
}

function wahaRespondendo() {
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ id: { id: BARE } }), { status: 200 })),
  );
}

/** O patch que o envio mandou para `conversations` — ou `{}`, quando não mandou. */
function patchDaConversa(capturas: CapturasDoDubleDoHandler): Record<string, unknown> {
  return capturas.patches.conversations?.at(-1) ?? {};
}

beforeEach(() => {
  // Só o relógio: o resto da suíte continua com os timers reais.
  vi.useFakeTimers({ now: AGORA, toFake: ["Date"] });
  wahaRespondendo();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/v1/messages com on_behalf_of_user_id cala a IA (#3421)", () => {
  it("⭐ grava o MESMO carimbo da resposta da tela, e a linha continua 'system'", async () => {
    // O controle: o que a TELA grava neste relógio travado.
    const tela = criarDubleDoHandler({ conversation: conversa(null) });
    await sendMessageHandler(tela.supabase, ctxTela, input);
    const carimboDaTela = patchDaConversa(tela.capturas).bot_silenced_until;
    expect(carimboDaTela, "controle: a resposta da tela pausa a IA").toBe(ESPERA_DA_TELA);

    // E o token, em nome da MESMA pessoa, no MESMO instante.
    const emNomeDe = criarDubleDoHandler({ conversation: conversa(null) });
    await sendMessageHandler(emNomeDe.supabase, ctxEmNomeDe, inputEmNomeDe);
    const carimbo = patchDaConversa(emNomeDe.capturas).bot_silenced_until;

    expect(
      carimbo,
      "o envio em nome de não pausou a IA — é o defeito da #3421 (IA respondia junto)",
    ).toBe(ESPERA_DA_TELA);
    expect(carimbo, "mesmo valor e mesmo tamanho: é o carimbo da tela").toBe(carimboDaTela);
    expect(
      carimbo,
      "carimbo finito: expira como o da tela — handoff permanente é 'infinity'",
    ).not.toBe("infinity");

    // (B) A história da linha continua a de sempre.
    const linha = emNomeDe.capturas.inserts.messages?.at(-1);
    expect(linha?.sent_via, "sent_via intocado: token de servidor segue 'system'").toBe("system");
    expect(linha?.sent_by_user_id, "quem AUTENTICOU continua nulo por token").toBeNull();
    expect(linha?.sent_on_behalf_of_user_id, "a pessoa segue na coluna de auditoria").toBe(USER);
    expect(
      (linha?.metadata as { sent_on_behalf?: { user_id: string } } | undefined)?.sent_on_behalf
        ?.user_id,
      "os dois nomes do balão seguem gravados",
    ).toBe(USER);
  });

  it("CONTROLE (C): envio SEM on_behalf — automação e token puro — NÃO pausa a IA", async () => {
    const regra = criarDubleDoHandler({ conversation: conversa(null) });
    await sendMessageHandler(regra.supabase, ctxAutomacao, input);
    expect(
      patchDaConversa(regra.capturas),
      "a regra pausou a IA sem ninguém ter decidido — regressão da #3421",
    ).not.toHaveProperty("bot_silenced_until");

    const integracao = criarDubleDoHandler({ conversation: conversa(null) });
    await sendMessageHandler(integracao.supabase, ctxTokenPuro, input);
    expect(
      patchDaConversa(integracao.capturas),
      "token SEM on_behalf pausou a IA — o ramo novo engoliu a integração pura",
    ).not.toHaveProperty("bot_silenced_until");
  });

  it("CONTROLE (D+E): janela de 5min na tela, e o espelho do motor devolve o automático no fim", async () => {
    const tela = criarDubleDoHandler({ conversation: conversa(null) });
    await sendMessageHandler(tela.supabase, ctxTela, input);
    const carimbo = String(patchDaConversa(tela.capturas).bot_silenced_until);

    // (D) A mesma duração da tela, medida no relógio travado: agora + 5min.
    expect(carimbo, "a janela da tela deixou de ser 5min").toBe(ESPERA_DA_TELA);

    // (E) O espelho do MOTOR lê o carimbo do jeito que o worker o lê.
    const fatos: FatosDoComando = {
      status: "ai_handling",
      assigned_to_user_id: null,
      bot_silenced_until: carimbo,
      is_group: false,
      is_blocked: false,
      force_human: false,
    };
    const durante = comandoDaConversa(fatos, AGORA);
    expect(durante.automaticoAtivo, "a IA não calou após a resposta da tela").toBe(false);
    expect(durante.motivo, "pausa por resposta: motivo da janela deslizante").toBe(
      "resposta_humana_recente",
    );
    expect(durante.silencioAte?.toISOString(), "a tela promete a hora da volta").toBe(
      ESPERA_DA_TELA,
    );

    // No instante do fim a janela venceu (a mesma régua `> agora` do worker e do
    // guard): o automático volta SOZINHO, sem ninguém devolver — e é este mesmo
    // carimbo que A amarra ao do envio em nome de.
    const depois = comandoDaConversa(fatos, new Date(AGORA.getTime() + JANELA_MS));
    expect(depois.automaticoAtivo, "a IA não voltou a responder após o fim do silenciamento").toBe(
      true,
    );
    expect(depois.motivo).toBeNull();
    expect(depois.travaVigente).toBe(false);
  });

  it("CONTROLE (D): silêncio já maior não é encurtado (mesma régua da tela)", async () => {
    const duarentaMinutos = new Date(AGORA.getTime() + 40 * 60 * 1000).toISOString();
    const emNomeDe = criarDubleDoHandler({ conversation: conversa(duarentaMinutos) });
    await sendMessageHandler(emNomeDe.supabase, ctxEmNomeDe, inputEmNomeDe);
    expect(
      patchDaConversa(emNomeDe.capturas),
      "encurtou um silêncio maior já setado — o envio em nome de não usa a régua da tela",
    ).not.toHaveProperty("bot_silenced_until");
  });
});
