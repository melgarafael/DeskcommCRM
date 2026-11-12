import { describe, expect, it } from "vitest";

import { moduloAvaliacaoNaoInstalado } from "./modulo";

describe("moduloAvaliacaoNaoInstalado", () => {
  it("reconhece tabela ausente no Postgres", () => {
    expect(moduloAvaliacaoNaoInstalado({ code: "42P01" })).toBe(true);
  });

  it("reconhece schema cache do PostgREST sem a tabela", () => {
    expect(moduloAvaliacaoNaoInstalado({ code: "PGRST205" })).toBe(true);
  });

  it("não engole outros erros de persistência", () => {
    expect(moduloAvaliacaoNaoInstalado({ code: "23503" })).toBe(false);
    expect(moduloAvaliacaoNaoInstalado({ code: "PGRST204" })).toBe(false);
    expect(moduloAvaliacaoNaoInstalado(null)).toBe(false);
  });
});
