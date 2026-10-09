/**
 * O CLASSIFICADOR NÃO PAGA A TARIFA DO AGENTE.
 *
 * Sem knob nem binding, o classificador de estágio e o de manipulação herdavam
 * o modelo do agente — Sonnet para devolver um rótulo, em todo turno.
 * Este arquivo prende três coisas:
 *
 *  1. A ESCOLHA (`escolherModeloEconomico`): o mais barato do mesmo provedor que
 *     ainda conversa — nunca o de embedding, nunca fora dos modelos habilitados,
 *     nunca quando não há régua de preço.
 *  2. A PRECEDÊNCIA: binding > knob > econômico > herança. Escolha explícita
 *     sempre vence a automática, e provider/credencial nunca mudam (PR #151).
 *  3. A RESERVA no seam: o econômico falhou ⇒ a chamada se repete no modelo de
 *     antes, e o que vai para `llm_calls` é o modelo que de fato respondeu.
 *
 * Asserções no seam são feitas na FÁBRICA do registry — o único lugar em que a
 * escolha vira chamada de verdade (ver `seam-respeita-o-binding.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  decidirBinding,
  escolherModeloEconomico,
  type EntradaDaDecisao,
  type ModeloDoCatalogoEconomico,
} from "@/lib/ai/pontos/resolver";
import { esquecerCatalogoEconomico } from "@/lib/agent-engine/edge/llm/binding-do-ponto";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

const m = (
  provider: string,
  model_id: string,
  input: number | null,
  output: number | null,
  over: Partial<ModeloDoCatalogoEconomico> = {},
): ModeloDoCatalogoEconomico => ({
  provider,
  model_id,
  input_price_per_million_cents: input,
  output_price_per_million_cents: output,
  supports_tools: true,
  supports_embedding: false,
  ...over,
});

// Recorte do catálogo curado do baseline (preços em centavos por milhão).
const CATALOGO = [
  m("anthropic", "claude-opus-5", 500, 2500),
  m("anthropic", "claude-sonnet-5", 200, 1000),
  m("anthropic", "claude-haiku-4-5", 100, 500),
  m("openai", "gpt-5.6-terra", 200, 1200),
  m("openai", "gpt-5.6-luna", 20, 120),
  m("openai", "gpt-5.4-nano", 20, 125),
  m("openai", "text-embedding-3-small", 2, 0, { supports_embedding: true }),
  m("google", "gemini-3.5-flash", 150, 900),
  m("google", "gemini-2.0-flash", 10, 40),
  m("google", "gemini-2.5-flash-lite", 10, 40),
];

describe("escolherModeloEconomico", () => {
  it("escolhe o mais barato do MESMO provedor", () => {
    expect(escolherModeloEconomico(CATALOGO, "anthropic", "claude-sonnet-5")).toBe("claude-haiku-4-5");
  });

  it("nunca escolhe modelo de embedding, mesmo sendo o mais barato", () => {
    // `text-embedding-3-small` custa 2: sem o filtro, todo classificador em
    // OpenAI iria para um endpoint de embedding e tomaria 400 calado.
    expect(escolherModeloEconomico(CATALOGO, "openai", "gpt-5.6-terra")).toBe("gpt-5.6-luna");
  });

  it("desempata de forma determinística (saída menor, depois id mais novo)", () => {
    // luna (20/120) vence nano (20/125) pela saída.
    expect(escolherModeloEconomico(CATALOGO, "openai", "gpt-5.6-terra")).toBe("gpt-5.6-luna");
    // Preço idêntico: o id em ordem decrescente — a versão mais nova.
    expect(escolherModeloEconomico(CATALOGO, "google", "gemini-3.5-flash")).toBe("gemini-2.5-flash-lite");
  });

  it("não troca quando o agente já está no modelo mais barato", () => {
    expect(escolherModeloEconomico(CATALOGO, "anthropic", "claude-haiku-4-5")).toBeNull();
  });

  it("não troca quando não sabe o preço do modelo atual", () => {
    // Sem régua não dá para afirmar economia — o agente pode já estar num
    // modelo barato que o catálogo não conhece.
    expect(escolherModeloEconomico(CATALOGO, "anthropic", "claude-desconhecido")).toBeNull();
    expect(escolherModeloEconomico(CATALOGO, "anthropic", null)).toBeNull();
  });

  it("respeita os modelos habilitados da organização", () => {
    expect(
      escolherModeloEconomico(CATALOGO, "anthropic", "claude-opus-5", ["claude-opus-5", "claude-sonnet-5"]),
    ).toBe("claude-sonnet-5");
    expect(escolherModeloEconomico(CATALOGO, "anthropic", "claude-sonnet-5", ["claude-sonnet-5"])).toBeNull();
  });

  it("fica de fora de provedor sem catálogo curado (roteadores, personalizado)", () => {
    const comRoteador = [...CATALOGO, m("openrouter", "anthropic/claude-haiku-4-5", 100, 500)];
    expect(escolherModeloEconomico(comRoteador, "openrouter", "anthropic/claude-sonnet-5")).toBeNull();
  });
});

const economico = (provider: string, atual: string | null) => escolherModeloEconomico(CATALOGO, provider, atual);

const entrada = (over: Partial<EntradaDaDecisao> = {}): EntradaDaDecisao => ({
  pontoId: "stage_classifier",
  binding: null,
  agentePublicado: { provider: "anthropic", credentialId: "cred-anthropic", model: "claude-sonnet-5" },
  modeloDeAmbiente: undefined,
  padraoDaOrganizacao: { provider: "anthropic", defaultModel: "claude-sonnet-5" },
  economicoDoProvedor: economico,
  ...over,
});

describe("a precedência com o degrau econômico", () => {
  it("classificador herdado vai para o econômico, com a MESMA credencial e o herdado como reserva", () => {
    const d = decidirBinding(entrada());
    expect(d).toMatchObject({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      credentialId: "cred-anthropic",
      origem: "economico_do_provedor",
      reserva: { modelId: "claude-sonnet-5", origem: "herdado_de_quem_chamou" },
    });
  });

  it("vale também para o padrão da organização (ponto sem agente que empreste)", () => {
    const d = decidirBinding(entrada({ agentePublicado: null }));
    expect(d.modelId).toBe("claude-haiku-4-5");
    expect(d.reserva).toEqual({ modelId: "claude-sonnet-5", origem: "padrao_da_organizacao" });
  });

  it("binding vence o econômico", () => {
    const d = decidirBinding(
      entrada({
        binding: {
          purpose: "stage_classifier",
          provider: "anthropic",
          credential_id: null,
          model_id: "claude-opus-5",
          base_url: null,
          is_enabled: true,
        },
      }),
    );
    expect(d.modelId).toBe("claude-opus-5");
    expect(d.origem).toBe("binding");
  });

  it("knob de ambiente vence o econômico", () => {
    const d = decidirBinding(entrada({ agentePublicado: null, modeloDeAmbiente: "claude-sonnet-5" }));
    expect(d.modelId).toBe("claude-sonnet-5");
    expect(d.origem).toBe("variavel_de_ambiente");
  });

  it("ponto que NÃO é classificação curta continua no modelo do agente", () => {
    // follow-up e validação de fluxo: saída fora do formato LANÇA (a fila repete
    // o turno no mesmo modelo) ou vai para o cadastro — a reserva não os cobre.
    for (const pontoId of [
      "promise_semantic",
      "checkpoint",
      "compaction",
      "intent_router",
      "followup_classify",
      "followup_decide_timing",
      "flow_validate",
    ]) {
      const d = decidirBinding(entrada({ pontoId }));
      expect(d.modelId, pontoId).toBe("claude-sonnet-5");
      expect(d.reserva, pontoId).toBeUndefined();
    }
  });

  it("os pontos do agente publicado nunca são trocados", () => {
    const d = decidirBinding(entrada({ pontoId: "agent_turn" }));
    expect(d.modelId).toBe("claude-sonnet-5");
    expect(d.origem).toBe("agente_publicado");
  });

  it("sem catálogo (economicoDoProvedor ausente) a regra é a de antes", () => {
    const d = decidirBinding(entrada({ economicoDoProvedor: undefined }));
    expect(d.modelId).toBe("claude-sonnet-5");
    expect(d.origem).toBe("herdado_de_quem_chamou");
  });
});

// ─── o seam ──────────────────────────────────────────────────────────────────

const ORG = "11111111-1111-4111-8111-111111111111";

function poolFalso(opts: { catalogo?: ModeloDoCatalogoEconomico[]; erroNoCatalogo?: boolean } = {}) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "anthropic",
              default_model: "claude-sonnet-5",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("from ai_models")) {
      if (opts.erroNoCatalogo) throw new Error('relation "ai_models" does not exist');
      return { rows: opts.catalogo ?? CATALOGO };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts, query };
}

function registrySpiao(falhaEm: ReadonlySet<string> = new Set(), instavelEm: ReadonlySet<string> = new Set()) {
  const chamadas: string[] = [];
  const fabrica = (provider: string) => (_apiKey: string, modelId: string) => {
    chamadas.push(modelId);
    return {
      specificationVersion: "v3",
      provider,
      modelId,
      doGenerate: async () => {
        if (falhaEm.has(modelId)) throw Object.assign(new Error(`model not found: ${modelId}`), { statusCode: 404 });
        if (instavelEm.has(modelId)) throw Object.assign(new Error("overloaded"), { statusCode: 503 });
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    } as never;
  };
  return { chamadas, registry: { anthropic: fabrica("anthropic"), openai: fabrica("openai") } };
}

const cfg = { anthropicApiKey: "chave-anthropic", openaiApiKey: "chave-openai", cacheTtl: "1h" as const };

async function rodar(
  purpose: string,
  pool: ReturnType<typeof poolFalso>,
  falhaEm?: ReadonlySet<string>,
  instavelEm?: ReadonlySet<string>,
) {
  const { registry, chamadas } = registrySpiao(falhaEm, instavelEm);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const r = await runModelCall(
    pool.pool,
    cfg,
    {
      tenantId: ORG,
      purpose,
      model: "claude-sonnet-5",
      llmOverride: { provider: "anthropic", credentialId: null },
      messages: [{ role: "user", content: "oi" }],
    },
    { registry, log: log as never },
  );
  return { r, chamadas, log };
}

describe("o seam aplica o econômico e tem reserva", () => {
  beforeEach(() => esquecerCatalogoEconomico());

  it("o classificador herdado chega à fábrica no modelo econômico", async () => {
    const pool = poolFalso();
    const { r, chamadas } = await rodar("jailbreak_detect", pool);
    expect(chamadas).toEqual(["claude-haiku-4-5"]);
    expect(r.origem).toBe("economico_do_provedor");
    expect(pool.inserts[0]!.params).toContain("claude-haiku-4-5");
  });

  it("o turno do agente nem consulta o catálogo", async () => {
    const pool = poolFalso();
    const { chamadas } = await rodar("agent_turn", pool);
    expect(chamadas).toEqual(["claude-sonnet-5"]);
    expect(pool.query.mock.calls.some((c: unknown[]) => String(c[0]).includes("from ai_models"))).toBe(false);
  });

  it("o econômico falhou ⇒ repete no modelo de antes, e llm_calls grava quem respondeu", async () => {
    const pool = poolFalso();
    const { r, chamadas, log } = await rodar("stage_classifier", pool, new Set(["claude-haiku-4-5"]));
    expect(chamadas).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.origem).toBe("herdado_de_quem_chamou");
    const sucesso = pool.inserts.find((i) => i.sql.includes("'ok'"));
    expect(sucesso?.params).toContain("claude-sonnet-5");
    // A falha coberta é registrada com origem própria — Execuções não mostra a
    // consequência de negócio de uma falha que não aconteceu para o cliente —
    // e não vira log de erro.
    const falha = pool.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes("insert into llm_calls") && (c[1] as unknown[]).includes("claude-haiku-4-5"),
    );
    expect(falha?.[1]).toContain("economico_coberto_pela_reserva");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("depois de uma recusa, os turnos seguintes da organização vão direto ao modelo de antes", async () => {
    const pool = poolFalso();
    await rodar("stage_classifier", pool, new Set(["claude-haiku-4-5"]));
    const { chamadas } = await rodar("jailbreak_detect", pool, new Set(["claude-haiku-4-5"]));
    // Sem o castigo, toda classificação pagaria a recusa antes da reserva.
    expect(chamadas).toEqual(["claude-sonnet-5"]);
  });

  it("a reserva também falhou ⇒ o erro sobe (quem chama decide, como antes)", async () => {
    const pool = poolFalso();
    await expect(
      rodar("stage_classifier", pool, new Set(["claude-haiku-4-5", "claude-sonnet-5"])),
    ).rejects.toThrow(/claude-sonnet-5/);
    // Aqui sim é erro de verdade: a linha da reserva leva a origem de sempre.
    const daReserva = pool.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes("insert into llm_calls") && (c[1] as unknown[]).includes("claude-sonnet-5"),
    );
    expect(daReserva?.[1]).toContain("herdado_de_quem_chamou");
  });

  it("instabilidade do provedor (5xx) NÃO troca de modelo — o classificador degrada como antes", async () => {
    const pool = poolFalso();
    await expect(rodar("jailbreak_detect", pool, undefined, new Set(["claude-haiku-4-5"]))).rejects.toThrow(
      "overloaded",
    );
    const { chamadas } = await rodar("jailbreak_detect", pool);
    // Uma chamada só no instável, e nenhum castigo: o próximo turno volta ao econômico.
    expect(chamadas).toEqual(["claude-haiku-4-5"]);
  });

  it("sem catálogo legível, segue no modelo herdado — mais caro, nunca quebrado", async () => {
    const pool = poolFalso({ erroNoCatalogo: true });
    const { chamadas, r } = await rodar("stage_classifier", pool);
    expect(chamadas).toEqual(["claude-sonnet-5"]);
    expect(r.origem).toBe("herdado_de_quem_chamou");
  });

  it("o catálogo é lido uma vez e reaproveitado entre chamadas", async () => {
    const pool = poolFalso();
    await rodar("stage_classifier", pool);
    await rodar("jailbreak_detect", pool);
    const leituras = pool.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes("from ai_models"));
    expect(leituras).toHaveLength(1);
  });
});
