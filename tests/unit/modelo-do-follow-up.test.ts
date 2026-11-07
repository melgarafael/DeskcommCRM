/**
 * O FOLLOW-UP TEM O PRÓPRIO MODELO — no SEAM, onde a escolha vira chamada.
 *
 * `pontos-de-ia-resolver.test.ts` prova a decisão pura (`decidirBinding`). Ela
 * pode estar certa e o seam ainda instanciar outro modelo — foi assim que o
 * PR #151 voltou um degrau abaixo (`heranca-de-provider-nos-pontos-auxiliares`).
 * Aqui o ponto de verdade é o argumento que chega à FÁBRICA de modelo e a linha
 * que vai para `llm_calls`, com o mesmo par que o turno do agente passa
 * (`model` + `llmOverride` da versão publicada).
 *
 * O que se mede, nos dois sentidos:
 *  - `followup_turn` com escolha no painel → a fábrica recebe o modelo do
 *    painel, no provider dele, com a chave do provider dele;
 *  - `followup_turn` sem escolha → o modelo da versão publicada, com a origem
 *    `agente_publicado` — o comportamento de antes de o ponto existir;
 *  - `agent_turn` com o MESMO binding gravado para ele → ignora: a resposta ao
 *    cliente segue no modelo do agente.
 */
import { describe, expect, it, vi } from "vitest";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import type { LinhaDeBinding } from "@/lib/ai/pontos/resolver";

const ORG = "11111111-1111-4111-8111-111111111111";

/** O que o turno do agente passa ao seam: o modelo e o provider da versão publicada. */
const DO_AGENTE = {
  model: "claude-sonnet-5",
  llmOverride: { provider: "anthropic", credentialId: null },
} as const;

const ESCOLHA_DO_PAINEL: LinhaDeBinding = {
  purpose: "followup_turn",
  provider: "openai",
  credential_id: null,
  model_id: "gpt-5.6-luna",
  base_url: null,
  is_enabled: true,
};

/**
 * Banco dublê que responde o binding POR PONTO (o `purpose` vai no 2º
 * parâmetro, como em `carregarBinding`) e guarda cada linha de `llm_calls`.
 */
function poolFalso(bindings: Record<string, LinhaDeBinding> = {}) {
  const linhas: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return { rows: [{ llm: { provider: "anthropic", default_model: "claude-padrao-da-org" } }] };
    }
    if (sql.includes("from ai_purpose_bindings")) {
      const b = bindings[String(params[1])];
      return { rows: b && b.is_enabled ? [b] : [] };
    }
    if (sql.includes("from ai_provider_credentials")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) {
      linhas.push(params);
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, linhas };
}

function registrySpiao() {
  const chamadas: Array<{ provider: string; apiKey: string; modelId: string }> = [];
  const fabrica = (provider: string) => (apiKey: string, modelId: string) => {
    chamadas.push({ provider, apiKey, modelId });
    return {
      specificationVersion: "v3",
      provider,
      modelId,
      doGenerate: async () => ({
        content: [{ type: "text", text: "oi de novo" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    } as never;
  };
  return { chamadas, registry: { anthropic: fabrica("anthropic"), openai: fabrica("openai") } };
}

const CFG = { anthropicApiKey: "chave-anthropic", openaiApiKey: "chave-openai", cacheTtl: "1h" as const };

async function chamar(purpose: string, bindings: Record<string, LinhaDeBinding> = {}) {
  const { registry, chamadas } = registrySpiao();
  const { pool, linhas } = poolFalso(bindings);
  const r = await runModelCall(
    pool,
    CFG,
    { tenantId: ORG, purpose, ...DO_AGENTE, messages: [{ role: "user", content: "retome a conversa" }] },
    { registry },
  );
  return { r, chamadas, linhas };
}

/** As colunas do INSERT de sucesso em `run-model-call.ts`: purpose é a 5ª, provider a 6ª, model a 7ª, origem a 14ª. */
const coluna = { purpose: 4, provider: 5, model: 6, origem: 13 } as const;

describe("followup_turn no seam", () => {
  it("com escolha no painel: a fábrica recebe o modelo do painel, com o provider e a chave dele", async () => {
    const { r, chamadas, linhas } = await chamar("followup_turn", { followup_turn: ESCOLHA_DO_PAINEL });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toEqual({ provider: "openai", apiKey: "chave-openai", modelId: "gpt-5.6-luna" });
    expect(r.origem).toBe("binding");
    // A linha de custo sai no ponto próprio — é o que separa o gasto do
    // follow-up do da resposta na tela e na consulta por `purpose`.
    expect(linhas).toHaveLength(1);
    expect(linhas[0]![coluna.purpose]).toBe("followup_turn");
    expect(linhas[0]![coluna.provider]).toBe("openai");
    expect(linhas[0]![coluna.model]).toBe("gpt-5.6-luna");
    expect(linhas[0]![coluna.origem]).toBe("binding");
  });

  it("sem escolha: o modelo da versão publicada, com a origem de sempre", async () => {
    const { r, chamadas, linhas } = await chamar("followup_turn");

    expect(chamadas).toEqual([{ provider: "anthropic", apiKey: "chave-anthropic", modelId: "claude-sonnet-5" }]);
    expect(r.origem).toBe("agente_publicado");
    expect(linhas[0]![coluna.purpose]).toBe("followup_turn");
    expect(linhas[0]![coluna.origem]).toBe("agente_publicado");
  });

  it("escolha DESLIGADA: volta à versão publicada", async () => {
    const { chamadas, r } = await chamar("followup_turn", {
      followup_turn: { ...ESCOLHA_DO_PAINEL, is_enabled: false },
    });
    expect(chamadas).toEqual([{ provider: "anthropic", apiKey: "chave-anthropic", modelId: "claude-sonnet-5" }]);
    expect(r.origem).toBe("agente_publicado");
  });

  it("controle: `agent_turn` com o mesmo binding gravado para ele segue no modelo do agente", async () => {
    // Sem este caso, um seam que aplicasse o binding a qualquer ponto passaria
    // em tudo acima — e trocaria o modelo de quem opera o CRM.
    const { chamadas, r, linhas } = await chamar("agent_turn", {
      agent_turn: { ...ESCOLHA_DO_PAINEL, purpose: "agent_turn" },
      followup_turn: ESCOLHA_DO_PAINEL,
    });
    expect(chamadas).toEqual([{ provider: "anthropic", apiKey: "chave-anthropic", modelId: "claude-sonnet-5" }]);
    expect(r.origem).toBe("agente_publicado");
    expect(linhas[0]![coluna.purpose]).toBe("agent_turn");
  });

  it("o binding do follow-up não vaza para a resposta ao cliente", async () => {
    // O cenário real: o painel tem a escolha SÓ do follow-up. A resposta lê o
    // binding do PRÓPRIO ponto e não acha nada.
    const { chamadas } = await chamar("agent_turn", { followup_turn: ESCOLHA_DO_PAINEL });
    expect(chamadas).toEqual([{ provider: "anthropic", apiKey: "chave-anthropic", modelId: "claude-sonnet-5" }]);
  });
});
