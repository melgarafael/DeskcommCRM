import { describe, expect, it } from "vitest";

import { agenteAtende, estadoDoAgente } from "./no-ar";

describe("atendimento real continua exigindo versão publicada", () => {
  it("rascunho configurado, sem published_version_id, não atende", () => {
    const rascunho = { paused_at: null, published_version_id: null };
    expect(estadoDoAgente(rascunho)).toBe("parado");
    expect(agenteAtende(rascunho)).toBe(false);
  });
});
