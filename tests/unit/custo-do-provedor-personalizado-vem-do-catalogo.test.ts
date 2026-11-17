/**
 * O TURNO DO PROVEDOR PERSONALIZADO GRAVA CUSTO — pelo catálogo da instalação (#3013).
 *
 * ═══ O defeito medido pelo dono ════════════════════════════════════════════════
 *
 * Provedor PERSONALIZADO apontando para o Groq, modelo `openai/gpt-oss-120b` no
 * propósito `checkpoint`: 180 chamadas (e 256 de `openai/gpt-oss-20b`) com
 * `llm_calls.cost_cents` NULO, de 12/10 a 16/10, enquanto o Haiku 5.5 do mesmo
 * turno gravava custo. A tabela estática do seam não conhece gpt-oss
 * (`grep -c gpt-oss` = 0) e o `null` não avisava ninguém — a tela de Uso somava
 * `coalesce(cost_cents, 0)` e a chamada paga não aparecia em lugar nenhum.
 *
 * ═══ O que este arquivo prova, pelo SEAM inteiro ═══════════════════════════════
 *
 * Não por leitura de módulo: por `runModelCall` com o pool fingido e a fábrica de
 * provedor espiã — o MESMO molde de `seam-respeita-o-binding.test.ts` e
 * `seam-endereco-da-empresa-exige-chave-da-empresa.test.ts`. O ponto de verdade é
 * o `cost_cents` que chega ao INSERT de `llm_calls`, que é a coluna da issue.
 *
 *  1. 🔴 com a linha de preço no banco (`ai_models`/`ai_pricing`), a chamada do
 *     provedor personalizado grava custo CALCULADO, em centavo fracionado;
 *  2. controle negativo: id em tabela nenhuma continua gravando `null` — e agora
 *     com aviso no log, uma vez por (provedor, modelo);
 *  3. recíproca: modelo que o motor JÁ sabe cobrar não consulta o banco e grava o
 *     mesmo número de antes — o caminho novo só existe atrás do `null`.
 *
 * ═══ Sobre os números ═════════════════════════════════════════════════════════
 *
 * 15/60 centavos por milhão são os da linha `openai/gpt-oss-120b` que o dono
 * MEDIU na instalação dele (a issue cita) — aqui eles são o DUBLÊ do banco de
 * quem instalou, não um preço que o repo declara: o preço do Groq não foi
 * conferido na fonte oficial, e chutá-lo seria trocar um nulo honesto por um
 * número errado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// A decifragem não é o assunto: a linha de credencial devolvida pelo banco vira
// esta chave. É o mesmo atalho do vizinho de endereço próprio.
vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-da-empresa",
}));

// O SDK nunca sai para a rede: `generateText` devolve o usage no shape que o
// seam lê (`LanguageModelUsage`), que é o mesmo dublê do caminho de mídia.
vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({
    text: "ok",
    usage: {
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      inputTokenDetails: { noCacheTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  })),
  streamText: vi.fn(),
  stepCountIs: () => () => false,
  // `stable-prefix.ts` e `count-tokens.ts` (importados pelo seam) usam este.
  asSchema: vi.fn(),
  tool: (t: unknown) => t,
}));

import { _esquecerPrecosDoCatalogoParaTestes } from "@/lib/agent-engine/edge/llm/pricing-do-catalogo";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const ORG = "11111111-1111-4111-8111-111111111111";
const MODELO = "openai/gpt-oss-120b";
const ENDERECO_DO_GROQ = "https://api.groq.com/openai/v1";

/**
 * O relógio é EXPLÍCITO: o endereço próprio da organização tem prazo
 * (`RECUSA_A_PARTIR_DE`), e um teste que não declara o instante mediria "o dia em
 * que a suíte rodou". Aqui a data é muito antes do corte — o assunto é o CUSTO.
 */
const ANTES_DO_PRAZO = new Date("2026-09-20T00:00:00.000Z");

interface LinhaDePreco {
  id: string;
  provider: string | null;
  entrada: number | null;
  saida: number | null;
  origem: "catalogo" | "tabela_de_preco";
}

