// @vitest-environment node
/**
 * A ASSINATURA DO CHATGPT RESPONDE COM O SENTRY LIGADO (#4798).
 *
 * O defeito de produção: com o provedor `openai-assinatura` (Sign in with
 * ChatGPT) toda chamada "Responder o cliente" falhava em ~1 s com
 * `Invalid state: The ReadableStream is locked`. Chamadas curtas do MESMO
 * provedor funcionavam, a aba Teste do agente dava `preview_failed`, e Gemini e
 * OpenAI por chave não eram afetados.
 *
 * Por que só a assinatura:
 *
 * - ela é o único ramo que usa `streamText` com tools
 *   (`lib/agent-engine/edge/llm/run-model-call.ts:1131`) — o SIWC exige
 *   streaming; todos os outros provedores vão por `generateText` (linha 1182);
 * - desde o `ai` 7.0.168 o SDK publica `redactTelemetryCredentials(result)` no
 *   canal `ai:telemetry`, e o Sentry — quando a integração `VercelAI` está
 *   instalada — troca `result.stream` por um stream espiado com
 *   `pipeThrough(...)`. O `pipeThrough` TRAVA o `ReadableStream` original; a
 *   cópia recebe o stream novo, o original fica travado, e o laço de ferramentas
 *   do SDK chama `pipeThrough` de novo → o erro. Sem tools não há segunda volta
 *   no stream, e é por isso que a chamada curta passava
 *   (getsentry/sentry-javascript#26403, vercel/ai#24970).
 *
 * E por que isso atingia quase toda instalação: `SENTRY_DSN` vazio cai no DSN
 * da comunidade (`resolveSentryDsn`), então o `Sentry.init` roda por padrão —
 * com `tracesSampleRate: 0`, que não desliga integração nenhuma. O padrão da
 * telemetria NÃO muda aqui (decisão do mantenedor no doc 371): o conserto é
 * tirar a integração do AI SDK dos inits de servidor.
 *
 * Os quatro casos que a issue pede estão aqui, pelo nome. O dublê do
 * `streamText` tem dentes: ele lança o erro REAL quando a instrumentação é
 * aplicada, e o controle negativo no fim prova isso.
 */
import { tracingChannel } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import path from "node:path";

import * as Sentry from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as ModuloAi from "ai";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-da-empresa",
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  renovarAssinaturaNoTurno: vi.fn(),
  lerLoginCodexRenovandoSeProxima: vi.fn(async () => ({
    access_token: "token-de-assinatura-de-teste",
    refresh_token: "refresh-de-teste",
    expires_at: Date.now() + 60_000,
  })),
}));

/**
 * Dublê do AI SDK. Só `generateText` e `streamText` são falsos: `tool`,
 * `jsonSchema`, `asSchema` e `stepCountIs` são os reais, porque o teste precisa
 * do formato verdadeiro das ferramentas.
 *
 * O `streamText` é onde mora a prova: se o stream do canal `ai:telemetry` tiver
 * sido trocado (é o que a integração `VercelAI` do Sentry faz), ele lança o erro
 * de produção. Sem a troca, devolve o resultado normal.
 */
const canalDeTelemetria = tracingChannel("ai:telemetry");

/**
 * `vi.mock` é içado para o topo do arquivo, então a fábrica do dublê do `ai` roda
 * ANTES desta const existir. A sonda é içada junto (`vi.hoisted`) e recebe o canal
 * depois dos imports — em tempo de CHAMADA, que é quando o dublê olha.
 *
 * É por ela que o dublê "tem dentes": qualquer assinante de `ai:telemetry` (a
 * integração `VercelAI` do Sentry é um) faz o `streamText` lançar o erro de
 * produção.
 */
const sonda = vi.hoisted(() => ({ canal: undefined as undefined | { hasSubscribers: boolean } }));

/**
 * O assinante que um caso instala à mão (o controle negativo). O canal é um
 * global do processo: `unsubscribe` PRECISA do MESMO objeto, então ele fica
 * guardado aqui e sai no `afterEach` — assinante que sobra contamina o caso
 * seguinte, que é exatamente o defeito que este arquivo mede.
 */
