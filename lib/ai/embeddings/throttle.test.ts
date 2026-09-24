import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetThrottleDeEmbedding, aguardarVezDeEmbedding } from "./throttle";

describe("throttle de embedding", () => {
  beforeEach(() => {
    delete process.env.RAG_EMBEDDING_INTERVALO_MS;
    _resetThrottleDeEmbedding();
  });
  afterEach(() => {
    delete process.env.RAG_EMBEDDING_INTERVALO_MS;
    _resetThrottleDeEmbedding();
  });

  it("espaça chamadas sequenciais pelo intervalo configurado", async () => {
    process.env.RAG_EMBEDDING_INTERVALO_MS = "50";
    const t0 = Date.now();
    await aguardarVezDeEmbedding();
    await aguardarVezDeEmbedding();
    // A 2ª chamada espera o intervalo da 1ª.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });

  it("serializa chamadas concorrentes (não passam todas de uma vez)", async () => {
    process.env.RAG_EMBEDDING_INTERVALO_MS = "40";
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => aguardarVezDeEmbedding()));
    // 3 chamadas → 2 intervalos de espera.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
  });

  it("intervalo 0 desliga o espaçador", async () => {
    process.env.RAG_EMBEDDING_INTERVALO_MS = "0";
    const t0 = Date.now();
    await Promise.all([1, 2, 3, 4, 5].map(() => aguardarVezDeEmbedding()));
    expect(Date.now() - t0).toBeLessThan(40);
  });
});
