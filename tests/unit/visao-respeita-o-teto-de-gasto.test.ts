import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDeTranscricao from "@/lib/messaging/media/transcription";

/**
 * A visão de imagem chama o provedor fora do `runModelCall`, e por isso o
 * "Parar a IA ao chegar no limite" barrava o atendimento e deixava a foto
 * seguir saindo, paga — o gasto passava do teto que a pessoa escolheu. O que
 * estes casos fixam: com o teto armado e estourado, a visão não chama o
 * provedor, devolve o marcador de mídia não lida, abre o aviso na Central e
 * deixa a MESMA linha de recusa que o seam deixa (`orcamento_esgotado`). Sem
 * teto, segue igual. A transcrição pelo modelo da organização (degrau 3 da
 * escada) é LLM cobrado por token e passa pelo MESMO gate; a pelo serviço
 * (degraus 1 e 2), de custo nulo, fica fora por decisão declarada no worker.
 *
 * Mesmo dublê de `midia-grava-custo-em-llm-calls.test.ts`, mais o pool que o
 * gate consulta.
 */

const downloadMock = vi.fn();
const llmCallsInsertMock = vi.fn();
const factoryMock = vi.fn(() => "modelo-de-mentira");
const transcribeDoSvcMock = vi.fn(async () => "transcrição de mentira");

const dns = vi.hoisted(() => ({ resposta: [] as Array<{ address: string; family: number }> }));
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async () => dns.resposta);
  return { lookup, default: { lookup } };
});

const BINDING = {
  provider: "anthropic",
  model_id: "claude-haiku-4-5",
  credential_id: "cred-1",
  base_url: null as string | null,
};
let bindingDaVez: typeof BINDING | null = BINDING;

let linhaDaMensagem = {
  id: "msg1",
  organization_id: "org1",
  type: "image" as string,
  media_mime: "image/jpeg",
  media_storage_path: "org1/conv1/msg1.jpg",
  media_derived_status: null as string | null,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings" ? bindingDaVez : tabela === "agent_inbox_items" ? null : linhaDaMensagem;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        insert: async (row: Record<string, unknown>) => {
          if (tabela === "llm_calls") llmCallsInsertMock(row);
          if (tabela === "agent_inbox_items") avisoInsertMock(row);
          return { error: null };
        },
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain),
      });
      return chain;
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "derivado de mentira"),
}));

// O teto armado: modo bloquear, carência vencida, já avisado neste mês, gasto
// acima do teto — o único estado em que `decidirOrcamento` devolve `bloquear`.
const orcamento = vi.hoisted(() => ({
  daConfig: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 } as Record<string, unknown>,
}));
const TETO_ESTOURADO = {
  teto: 1000,
  modo: "bloquear",
  efetivo_em: new Date("2026-01-01T00:00:00Z"),
  limiar_pct: 80,
  gasto: "1500",
  avisado_antes: true,
};
const poolQueryMock = vi.fn(async (sql: string) => ({
  rows: sql.includes("fn_gasto_de_ia_do_mes") ? [TETO_ESTOURADO] : [],
}));
vi.mock("@/lib/agent-engine/db/pool", () => ({
  createPool: () => ({ query: poolQueryMock }),
}));

const credencial = vi.hoisted(() => ({
  origemDaChave: "credencial_da_organizacao" as "credencial_da_organizacao" | "chave_da_instalacao",
  /** Preenchido = conversa Google com `audio` e sem chave OpenAI: degrau 3 da escada. */
  conversaGoogle: null as string | null,
}));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async (_db: unknown, _cfg: unknown, _org: string, override?: { provider?: string }) => {
    if (credencial.conversaGoogle && override?.provider === "openai") throw new Error("sem credencial openai");
    return {
      provider: credencial.conversaGoogle ? "google" : "anthropic",
      apiKey: "chave-do-binding",
      origemDaChave: credencial.origemDaChave,
      defaultModel: credencial.conversaGoogle ?? "claude-haiku-4-5",
      params: {},
      enabledModels: [],
      orcamento: orcamento.daConfig,
      orcamentoIndisponivelPorque: null,
    };
  }),
}));

