/**
 * A tela e o DELETE tinham duas regras de "em uso" — a tela contava qualquer
 * versão de agente ativo, o DELETE só a publicada. Botão desabilitado com
 * tooltip "em uso" quando a API deixaria excluir. Uma regra, dois consumidores.
 */
import { describe, expect, it } from "vitest";
import { contarUsoPublicado, type VersaoVinculada } from "./uso";

const linha = (over: Partial<VersaoVinculada> & { publicada?: string | null; arquivado?: boolean }): VersaoVinculada => ({
  id: over.id ?? "v1",
  credential_id: over.credential_id ?? "c1",
  ai_agents: {
    archived_at: over.arquivado ? "2026-01-01T00:00:00Z" : null,
    published_version_id: over.publicada === undefined ? "v1" : over.publicada,
  },
});

describe("contarUsoPublicado", () => {
  it("conta só a versão que É a publicada do agente", () => {
    expect(contarUsoPublicado([linha({ id: "v1", publicada: "v1" })])).toEqual({ c1: 1 });
  });

  it("rascunho (versão não publicada) não conta", () => {
    expect(contarUsoPublicado([linha({ id: "v2", publicada: "v1" })])).toEqual({});
  });

  it("agente arquivado não conta", () => {
    expect(contarUsoPublicado([linha({ arquivado: true })])).toEqual({});
  });

  it("agente sem versão publicada não conta", () => {
    expect(contarUsoPublicado([linha({ publicada: null })])).toEqual({});
  });

  it("soma por credencial e aceita join como array", () => {
    const r = contarUsoPublicado([
      linha({ id: "v1", credential_id: "c1" }),
      { id: "v9", credential_id: "c1", ai_agents: [{ archived_at: null, published_version_id: "v9" }] },
      linha({ id: "v3", credential_id: "c2", publicada: "v3" }),
    ]);
    expect(r).toEqual({ c1: 2, c2: 1 });
  });
});