/** A linha da instalação da issue: `openai/gpt-oss-120b` a 15/60 centavos por milhão. */
const PRECO_DO_GPT_OSS: LinhaDePreco = {
  id: MODELO,
  provider: "openrouter",
  entrada: 15,
  saida: 60,
  origem: "catalogo",
};

/**
 * `pg.Pool` fingido. Cada ramo é identificado por trecho de SQL, de propósito: se
 * o seam trocar a consulta, o teste quebra alto em vez de devolver `undefined` e
 * cair no caminho padrão. A consulta de preço é reconhecida pelo nome do CTE.
 */
function poolFalso(linhasDePreco: LinhaDePreco[] = [], opts: { precoFalha?: boolean } = {}) {
  const inserts: unknown[][] = [];
  const consultas: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push(sql);
    if (sql.includes("candidatos_de_preco")) {
      if (opts.precoFalha) throw new Error('relation "ai_models" does not exist');
      const ids = new Set((params[0] as string[] | undefined) ?? []);
      return { rows: linhasDePreco.filter((l) => ids.has(l.id)) };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push(params);
      return { rows: [{ id: "call-1" }] };
    }
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "custom",
              default_model: MODELO,
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    // O endereço do provedor personalizado vem da CREDENCIAL (#1642).
    if (sql.includes("base_url")) return { rows: [{ base_url: ENDERECO_DO_GROQ }] };
    if (sql.includes("api_key_encrypted")) {
      return {
        rows: [{ id: "cred-1", api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }],
      };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts, consultas };
}

/** Registry espião: registra com QUEM a chamada saiu (provider, modelo, endereço). */
function registryEspiao() {
  const chamadas: Array<{ provider: string; modelId: string; baseUrl: string | undefined }> = [];
  const fabrica = (provider: string) => (apiKey: unknown, modelId: string, baseUrl?: string) => {
    chamadas.push({ provider, modelId, baseUrl });
    return {
      specificationVersion: "v3",
      provider,
      modelId,
      doGenerate: async () => {
        throw new Error("SENTINELA: o seam usou o SDK de verdade em vez do dublê");
      },
    } as never;
  };
  return {
    chamadas,
    registry: {
      custom: fabrica("custom"),
      anthropic: fabrica("anthropic"),
      openai: fabrica("openai"),
    },
  };
}

function logEspiao() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

const cfg = { cacheTtl: "1h" as const };

async function rodar(opts: { linhasDePreco?: LinhaDePreco[]; modelo?: string } = {}) {
  const { pool, inserts, consultas } = poolFalso(opts.linhasDePreco);
  const { registry, chamadas } = registryEspiao();
  const log = logEspiao();
  const resultado = await runModelCall(
    pool,
    cfg,
    {
      tenantId: ORG,
      purpose: "checkpoint",
      messages: [{ role: "user", content: "oi" }],
      ...(opts.modelo !== undefined ? { model: opts.modelo } : {}),
    },
    { registry, log, agora: ANTES_DO_PRAZO },
  );
  return { resultado, inserts, consultas, chamadas, log };
}

/** `cost_cents` é o 12º parâmetro do INSERT (organization_id … cost_cents). */
const custoGravado = (inserts: unknown[][]) => inserts[0]![11] as number | null;

const consultouOpreco = (consultas: string[]) =>
  consultas.some((sql) => sql.includes("candidatos_de_preco"));

beforeEach(() => _esquecerPrecosDoCatalogoParaTestes());

