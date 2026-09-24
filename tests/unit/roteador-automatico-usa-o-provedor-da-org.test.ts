/**
 * "AUTOMÁTICO — USA O PROVEDOR DA ORGANIZAÇÃO" TEM DE SER VERDADE.
 *
 * A tela do roteador grava `classifier_model: null` quando a pessoa escolhe
 * "Automático". O loader trocava esse vazio por `claude-haiku-4-5`, e o seam
 * trata o modelo do call site como knob de ambiente (degrau 3), que vence o
 * padrão da organização (degrau 5). Numa organização só-OpenAI o resultado era
 * `openai` + `claude-haiku-4-5`: o provedor responde "modelo inexistente", TODA
 * classificação falha e toda conversa cai no fallback do roteador.
 *
 * O teste atravessa as três peças reais — loader, classificador e a decisão do
 * seam — porque o defeito só existe na junção delas.
 */
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import { classifyIntent } from "@/lib/agent-engine/agent/intent-classifier";
import { decidirBinding } from "@/lib/ai/pontos/resolver";

function poolDoRoteador(config: Record<string, unknown>): pg.Pool {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ id: "r1", name: "R", config, fallback_agent_id: null }] })
    .mockResolvedValueOnce({
      rows: [{ agent_id: "a1", intent_name: "vendas", intent_description: "Quer comprar", examples: [] }],
    });
  return { query } as unknown as pg.Pool;
}

async function modeloDecidido(config: Record<string, unknown>) {
  const router = await loadActiveRouter(poolDoRoteador(config), "org1", "cs1");
  const runModelCall = vi.fn().mockResolvedValue({ result: { text: '{"intent":"none","confidence":0}' } });
  await classifyIntent(
    {} as never,
    {} as never,
    { tenantId: "org1", leadId: null, jobId: null, router: router!, signal: "oi" },
    { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, runModelCall } as never,
  );
  const input = runModelCall.mock.calls[0]![2] as { model?: string };
  // Mesma entrada que `decidirParaOSeam` monta quando não há override de agente.
  return decidirBinding({
    pontoId: "intent_router",
    binding: null,
    agentePublicado: null,
    modeloDeAmbiente: input.model,
    padraoDaOrganizacao: { provider: "openai", defaultModel: "gpt-5-mini" },
  });
}

describe("roteador em Automático", () => {
  it("numa organização só-OpenAI, classifica com o modelo padrão DELA — nunca com um id da Anthropic", async () => {
    const d = await modeloDecidido({ classifier_model: null, classifier_provider: null });
    expect(d.provider).toBe("openai");
    expect(d.modelId).toBe("gpt-5-mini");
  });

  it("config sem a chave do modelo (roteador antigo) também cai no padrão da organização", async () => {
    const d = await modeloDecidido({});
    expect(d.modelId).toBe("gpt-5-mini");
  });

  it("modelo escolhido na tela continua valendo", async () => {
    const d = await modeloDecidido({ classifier_model: "gpt-5.4-mini", classifier_provider: "openai" });
    expect(d.modelId).toBe("gpt-5.4-mini");
  });
});
