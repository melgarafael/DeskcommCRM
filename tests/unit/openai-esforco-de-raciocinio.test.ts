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

async function disparar(model: LanguageModel): Promise<void> {
  await generateText({ model, prompt: "oi", maxRetries: 0 }).catch(() => {});
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
