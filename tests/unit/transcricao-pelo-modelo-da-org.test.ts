import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Ai from "ai";

/**
 * #2171 — quem OUVE o áudio do cliente.
 *
 * O ponto `transcricao_de_audio` é `fixo` e só falha o protocolo da OpenAI: o
 * worker de derivação pedia uma chave OpenAI própria mesmo para uma
 * organização cujo MODELO DE CONVERSA já entende áudio (Gemini com a chave do
 * Google validada). Sem essa segunda conta, o áudio não era transcrito — e a
 * linha ficava com `media_derived_status` nulo, que é o mesmo estado de
 * "ninguém tentou", para o drain e para quem opera.
 *
 * Estes casos cobrem os dois itens do corpo da issue (o item 3, de avisar o
 * agente no turno, é FORA do escopo):
 *
 *   1. modelo de conversa da org com capacidade `audio` transcreve sozinho,
 *      sem nenhuma chave OpenAI em lugar nenhum;
 *   2. quando não há quem transcreva (ou a transcrição vem vazia), o status
 *      vira `failed` COM MOTIVO — nunca nulo, nunca `ready` com texto vazio.
 *
 * Mais dois CONTROLES: quem não tem capacidade `audio` continua no padrão
 * OpenAI-compatível, e o caminho de documento/PDF não muda.
 */
// Os dublês vão em `vi.hoisted` porque os factories de `vi.mock` referenciam
// eles — e o Vitest executa esses factories antes de qualquer `const` aqui.
const mocks = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  updateEqMock: vi.fn(),
  inboxInsertMock: vi.fn(),
  generateTextMock: vi.fn(),
  extractPdfMock: vi.fn(),
  fetchMock: vi.fn(),
  resolveMock: vi.fn(),
}));
const {
  downloadMock,
  updateEqMock,
  inboxInsertMock,
  generateTextMock,
  extractPdfMock,
  fetchMock,
  resolveMock,
} = mocks;

vi.hoisted(() => {
  // Nenhum degrau OpenAI pode valer: nem a chave da instalação, nem o serviço
  // de transcrição do `.env`. É o cenário da issue.
  process.env.OPENAI_API_KEY = "";
  process.env.TRANSCRIPTION_API_KEY = "";
  process.env.TRANSCRIPTION_BASE_URL = "";
  process.env.TRANSCRIPTION_LANGUAGES = "";
});

/** A linha que o worker lê e regrava. `media_derived_status` nasce nulo. */
const messageRow: Record<string, unknown> = {
  id: "msg1",
  organization_id: "org1",
  type: "audio" as string,
  media_mime: "audio/ogg" as string | null,
  media_storage_path: "org1/conv1/msg1.ogg" as string | null,
  media_derived_status: null as string | null,
  metadata: {} as Record<string, unknown> | null,
};

/** Binding de visão nulo: nenhum ponto escolhido no painel (o caso comum). */
let bindingDeVisao: Record<string, unknown> | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings"
          ? bindingDeVisao
          : tabela === "agent_inbox_items" || tabela === "ai_models"
            ? null
            : tabela === "ai_agent_versions"
              ? { id: "v1" }
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chain: any = new Proxy(
            {
              eq: () => chain,
              neq: () => chain,
              filter: () => chain,
              select: () => chain,
              then: (onFulfilled: (v: unknown) => void, onRejected?: (e: unknown) => void) => {
                const p = Promise.resolve({ data: [messageRow], error: null });
                return p.then(onFulfilled, onRejected);
              },
            },
            { get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain) },
          );
          return chain;
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

// O extrator de PDF é REAL no worker (não passa por `deriveMediaText` mockado
// aqui) — este arquivo exercita a cadeia inteira, então ele é dublado à parte.
vi.mock("@/lib/ai/rag/extractors/pdf", () => ({
  extractPdfText: (...args: unknown[]) => extractPdfMock(...args),
}));

// `generateText` é o que a transcrição PELO MODELO DA ORG usa (mesmo seam da
// visão). O original fica de pé para os demais exportes do pacote.
vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof Ai>();
  return { ...original, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: (...args: unknown[]) => resolveMock(...args),
}));

