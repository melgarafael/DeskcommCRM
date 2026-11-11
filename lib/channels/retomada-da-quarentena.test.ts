import { beforeEach, describe, expect, it, vi } from "vitest";

import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { ORIGEM_DA_RETOMADA, retomarFluxoDaMensagemLiberada } from "./retomada-da-quarentena";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/pos-entrada", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/channels/pos-entrada")>();
  return { ...real, aplicarEfeitosPosEntrada: vi.fn(async () => {}) };
});

/**
 * LIBERAR NÃO É REENVIAR (#4026, fatia 1).
 *
 * ─── O que este arquivo segura ─────────────────────────────────────────────
 *
 * A liberação devolve a mensagem ao MESMO caminho da ingestão
 * (`aplicarEfeitosPosEntrada`) — não a uma segunda régua que diverge na
 * primeira mudança. Mas ela tem duas travas, e as duas são lados opostos da
 * issue:
 *
 * · (c) liberar restaura o comportamento normal: a mensagem volta a gerar os
 *   efeitos de entrada;
 * · (g) sem reenvio retroativo: mensagem que já tinha resposta depois dela só
 *   perde a marca. Re-despachar ali faria o cliente receber duas respostas
 *   para a mesma fala — e uma revisão de vinte mensagens viraria uma rajada.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 *
 * · tirar a trava de "já respondida": o caso acusa (os efeitos rodam para a
 *   mensagem respondida);
 * · chamar os efeitos para mensagem de SAÍDA: o caso do `nao_e_entrada` acusa;
 * · falhar fechado na leitura da resposta existente: o caso do erro acusa
 *   (a função promete não retomar na dúvida, sem lançar).
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const MENSAGEM = "55555555-5555-4555-8555-555555555555";

type Linha = Record<string, unknown> | null;

function clienteFalso(roteiro: {
  mensagem: Linha;
  mensagemErro?: { message: string } | null;
  respostaExistente?: Linha;
  respostaErro?: { message: string } | null;
  conversa?: Linha;
  contato?: Linha;
}) {
  const from = (tabela: string) => {
    const estado = { tabela, colunas: "", filtros: [] as Array<[string, unknown]> };
    const builder = {
      select(colunas: string) {
        estado.colunas = colunas;
        return builder;
      },
      eq(coluna: string, valor: unknown) {
        estado.filtros.push([coluna, valor]);
        return builder;
      },
      gte() {
        return builder;
      },
      limit() {
        return builder;
      },
      async maybeSingle() {
        if (tabela === "messages" && estado.colunas.includes("direction, sent_at")) {
          return { data: roteiro.mensagem, error: roteiro.mensagemErro ?? null };
        }
        if (tabela === "messages") {
          // A procura por resposta posterior: é a leitura que decide (g).
          return { data: roteiro.respostaExistente ?? null, error: roteiro.respostaErro ?? null };
        }
        if (tabela === "conversations") return { data: roteiro.conversa ?? null, error: null };
        if (tabela === "contacts") return { data: roteiro.contato ?? null, error: null };
        return { data: null, error: null };
      },
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

const MENSAGEM_GRAVADA = {
  id: MENSAGEM,
  body: "clique aqui e ganhe um prêmio",
  contact_id: "contato-1",
  conversation_id: CONVERSA,
  channel_session_id: "sessao-1",
  direction: "inbound",
  sent_at: "2026-11-05T12:00:00.000Z",
};

beforeEach(() => {
  vi.mocked(aplicarEfeitosPosEntrada).mockClear();
  vi.mocked(aplicarEfeitosPosEntrada).mockResolvedValue(undefined);
});

describe("liberar devolve a mensagem ao fluxo normal", () => {
  it("roda os MESMOS efeitos da ingestão, com a mensagem inteira", async () => {
    const cliente = clienteFalso({
      mensagem: MENSAGEM_GRAVADA,
      conversa: { id: CONVERSA, channel: "instagram" },
      contato: { id: "contato-1", display_name: "Cliente" },
    });

    const desfecho = await retomarFluxoDaMensagemLiberada(cliente, {
      organizationId: ORG,
      messageId: MENSAGEM,
    });

    expect(desfecho).toEqual({ retomou: true });
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledTimes(1);
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        contactId: "contato-1",
        conversationId: CONVERSA,
        messageId: MENSAGEM,
        channelSessionId: "sessao-1",
        // O corpo é o MESMO: a quarentena nunca tocou a mensagem.
        texto: "clique aqui e ganhe um prêmio",
        nomeDoContato: "Cliente",
        origem: ORIGEM_DA_RETOMADA,
        canal: "instagram",
      }),
    );
  });
});

describe("os lados opostos", () => {
  it("(g) mensagem já respondida depois dela: só a marca sai, nada é re-despachado", async () => {
    const cliente = clienteFalso({
      mensagem: MENSAGEM_GRAVADA,
      respostaExistente: { id: "resposta-1" },
    });

    const desfecho = await retomarFluxoDaMensagemLiberada(cliente, {
      organizationId: ORG,
      messageId: MENSAGEM,
    });

    expect(desfecho).toEqual({ retomou: false, motivo: "ja_respondida" });
    expect(aplicarEfeitosPosEntrada, "reenviou resposta para quem já foi respondido").not.toHaveBeenCalled();
  });

  it("mensagem de SAÍDA não tem efeito de entrada a retomar", async () => {
    const cliente = clienteFalso({
      mensagem: { ...MENSAGEM_GRAVADA, direction: "outbound" },
    });

    expect(
      await retomarFluxoDaMensagemLiberada(cliente, { organizationId: ORG, messageId: MENSAGEM }),
    ).toEqual({ retomou: false, motivo: "nao_e_entrada" });
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });

  it("mensagem inexistente (ou de outra organização) não retoma", async () => {
    const cliente = clienteFalso({ mensagem: null });

    expect(
      await retomarFluxoDaMensagemLiberada(cliente, { organizationId: ORG, messageId: MENSAGEM }),
    ).toEqual({ retomou: false, motivo: "mensagem_nao_encontrada" });
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });

  it("na dúvida (leitura da resposta falhou) NÃO retoma e não lança", async () => {
    const cliente = clienteFalso({
      mensagem: MENSAGEM_GRAVADA,
      respostaErro: { message: "timeout" },
    });

    await expect(
      retomarFluxoDaMensagemLiberada(cliente, { organizationId: ORG, messageId: MENSAGEM }),
    ).resolves.toEqual({ retomou: false, motivo: "falha" });
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });
});
