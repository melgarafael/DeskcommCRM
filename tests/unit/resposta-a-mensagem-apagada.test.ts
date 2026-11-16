/**
 * RESPONDER CITANDO UMA MENSAGEM APAGADA É RECUSADO — ANTES DA PLATAFORMA (#4787).
 *
 * ─── O defeito, medido na main ─────────────────────────────────────────────
 *
 * A tela passou a esconder a ação (o balão), mas o servidor era o elo que
 * faltava: `sendMessageHandler` conferia apenas organização e conversa da
 * mensagem citada (`app/api/v1/messages/_handler.ts`, bloco "A CITAÇÃO") e
 * nunca lia `revoked_at`. O `reply_to_message_id` seguia para o insert e a
 * referência saía para o canal — por qualquer porta (REST, MCP, agente), e
 * também no caso em que a citação foi escolhida ANTES da exclusão, quando o
 * id já estava no compositor.
 *
 * ─── Como se mede ──────────────────────────────────────────────────────────
 *
 * Handler REAL com o dublê de banco compartilhado (`criarDubleDoHandler`), e o
 * `fetch` global dublado. "Nada saiu" tem de ser observável em três lugares:
 *
 *   1. o erro que a rota devolve (status, código e frase legível);
 *   2. `fetch` com ZERO chamadas — nenhum canal foi tocado;
 *   3. nenhuma linha nova em `messages` — a recusa não grava e depois reclama.
 *
 * O caso (c) é uma SEQUÊNCIA, de propósito: envia citando a viva (sai), apaga a
 * linha no banco e envia de novo com o MESMO id já escolhido. É o que acontece
 * na tela quando o contato apaga entre a escolha e o Enter — e a sabotagem que
 * remove a checagem do servidor derruba (b) e (c).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { listMessagesHandler, sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { Message } from "@/lib/types/messaging";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const SESSAO = "55555555-5555-4555-8555-555555555555";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const USUARIO = "77777777-7777-4777-8777-777777777777";
const APAGADA = "88888888-8888-4888-8888-888888888888";
const VIVA = "99999999-9999-4999-8999-999999999999";
const WAHA_BASE = "http://localhost:3030";

const ctx = {
  organization_id: ORG,
  actor: { type: "user", id: USUARIO },
  requestId: "req-4787",
  idioma: "pt-BR",
} as unknown as HandlerCtx;

function conversaRow() {
  return {
    id: CONVERSA,
    organization_id: ORG,
    contact_id: CONTATO,
    channel_session_id: SESSAO,
    is_group: false,
    group_chat_id: null,
    contacts: { phone_number: "+553****8888", wa_identity: null, is_blocked: false },
    channel_sessions: {
      provider: "waha",
      waha_session_name: "default",
      status: "WORKING",
      archived_at: null,
    },
  };
}

/** A mensagem recebida que o contato apagou (o alvo do defeito). */
function recebida(over: Record<string, unknown> = {}) {
  return {
    id: APAGADA,
    organization_id: ORG,
    conversation_id: CONVERSA,
    type: "text",
    direction: "inbound",
    body: "texto que o contato apagou",
    media_storage_path: null,
    media_url: null,
    revoked_at: null,
    ...over,
  };
}

/** O `messages` do canal devolve o id serializado — o handler o traduz. */
function duble(mensagensIniciais: Array<Record<string, unknown>>) {
  return criarDubleDoHandler({ conversation: conversaRow(), mensagensIniciais });
}

