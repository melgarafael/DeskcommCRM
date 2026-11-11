import { describe, expect, it } from "vitest";

import { EXTENSION_PERMISSIONS } from "./capacidades";
import { EXTENSION_AREAS, ehPermissaoDeArea, permissaoDaArea } from "./areas";
import { nomeDaPorta } from "./portas-legiveis";

const MODOS = ["leitura", "escrita"] as const;

describe("vocabulario das areas (modulo conectado, F1)", () => {
  it("cada area e cada modo devolve uma permissao que existe em EXTENSION_PERMISSIONS", () => {
    for (const area of EXTENSION_AREAS) {
      for (const modo of MODOS) {
        expect(EXTENSION_PERMISSIONS).toContain(permissaoDaArea(area, modo));
      }
    }
  });

  it("as permissoes de area sao exatamente o produto area x modo (18 no total: 9 areas x 2 modos)", () => {
    const deArea = EXTENSION_PERMISSIONS.filter(ehPermissaoDeArea);
    const produto = EXTENSION_AREAS.flatMap((area) =>
      MODOS.map((modo) => permissaoDaArea(area, modo)),
    );
    expect(deArea).toHaveLength(18);
    expect([...deArea].sort()).toEqual([...produto].sort());
  });

  it("o vocabulario inteiro tem 26 permissoes e 9 areas; tarefas e financeiro nao sao areas", () => {
    expect(EXTENSION_AREAS).toHaveLength(9);
    expect(EXTENSION_PERMISSIONS).toHaveLength(26);
    for (const area of ["tarefas", "financeiro"]) {
      expect(EXTENSION_AREAS as readonly string[]).not.toContain(area);
      expect(EXTENSION_PERMISSIONS as readonly string[]).not.toContain(`area.${area}.leitura`);
      expect(EXTENSION_PERMISSIONS as readonly string[]).not.toContain(`area.${area}.escrita`);
    }
  });

  it("toda permissao, inclusive as de area, tem nome legivel", () => {
    for (const permissao of EXTENSION_PERMISSIONS) {
      expect(nomeDaPorta(permissao).length).toBeGreaterThan(0);
    }
  });
});
