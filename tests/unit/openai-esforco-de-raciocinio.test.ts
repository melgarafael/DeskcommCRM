/**
 * O ESFORÇO DE RACIOCÍNIO DA OPENAI É REGULÁVEL — pelo knob e SÓ na OpenAI.
 *
 * Motivo (medido em 2026-09-24, `gpt-6-luna`, prompt de produção, tool
 * `send_message`): no padrão o modelo pensa ~250 tokens antes de um rascunho de
 * ~40 e às vezes nem chama a tool (0 de 2); com `effort=none` a chamada caiu de
 * ~5 s para ~2 s e chamou a tool 2 de 2. O campo vai no CORPO do request.
 *
 * O que estes testes medem: o corpo que SAI do processo (fetch interceptado).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, type LanguageModel } from "ai";

import {
  createDefaultRegistry,
  esforcoDeRaciocinioOpenAI,
  modeloOpenAIRaciocina,
} from "@/lib/agent-engine/edge/llm/providers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function interceptarSaida(): { urls: string[]; corpos: Array<Record<string, unknown>> } {
  const urls: string[] = [];
  const corpos: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url);
      corpos.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      throw new Error("PARADA_DE_TESTE");
    }),
  );
  return { urls, corpos };
}

async function disparar(
  model: LanguageModel,
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"],
): Promise<void> {
  await generateText({ model, prompt: "oi", maxRetries: 0, ...(providerOptions ? { providerOptions } : {}) }).catch(
    () => {},
  );
}

describe("knob ligado: a chamada da OpenAI leva reasoning.effort", () => {
  it("pela opção do registry", async () => {
    const { urls, corpos } = interceptarSaida();
    await disparar(createDefaultRegistry({ openaiReasoningEffort: "none" })["openai"]!("sk-de-teste", "gpt-6-luna"));
    expect(urls[0]).toBe("https://api.openai.com/v1/responses");
    expect(corpos[0]?.reasoning).toMatchObject({ effort: "none" });
  });

  it("pelo ambiente (OPENAI_REASONING_EFFORT), que é como o operador liga", async () => {
    vi.stubEnv("OPENAI_REASONING_EFFORT", "low");
    const { corpos } = interceptarSaida();
    await disparar(createDefaultRegistry()["openai"]!("sk-de-teste", "gpt-6-luna"));
    expect(corpos[0]?.reasoning).toMatchObject({ effort: "low" });
  });
});

describe("knob em none/minimal num modelo que não aceita desligar o raciocínio", () => {
  // Doc oficial (11/10/2026): o gpt-6.1-sol diz "`none` and `minimal` reasoning
  // efforts are not supported"; o gpt-6-astra lista só low…max; o gpt-6-luna lista
  // none, low…max — sem minimal. Mandar o knob como está seria 400 em toda resposta.
  it.each([
    ["gpt-6.1-sol", "none"],
    ["gpt-6-astra", "none"],
    ["gpt-6.1-sol", "minimal"],
    ["gpt-6-astra", "minimal"],
  ] as const)("%s com %s recebe low", async (modelo, esforco) => {
    const { corpos } = interceptarSaida();
    await disparar(createDefaultRegistry({ openaiReasoningEffort: esforco })["openai"]!("sk-de-teste", modelo));
    expect(corpos[0]?.reasoning).toMatchObject({ effort: "low" });
  });

  it("quem aceita none continua recebendo none (gpt-6-luna, gpt-6-sol, gpt-6.1-terra, linha 5.x)", async () => {
    for (const modelo of ["gpt-6-luna", "gpt-6-sol", "gpt-6.1-terra", "gpt-5.6-terra"]) {
      const { corpos } = interceptarSaida();
      await disparar(createDefaultRegistry({ openaiReasoningEffort: "none" })["openai"]!("sk-de-teste", modelo));
      expect(corpos[0]?.reasoning, modelo).toMatchObject({ effort: "none" });
    }
  });

  // Quem pediu minimal pediu velocidade: no Luna `low` é mais lento que o padrão
  // (medição na docstring do knob), então o que respeita o pedido é `none`.
  it.each(["gpt-6-luna", "gpt-6-sol", "gpt-6.1-terra"])("%s com minimal recebe none", async (modelo) => {
    const { corpos } = interceptarSaida();
    await disparar(createDefaultRegistry({ openaiReasoningEffort: "minimal" })["openai"]!("sk-de-teste", modelo));
    expect(corpos[0]?.reasoning).toMatchObject({ effort: "none" });
  });

  it("esforço que o modelo aceita passa intacto", async () => {
    const { corpos } = interceptarSaida();
    await disparar(createDefaultRegistry({ openaiReasoningEffort: "high" })["openai"]!("sk-de-teste", "gpt-6-astra"));
    expect(corpos[0]?.reasoning).toMatchObject({ effort: "high" });
  });
});

describe("linha 5: o knob vira o esforço mais rápido que a família aceita", () => {
  // Matriz da linha 5, espelhada de `getGpt5ReasoningEfforts` do @ai-sdk/openai
  // 4.0.108 (node_modules/@ai-sdk/openai/dist/index.js, l. 467-495): minor 0
  // (gpt-5, -mini, -nano) lista minimal…high SEM `none`; do 5.1 em diante lista
  // none…high SEM `minimal` (e 5.2–5.6 acrescentam `xhigh`). Mandar o knob cru
  // era 400 em toda chamada sem `reasoning` — o turno inteiro do agente.
  function esforcosAceitosGpt5(minor: number): readonly string[] {
    if (minor === 0) return ["minimal", "low", "medium", "high"];
    if (minor === 1) return ["none", "low", "medium", "high"];
    if (minor < 6) return ["none", "low", "medium", "high", "xhigh"];
    return ["none", "low", "medium", "high", "xhigh", "max"];
  }

  it.each([
    // gpt-5, -mini, -nano: `none` não existe, o mais rápido aceito é `minimal`.
    ["gpt-5", 0, "none", "minimal"],
    ["gpt-5-mini", 0, "none", "minimal"],
    ["gpt-5-nano", 0, "none", "minimal"],
    ["gpt-5", 0, "minimal", "minimal"],
    ["gpt-5-nano", 0, "minimal", "minimal"],
    // 5.1 a 5.6: `minimal` não existe, o mais rápido aceito é `none`.
    ["gpt-5.1", 1, "none", "none"],
    ["gpt-5.1", 1, "minimal", "none"],
    ["gpt-5.2", 2, "minimal", "none"],
    ["gpt-5.4-nano", 4, "minimal", "none"],
    ["gpt-5.6", 6, "minimal", "none"],
    ["gpt-5.6-terra", 6, "minimal", "none"],
  ] as const)("%s com knob %s recebe %s", async (modelo, minor, knob, esperado) => {
    const { corpos } = interceptarSaida();
    await disparar(
      createDefaultRegistry({ openaiReasoningEffort: knob })["openai"]!("sk-de-teste", modelo),
    );
    const reasoning = corpos[0]?.reasoning as { effort?: string } | undefined;
    expect(reasoning).toMatchObject({ effort: esperado });
    // Controle negativo: o que sai tem de estar na lista do modelo. Se a tradução
    // voltar a passar o knob cru, isto (e o caso acima) reprovam.
    expect(esforcosAceitosGpt5(minor), `${modelo} com ${knob}`).toContain(reasoning?.effort);
  });

  it.each([
    ["gpt-5", 0],
    ["gpt-5-nano", 0],
    ["gpt-5.1", 1],
    ["gpt-5.6-terra", 6],
  ] as const)("%s: low e high passam intactos", async (modelo, minor) => {
    for (const esforco of ["low", "high"] as const) {
      const { corpos } = interceptarSaida();
      await disparar(
        createDefaultRegistry({ openaiReasoningEffort: esforco })["openai"]!("sk-de-teste", modelo),
      );
      const reasoning = corpos[0]?.reasoning as { effort?: string } | undefined;
      expect(reasoning, `${modelo} com ${esforco}`).toMatchObject({ effort: esforco });
      expect(esforcosAceitosGpt5(minor)).toContain(reasoning?.effort);
    }
  });

  it("modelo da linha 5 sem o knob não ganha reasoning no corpo", async () => {
    const { corpos } = interceptarSaida();
    await disparar(createDefaultRegistry({ openaiReasoningEffort: null })["openai"]!("sk-de-teste", "gpt-5-nano"));
    expect(corpos[0]?.reasoning).toBeUndefined();
  });
});

describe("chamada que já pediu esforço não é sobrescrita pelo knob", () => {
  // O knob é o padrão da INSTALAÇÃO, não uma ordem por cima de quem pediu: a
  // opção `reasoning` de `runModelCall` chega ao corpo como `reasoning.effort`
  // e tem de sobreviver — senão um OPENAI_REASONING_EFFORT=high faz as
  // classificações, que pedem `none`, voltarem a pensar.
  it.each([
    ["gpt-5-nano", "none"],
    ["gpt-5.4-nano", "minimal"],
  ] as const)("%s: o effort da chamada (high) vence o knob %s", async (modelo, knob) => {
    const { corpos } = interceptarSaida();
    await disparar(createDefaultRegistry({ openaiReasoningEffort: knob })["openai"]!("sk-de-teste", modelo), {
      openai: { reasoningEffort: "high" },
    });
    expect(corpos[0]?.reasoning).toMatchObject({ effort: "high" });
  });
});

describe("knob desligado ou fora do escopo: nada é injetado", () => {
  it("sem a variável, o corpo da OpenAI não ganha reasoning", async () => {
    vi.stubEnv("OPENAI_REASONING_EFFORT", "");
    const { corpos } = interceptarSaida();
    await disparar(createDefaultRegistry()["openai"]!("sk-de-teste", "gpt-6-luna"));
    expect(corpos[0]?.reasoning).toBeUndefined();
  });

  it("modelo da OpenAI SEM raciocínio não recebe o campo (a API recusaria com 400)", async () => {
    const { corpos } = interceptarSaida();
    await disparar(createDefaultRegistry({ openaiReasoningEffort: "none" })["openai"]!("sk-de-teste", "gpt-4.1-nano"));
    expect(corpos[0]?.reasoning).toBeUndefined();
  });

  it("a DeepSeek não herda o knob da OpenAI", async () => {
    const { corpos } = interceptarSaida();
    await disparar(createDefaultRegistry({ openaiReasoningEffort: "none" })["deepseek"]!("sk-de-teste", "deepseek-flash"));
    expect(corpos[0]?.reasoning).toBeUndefined();
  });
});

describe("quais modelos raciocinam", () => {
  it("famílias o*, gpt-5* e gpt-6* sim; -chat e gpt-4.x não", () => {
    for (const m of ["gpt-6-luna", "gpt-5.4-mini", "o3", "o4-mini"]) expect(modeloOpenAIRaciocina(m)).toBe(true);
    for (const m of ["gpt-4.1-nano", "gpt-4o-mini", "gpt-5-chat-latest", "gpt-5.2-chat-latest"]) expect(modeloOpenAIRaciocina(m)).toBe(false);
  });
});

describe("validação na leitura do knob", () => {
  it("aceita os valores da API, sem diferenciar maiúscula", () => {
    expect(esforcoDeRaciocinioOpenAI(" None ")).toBe("none");
    expect(esforcoDeRaciocinioOpenAI("xhigh")).toBe("xhigh");
    expect(esforcoDeRaciocinioOpenAI(undefined)).toBeNull();
  });

  it("grafia errada falha na hora, com a lista do que vale", () => {
    expect(() => esforcoDeRaciocinioOpenAI("nenhum")).toThrow(/OPENAI_REASONING_EFFORT inválido/);
  });
});
