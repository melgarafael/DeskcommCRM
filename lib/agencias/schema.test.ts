import { describe, expect, it } from "vitest";
import { configuracaoAgenciaSchema } from "./schema";

describe("configuração de agência", () => {
  it("aceita limite zero para bloquear novas criações sem desabilitar gestão", () => {
    expect(configuracaoAgenciaSchema.parse({ habilitada: true, limite_clientes: 0 })).toEqual({
      habilitada: true,
      limite_clientes: 0,
    });
  });
  it.each([-1, 1.5, 10001, NaN, Infinity, "10", null])(
    "recusa cota inválida %s",
    (limite_clientes) => {
      expect(
        configuracaoAgenciaSchema.safeParse({ habilitada: true, limite_clientes }).success,
      ).toBe(false);
    },
  );
  it("recusa campos que tentem elevar autoridade", () => {
    expect(
      configuracaoAgenciaSchema.safeParse({
        habilitada: true,
        limite_clientes: 10,
        is_platform_admin: true,
      }).success,
    ).toBe(false);
  });
});