let assinanteInstalado: object | undefined;

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloAi>()),
  generateText: vi.fn(),
  streamText: vi.fn(() => {
    if (sonda.canal?.hasSubscribers) {
      throw new TypeError("Invalid state: The ReadableStream is locked");
    }
    return {
      text: Promise.resolve("resposta ao cliente"),
      usage: Promise.resolve({
        inputTokens: 900,
        outputTokens: 40,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      response: Promise.resolve({ id: "r1" }),
      steps: Promise.resolve([]),
      responseMessages: Promise.resolve([{ role: "assistant", content: [{ type: "text", text: "ok" }] }]),
      toolCalls: Promise.resolve([{ toolName: "buscar", input: { q: "oi" } }]),
      finishReason: Promise.resolve("stop"),
    };
  }),
}));

import { generateText, streamText, tool, type ToolSet } from "ai";

import {
  INTEGRACAO_DO_SDK_DO_AI,
  integracoesDoServidor,
  resolveSentryDsn,
} from "@/lib/sentry/dsn";
import { opcoesDePrivacidade } from "@/lib/sentry/privacidade";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

// Ligação da sonda içada com o canal de verdade (ver o comentário dela).
sonda.canal = canalDeTelemetria;

const ORG = "33333333-3333-4333-8333-333333333333";

const ARQUIVOS_COM_INIT = [
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "workers/agent-worker/main.ts",
  "instrumentation-client.ts",
] as const;

const fonte = (arquivo: string) => readFileSync(path.join(process.cwd(), arquivo), "utf8");

function poolCom(provider: string, modelo: string) {
  const inserts: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider,
              default_model: modelo,
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push(params);
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

const registry = {
  "openai-assinatura": (_k: string, modelId: string) => ({
    specificationVersion: "v3",
    provider: "openai-assinatura",
    modelId,
    doGenerate: async () => ({ text: "ok", usage: {} }),
    doStream: async () => ({ stream: [] }),
  }),
  openai: (_k: string, modelId: string) => ({
    specificationVersion: "v3",
    provider: "openai",
    modelId,
    doGenerate: async () => ({ text: "ok", usage: {} }),
    doStream: async () => ({ stream: [] }),
  }),
  anthropic: (_k: string, modelId: string) => ({
    specificationVersion: "v3",
    provider: "anthropic",
    modelId,
    doGenerate: async () => ({ text: "ok", usage: {} }),
    doStream: async () => ({ stream: [] }),
  }),
} as never;

const logDuble = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/**
 * `comReserva: false` é o mundo de quem usa a assinatura SEM chave de API
 * cadastrada — o caso do relato da issue, em que a queda da assinatura não tem
 * para onde cair. Com reserva, o motor troca de credencial e o cliente recebe
 * resposta; o defeito fica invisível, e é assim que ele passou tanto tempo no ar.
 */
const MODELO_DO_PROVEDOR: Record<string, string> = {
  "openai-assinatura": "gpt-6-astra",
  openai: "gpt-6-astra",
  anthropic: "claude-haiku-5-5",
};

async function chamar(provider: string, tools: ToolSet, opcoes: { comReserva?: boolean } = {}) {
  const { pool, inserts } = poolCom(provider, MODELO_DO_PROVEDOR[provider] ?? "gpt-6-astra");
  const resultado = await runModelCall(
    pool,
    {
      // A reserva da assinatura fala com a OpenAI por chave: sem esta chave, a
      // queda da assinatura não tem para onde cair.
      ...(opcoes.comReserva === false ? {} : { openaiApiKey: "openai-de-teste" }),
      anthropicApiKey: "anthropic-de-teste",
      cacheTtl: "1h",
    },
    {
      tenantId: ORG,
      purpose: "agent_turn",
      system: "sistema",
      messages: [{ role: "user", content: "oi" }],
      tools,
    },
    { registry, log: logDuble() as never },
  );
  return { resultado, inserts };
}

const ferramenta = () =>
  ({
    buscar: tool({ description: "Busca no catálogo.", inputSchema: z.object({ q: z.string() }) }),
  }) as ToolSet;

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.mocked(streamText).mockClear();
  vi.mocked(generateText).mockResolvedValue({
    text: "resposta ao cliente",
    usage: {
      inputTokens: 900,
      outputTokens: 40,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    steps: [],
    responseMessages: [],
    toolCalls: [],
    finishReason: "stop",
  } as never);
});