/** Um dublê novo por chamada, com `fetch` dublado no mesmo passo. */
let ultimoFetch: ReturnType<typeof vi.fn>;
function dubleComFetch(mensagensIniciais: Array<Record<string, unknown>> = []) {
  const d = duble(mensagensIniciais);
  vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
  vi.stubEnv("WAHA_API_KEY", "hash123");
  ultimoFetch = vi.fn(async () => Response.json({ id: { _serialized: "MSG-1" } }));
  vi.stubGlobal("fetch", ultimoFetch);
  return d;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * Quantas vezes o CANAL foi chamado de verdade.
 *
 * `fetch` também é o transporte do Supabase neste ambiente de teste (a trilha
 * de auditoria some por ele, em fire-and-forget), então contar `fetch` inteiro
 * mediria a auditoria, não o envio. O que interessa é a rota de envio.
 */
const chamadasAoEnvio = () =>
  ultimoFetch.mock.calls.filter(([url]) => String(url).includes("/sendText")).length;

describe("envio com citação a mensagem apagada", () => {
  it("é recusado com erro nomeado, e o canal NUNCA é chamado", async () => {
    const d = dubleComFetch([recebida({ revoked_at: "2026-09-08T12:05:00.000Z" })]);

    await expect(
      sendMessageHandler(d.supabase, ctx, {
        conversation_id: CONVERSA,
        body: "Claro, já resolvo",
        type: "text",
        reply_to_message_id: APAGADA,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "citacao_apagada",
      message:
        "A mensagem citada foi apagada e não pode ser citada. Envie a resposta sem citá-la.",
    });

    // A prova do "antes da plataforma": o canal não foi tocado e nada foi gravado.
    expect(chamadasAoEnvio()).toBe(0);
    expect(ultimoFetch).not.toHaveBeenCalled();
    expect(d.capturas.inserts.messages ?? []).toEqual([]);
  });

  it("a citação escolhida ANTES da exclusão também é recusada", async () => {
    const viva = recebida({ id: VIVA, body: "qual o prazo?" });
    const d = dubleComFetch([viva]);

    // 1. A escolha foi feita com a mensagem viva: o envio sai, com o fio.
    const primeira = await sendMessageHandler(d.supabase, ctx, {
      conversation_id: CONVERSA,
      body: "Até sexta",
      type: "text",
      reply_to_message_id: VIVA,
    });
    expect(primeira.reply_to_message_id).toBe(VIVA);
    // Um envio bem-sucedido toca o canal: o que interessa aqui é a contagem
    // RELATIVA — a recusa seguinte não pode acrescentar chamada nenhuma.
    expect(chamadasAoEnvio()).toBe(1);

    // 2. O contato apaga a mensagem citada — a linha muda no banco, e o id
    //    continua escolhido no compositor (é o que a tela tem em mãos).
    const linha = d.mensagens.find((m) => m.id === VIVA)!;
    linha.revoked_at = "2026-09-08T12:30:00.000Z";

    // 3. O MESMO id, agora apagado: recusa — e nada novo sai.
    await expect(
      sendMessageHandler(d.supabase, ctx, {
        conversation_id: CONVERSA,
        body: "Até sexta",
        type: "text",
        reply_to_message_id: VIVA,
      }),
    ).rejects.toMatchObject({ status: 422, code: "citacao_apagada" });
    expect(chamadasAoEnvio()).toBe(1);
    expect(d.capturas.inserts.messages).toHaveLength(1);
  });

  it("CONTROLE: mensagem viva continua citável e o envio sai", async () => {
    const d = dubleComFetch([recebida({ id: VIVA, body: "qual o prazo?" })]);

    const mensagem = await sendMessageHandler(d.supabase, ctx, {
      conversation_id: CONVERSA,
      body: "Até sexta",
      type: "text",
      reply_to_message_id: VIVA,
    });

    expect(mensagem.reply_to_message_id).toBe(VIVA);
    const gravada = (d.capturas.inserts.messages ?? [])[0] as Record<string, unknown>;
    expect(gravada.reply_to_message_id).toBe(VIVA);
    expect(chamadasAoEnvio()).toBe(1);
  });

  it("sem citação o envio normal segue saindo (o caminho do reenvio)", async () => {
    const d = dubleComFetch([recebida({ revoked_at: "2026-09-08T12:05:00.000Z" })]);

    const mensagem = await sendMessageHandler(d.supabase, ctx, {
      conversation_id: CONVERSA,
      body: "Claro, já resolvo",
      type: "text",
    });

    expect(mensagem.reply_to_message_id).toBeNull();
    // O envio sem citação é o caminho de saída da recusa: ele sai pelo canal.
    expect(chamadasAoEnvio()).toBe(1);
  });
});

describe("o texto retido da apagada continua legível por quem tem permissão", () => {
  /** Cliente mínimo: o alvo aqui é o PAYLOAD, como no irmão `texto-retido-payload`. */
  function clienteDeListagem(linhas: Array<Partial<Message>>, settings: unknown) {
    const tabela = (nome: string) => {
      const q: Record<string, unknown> = {};
      const devolve = () =>
        nome === "messages"
          ? linhas
          : nome === "conversations"
            ? [{ contact_id: CONTATO }]
            : nome === "organizations"
              ? [{ settings }]
              : [{ is_personal: false }];
      for (const metodo of ["select", "eq", "order", "limit", "or"]) q[metodo] = () => q;
      q.then = (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: devolve(), error: null }).then(ok, falha);
      return q;
    };
    return { from: tabela } as never;
  }

  it("o corpo segue mascarado e o sinal do botão continua no payload", async () => {
    const apagada = recebida({
      revoked_at: "2026-09-08T12:05:00.000Z",
      body: "combinado fictício de teste",
    }) as unknown as Partial<Message>;
    const supabase = clienteDeListagem([apagada], { texto_retido: { perfis: ["manager"] } });

    const pagina = await listMessagesHandler(supabase, ctx, CONVERSA, { limit: 50 });

    const linha = pagina.messages[0]!;
    // `revoked_at` chega ao cliente — é dele que o balão tira a condição da ação.
    expect(linha.revoked_at).toBe("2026-09-08T12:05:00.000Z");
    // A leitura normal continua sem o texto…
    expect(linha.body).toBeNull();
    // …e a porta do #3277 continua sinalizada para o perfil autorizado.
    expect((linha as unknown as { texto_retido?: boolean }).texto_retido).toBe(true);
  });
});
