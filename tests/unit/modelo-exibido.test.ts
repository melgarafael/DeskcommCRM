/**
 * O card do agente anunciava "anthropic · claude-sonnet-5" enquanto o motor
 * rodava `nvidia/nemotron-3-ultra-550b-a55b:free` — porque a tela lia
 * `ai_agents.model` (escrito uma vez, na criação) e o motor lê o model da
 * versão PUBLICADA. Estes testes fixam quem vence.
 */
import { describe, expect, it } from "vitest";

import { modeloExibido } from "@/lib/ai/agents/modelo-exibido";

describe("modeloExibido", () => {
  it("a versão publicada vence a coluna legada do agente", () => {
    expect(
      modeloExibido({
        model: "anthropic/claude-sonnet-5",
        published_provider: "openrouter",
        published_model: "nvidia/nemotron-3-ultra-550b-a55b:free",
      }),
    ).toEqual({
      provider: "openrouter",
      model: "nvidia/nemotron-3-ultra-550b-a55b:free",
      origem: "versao",
    });
  });

  it("não adivinha provedor por prefixo quando a versão o declara", () => {
    // `nvidia/` é família do modelo, não o provedor — quem serve é a OpenRouter.
    const { provider } = modeloExibido({
      published_provider: "openrouter",
      published_model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    });
    expect(provider).toBe("openrouter");
  });

  it("sem versão publicada cai na coluna legada, como antes", () => {
    expect(modeloExibido({ model: "anthropic/claude-sonnet-5" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      origem: "legado",
    });
  });

  it("agente sem modelo nenhum não inventa nada", () => {
    expect(modeloExibido({ model: null }).model).toBe("—");
    expect(modeloExibido({ model: "", published_model: "  " }).model).toBe("—");
  });
});