afterEach(() => {
  if (assinanteInstalado) {
    canalDeTelemetria.unsubscribe(assinanteInstalado as never);
    assinanteInstalado = undefined;
  }
  Sentry.getCurrentScope().setClient(undefined);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * (a) SEM DSN (`SENTRY_DSN=off`), NENHUM Sentry É INICIALIZADO.
 * ────────────────────────────────────────────────────────────────────────────*/
describe("(a) sem DSN nenhum Sentry é inicializado, e nenhum init traz o DSN da comunidade literal", () => {
  it("`off` resolve para `undefined`", () => {
    expect(resolveSentryDsn("off")).toBeUndefined();
  });

  it("os quatro pontos de init só chamam Sentry.init quando há DSN", () => {
    for (const arquivo of ARQUIVOS_COM_INIT) {
      const texto = fonte(arquivo);
      const guarda = texto.indexOf("if (sentryDsn)");
      const init = texto.indexOf("Sentry.init(");
      expect(guarda, `${arquivo}: sem \`if (sentryDsn)\` o init roda com dsn undefined`).toBeGreaterThan(-1);
      expect(init, `${arquivo}: \`Sentry.init(\` não encontrado`).toBeGreaterThan(guarda);
      // O init tem de estar DENTRO do `if`: entre a guarda e o init só pode
      // haver a abertura do bloco.
      const trecho = texto.slice(guarda, init);
      expect(trecho.includes("{"), `${arquivo}: o init ficou FORA do \`if (sentryDsn)\``).toBe(true);
      expect(trecho.split("}").length - 1, `${arquivo}: o bloco do \`if\` fecha antes do init`).toBe(0);
    }
  });

  it("nenhum init traz o DSN da comunidade como valor de `dsn:`", () => {
    for (const arquivo of ARQUIVOS_COM_INIT) {
      const texto = fonte(arquivo);
      expect(texto).toContain("dsn: sentryDsn");
      expect(texto, `${arquivo}: init com o DSN da comunidade literal`).not.toContain("dsn: DEFAULT_SENTRY_DSN");
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * (b) COM DSN, O RAMO DA ASSINATURA RODA `streamText` COM TOOLS.
 * ────────────────────────────────────────────────────────────────────────────*/
describe("(b) com SENTRY_DSN configurado, a assinatura responde sem a instrumentação que trava", () => {
  /**
   * Imita o que a integração `VercelAI` do Sentry faz no `asyncEnd`: troca
   * `result.stream` por um stream espiado. Aqui a troca é só o `pipeThrough`
   * (que trava o original) — o suficiente para o dublê do `streamText` lançar o
   * erro de produção.
   */
  function integrarComoOSentry() {
    const assinante = {
      asyncEnd: (ctx: { result?: { stream?: ReadableStream } }) => {
        if (!ctx.result?.stream) return;
        ctx.result.stream = ctx.result.stream.pipeThrough(new TransformStream());
      },
    };
    canalDeTelemetria.subscribe(assinante as never);
    assinanteInstalado = assinante;
  }

  const padraoDoSdk = () => [
    { name: "EventFilters", setupOnce: () => {} },
    { name: "Http", setupOnce: () => {} },
    { name: INTEGRACAO_DO_SDK_DO_AI, setupOnce: integrarComoOSentry },
  ];

  it("os três inits de SERVIDOR passam a lista filtrada (o filtro não pode ficar só no teste)", () => {
    for (const arquivo of ARQUIVOS_COM_INIT) {
      const texto = fonte(arquivo);
      if (arquivo === "instrumentation-client.ts") continue; // navegador não serve a assinatura
      expect(texto, `${arquivo}: init sem \`integrations: integracoesDoServidor\``).toContain(
        "integrations: integracoesDoServidor",
      );
      // Ninguém pode instalar a integração à mão "para ter span de IA".
      expect(texto, `${arquivo}: \`vercelAIIntegration\` reintroduzida`).not.toContain(
        "vercelAIIntegration",
      );
    }
  });

  it("as integrações que o init aceita NÃO incluem a do AI SDK", () => {
    const mantidas = integracoesDoServidor(padraoDoSdk()).map((i) => i.name);
    expect(mantidas).not.toContain(INTEGRACAO_DO_SDK_DO_AI);
    expect(mantidas).toContain("EventFilters");
    expect(mantidas).toContain("Http");
  });

  it("o caminho da assinatura executa `streamText` com tools e devolve a resposta", async () => {
    const dsn = resolveSentryDsn("https://chave@o0.ingest.sentry.io/1");
    expect(dsn).toBe("https://chave@o0.ingest.sentry.io/1");

    // O init REAL, com a lista que ele de fato instala: se a integração do AI
    // voltar para a lista, `setupOnce` assina o canal e a chamada abaixo lança.
    for (const integracao of integracoesDoServidor(padraoDoSdk())) integracao.setupOnce();
    expect(canalDeTelemetria.hasSubscribers).toBe(false);

    const { resultado } = await chamar("openai-assinatura", ferramenta());

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    // `runModelCall` devolve `{ result, usage, ... }`: o resultado do SDK (o
    // mesmo formato que o `generateText` daria) vem em `result`.
    expect(resultado.result.text).toBe("resposta ao cliente");
    // O laço de ferramentas chegou ao motor: é o que a assinatura precisa para
    // responder o cliente, e é o que o stream travado impedia.
    expect((resultado.result as { toolCalls?: unknown[] }).toolCalls).toHaveLength(1);
  });

  it("controle negativo: com a instrumentação aplicada, o MESMO caminho falha", async () => {
    integrarComoOSentry();
    // Sem reserva: exatamente o relato da issue — a assinatura não tem para onde
    // cair, e o cliente fica sem resposta em ~1 s.
    await expect(chamar("openai-assinatura", ferramenta(), { comReserva: false })).rejects.toThrow(
      "The ReadableStream is locked",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * (c) A CAPTURA DE ERRO DE QUEM CONFIGUROU DSN CONTINUA ATIVA.
 * ────────────────────────────────────────────────────────────────────────────*/
describe("(c) quem configurou DSN continua com captura de erro", () => {
  it("o init de DSN próprio segue enviando erro, com scrub e coleta restrita", async () => {
    const enviados: unknown[] = [];
    Sentry.getCurrentScope().setClient(undefined);
    Sentry.init({
      dsn: "https://chave@o0.ingest.sentry.io/1",
      tracesSampleRate: 1,
      integrations: integracoesDoServidor,
      ...opcoesDePrivacidade,
      transport: () => ({
        send: async (envelope: unknown) => {
          enviados.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });

    // A integração do AI SDK não está lá; as de erro estão.
    expect(Sentry.getClient()?.getIntegrationByName?.(INTEGRACAO_DO_SDK_DO_AI)).toBeUndefined();
    expect(Sentry.getClient()?.getIntegrationByName?.("EventFilters")).toBeTruthy();

    Sentry.captureException(new Error("falha que precisa chegar ao Sentry do operador"));
    await Sentry.flush(2000);

    const texto = JSON.stringify(enviados);
    expect(enviados.length).toBeGreaterThan(0);
    expect(texto).toContain("falha que precisa chegar ao Sentry do operador");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * (d) CHAMADA CURTA E OUTROS PROVEDORES, INTOCADOS.
 * ────────────────────────────────────────────────────────────────────────────*/
describe("(d) chamada curta e outros provedores ficam como estavam", () => {
  it("outros provedores continuam indo por `generateText`", async () => {
    for (const provider of ["openai", "anthropic"]) {
      vi.mocked(streamText).mockClear();
      vi.mocked(generateText).mockClear();
      const { resultado } = await chamar(provider, ferramenta());
      expect(vi.mocked(generateText), `${provider} deixou de usar generateText`).toHaveBeenCalledTimes(1);
      expect(vi.mocked(streamText), `${provider} passou pelo ramo de streaming`).not.toHaveBeenCalled();
      expect(resultado.result.text).toBe("resposta ao cliente");
    }
  });

  it("a chamada curta da assinatura (sem tools) continua funcionando", async () => {
    const { resultado } = await chamar("openai-assinatura", {} as ToolSet);
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(resultado.result.text).toBe("resposta ao cliente");
  });

  it("e a chamada curta também funciona COM a instrumentação fora do caminho", async () => {
    for (const integracao of integracoesDoServidor([{ name: "Http", setupOnce: () => {} }])) {
      integracao.setupOnce();
    }
    const { resultado } = await chamar("openai-assinatura", {} as ToolSet);
    expect(resultado.result.text).toBe("resposta ao cliente");
  });
});
