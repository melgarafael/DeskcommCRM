import { describe, expect, it } from "vitest";

import { problemaNoMapa } from "@/lib/agencia/mapas/regras";

/** A conferência do mapa antes de publicar (docs/agencia/SPEC-mapa-mental.md, M3). */
describe("publicar o mapa", () => {
  const b = (id: string, titulo = `Bloco ${id}`) => ({ id, titulo });

  it("mapa certo pode publicar", () => {
    expect(problemaNoMapa([b("a"), b("b"), b("c")], [{ de_id: "a", para_id: "b" }, { de_id: "b", para_id: "c" }])).toBeNull();
  });

  it("recusa mapa vazio, bloco sem título e setas em círculo", () => {
    expect(problemaNoMapa([], [])).toMatch(/nenhum bloco/);
    expect(problemaNoMapa([b("a", " ")], [])).toMatch(/título/);
    expect(problemaNoMapa([b("a"), b("b"), b("c")], [{ de_id: "a", para_id: "b" }, { de_id: "b", para_id: "c" }, { de_id: "c", para_id: "b" }])).toMatch(/círculo/);
  });
});
