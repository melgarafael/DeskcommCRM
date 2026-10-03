import { describe, expect, it } from "vitest";
import { temVersaoNovaNoCatalogo } from "./versao-nova-catalogo";

describe("temVersaoNovaNoCatalogo", () => {
  it("cópia da versão atual do catálogo não é avisada", () => {
    expect(temVersaoNovaNoCatalogo("ver-plat-1", "ver-plat-1")).toBe(false);
  });
  it("cópia de versão anterior à atual do catálogo é avisada", () => {
    expect(temVersaoNovaNoCatalogo("ver-plat-1", "ver-plat-2")).toBe(true);
  });
  it("skill sem origem no catálogo (.zip ou criada na org) nunca é avisada", () => {
    expect(temVersaoNovaNoCatalogo(null, "ver-plat-2")).toBe(false);
    expect(temVersaoNovaNoCatalogo(undefined, "ver-plat-2")).toBe(false);
  });
  it("skill que saiu do catálogo não é avisada", () => {
    expect(temVersaoNovaNoCatalogo("ver-plat-1", undefined)).toBe(false);
  });
});
