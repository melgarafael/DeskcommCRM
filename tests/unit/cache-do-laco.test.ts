import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";

import { passoSeguinteLeuOCache } from "@/scripts/lib/cache-do-laco";

/**
 * A régua do check de cauda do smoke da OpenRouter (scripts/smoke-llm.ts). A
 * antiga comparava a leitura do passo 2 com o `inputTokens` do passo 1 e dava
 * vermelho contra o modelo real: a leitura é igual à ESCRITA do passo 1, e o
 * prompt do passo 1 passa dela por 1 a 4 tokens que ficam depois do ponto de cache.
 */
const uso = (lidos: number, escritos: number, entrada = lidos + escritos + 3): Pick<LanguageModelUsage, "inputTokenDetails" | "inputTokens"> => ({
  inputTokens: entrada,
  inputTokenDetails: { noCacheTokens: entrada - lidos - escritos, cacheReadTokens: lidos, cacheWriteTokens: escritos },
});

describe("o passo seguinte do laço leu o cache que o anterior deixou", () => {
  it("leitura igual à escrita do passo 1 passa, mesmo com o prompt dele 3 tokens maior", () => {
    expect(passoSeguinteLeuOCache(uso(0, 4100), uso(4100, 60))).toEqual({ deixado: 4100, lido: 4100, ok: true });
  });

  it("o que o passo 1 LEU também foi deixado no cache e tem de ser lido de novo", () => {
    expect(passoSeguinteLeuOCache(uso(4096, 40), uso(4136, 30)).ok).toBe(true);
    expect(passoSeguinteLeuOCache(uso(4096, 40), uso(4096, 70)).ok).toBe(false);
  });

  it("leitura menor que o deixado reprova; nada deixado é sonda cega e reprova", () => {
    expect(passoSeguinteLeuOCache(uso(0, 4100), uso(2048, 2100)).ok).toBe(false);
    expect(passoSeguinteLeuOCache(uso(0, 0), uso(0, 0)).ok).toBe(false);
  });
});
