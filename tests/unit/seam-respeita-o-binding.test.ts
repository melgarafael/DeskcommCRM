/**
 * O SEAM OBEDECE AO PAINEL — provado no ponto onde o modelo é instanciado.
 *
 * A suíte inteira (2984 testes) continuou verde depois de plugar o resolvedor
 * no seam, e isso não é boa notícia sozinha: significa que nenhum teste
 * existente exercita o caminho novo. Eles usam um `pg.Pool` fingido que não
 * responde à consulta de binding, então a leitura falha, o seam cai no padrão,
 * e o comportamento observado é o de antes. Verde por ausência, não por acerto.
 *
 * Este arquivo fecha esse buraco pelo único lugar que não mente: o argumento
 * que chega à FÁBRICA de modelo do registry. É lá que a escolha vira uma
 * chamada de verdade — asserção sobre o retorno de `runModelCall` passaria
 * mesmo se o provider instanciado fosse outro.
 */
import { describe, expect, it, vi } from "vitest";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

const ORG = "11111111-1111-4111-8111-111111111111";

interface LinhaBinding {
  provider: string;
  credential_id: string | null;
  model_id: string;
  base_url: string | null;
  is_enabled: boolean;
}

/**
 * `pg.Pool` fingido que responde às três consultas do caminho: config da org,
 * binding do ponto e o insert em `llm_calls`. Distinguir por trecho do SQL é
 * frágil de propósito — se o seam trocar a consulta, o teste quebra alto em vez
 * de silenciosamente devolver `undefined` e voltar ao caminho padrão.
 */
function poolFalso(opts: {
  binding?: LinhaBinding | null;
  llmSettings?: Record<string, unknown>;
  erroNoBinding?: boolean;
  advomaxEmpresaCodigo?: number;
}) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: opts.llmSettings ?? {
              provider: "anthropic",
              default_model: "claude-padrao-da-org",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
            advomax_empresa_codigo: opts.advomaxEmpresaCodigo ?? null,
          },
        ],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) {
      if (opts.erroNoBinding) throw new Error('relation "ai_purpose_bindings" does not exist');
      return { rows: opts.binding ? [opts.binding] : [] };
    }
    if (sql.includes("from ai_provider_credentials")) {
      return { rows: [] }; // sem BYOK → cai na chave de plataforma
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts, query };
}

/** Registry que registra COM O QUE foi chamado — o ponto de verdade. */
function registrySpiao() {
  const chamadas: Array<{ provider: string; apiKey: string; modelId: string; baseUrl?: string; organizationId?: string }> = [];
  const fabrica = (provider: string) => (apiKey: string, modelId: string, baseUrl?: string, organizationId?: string) => {
    chamadas.push({ provider, apiKey, modelId, ...(baseUrl ? { baseUrl } : {}), ...(organizationId ? { organizationId } : {}) });
    return {
      specificationVersion: "v3",
      provider,
      modelId,
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    } as never;
  };
  return {
    chamadas,
    registry: {
      anthropic: fabrica("anthropic"),
      openai: fabrica("openai"),
      openrouter: fabrica("openrouter"),
      advomax: fabrica("advomax"),
    },
  };
}

const cfg = { anthropicApiKey: "chave-anthropic", openaiApiKey: "chave-openai", cacheTtl: "1h" as const };

async function rodar(opts: Parameters<typeof poolFalso>[0] & { purpose: string; model?: string }) {
  const { pool, inserts } = poolFalso(opts);
  const { registry, chamadas } = registrySpiao();
  const r = await runModelCall(
    pool,
    cfg,
    {
      tenantId: ORG,
      purpose: opts.purpose,
      messages: [{ role: "user", content: "oi" }],
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    },
    { registry },
  );
  return { resultado: r, chamadas, inserts };
}