vi.mock("@/lib/agent-engine/edge/llm/providers", () => ({
  createDefaultRegistry: () => ({
    anthropic: factoryMock,
    openai: factoryMock,
    openrouter: factoryMock,
    google: factoryMock,
  }),
}));

vi.mock("@/lib/ai/pontos/capacidade-em-vigor", () => ({
  visaoEmVigor: vi.fn(async () => ({ enxerga: true, sabemos: true })),
}));

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({
    text: "descrição de mentira",
    usage: {
      inputTokens: 1200,
      outputTokens: 40,
      inputTokenDetails: { noCacheTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  })),
}));

vi.mock("@/lib/messaging/media/transcription", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloDeTranscricao>()),
  apiTranscriptionProvider: () => ({ transcribe: transcribeDoSvcMock }),
}));

const transcricaoDoEnv = vi.hoisted(() => ({ apiKey: "", baseUrl: "" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<{ env: Env }>();
  return {
    env: {
      ...real.env,
      get TRANSCRIPTION_API_KEY() {
        return transcricaoDoEnv.apiKey;
      },
      get TRANSCRIPTION_BASE_URL() {
        return transcricaoDoEnv.baseUrl;
      },
      AI_BUDGET_ENFORCEMENT: "on",
      TRANSCRIPTION_MODEL: "",
      TRANSCRIPTION_LANGUAGES: "",
      IA_DESTINOS_INTERNOS_PERMITIDOS: "",
    },
  };
});

import { deriveMessageMedia, MARCADOR_NAO_LIDA } from "@/workers/media-derive-worker";
import { esquecerDestinosInternos } from "@/lib/automation/destinos-internos-autorizados";
import { PONTO_TRANSCRICAO_DE_AUDIO, PONTO_VISAO_DE_IMAGEM } from "@/lib/ai/pontos/registro";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import { generateText } from "ai";
import type { Env } from "@/lib/env";

const avisoInsertMock = vi.fn();

function eventRow() {
  return {
    id: "ev1",
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

function depsDaChamada(): DeriveDeps {
  const deps = vi.mocked(deriveMediaText).mock.calls[0]?.[3];
  if (!deps) throw new Error("deriveMediaText não recebeu deps: a derivação parou antes");
  return deps;
}

function armarTeto(): void {
  orcamento.daConfig = {
    modo: "bloquear",
    tetoCents: 1000,
    efetivoEm: new Date("2026-01-01T00:00:00Z"),
    limiarPct: 80,
  };
}

/** Os statements que o gate mandou ao banco, pela tabela que cada um toca. */
function statementsDoGate(trecho: string): Array<{ sql: string; params: unknown[] }> {
  return poolQueryMock.mock.calls
    .map((c) => ({ sql: String(c[0]), params: (c as unknown as [string, unknown[]])[1] ?? [] }))
    .filter((q) => q.sql.includes(trecho));
}

beforeEach(() => {
  vi.clearAllMocks();
  esquecerDestinosInternos();
  dns.resposta = [{ address: "93.184.216.34", family: 4 }];
  credencial.origemDaChave = "credencial_da_organizacao";
  credencial.conversaGoogle = null;
  orcamento.daConfig = { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 };
  bindingDaVez = BINDING;
  transcricaoDoEnv.apiKey = "";
  transcricaoDoEnv.baseUrl = "";
  linhaDaMensagem = {
    id: "msg1",
    organization_id: "org1",
    type: "image",
    media_mime: "image/jpeg",
    media_storage_path: "org1/conv1/msg1.jpg",
    media_derived_status: null,
  };
  downloadMock.mockResolvedValue({ data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null });
});

describe("a visão de imagem respeita o teto de gasto", () => {
  it("teto armado e estourado: a foto não sai, a mídia fica como não lida e a Central diz por quê", async () => {
    armarTeto();

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(texto).toBe(MARCADOR_NAO_LIDA);
    expect(generateText).not.toHaveBeenCalled();
    expect(factoryMock).not.toHaveBeenCalled();
    // Nenhuma linha de CUSTO: a recusa é gravada pelo gate, não pela rota de custo.
    expect(llmCallsInsertMock).not.toHaveBeenCalled();

    expect(avisoInsertMock).toHaveBeenCalledTimes(1);
    const aviso = avisoInsertMock.mock.calls[0]![0] as Record<string, string>;
    expect(aviso.kind).toBe("midia_nao_lida");
    expect(aviso.body).toContain("limite de gasto com IA");
    expect(aviso.body).toContain("Uso de IA › Orçamento");
    expect(aviso.body).not.toContain("Agente de IA → Provedores");
  });

  it("a recusa deixa o mesmo rastro do seam: budget_exceeded na Central e orcamento_esgotado em Execuções", async () => {
    armarTeto();

    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(statementsDoGate("fn_gasto_de_ia_do_mes")).toHaveLength(1);
    expect(statementsDoGate("'budget_exceeded', 'critical'")).toHaveLength(1);
    const [recusa] = statementsDoGate("insert into llm_calls");
    expect(recusa).toBeDefined();
    expect(recusa!.params).toEqual(
      expect.arrayContaining(["org1", PONTO_VISAO_DE_IMAGEM, "anthropic", "claude-haiku-4-5", "orcamento_esgotado"]),
    );
  });

  it("sem teto, a visão segue igual e o gate nem consulta o banco", async () => {
    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(texto).toBe("descrição de mentira");
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(poolQueryMock).not.toHaveBeenCalled();
    expect(avisoInsertMock).not.toHaveBeenCalled();
  });

  it("o degrau 3 da transcrição (modelo da organização) é LLM pago: com o teto estourado o áudio não sai", async () => {
    armarTeto();
    credencial.conversaGoogle = "gemini-2.5-flash";
    bindingDaVez = null;
    linhaDaMensagem = { ...linhaDaMensagem, type: "audio", media_mime: "audio/ogg", media_storage_path: "org1/conv1/msg1.ogg" };

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(texto).toBe(MARCADOR_NAO_LIDA);
    expect(generateText).not.toHaveBeenCalled();
    expect(factoryMock).not.toHaveBeenCalled();
    expect(transcribeDoSvcMock).not.toHaveBeenCalled();
    expect(llmCallsInsertMock).not.toHaveBeenCalled();
    const [recusa] = statementsDoGate("insert into llm_calls");
    expect(recusa!.params).toEqual(
      expect.arrayContaining(["org1", PONTO_TRANSCRICAO_DE_AUDIO, "google", "gemini-2.5-flash", "orcamento_esgotado"]),
    );
    expect(avisoInsertMock).toHaveBeenCalledTimes(1);
    const aviso = avisoInsertMock.mock.calls[0]![0] as Record<string, string>;
    expect(aviso.kind).toBe("midia_nao_lida");
    expect(aviso.title).toContain("áudio");
    expect(aviso.body).toContain("o áudio não foi enviado ao provedor");
    expect(aviso.body).toContain("Uso de IA › Orçamento");
  });

  it("o degrau 3 sem teto segue igual: o áudio vai ao modelo", async () => {
    credencial.conversaGoogle = "gemini-2.5-flash";
    bindingDaVez = null;
    linhaDaMensagem = { ...linhaDaMensagem, type: "audio", media_mime: "audio/ogg", media_storage_path: "org1/conv1/msg1.ogg" };

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(texto).toBe("descrição de mentira");
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(avisoInsertMock).not.toHaveBeenCalled();
  });

  it("os degraus 1 e 2 da transcrição ficam fora do gate: com o teto estourado o áudio ainda vira texto", async () => {
    armarTeto();
    linhaDaMensagem = { ...linhaDaMensagem, type: "audio", media_mime: "audio/ogg", media_storage_path: "org1/conv1/msg1.ogg" };

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(texto).toBe("transcrição de mentira");
    expect(transcribeDoSvcMock).toHaveBeenCalledTimes(1);
    expect(statementsDoGate("fn_gasto_de_ia_do_mes")).toHaveLength(0);
  });
});
