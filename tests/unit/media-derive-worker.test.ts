import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadMock = vi.fn();
const updateEqMock = vi.fn();
const messageRow = {
  id: "msg1",
  organization_id: "org1",
  type: "audio" as string,
  media_mime: "audio/ogg",
  media_storage_path: "org1/conv1/msg1.ogg",
  media_derived_status: null as string | null,
};

/**
 * O dublê PRECISA saber em que tabela está.
 *
 * A versão anterior devolvia `messageRow` para qualquer `from(...)` e encadeava
 * exatamente dois `.eq`. Isso a tornava frágil nos dois eixos: o worker passou a
 * consultar `ai_purpose_bindings` (com três filtros) e o stub quebrava no
 * terceiro `.eq` — falha que aparece como "status error" e aponta para o lugar
 * errado. O Proxy devolve o chain para qualquer filtro, e a linha vem por
 * tabela: mensagem para `messages`, NENHUM binding para `ai_purpose_bindings`
 * (o caso "ninguém configurou nada", que é o comportamento anterior que estes
 * casos existem para preservar).
 */
const bindingDeVisao: { provider: string; model_id: string; credential_id: string | null } | null = null;

/**
 * A Central: o que ela JÁ TEM aberto, e o que o worker manda inserir.
 *
 * `agent_inbox_items` devolve `null` no select, e não `messageRow`: o dedupe de
 * `avisarMidiaNaoLida` desiste quando acha item aberto, então um dublê que
 * devolve linha para qualquer tabela faria o aviso NUNCA ser inserido — com o
 * teste passando por não ter exercitado nada.
 */
const avisoAbertoNaCentral: Record<string, unknown> | null = null;
const inboxInsertMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings"
          ? bindingDeVisao
          : tabela === "agent_inbox_items"
            ? avisoAbertoNaCentral
            : messageRow;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        single: async () => ({ data: linha, error: null }),
        insert: async (row: Record<string, unknown>) => {
          if (tabela === "agent_inbox_items") inboxInsertMock(row);
          return { error: null };
        },
        update: (patch: Record<string, unknown>) => {
          updateEqMock(patch);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: linha ? [linha] : [], error: null }).then(resolve),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) =>
          prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain,
      });
      return chain;
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "transcrição do áudio real"),
}));

// resolveOrgLlmConfig e generateText mockados: o worker precisa de credencial p/
// montar as deps, mas o teste não exercita rede.
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openai",
    apiKey: "sk-test",
    defaultModel: "gpt-5",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
  })),
}));

import { deriveMessageMedia, MARCADOR_NAO_LIDA } from "@/workers/media-derive-worker";
import { deriveMediaText } from "@/lib/messaging/media/derive";
import { DETALHE_TECNICO } from "@/lib/event-log/aviso-de-evento-morto";

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

