import { describe, expect, it } from "vitest";
import { codificarPagina, lerPagina, paginaSchema } from "./paginacao";
describe("cursores de cadências", () => {
  it("preserva instante e desempate por id sem gramática arbitrária", () => {
    const id = "ca173800-0000-4000-8000-000000000002"; const instante = "2026-10-26T12:30:01.123+00:00";
    expect(lerPagina(codificarPagina(instante, id))).toEqual({ instante, id });
    for (const alvo of [{ instante: `${instante},status.eq.ativa`, id }, { instante, id: `${id}),id.not.is.null` }, { instante: "ontem", id }]) {
      expect(lerPagina(Buffer.from(JSON.stringify(alvo)).toString("base64url"))).toBeNull();
    }
    expect(lerPagina("invalido")).toBeNull();
  });
  it("não aceita limit inválido nem cursor sem teto", () => {
    for (const limit of ["-1", "2.5", "201", "abc"]) expect(paginaSchema.safeParse({ limit }).success).toBe(false);
    expect(paginaSchema.parse({})).toEqual({ limit: 50 });
    expect(paginaSchema.safeParse({ cursor: "x".repeat(1001) }).success).toBe(false);
  });
});
