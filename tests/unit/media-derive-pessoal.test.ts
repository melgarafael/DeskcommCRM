import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A MÍDIA DE CONTATO PESSOAL NÃO VAI AO PROVEDOR DE IA (#3592, spec 21).
 *
 * O contato marcado como pessoal sai da operação inteira: a conversa fecha, o
 * follow-up/campanha/prospecção param, o RAG esquece, a entrada de mensagem
 * pula os efeitos. A derivação de mídia era o único caminho que continuava
 * olhando só a mensagem — baixava o arquivo, resolvia a credencial da
 * organização e mandava o áudio/foto/vídeo/documento para um terceiro. Dois
 * custos, e o segundo não se paga com dinheiro: token da organização em
 * conteúdo que ninguém da operação vai ler, e a vida privada de alguém indo
 * parar num provedor.
 *
 * O arquivo em si continua salvo e tocável na conversa — o que não nasce é o
 * `media_derived_text`. Por isso a asserção central de cada caso PESSOAL é
 * dupla: `skipped` (terminal, o dreno do turno não fica esperando 120s) e
 * NADA de Storage, credencial ou transcrição.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Tirar o corte de contato pessoal de `deriveMessageMedia`: caem os 4 casos
 *   por tipo e os 2 de falha de leitura (6 de 11).
 * - Trocar `=== true` por `!== false` na régua compartilhada: não muda nada
 *   aqui (a coluna chega tipada); quem cobra é `contato-pessoal-selects`.
 * - Devolver `skipped` sem gravar `media_derived_status`: cai o caso de falha
 *   ao marcar (o dreno precisa tentar de novo).
 * Linha para reverter: `workers/media-derive-worker.ts` (o corte) e
 * `lib/contacts/contato-pessoal.ts` (a régua).
 */

const downloadMock = vi.fn();
const storageFromMock = vi.fn(() => ({ download: downloadMock }));
const updateEqMock = vi.fn();
const updateFilterMock = vi.fn();
const inboxInsertMock = vi.fn();
/** Toda tabela que o worker tocou, na ordem — é o que prova "nem perguntou". */
const tabelasConsultadas: string[] = [];

type Linha = Record<string, unknown> | null;

let mensagem: Record<string, unknown> = {};
let conversa: Linha = null;
let contato: Linha = null;
let erroDaConversa: { message: string } | null = null;
let erroDoContato: { message: string } | null = null;
let erroNaAtualizacao: { message: string } | null = null;

/**
 * Dublê do PostgREST que SABE em que tabela está.
 *
 * O dublê genérico (devolve a mensagem para qualquer `from`) faria a leitura de
 * `contacts` devolver a própria mensagem, `is_personal` viria `undefined` e
 * todo caso PESSOAL passaria sem exercitar o corte — o falso verde clássico
 * deste arquivo.
 */
function linhaDa(tabela: string): { data: Linha; error: { message: string } | null } {
  switch (tabela) {
    case "messages":
      return { data: mensagem, error: null };
    case "conversations":
      return { data: conversa, error: erroDaConversa };
    case "contacts":
      return { data: contato, error: erroDoContato };
    case "ai_agent_versions":
      // Vídeo LIGADO: o caminho de vídeo tem de ser barrado pelo corte de
      // pessoal, não pela flag desligada (que esconderia a sabotagem).
      return { data: { id: "versao-1" }, error: null };
    default:
      return { data: null, error: null };
  }
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      tabelasConsultadas.push(tabela);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => linhaDa(tabela),
        single: async () => linhaDa(tabela),
        insert: async (row: Record<string, unknown>) => {
          if (tabela === "agent_inbox_items") inboxInsertMock(row);
          return { error: null };
        },
        update: (patch: Record<string, unknown>) => {
          updateEqMock(patch);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chain: any = new Proxy(
            {
              eq: (coluna: string, valor: unknown) => {
                updateFilterMock(coluna, valor);
                return chain;
              },
              filter: () => chain,
              select: () => chain,
              then: (onFulfilled: (v: unknown) => void, onRejected?: (e: unknown) => void) => {
                const p = Promise.resolve({
                  data: erroNaAtualizacao ? null : [{ id: mensagem.id }],
                  error: erroNaAtualizacao,
                });
                return p.then(onFulfilled, onRejected);
              },
            },
            { get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain) },
          );
          return chain;
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: conversa ? [conversa] : [], error: null }).then(resolve),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain),
      });
      return chain;
    },
    storage: { from: storageFromMock },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "transcrição da nota de voz"),
}));

vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openai",
    apiKey: "chave-da-organizacao",
    origemDaChave: "credencial_da_organizacao",
    defaultModel: "gpt-5",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
    baseUrl: null,
  })),
}));

// Efeitos posteriores à gravação do texto: nada disso é o assunto deste
// arquivo, e nenhum deles pode ser tocado quando a mídia é de contato pessoal.
vi.mock("@/lib/escalacao/handoff-tecnico", () => ({
  reagirAConclusaoDeDerivacao: vi.fn(async () => {}),
}));
vi.mock("@/workers/media-derive-worker.pedidos", () => ({
  avaliarPedidosFalados: vi.fn(async () => {}),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { deriveMessageMedia } from "@/workers/media-derive-worker";
import { deriveMediaText } from "@/lib/messaging/media/derive";
import { resolveOrgLlmConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { reagirAConclusaoDeDerivacao } from "@/lib/escalacao/handoff-tecnico";

const TIPOS = ["audio", "image", "video", "document"] as const;
const MIME: Record<(typeof TIPOS)[number], string> = {
  audio: "audio/ogg",
  image: "image/jpeg",
  video: "video/mp4",
  document: "application/pdf",
};

function evento() {
  return {
    id: "ev-3592",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

beforeEach(() => {
  downloadMock
    .mockReset()
    .mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
  storageFromMock.mockClear();
  updateEqMock.mockReset();
  updateFilterMock.mockReset();
  inboxInsertMock.mockReset();
  tabelasConsultadas.length = 0;
  erroDaConversa = null;
  erroDoContato = null;
  erroNaAtualizacao = null;
  mensagem = {
    id: "msg1",
    organization_id: "org1",
    conversation_id: "conv1",
    type: "audio",
    media_mime: "audio/ogg",
    media_storage_path: "org1/conv1/msg1.ogg",
    media_derived_status: null,
    metadata: {},
    direction: "inbound",
    sent_via: "waha",
    created_at: "2026-10-27T12:00:00.000Z",
  };
  conversa = { contact_id: "contato-1" };
  contato = { is_personal: false };
  vi.mocked(deriveMediaText).mockClear();
  vi.mocked(resolveOrgLlmConfig).mockClear();
  vi.mocked(reagirAConclusaoDeDerivacao).mockClear();
});

describe("#3592 — mídia de contato pessoal não é transcrita, descrita nem enviada ao provedor", () => {
  it.each(TIPOS)(
    "%s de contato pessoal fecha como dispensado, sem download, credencial ou provedor",
    async (tipo) => {
      contato = { is_personal: true };
      mensagem.type = tipo;
      mensagem.media_mime = MIME[tipo];

      const resultado = await deriveMessageMedia(evento());

      expect(resultado).toEqual({
        consumer_key: "media_derive_v1",
        status: "skipped",
        detail: "contato pessoal",
      });
      // Nada tocou o Storage: o arquivo não sai do bucket.
      expect(storageFromMock).not.toHaveBeenCalled();
      expect(downloadMock).not.toHaveBeenCalled();
      // Nada resolveu credencial e nada chamou o provedor.
      expect(resolveOrgLlmConfig).not.toHaveBeenCalled();
      expect(deriveMediaText).not.toHaveBeenCalled();
      // Nem passou perto do painel de provedores nem da flag de vídeo.
      expect(tabelasConsultadas).not.toContain("ai_purpose_bindings");
      expect(tabelasConsultadas).not.toContain("ai_agent_versions");
      // A única escrita é o desfecho terminal — nunca `media_derived_text`.
      expect(updateEqMock).toHaveBeenCalledExactlyOnceWith({ media_derived_status: "skipped" });
      expect(updateEqMock.mock.calls[0]?.[0]).not.toHaveProperty("media_derived_text");
      expect(updateFilterMock.mock.calls).toEqual([
        ["id", "msg1"],
        ["organization_id", "org1"],
      ]);
      // Nenhum aviso na Central: não houve falha de leitura a avisar.
      expect(inboxInsertMock).not.toHaveBeenCalled();
      expect(reagirAConclusaoDeDerivacao).not.toHaveBeenCalled();
    },
  );

  it.each(TIPOS)(
    "%s de contato NORMAL continua derivando — o corte é da marca, não do tipo",
    async (tipo) => {
      contato = { is_personal: false };
      mensagem.type = tipo;
      mensagem.media_mime = MIME[tipo];

      const resultado = await deriveMessageMedia(evento());

      expect(resultado).toEqual({ consumer_key: "media_derive_v1", status: "ok" });
      expect(downloadMock).toHaveBeenCalledTimes(1);
      expect(resolveOrgLlmConfig).toHaveBeenCalled();
      expect(deriveMediaText).toHaveBeenCalledWith(tipo, expect.anything(), MIME[tipo], expect.anything());
      expect(updateEqMock).toHaveBeenCalledWith(
        expect.objectContaining({ media_derived_text: "transcrição da nota de voz", media_derived_status: "ready" }),
      );
    },
  );

  it("conversa da mensagem não pertence a esta organização: o contato não é consultado", async () => {
    // Sem a conversa, não há dono — e o worker NÃO presume "não é pessoal" a
    // partir de uma leitura vazia: ele para no `error` abaixo. Este caso fixa
    // o filtro de organização da consulta do dono.
    conversa = null;
    const resultado = await deriveMessageMedia(evento());
    // `conversations` casou zero linhas: sem `contact_id`, nada a perguntar.
    expect(resultado).toEqual({ consumer_key: "media_derive_v1", status: "ok" });
    expect(tabelasConsultadas).toContain("conversations");
    expect(tabelasConsultadas).not.toContain("contacts");
  });

  it.each(["conversa", "contato"] as const)(
    "falha ao ler quem é o dono (%s) NÃO gasta token: devolve error e não baixa",
    async (onde) => {
      const externo = "detalhe-interno-do-banco-que-nao-deve-vazar";
      if (onde === "conversa") erroDaConversa = { message: externo };
      else erroDoContato = { message: externo };

      const resultado = await deriveMessageMedia(evento());

      // Erro, não `skipped`: o dreno tenta de novo (até 5). Falhar fechada no
      // GASTO — e não na mensagem — é o ponto: privacidade vale uma nova
      // tentativa; mandar o áudio de alguém a um terceiro não tem desfazer.
      expect(resultado).toEqual({
        consumer_key: "media_derive_v1",
        status: "error",
        detail: "personal_check_failed",
      });
      expect(JSON.stringify(resultado)).not.toContain(externo);
      expect(storageFromMock).not.toHaveBeenCalled();
      expect(downloadMock).not.toHaveBeenCalled();
      expect(resolveOrgLlmConfig).not.toHaveBeenCalled();
      expect(deriveMediaText).not.toHaveBeenCalled();
      // Nada foi marcado: o status continua nulo para a próxima tentativa.
      expect(updateEqMock).not.toHaveBeenCalled();
    },
  );

  it("mensagem pessoal já derivada antes do conserto não é rebaixada para skipped", async () => {
    contato = { is_personal: true };
    mensagem.media_derived_status = "ready";

    const resultado = await deriveMessageMedia(evento());

    expect(resultado).toEqual({
      consumer_key: "media_derive_v1",
      status: "skipped",
      detail: "already derived",
    });
    // `ready` sem o texto apagado seria mentira sobre o estado da linha: o
    // corte cobre o que ainda vai acontecer, não o histórico.
    expect(updateEqMock).not.toHaveBeenCalled();
    expect(downloadMock).not.toHaveBeenCalled();
    expect(tabelasConsultadas).toEqual(["messages"]);
  });
});
