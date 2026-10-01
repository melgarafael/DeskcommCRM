/**
 * A CHEAPER INFERENCE É PROVEDOR DE PRIMEIRA CLASSE, e é ROTEADOR.
 *
 * Mesmo formato de `provedor-requesty.test.ts`: `provedores-x-registry.test.ts`
 * casa a lista com o registry genérico, e ESTE arquivo prende o caso concreto.
 * Como a Requesty, a Cheaper Inference revende modelos de vários fabricantes,
 * e por isso atravessa também os pontos que só roteador atravessa. A diferença
 * é que os ids vêm SEM prefixo de fabricante (`gpt-5.4-mini`):
 *
 *  - ESCRITA: `versionCreateSchema` e as portas que derivam de
 *    `IDS_DE_PROVEDOR` aceitam provider=cheaperinference.
 *  - EXECUÇÃO: o registry de produção e o runtime de ensaio instanciam a
 *    Cheaper Inference como OpenAI-compatível, em Chat Completions.
 *  - ROTEADOR: sem prefixo, o registro não chuta capacidade — quem decide é o
 *    catálogo (`ai_models.supports_vision`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  capacidadeEhConhecida,
  ehRoteador,
  modelCapabilities,
} from "@/lib/agent-engine/edge/llm/capabilities";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { versionCreateSchema } from "@/lib/ai/agents/validation";
import { ehProvedorSuportado, IDS_DE_PROVEDOR, PROVEDOR_POR_ID } from "@/lib/ai/pontos/provedores";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import { buildModel } from "@/lib/ai/runtime/agent";
import { montarRequisicaoDeProva } from "@/lib/instalacao/prova-de-credito";

afterEach(() => {
  vi.unstubAllGlobals();
});

function respostaFalsa(status: number, corpo: unknown = {}) {
  return vi.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => corpo,
      }) as unknown as Response,
  );
}

describe("Cheaper Inference é aceita na ESCRITA", () => {
  it("está na lista única de que derivam todas as portas de escrita", () => {
    expect(IDS_DE_PROVEDOR).toContain("cheaperinference");
    expect(ehProvedorSuportado("cheaperinference")).toBe(true);
  });

  it("o schema de versão de agente aceita provider=cheaperinference", () => {
    const r = versionCreateSchema.safeParse({
      system_prompt: "Você é um atendente útil e cordial.",
      provider: "cheaperinference",
      model: "gpt-5.4-mini",
      credential_id: null,
      channel_session_id: null,
    });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });
});

describe("Cheaper Inference é executável", () => {
  it("declara os campos que a tela precisa", () => {
    const p = PROVEDOR_POR_ID.get("cheaperinference");
    expect(p).toBeDefined();
    expect(p!.rotulo).toBe("Cheaper Inference");
    expect(p!.quandoUsar.trim().length).toBeGreaterThan(20);
    expect(p!.aceitaEndpointProprio).toBe(true);
    expect(p!.catalogoSincronizavel).toBe(true);
    expect(p!.ondePegarAChave).toMatch(/^https:\/\//);
    expect(p!.prefixoDaChave).toBe("ci_live_…");
  });

  it("o registry de PRODUÇÃO tem a fábrica, em Chat Completions", () => {
    const fabrica = createDefaultRegistry()["cheaperinference"];
    expect(fabrica).toBeTypeOf("function");
    const modelo = fabrica!("k", "gpt-5.4-mini") as { provider?: string };
    expect(modelo.provider).toBe("openai.chat");
  });

  it("a fábrica honra um endpoint próprio (gateway)", () => {
    const modelo = createDefaultRegistry()["cheaperinference"]!(
      "k",
      "gpt-5.4-mini",
      "https://gateway.exemplo/v1",
    );
    expect(modelo).toBeDefined();
  });

  it("o runtime de ENSAIO executa cheaperinference (buildModel)", () => {
    expect(() => buildModel("cheaperinference", "k", "gpt-5.4-mini")).not.toThrow();
  });

  it("a prova de crédito vai ao /chat/completions do endpoint", () => {
    const req = montarRequisicaoDeProva("cheaperinference", "k", "gpt-5.4-mini");
    expect(req?.url).toBe("https://api.cheaperinference.com/v1/chat/completions");
    expect(req?.headers.authorization).toBe("Bearer k");
  });

  it("o validador de chave conhece cheaperinference e trata 401 e 403 como chave ruim", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal("fetch", respostaFalsa(status));
      const r = await validateProviderKey("cheaperinference", "");
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toBe("auth_failed_401");
    }
  });

  it("o validador devolve os modelos que a chave enxerga", async () => {
    vi.stubGlobal("fetch", respostaFalsa(200, { data: [{ id: "gpt-5.4-mini" }] }));
    const r = await validateProviderKey("cheaperinference", "k");
    expect(r).toEqual({ ok: true, models: ["gpt-5.4-mini"] });
  });
});

describe("Cheaper Inference é ROTEADOR", () => {
  it("sem prefixo de fabricante, o registro não afirma capacidade", () => {
    expect(ehRoteador("cheaperinference")).toBe(true);
    expect(modelCapabilities("cheaperinference", "gpt-5.4-mini")).toEqual({
      image: false,
      pdf: false,
    });
    expect(capacidadeEhConhecida("cheaperinference", "gpt-5.4-mini")).toBe(false);
  });
});