describe("deriveMessageMedia", () => {
  beforeEach(() => {
    downloadMock.mockReset().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    updateEqMock.mockReset();
    inboxInsertMock.mockReset();
    messageRow.media_derived_status = null;
    messageRow.type = "audio";
    vi.mocked(deriveMediaText).mockReset().mockResolvedValue("transcrição do áudio real");
  });

  it("baixa a mídia, deriva e grava ready", async () => {
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("ok");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_text: "transcrição do áudio real", media_derived_status: "ready" }),
    );
  });

  it("pula se já derivado (idempotência)", async () => {
    messageRow.media_derived_status = "ready";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("skipped");
    expect(deriveMediaText).not.toHaveBeenCalled();
  });

  it("tipo sem derivado (sticker) → skipped sem baixar", async () => {
    messageRow.type = "sticker";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("skipped");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("erro na derivação marca failed no último attempt", async () => {
    vi.mocked(deriveMediaText).mockRejectedValue(new Error("transcription_503"));
    const r = await deriveMessageMedia(eventRow(4));
    expect(r.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_status: "failed" }),
    );
  });

  /**
   * O `failed` sem marcador deixava o agente ver `[documento]` — "veio um
   * arquivo", sem dizer que a leitura falhou — e responder sobre um conteúdo
   * que ele nunca leu. Medido numa VPS em produção (17/09): PDF de catálogo sem
   * camada de texto, extrator falhou, e o agente disse ao cliente que o material
   * "parece ser de distribuidora/promocional".
   */
  it("a falha permanente entrega ao agente o marcador de mídia não lida", async () => {
    messageRow.type = "document";
    messageRow.media_mime = "application/pdf";
    vi.mocked(deriveMediaText).mockRejectedValue(
      new Error("pdfjs-dist extracted no text (possibly image-only PDF)"),
    );

    await deriveMessageMedia(eventRow(4));

    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_derived_text: MARCADOR_NAO_LIDA,
        media_derived_status: "failed",
      }),
    );
  });

  /**
   * DESISTIR CALADO ERA O DESFECHO MAIS COMUM DOS TRÊS.
   *
   * As recusas que o worker sabia explicar — modelo sem visão, provedor
   * indisponível, falta de chave para transcrever — já abriam
   * `midia_nao_lida`, e por isso pareciam cobrir o
   * assunto. A falha que vem de DENTRO da chamada ao modelo estoura como
   * exceção, cai no catch, marcava `failed` e não dizia nada.
   *
   * Medido numa VPS em produção (org real, 14/09): quatro imagens JPEG com
   * `media_derived_status='failed'`, os quatro eventos mortos em `event_log`
   * com "The model `claude-sonnet-5` does not exist or you do not have access
   * to it", e a Central com ZERO avisos de mídia.
   */
  describe("a falha permanente avisa a Central", () => {
    const RECUSA_DO_PROVEDOR =
      "The model `claude-sonnet-5` does not exist or you do not have access to it.";

    it("no último attempt abre `midia_nao_lida` com a frase do provedor", async () => {
      messageRow.type = "image";
      messageRow.media_mime = "image/jpeg";
      vi.mocked(deriveMediaText).mockRejectedValue(new Error(RECUSA_DO_PROVEDOR));

      await deriveMessageMedia(eventRow(4));

      expect(inboxInsertMock, "falhou de vez e não avisou ninguém").toHaveBeenCalledTimes(1);
      const aviso = inboxInsertMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(aviso).toMatchObject({
        organization_id: "org1",
        kind: "midia_nao_lida",
        severity: "warn",
      });
      // A frase do PROVEDOR precisa chegar: é ela que distingue "chave errada"
      // de "modelo que sua conta não assina" — duas ações diferentes.
      expect(String(aviso.body)).toContain("claude-sonnet-5");
      // E o tipo tem que ser o que o operador chama de "isto", não `msg.type`.
      expect(String(aviso.title)).toContain("imagem");
      // O turno que já correu seguiu sem o texto — isso o aviso continua
      // dizendo. O que mudou é o DEPOIS: `markFailed` grava o marcador, então
      // do próximo turno em diante o agente sabe que houve arquivo ilegível.
      expect(String(aviso.body)).toContain("O conteúdo do arquivo não chegou ao agente.");
      expect(String(aviso.body)).toContain("responde avisando");
      // E a frase do provedor vem no FIM, rotulada: é inglês de API, e quem lê
      // a Central não programa.
      const corpo = String(aviso.body);
      const rotulo = corpo.indexOf(DETALHE_TECNICO);
      expect(rotulo, "a frase do provedor sem o rótulo de detalhe técnico").toBeGreaterThan(0);
      expect(corpo.slice(0, rotulo)).not.toContain("does not exist");
      expect(corpo.slice(rotulo)).toContain(RECUSA_DO_PROVEDOR);
    });

    it("tentativa que ainda VAI tentar de novo não avisa (controle)", async () => {
      // Sem este controle, o caso acima passaria com o worker avisando a cada
      // tentativa — cinco avisos por mídia, que é como a Central deixa de ser lida.
      messageRow.type = "image";
      vi.mocked(deriveMediaText).mockRejectedValue(new Error(RECUSA_DO_PROVEDOR));

      await deriveMessageMedia(eventRow(0));

      expect(inboxInsertMock, "avisou antes de desistir").not.toHaveBeenCalled();
    });

    it("derivação que dá certo não avisa nada (controle)", async () => {
      await deriveMessageMedia(eventRow(4));
      expect(inboxInsertMock).not.toHaveBeenCalled();
    });
  });
});
