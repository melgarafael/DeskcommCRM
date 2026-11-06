/**
 * ENCAMINHAR USA O MESMO CAMINHO DE ENVIO DO INBOX (#2835).
 *
 * ─── O que este teste protege ────────────────────────────────────────────────
 *
 * A issue pede um botão de "encaminhar" e diz que "o transporte do canal já
 * disponibiliza".
 * O risco não é o botão: é alguém abrir um SEGUNDO caminho de envio (um
 * `sendForward` falando com o transporte) em vez de reusar o primeiro. No dia
 * em que um dos dois ganhasse um guard — janela de 24h, canal desativado,
 * assinatura do emissor —, o outro enviaria por fora da regra, e nada ficaria
 * vermelho: a mensagem simplesmente sairia.
 *
 * Por isso o que se cobra aqui é COMPORTAMENTO do caminho, não forma:
 *
 *   (a) o encaminhamento leva o conteúdo para a conversa ESCOLHIDA passando
 *       pelo `sendMessageHandler` — o mesmo handler de `POST /api/v1/messages`;
 *   (b) a mensagem de ORIGEM não é tocada (o encaminhamento só a lê);
 *   (c) um destino sem canal válido recusa ALTO, com motivo — nunca em
 *       silêncio.
 *
 * `sendMessageHandler` é dublado (o disparo real do transporte não é o que se
 * mede aqui), e o banco é um fake local estreito: só as três tabelas que o
 * caminho lê (`messages`, `conversations`, `channel_sessions`). O fake registra
 * toda escrita, e é o registro que prova (b) — a origem não vira linha nova nem
 * sofre `update`.
 *
 * ⚠️ O que ESTE dublê não alcança, e por isso tem arquivo próprio: a guarda
 * anti-SSRF mora DENTRO de `sendMessageHandler`, então um handler dublado nunca
 * a executa. Foi essa cegueira que deixou passar o defeito da mídia recebida
 * (`http://localhost:3000/api/files/...` recusada como `unsafe_url`). Quem mede
 * a mídia no caminho REAL é `encaminhar-midia-chega-como-objeto.test.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";

// O handler de envio REAL é substituído por um espião: mede-se que ele FOI
// chamado (o caminho), não o que o transporte faria depois. `vi.hoisted` existe
// porque `vi.mock` sobe para o topo do arquivo e não enxergaria um `const`
// declarado abaixo dele.
const { enviado } = vi.hoisted(() => ({ enviado: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: enviado,
  listMessagesHandler: vi.fn(),
}));

import { ApiError } from "@/lib/api/types";
import { encaminharMensagem, motivoParaNaoEncaminhar } from "@/lib/inbox/encaminhar-mensagem";
const ORG = "11111111-1111-4111-8111-111111111111";
const ORIGEM_ID = "22222222-2222-4222-8222-222222222222";
const ORIGEM_CONV = "33333333-3333-4333-8333-333333333333";
const DESTINO_CONV = "44444444-4444-4444-8444-444444444444";
const SESSAO = "55555555-5555-4555-8555-555555555555";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "usuario-1" },
  requestId: "req-1",
  idioma: "pt-BR",
};

/** A linha devolvida pelo envio dublado: carrega a conversa que recebeu. */
function mensagemEnviada(conversationId: string, body: string | null) {
  return {
    id: "mensagem-nova",
    organization_id: ORG,
    conversation_id: conversationId,
    body,
    direction: "outbound",
    type: "text",
    status: "queued",
  };
}

interface Cenario {
  origem?: Record<string, unknown> | null;
  destino?: Record<string, unknown> | null;
  sessao?: Record<string, unknown> | null;
}

/**
 * Fake estreito e com MEMÓRIA DE ESCRITA. `escritas` é o que prova (b): se o
 * caminho de encaminhamento tentar `insert`/`update`/`delete` na origem, o
 * teste vê. Um fake que só responde leitura não teria como provar isso.
 */
function fakeSupabase(cenario: Cenario) {
  const escritas: Array<{ tabela: string; operacao: string }> = [];
  const linhas: Record<string, unknown> = {
    messages: cenario.origem === undefined ? origemValida() : cenario.origem,
    conversations:
      cenario.destino === undefined ? { id: DESTINO_CONV, channel_session_id: SESSAO } : cenario.destino,
    channel_sessions: cenario.sessao === undefined ? { id: SESSAO, metadata: {} } : cenario.sessao,
  };

  const client = {
    from(tabela: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
        insert: () => {
          escritas.push({ tabela, operacao: "insert" });
          return builder;
        },
        update: () => {
          escritas.push({ tabela, operacao: "update" });
          return builder;
        },
        delete: () => {
          escritas.push({ tabela, operacao: "delete" });
          return builder;
        },
      };
      return builder;
    },
  };
  return { supabase: client as unknown as SupabaseClient, escritas };
}