describe("🔴 #3013 — provedor personalizado com o preço no catálogo da instalação", () => {
  it("a chamada gravou `cost_cents` CALCULADO — deixa de ser nula", async () => {
    const { resultado, inserts, chamadas } = await rodar({ linhasDePreco: [PRECO_DO_GPT_OSS] });

    // A chamada saiu pelo endpoint do operador, com o modelo dele — é o cenário
    // da issue, não um caminho parecido.
    expect(chamadas).toEqual([{ provider: "custom", modelId: MODELO, baseUrl: ENDERECO_DO_GROQ }]);
    expect(inserts).toHaveLength(1);

    // O defeito medido: `null` aqui era TODA chamada da instalação.
    expect(custoGravado(inserts)).not.toBeNull();
    // 2 MTok de entrada a 15¢/M mais 1 MTok de saída a 60¢/M = 90 centavos, sem
    // arredondar (o arredondamento para cima foi defeito medido neste repo).
    expect(custoGravado(inserts)).toBeCloseTo(90, 9);
    // E o mesmo número volta para quem chamou — é ele que o painel mostra.
    expect(resultado.costCents).toBeCloseTo(90, 9);
  });

  it("o log diz de ONDE saiu o preço, e o nulo calado não volta", async () => {
    const { log } = await rodar({ linhasDePreco: [PRECO_DO_GPT_OSS] });

    const concluida = log.info.mock.calls.find(([msg]) => msg === "llm: chamada concluída");
    expect(concluida).toBeDefined();
    expect(concluida![1]).toMatchObject({ cost_cents: 90, custo_origem: "catalogo_da_instalacao" });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("quando a linha só existe em ai_pricing, o custo também sai calculado", async () => {
    const { inserts } = await rodar({
      linhasDePreco: [{ ...PRECO_DO_GPT_OSS, provider: null, origem: "tabela_de_preco" }],
    });
    expect(custoGravado(inserts)).toBeCloseTo(90, 9);
  });
});

describe("controle negativo pelo seam — id sem preço em tabela nenhuma", () => {
  it("grava null (nunca um número inventado) E avisa no log", async () => {
    const { inserts, log } = await rodar({
      modelo: "provedor-x/modelo-que-nao-existe",
      linhasDePreco: [PRECO_DO_GPT_OSS],
    });

    expect(custoGravado(inserts)).toBeNull();
    expect(typeof custoGravado(inserts)).not.toBe("number");

    // O que a issue cobra: o nulo passa a ser EXPLÍCITO.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toContain("sem preço");
    expect(log.warn.mock.calls[0]![1]).toEqual({
      provider: "custom",
      model: "provedor-x/modelo-que-nao-existe",
    });

    // E a linha do log da chamada continua dizendo null — agora com o MOTIVO
    // junto (`sem_preco`, #4697): nulo declarado, não nulo calado.
    const concluida = log.info.mock.calls.find(([msg]) => msg === "llm: chamada concluída");
    expect(concluida![1]).toMatchObject({ cost_cents: null, custo_origem: "sem_preco" });
  });

  it("banco fora do ar no preço não derruba o turno: a resposta sai, o custo volta a ser desconhecido", async () => {
    // Só a consulta de preço estoura; todo o resto do pool segue de pé.
    const { pool, inserts, consultas } = poolFalso([PRECO_DO_GPT_OSS], { precoFalha: true });
    const { registry } = registryEspiao();
    const log = logEspiao();

    const resultado = await runModelCall(
      pool,
      cfg,
      { tenantId: ORG, purpose: "checkpoint", messages: [{ role: "user", content: "oi" }] },
      { registry, log, agora: ANTES_DO_PRAZO },
    );

    expect(resultado.costCents).toBeNull();
    expect(inserts).toHaveLength(1);
    // A leitura foi TENTADA e falhou — e mesmo assim a chamada fechou com null.
    expect(consultouOpreco(consultas)).toBe(true);
  });
});

describe("recíproca — o modelo que o motor JÁ sabe cobrar não passa pelo banco", () => {
  it("claude-haiku-5-5 grava o mesmo custo de antes, sem uma consulta a mais", async () => {
    const { inserts, consultas, resultado } = await rodar({
      modelo: "claude-haiku-5-5",
      // O banco até tem linha para ele: o caminho estático tem de vencer mesmo assim.
      linhasDePreco: [{ ...PRECO_DO_GPT_OSS, id: "claude-haiku-5-5", entrada: 9999, saida: 9999 }],
    });

    // 2 MTok de entrada a 10¢/M (US$ 0,1) mais 1 MTok de saída a 50¢/M = 70 centavos.
    expect(custoGravado(inserts)).toBeCloseTo(70, 9);
    expect(resultado.costCents).toBeCloseTo(70, 9);
    expect(consultouOpreco(consultas)).toBe(false);
  });
});
