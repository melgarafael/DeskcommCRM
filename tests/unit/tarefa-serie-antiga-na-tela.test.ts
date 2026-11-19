import { describe, expect, it } from "vitest";

import { normalizarRegra } from "@/lib/tarefas/recorrencia";
import { periodicidadeDaRegra } from "@/lib/tarefas/tipos";

// A série gravada na 1.114 a 1.116 não tem `tipo`. Sem este critério, o
// formulário abria com "Repetir" vazio e salvar até só o título dava 422.
const DA_1_114 = { dias: [1], hora: 9, ativa: true };

describe("a série gravada antes de `tipo` existir", () => {
  it("a tela lê como semanal, igual ao servidor", () => {
    expect(periodicidadeDaRegra(DA_1_114)).toBe("semanal");
    expect(normalizarRegra(DA_1_114)?.tipo).toBe(periodicidadeDaRegra(DA_1_114));
  });

  it("a periodicidade gravada continua valendo", () => {
    for (const tipo of ["diaria", "semanal", "mensal"] as const) {
      expect(periodicidadeDaRegra({ tipo, ativa: true })).toBe(tipo);
    }
  });
});