import { deriveMessageMedia } from "@/workers/media-derive-worker";
import type { OrgLlmConfig } from "@/lib/agent-engine/edge/llm/credentials";

/**
 * Chaves de CONTROLE, de propósito com grafia que não parece segredo nenhum:
 * o valor tem que chegar inteiro ao teste, sem ser interpretado como credencial
 * em trânsito.
 */
const CHAVE_GOOGLE = "chave-google-da-organizacao";
const CHAVE_OPENAI = "chave-openai-de-controle";
const CHAVE_ANTHROPIC = "chave-anthropic-de-controle";

function configResolvida(over: Partial<OrgLlmConfig> = {}): OrgLlmConfig {
  return {
    provider: "google",
    apiKey: CHAVE_GOOGLE,
    origemDaChave: "credencial_da_organizacao",
    defaultModel: "gemini-3.5-flash",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
    baseUrl: null,
    ...over,
  };
}

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

/** O degrau OpenAI da escada: existe para uma org SEM chave alguma da OpenAI. */
const semChaveOpenAi = () =>
  resolveMock.mockImplementation(
    async (_pool: unknown, _cfg: unknown, _org: unknown, override?: { provider?: string }) => {
      if (override?.provider === "openai") {
        throw new Error("Nenhuma credencial padrão encontrada para a organização");
      }
      return configResolvida();
    },
  );

