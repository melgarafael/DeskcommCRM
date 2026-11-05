import { describe, expect, it } from "vitest";

import {
  GRUPO_DOS_MODULOS,
  NAV_GROUPS,
  searchable,
  sidebarGroups,
} from "@/lib/navigation/registry";

/**
 * O grupo "Módulos" é GERADO (Spec 33, F4, tarefa 4): um item `/app/m/<slug>` por módulo conectado
 * ativo. A regra de ouro é que, sem módulo, a navegação é exatamente a de antes.
 */

const PAPEIS = [
  { platform: false, role: "viewer" as const },
  { platform: false, role: "agent" as const },
  { platform: false, role: "manager" as const },
  { platform: false, role: "admin" as const },
  { platform: true, role: null },
];

const DOIS = [
  { slug: "acme-comanda", titulo: "Comanda" },
  { slug: "acme-fidelidade", titulo: "Fidelidade" },
];

describe("grupo Módulos gerado: sem módulo, nada muda", () => {
  for (const { platform, role } of PAPEIS) {
    it(`sidebarGroups idêntico com lista vazia ou ausente (${role ?? "plataforma"})`, () => {
      const sem = sidebarGroups(platform, role);
      expect(sidebarGroups(platform, role, undefined, [], [], [])).toEqual(sem);
      expect(sidebarGroups(platform, role, undefined, [], [], undefined)).toEqual(sem);
      expect(sem.some((g) => g.group.id === "modulos")).toBe(false);
    });

    it(`searchable idêntico com lista vazia ou ausente (${role ?? "plataforma"})`, () => {
      const sem = searchable(platform, role);
      expect(searchable(platform, role, undefined, undefined, undefined, [])).toEqual(sem);
      expect(searchable(platform, role, undefined, undefined, undefined, undefined)).toEqual(sem);
      expect(sem.some((d) => d.group === "modulos")).toBe(false);
    });
  }

  it("o grupo gerado não está em NAV_GROUPS (não é entrada estática)", () => {
    expect(NAV_GROUPS.some((g) => g.id === GRUPO_DOS_MODULOS.id)).toBe(false);
  });
});

describe("grupo Módulos gerado: com módulos", () => {
  it("aparece um grupo Módulos com um item /app/m/<slug> por módulo, e o resto fica igual", () => {
    const base = sidebarGroups(false, "viewer");
    const com = sidebarGroups(false, "viewer", undefined, [], [], DOIS);
    expect(com.slice(0, base.length)).toEqual(base);
    const g = com.find((x) => x.group.id === "modulos");
    expect(g?.group.label).toBe("Módulos");
    expect(g?.items.map((i) => i.href)).toEqual(["/app/m/acme-comanda", "/app/m/acme-fidelidade"]);
    expect(g?.items.map((i) => i.label)).toEqual(["Comanda", "Fidelidade"]);
  });

  it("é visível a qualquer membro, do viewer ao admin", () => {
    for (const role of ["viewer", "agent", "manager", "admin"] as const) {
      const g = sidebarGroups(false, role, undefined, [], [], DOIS).find(
        (x) => x.group.id === "modulos",
      );
      expect(g?.items).toHaveLength(2);
    }
  });

  it("entra no ⌘K, depois dos destinos de sempre", () => {
    const base = searchable(false, "agent");
    const com = searchable(false, "agent", undefined, undefined, undefined, DOIS);
    expect(com.slice(0, base.length)).toEqual(base);
    expect(com.slice(base.length).map((d) => d.href)).toEqual([
      "/app/m/acme-comanda",
      "/app/m/acme-fidelidade",
    ]);
    expect(com.slice(base.length).every((d) => d.group === "modulos")).toBe(true);
  });

  it("slug fora de [a-z0-9-] é descartado, e repetido vale uma vez", () => {
    const sujos = [
      { slug: "Maiuscula", titulo: "A" },
      { slug: "com/barra", titulo: "B" },
      { slug: "../fuga", titulo: "C" },
      { slug: "com espaco", titulo: "D" },
      { slug: "-comeca-com-hifen", titulo: "E" },
      { slug: "termina-com-hifen-", titulo: "F" },
      { slug: "dois--hifens", titulo: "G" },
      { slug: "", titulo: "H" },
      { slug: "ok-um", titulo: "Bom" },
      { slug: "ok-um", titulo: "Bom de novo" },
    ];
    const g = sidebarGroups(false, "viewer", undefined, [], [], sujos).find(
      (x) => x.group.id === "modulos",
    );
    expect(g?.items.map((i) => i.href)).toEqual(["/app/m/ok-um"]);
    expect(
      searchable(false, "viewer", undefined, [], [], sujos).filter((d) => d.group === "modulos"),
    ).toHaveLength(1);
  });

  it("só slugs inválidos: nenhum grupo", () => {
    const g = sidebarGroups(false, "viewer", undefined, [], [], [{ slug: "X/Y", titulo: "Z" }]);
    expect(g.some((x) => x.group.id === "modulos")).toBe(false);
  });
});
