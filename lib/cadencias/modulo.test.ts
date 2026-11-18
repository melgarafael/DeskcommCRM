import { describe, expect, it } from "vitest";

import { cadenciasHabilitadas } from "./modulo";

describe("habilitação explícita das cadências", () => {
  it.each([null, {}, { cadencias: true }, { cadencias: { enabled: "true" } }, { cadencias: { enabled: false } }])(
    "falha fechada para configuração ausente ou malformada: %j", (settings) => {
      expect(cadenciasHabilitadas(settings)).toBe(false);
    },
  );
  it("só o booleano verdadeiro da empresa habilita", () => {
    expect(cadenciasHabilitadas({ cadencias: { enabled: true } })).toBe(true);
  });
});
