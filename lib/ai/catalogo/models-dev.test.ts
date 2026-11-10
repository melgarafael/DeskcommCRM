import { describe, expect, it, vi } from "vitest";

import { sincronizarModelosNativos, traduzirCatalogoNativo } from "./models-dev";

function modelo(id: string) {
  return {
    id,
    name: id,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_050_000 },
    cost: { input: 1, output: 5 },
  };
}

function resposta() {
  return {
    openai: { models: { "gpt-6.1-terra": modelo("gpt-6.1-terra") } },
    anthropic: { models: { "claude-opus-5-5": modelo("claude-opus-5-5") } },
  };
}

describe("descoberta de modelos nativos", () => {
  it("preserva IDs nativos e traduz preço por milhão, ferramentas e visão", () => {
    const linhas = traduzirCatalogoNativo(resposta());
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toMatchObject({
      provider: "openai",
      model_id: "gpt-6.1-terra",
      source: "models.dev",
      input_price_per_million_cents: 100,
      output_price_per_million_cents: 500,
      context_window: 1_050_000,
      supports_tools: true,
      supports_vision: true,
    });
    expect(linhas[1]).toMatchObject({ provider: "anthropic", model_id: "claude-opus-5-5" });
  });

  it("não publica aposentados, modelos sem ferramentas nem saídas de imagem/áudio", () => {
    const r = resposta();
    r.openai.models["gpt-6.1-terra"].tool_call = false;
    r.anthropic.models["claude-opus-5-5"].modalities.output = ["audio"];
    expect(traduzirCatalogoNativo(r)).toEqual([]);
    expect(
      traduzirCatalogoNativo({
        ...resposta(),
        openai: { models: { aposentado: { ...modelo("aposentado"), status: "deprecated" } } },
      }).map((m) => m.provider),
    ).toEqual(["anthropic"]);
  });

  it("modelo de tempo real (voz) não entra, mesmo com texto e ferramentas", () => {
    const r = resposta();
    expect(
      traduzirCatalogoNativo({
        ...r,
        openai: {
          models: {
            ...r.openai.models,
            "gpt-realtime-2.1": { ...modelo("gpt-realtime-2.1"), type: "realtime" },
          },
        },
      }).map((m) => m.model_id),
    ).toEqual(["gpt-6.1-terra", "claude-opus-5-5"]);
  });

  it("modelo de imagem com contexto zero não impede descobrir modelos de conversa", () => {
    const r = resposta();
    expect(
      traduzirCatalogoNativo({
        ...r,
        openai: {
          models: {
            ...r.openai.models,
            imagem: {
              ...modelo("imagem"),
              tool_call: false,
              modalities: { input: ["text"], output: ["image"] },
              limit: { context: 0 },
            },
          },
        },
      }),
    ).toHaveLength(2);
  });

  it("preço ausente é desconhecido; preço zero permanece zero", () => {
    const r = resposta();
    expect(
      traduzirCatalogoNativo({
        ...r,
        openai: { models: { novo: { ...modelo("novo"), cost: undefined } } },
      })[0]?.input_price_per_million_cents,
    ).toBeNull();
    r.openai.models["gpt-6.1-terra"].cost.input = 0;
    expect(traduzirCatalogoNativo(r)[0]?.input_price_per_million_cents).toBe(0);
  });

  it.each([
    {},
    { ...resposta(), anthropic: undefined },
    { ...resposta(), openai: { models: { trocado: modelo("outro") } } },
    { ...resposta(), openai: { models: { novo: { ...modelo("novo"), cost: { input: -1 } } } } },
  ])("recusa resposta inválida inteira antes de gravar (%#)", async (r) => {
    const from = vi.fn();
    await expect(sincronizarModelosNativos({ from } as never, async () => r)).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
  });

  it("recusa fonte vazia ou sem modelos utilizáveis de um dos fabricantes", async () => {
    const from = vi.fn();
    await expect(
      sincronizarModelosNativos({ from } as never, async () => ({
        ...resposta(),
        openai: { models: {} },
      })),
    ).rejects.toThrow("catalogo_nativo_vazio");
    expect(from).not.toHaveBeenCalled();
  });

  it("adiciona sem sobrescrever curadoria, não ressuscita depreciados e repetir não duplica", async () => {
    const manual = {
      provider: "openai",
      model_id: "gpt-6.1-terra",
      source: "manual",
      deprecated_at: "2026-01-01",
      display_name: "Escolha manual",
    };
    const linhas = new Map([[`${manual.provider}/${manual.model_id}`, manual]]);
    const upsert = vi.fn((novas, opcoes) => ({
      select: async () => {
        expect(opcoes).toEqual({ onConflict: "provider,model_id", ignoreDuplicates: true });
        const inseridas: (typeof manual)[] = [];
        for (const nova of novas) {
          const chave = `${nova.provider}/${nova.model_id}`;
          if (!linhas.has(chave)) {
            linhas.set(chave, nova);
            inseridas.push(nova);
          }
        }
        return { data: inseridas, error: null };
      },
    }));
    const from = vi.fn(() => ({ upsert }));
    const db = { from } as never;
    expect(await sincronizarModelosNativos(db, async () => resposta())).toMatchObject({
      recebidos: 2,
      gravados: 1,
    });
    expect(await sincronizarModelosNativos(db, async () => resposta())).toMatchObject({
      gravados: 0,
    });
    expect(linhas.size).toBe(2);
    expect(linhas.get("openai/gpt-6.1-terra")).toEqual(manual);
    expect(from).toHaveBeenCalledWith("ai_models");
  });

  it("propaga erro de gravação; não declara sincronizado", async () => {
    const db = {
      from: () => ({
        upsert: () => ({
          select: async () => ({ data: null, error: { message: "banco indisponível" } }),
        }),
      }),
    };
    await expect(sincronizarModelosNativos(db as never, async () => resposta())).rejects.toThrow(
      "catalogo_nativo_gravacao_falhou",
    );
  });

  it("consulta fonte pública com timeout e falha HTTP não grava nada", async () => {
    const buscar = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", buscar);
    try {
      const from = vi.fn();
      await expect(sincronizarModelosNativos({ from } as never)).rejects.toThrow(
        "catalogo_nativo_status_503",
      );
      expect(buscar).toHaveBeenCalledWith(
        "https://models.dev/api.json",
        expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
      );
      expect(from).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