describe("transcricao_de_audio — quem ouve o áudio (#2171)", () => {
  beforeEach(() => {
    downloadMock.mockReset().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    updateEqMock.mockReset();
    inboxInsertMock.mockReset();
    generateTextMock.mockReset().mockResolvedValue({ text: "Quiero una cotización de 20 unidades" });
    extractPdfMock.mockReset().mockResolvedValue("NF: 120 Contrato: 9912492178");
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ text: "transcrito pelo whisper" }) });
    vi.stubGlobal("fetch", fetchMock);
    messageRow.type = "audio";
    messageRow.media_mime = "audio/ogg";
    messageRow.media_storage_path = "org1/conv1/msg1.ogg";
    messageRow.media_derived_status = null;
    messageRow.metadata = {};
    bindingDeVisao = null;
    semChaveOpenAi();
  });

  it("o modelo de conversa da org que declara audio transcreve, sem nenhuma chave OpenAI", async () => {
    // Organização da issue: Gemini + chave do Google validada, SEM conta OpenAI.
    const r = await deriveMessageMedia(eventRow());

    expect(r.status, `detail=${r.detail}`).toBe("ok");

    // A chamada saiu pelo MODELO DE CONVERSA — o único caminho que usa
    // `generateText` —, com o áudio como parte do pedido...
    expect(generateTextMock, "não transcreveu pelo modelo da organização").toHaveBeenCalledTimes(1);
    const chamada = generateTextMock.mock.calls[0]![0] as {
      model: { modelId?: string };
      messages: { content: Array<Record<string, unknown>> }[];
    };
    const conteudo = chamada.messages[0]!.content;
    expect(conteudo).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "file", mediaType: "audio/ogg" })]),
    );
    expect(String(chamada.model?.modelId ?? "")).toContain("gemini");

    // ...e o endpoint da OpenAI não foi chamado. O degrau OpenAI FOI
    // consultado — ele vem antes (ordem de `lib/ai/embeddings/chave.ts`) — e
    // não achou chave, que é o caso da issue.
    expect(fetchMock).not.toHaveBeenCalled();

    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_derived_status: "ready",
        media_derived_text: "Quiero una cotización de 20 unidades",
      }),
    );
  });

  it("sem NINGUÉM que transcreva, grava failed COM motivo — nunca nulo nem pronto com texto vazio", async () => {
    // Conversa em um modelo que NÃO declara audio, sem chave OpenAI em lugar
    // nenhum: não há quem ouça o áudio, e essa constatação não pode virar
    // silêncio (o drain esperaria 8 minutos por uma leitura que nunca vem).
    resolveMock.mockImplementation(async (_p, _c, _o, override) => {
      if (override?.provider === "openai") throw new Error("sem credencial openai nesta organização");
      return configResolvida({ provider: "anthropic", defaultModel: "claude-sonnet-5" });
    });

    const r = await deriveMessageMedia(eventRow());

    expect(r.status, `detail=${r.detail}`).toBe("ok");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_derived_status: "failed",
        media_derived_text: expect.stringContaining("mídia"),
      }),
    );
    const gravado = updateEqMock.mock.calls.at(-1)![0] as {
      metadata?: Record<string, unknown>;
    };
    expect(String(gravado.metadata?.media_derived_motivo ?? ""), "faltou o motivo do failed").toMatch(/\S/);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transcrição que volta VAZIA vira failed com motivo (nunca `ready` sem texto)", async () => {
    generateTextMock.mockResolvedValue({ text: "   " });

    const r = await deriveMessageMedia(eventRow());

    expect(r.status, `detail=${r.detail}`).toBe("ok");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_status: "failed" }),
    );
    const gravado = updateEqMock.mock.calls.at(-1)![0] as { metadata?: Record<string, unknown> };
    expect(String(gravado.metadata?.media_derived_motivo ?? "")).toMatch(/\S/);
  });

  describe("controles — nada muda para quem já funciona", () => {
    it("organização SEM capacidade audio continua no padrão OpenAI-compatível", async () => {
      resolveMock.mockImplementation(
        async (_pool: unknown, _cfg: unknown, _org: unknown, override?: { provider?: string }) =>
          override?.provider === "openai"
            ? configResolvida({ provider: "openai", apiKey: CHAVE_OPENAI, defaultModel: "whisper-1" })
            : configResolvida({ provider: "anthropic", apiKey: CHAVE_ANTHROPIC, defaultModel: "claude-sonnet-5" }),
      );

      const r = await deriveMessageMedia(eventRow());

      expect(r.status, `detail=${r.detail}`).toBe("ok");
      // NÃO foi pelo modelo da conversa...
      expect(generateTextMock).not.toHaveBeenCalled();
      // ...foi o `/v1/audio/transcriptions` de sempre, com a chave que o
      // resolvedor devolveu para o degrau OpenAI-compatível.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]! as [
        string,
        { method: string; headers: Record<string, string>; body: unknown },
      ];
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
      expect(String(init.headers.Authorization)).toBe(`Bearer ${CHAVE_OPENAI}`);
      expect(updateEqMock).toHaveBeenCalledWith(
        expect.objectContaining({
          media_derived_status: "ready",
          media_derived_text: "transcrito pelo whisper",
        }),
      );
    });

    it("org com Gemini que TAMBÉM tem chave OpenAI segue no whisper-1 — ninguém troca de fornecedor numa atualização", async () => {
      // A ordem da escada é a de `lib/ai/embeddings/chave.ts` (degraus 5 e 7):
      // a chave OpenAI vem antes do modelo da organização. Quem já transcrevia
      // pelo Whisper continua nele; o Gemini só ouve quem não tem chave OpenAI.
      resolveMock.mockImplementation(
        async (_pool: unknown, _cfg: unknown, _org: unknown, override?: { provider?: string }) =>
          override?.provider === "openai"
            ? configResolvida({ provider: "openai", apiKey: CHAVE_OPENAI, defaultModel: "gpt-5" })
            : configResolvida(),
      );

      const r = await deriveMessageMedia(eventRow());

      expect(r.status, `detail=${r.detail}`).toBe("ok");
      expect(generateTextMock, "o áudio foi para o Gemini, trocando o fornecedor").not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]! as [string, { headers: Record<string, string> }];
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(String(init.headers.Authorization)).toBe(`Bearer ${CHAVE_OPENAI}`);
      expect(updateEqMock).toHaveBeenCalledWith(
        expect.objectContaining({ media_derived_status: "ready", media_derived_text: "transcrito pelo whisper" }),
      );
    });

    it("o caminho de documento/PDF segue intacto", async () => {
      messageRow.type = "document";
      messageRow.media_mime = "application/pdf";

      const r = await deriveMessageMedia(eventRow());

      expect(r.status, `detail=${r.detail}`).toBe("ok");
      expect(extractPdfMock).toHaveBeenCalledTimes(1);
      expect(generateTextMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateEqMock).toHaveBeenCalledWith(
        expect.objectContaining({
          media_derived_status: "ready",
          media_derived_text: "NF: 120 Contrato: 9912492178",
        }),
      );
    });
  });
});