describe("o seam usa o modelo que o painel escolheu", () => {
  it("empresa Advomax usa o modelo herdado mesmo com o modelo antigo do agente publicado", async () => {
    const fetchAnterior = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      modelo: "deepseek-chat", ativo: true, apiKeyConfigurada: true,
    }), { status: 200 })) as typeof fetch;
    try {
      const { pool } = poolFalso({ binding: null, advomaxEmpresaCodigo: 7 });
      const { registry, chamadas } = registrySpiao();
      const resultado = await runModelCall(
        pool,
        { ...cfg, advomaxApiUrl: "https://gestao.local", advomaxIntegrationKey: "ponte-secreta" },
        {
          tenantId: ORG,
          purpose: "agent_turn",
          model: "claude-antigo-do-agente",
          llmOverride: { provider: "anthropic", credentialId: null },
          messages: [{ role: "user", content: "oi" }],
        },
        { registry },
      );
      expect(chamadas[0]).toMatchObject({
        provider: "advomax",
        modelId: "deepseek-chat",
        apiKey: "ponte-secreta",
        baseUrl: "https://gestao.local/integracoes/crm/ia",
        organizationId: ORG,
      });
      expect(resultado.origem).toBe("padrao_da_organizacao");
    } finally {
      global.fetch = fetchAnterior;
    }
  });

  it("sem binding, nada muda — segue o padrão da organização", () => {
    // A recíproca de tudo abaixo. Sem ela, um seam que ignorasse o painel por
    // completo passaria neste arquivo inteiro se os outros testes fossem
    // escritos ao contrário.
    return rodar({ purpose: "stage_classifier", binding: null }).then(({ chamadas, resultado }) => {
      expect(chamadas).toHaveLength(1);
      expect(chamadas[0]).toMatchObject({ provider: "anthropic", modelId: "claude-padrao-da-org" });
      expect(resultado.origem).toBe("padrao_da_organizacao");
    });
  });

  it("com binding, o modelo E o provider do painel chegam à fábrica", async () => {
    const { chamadas, resultado } = await rodar({
      purpose: "stage_classifier",
      binding: {
        provider: "openai",
        credential_id: null,
        model_id: "gpt-5-mini",
        base_url: null,
        is_enabled: true,
      },
    });
    expect(chamadas[0]).toMatchObject({ provider: "openai", modelId: "gpt-5-mini" });
    // A chave tem de ser a do provider ESCOLHIDO, não a do padrão da org. É a
    // forma exata do defeito do PR #151: modelo certo, chave do provider
    // errado, e o turno morre com 404 no endpoint de quem não tem o modelo.
    expect(chamadas[0]?.apiKey).toBe("chave-openai");
    expect(resultado.origem).toBe("binding");
  });

  it("o binding vence a variável de ambiente que o call site passou", async () => {
    const { chamadas, resultado } = await rodar({
      purpose: "compaction",
      model: "modelo-da-variavel-de-ambiente",
      binding: {
        provider: "openai",
        credential_id: null,
        model_id: "gpt-5-nano",
        base_url: null,
        is_enabled: true,
      },
    });
    expect(chamadas[0]?.modelId).toBe("gpt-5-nano");
    expect(resultado.origem).toBe("binding");
    expect(resultado.avisos.join(" ")).toContain("modelo-da-variavel-de-ambiente");
  });

  it("binding desligado não é aplicado", async () => {
    const { chamadas } = await rodar({
      purpose: "compaction",
      binding: {
        provider: "openai",
        credential_id: null,
        model_id: "NAO-DEVE-SER-USADO",
        base_url: null,
        is_enabled: false,
      },
    });
    expect(chamadas[0]?.modelId).toBe("claude-padrao-da-org");
  });

  it("cada ponto é resolvido pelo SEU purpose", async () => {
    // O painel promete configuração por ponto. Se o seam consultasse sem
    // filtrar por purpose, o binding de um ponto vazaria para todos os outros
    // — e a promessa central da tela seria falsa.
    const { pool } = poolFalso({
      binding: {
        provider: "openai",
        credential_id: null,
        model_id: "gpt-5-mini",
        base_url: null,
        is_enabled: true,
      },
    });
    const { registry } = registrySpiao();
    await runModelCall(
      pool,
      cfg,
      { tenantId: ORG, purpose: "jailbreak_detect", messages: [{ role: "user", content: "oi" }] },
      { registry },
    );
    const consultaDeBinding = (pool as unknown as { query: ReturnType<typeof vi.fn> }).query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes("from ai_purpose_bindings"),
    );
    expect(consultaDeBinding, "o seam nem consultou a tabela de bindings").toBeDefined();
    expect(consultaDeBinding?.[1]).toEqual([ORG, "jailbreak_detect"]);
  });
});

describe("quando a tabela de bindings não responde", () => {
  it("a chamada continua, no padrão da organização", async () => {
    // Um clone que não aplicou o baseline não tem a tabela. Derrubar o turno
    // aqui trocaria um problema de configuração por um de disponibilidade: o
    // cliente ficaria sem resposta no WhatsApp por causa de uma tela.
    const { chamadas } = await rodar({ purpose: "compaction", erroNoBinding: true });
    expect(chamadas[0]?.modelId).toBe("claude-padrao-da-org");
  });

  it("mas AVISA — a falha não pode ser silenciosa", async () => {
    // Sem este aviso, o painel pareceria funcionar (salva, mostra a escolha) e
    // nenhuma chamada de modelo o respeitaria — a forma exata do problema que
    // esta frente veio resolver, recriada por ela.
    const { pool } = poolFalso({ erroNoBinding: true });
    const { registry } = registrySpiao();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await runModelCall(
      pool,
      cfg,
      { tenantId: ORG, purpose: "compaction", messages: [{ role: "user", content: "oi" }] },
      { registry, log: log as never },
    );
    const avisos = log.warn.mock.calls.map((c) => String(c[0]));
    expect(avisos.some((m) => m.includes("binding"))).toBe(true);
  });
});

describe("o custo é atribuído ao ponto certo", () => {
  it("llm_calls grava o purpose e o provider efetivamente usado", async () => {
    const { inserts } = await rodar({
      purpose: "flywheel_judge",
      binding: {
        provider: "openai",
        credential_id: null,
        model_id: "gpt-5-mini",
        base_url: null,
        is_enabled: true,
      },
    });
    expect(inserts).toHaveLength(1);
    const params = inserts[0]!.params;
    // O provider gravado tem de ser o do binding, não o padrão da org — senão
    // a conta do mês atribui o gasto ao provedor errado e o painel de uso
    // conta uma história que não aconteceu.
    expect(params).toContain("flywheel_judge");
    expect(params).toContain("openai");
    expect(params).toContain("gpt-5-mini");
  });
});