function origemValida(extra: Record<string, unknown> = {}) {
  return {
    id: ORIGEM_ID,
    organization_id: ORG,
    conversation_id: ORIGEM_CONV,
    type: "text",
    body: "Segue o orçamento combinado.",
    media_url: null,
    media_storage_path: null,
    media_mime: null,
    revoked_at: null,
    ...extra,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("encaminhar mensagem — mesmo caminho de envio do Inbox", () => {
  it("(a) leva o conteúdo para a conversa escolhida pelo sendMessageHandler", async () => {
    enviado.mockImplementation(async (_sb: unknown, _ctx: unknown, input: { conversation_id: string; body?: string }) =>
      mensagemEnviada(input.conversation_id, input.body ?? null),
    );
    const { supabase } = fakeSupabase({});

    const resultado = await encaminharMensagem(supabase, ctx, {
      messageId: ORIGEM_ID,
      conversationIdDestino: DESTINO_CONV,
      via: "session",
    });

    expect(enviado).toHaveBeenCalledTimes(1);
    const [sbRecebido, ctxRecebido, input] = enviado.mock.calls[0] as [
      unknown,
      HandlerCtx,
      { conversation_id: string; body?: string; metadata?: Record<string, unknown> },
    ];
    // O caminho é o MESMO objeto de banco e o MESMO ctx da rota de envio.
    expect(sbRecebido).toBe(supabase);
    expect(ctxRecebido.organization_id).toBe(ORG);
    // O conteúdo original viaja; o destino é a conversa ESCOLHIDA, não a de origem.
    expect(input.conversation_id).toBe(DESTINO_CONV);
    expect(input.conversation_id).not.toBe(ORIGEM_CONV);
    expect(input.body).toBe("Segue o orçamento combinado.");
    expect(input.metadata?.forwarded_from_message_id).toBe(ORIGEM_ID);
    // E a linha devolvida é a que o envio criou no destino.
    expect(resultado.conversation_id).toBe(DESTINO_CONV);
  });

  it("(b) não escreve na mensagem de origem — só a lê", async () => {
    enviado.mockImplementation(async (_sb: unknown, _ctx: unknown, input: { conversation_id: string; body?: string }) =>
      mensagemEnviada(input.conversation_id, input.body ?? null),
    );
    const origem = origemValida();
    const { supabase, escritas } = fakeSupabase({ origem });

    await encaminharMensagem(supabase, ctx, {
      messageId: ORIGEM_ID,
      conversationIdDestino: DESTINO_CONV,
      via: "session",
    });

    // Nenhum insert/update/delete em tabela nenhuma passou por este caminho:
    // a origem continua exatamente como estava.
    expect(escritas).toEqual([]);
    expect(origem.body).toBe("Segue o orçamento combinado.");
  });

  it("(c) destino sem conversa válida recusa com motivo, sem enviar", async () => {
    const { supabase } = fakeSupabase({ destino: null });

    await expect(
      encaminharMensagem(supabase, ctx, { messageId: ORIGEM_ID, conversationIdDestino: DESTINO_CONV, via: "session" }),
    ).rejects.toMatchObject({ status: 422, code: "destino_invalido" });
    expect(enviado).not.toHaveBeenCalled();
  });

  it("(c) destino sem canal de envio recusa com motivo, sem enviar", async () => {
    const { supabase } = fakeSupabase({ destino: { id: DESTINO_CONV, channel_session_id: null } });

    await expect(
      encaminharMensagem(supabase, ctx, { messageId: ORIGEM_ID, conversationIdDestino: DESTINO_CONV, via: "session" }),
    ).rejects.toMatchObject({ status: 422, code: "destino_sem_canal" });
    expect(enviado).not.toHaveBeenCalled();
  });

  it("(c) canal do destino desativado recusa com motivo, sem enviar", async () => {
    const { supabase } = fakeSupabase({ sessao: { id: SESSAO, metadata: { disabled: true } } });

    await expect(
      encaminharMensagem(supabase, ctx, { messageId: ORIGEM_ID, conversationIdDestino: DESTINO_CONV, via: "session" }),
    ).rejects.toMatchObject({ status: 422, code: "canal_desativado" });
    expect(enviado).not.toHaveBeenCalled();
  });

  it("mensagem apagada não é encaminhada — recusa antes de tocar o destino", async () => {
    const { supabase } = fakeSupabase({ origem: origemValida({ revoked_at: new Date().toISOString() }) });

    await expect(
      encaminharMensagem(supabase, ctx, { messageId: ORIGEM_ID, conversationIdDestino: DESTINO_CONV, via: "session" }),
    ).rejects.toMatchObject({ status: 422, code: "nao_encaminhavel" });
    expect(enviado).not.toHaveBeenCalled();
  });

  it("a recusa é um ApiError com mensagem legível, nunca um silêncio", async () => {
    const { supabase } = fakeSupabase({ destino: null });
    let capturado: unknown;
    try {
      await encaminharMensagem(supabase, ctx, { messageId: ORIGEM_ID, conversationIdDestino: DESTINO_CONV, via: "session" });
    } catch (err) {
      capturado = err;
    }
    expect(capturado).toBeInstanceOf(ApiError);
    expect((capturado as ApiError).message.length).toBeGreaterThan(0);
  });
});

describe("motivoParaNaoEncaminhar — a régua da origem", () => {
  // Mídia só no NOSSO Storage era motivo de recusa até o conserto do #2835: o
  // objeto agora é COPIADO para a pasta do destino e enviado por
  // `media_storage_path` (prova no caminho real em
  // `tests/unit/encaminhar-midia-chega-como-objeto.test.ts`). Deixou de ser
  // impedimento — e este caso existe para que voltar a recusá-la fique vermelho.
  it("mídia só no Storage, sem URL e sem texto, NÃO tem impedimento", () => {
    const motivo = motivoParaNaoEncaminhar({
      ...origemValida({ body: null, media_url: null }),
      media_storage_path: `${ORG}/${ORIGEM_CONV}/foto.jpg`,
    });
    expect(motivo).toBeNull();
  });

  it("texto puro não tem impedimento", () => {
    expect(motivoParaNaoEncaminhar(origemValida())).toBeNull();
  });

  it("sem texto e sem mídia nenhuma: sem_conteudo", () => {
    const motivo = motivoParaNaoEncaminhar(
      origemValida({ body: null, media_url: null, media_storage_path: null }),
    );
    expect(motivo).toBe("sem_conteudo");
  });
});
