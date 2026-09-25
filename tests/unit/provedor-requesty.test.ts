/**
 * A REQUESTY É PROVEDOR DE PRIMEIRA CLASSE, e é ROTEADOR.
 *
 * Mesmo formato de `provedor-deepseek.test.ts`: `provedores-x-registry.test.ts`
 * casa a lista com o registry genérico, e ESTE arquivo prende o caso concreto.
 * A diferença para a DeepSeek é que a Requesty revende modelos de vários
 * fabricantes, como a OpenRouter, e por isso atravessa também os pontos que só
 * roteador atravessa:
 *
 *  - ESCRITA: `versionCreateSchema` e as portas que derivam de
 *    `IDS_DE_PROVEDOR` aceitam provider=requesty.
 *  - EXECUÇÃO: o registry de produção e o runtime de ensaio instanciam a
 *    Requesty como OpenAI-compatível, em Chat Completions.
 *  - ROTEADOR: a capacidade sai do prefixo do fabricante no id.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ehRoteador, modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { versionCreateSchema } from "@/lib/ai/agents/validation";
import { ehProvedorSuportado, IDS_DE_PROVEDOR, PROVEDOR_POR_ID } from "@/lib/ai/pontos/provedores";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import { buildModel } from "@/lib/ai/runtime/agent";

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

describe("Requesty é aceita na ESCRITA", () => {
  it("está na lista única de que derivam todas as portas de escrita", () => {
    expect(IDS_DE_PROVEDOR).toContain("requesty");
    expect(ehProvedorSuportado("requesty")).toBe(true);
  });

  it("o schema de versão de agente aceita provider=requesty", () => {
    const r = versionCreateSchema.safeParse({
      system_prompt: "Você é um atendente útil e cordial.",
      provider: "requesty",
      model: "openai/gpt-4o-mini",
      credential_id: null,
      channel_session_id: null,
    });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });
});

describe("Requesty é executável", () => {
  it("declara os campos que a tela precisa", () => {
    const p = PROVEDOR_POR_ID.get("requesty");
    expect(p).toBeDefined();
    expect(p!.rotulo.trim().length).toBeGreaterThan(0);
    expect(p!.quandoUsar.trim().length).toBeGreaterThan(20);
    expect(p!.aceitaEndpointProprio).toBe(true);
    expect(p!.catalogoSincronizavel).toBe(true);
    expect(p!.ondePegarAChave).toMatch(/^https:\/\//);
    expect(p!.prefixoDaChave).toBe("rqsty-…");
  });

  it("o registry de PRODUÇÃO tem a fábrica, em Chat Completions", () => {
    const fabrica = createDefaultRegistry()["requesty"];
    expect(fabrica).toBeTypeOf("function");
    const modelo = fabrica!("k", "openai/gpt-4o-mini") as { provider?: string };
    expect(modelo.provider).toBe("openai.chat");
  });

  it("a fábrica honra um endpoint próprio (região da Europa, gateway)", () => {
    const modelo = createDefaultRegistry()["requesty"]!(
      "k",
      "openai/gpt-4o-mini",
      "https://gateway.exemplo/v1",
    );
    expect(modelo).toBeDefined();
  });

  it("o runtime de ENSAIO executa requesty (buildModel)", () => {
    expect(() => buildModel("requesty", "k", "openai/gpt-4o-mini")).not.toThrow();
  });

  it("o validador de chave conhece requesty e trata 401 e 403 como chave ruim", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal("fetch", respostaFalsa(status));
      const r = await validateProviderKey("requesty", "");
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toBe("auth_failed_401");
    }
  });

  it("o validador devolve os modelos que a chave enxerga", async () => {
    vi.stubGlobal("fetch", respostaFalsa(200, { data: [{ id: "openai/gpt-4o-mini" }] }));
    const r = await validateProviderKey("requesty", "k");
    expect(r).toEqual({ ok: true, models: ["openai/gpt-4o-mini"] });
  });
});

describe("Requesty é ROTEADOR", () => {
  it("a capacidade sai do fabricante no prefixo do id", () => {
    expect(ehRoteador("requesty")).toBe(true);
    expect(modelCapabilities("requesty", "openai/gpt-4o-mini")).toEqual(
      modelCapabilities("openai", "gpt-4o-mini"),
    );
  });
});
