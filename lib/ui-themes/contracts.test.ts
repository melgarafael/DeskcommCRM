import { describe, expect, it } from "vitest";
import {
  compatibleArea,
  uiThemePackageSchema,
  validateUiThemeOptions,
  type UiThemePackage,
} from "./contracts";
import { createUiThemeCatalog, createUiAreaCatalog } from "./registry";
import {
  resolveUiArea,
  resolveUiTheme,
  regionClassName,
  globalClassName,
  type UiThemeSavedState,
} from "./resolve";
import { registeredUiAreas } from "./areas";
import { publicUiThemeCatalog as installedUiThemes } from "./public-catalog";

const demo: UiThemePackage = {
  apiVersion: 1,
  id: "demo",
  title: "Exemplo",
  version: "1.0.0",
  description: "Fixture genérica não distribuída.",
  optionsVersion: 1,
  global: {
    className: "base",
    variants: { "global.spacing": { normal: "space-normal", wide: "space-wide" } },
  },
  options: [
    {
      key: "global.spacing",
      label: "Espaçamento",
      type: "enum",
      default: "normal",
      choices: [
        { value: "normal", label: "Normal" },
        { value: "wide", label: "Amplo" },
      ],
    },
    { key: "sample-area.details", label: "Detalhes", type: "boolean", default: true },
    { key: "global.radius", label: "Cantos", type: "range", default: 8, min: 4, max: 16, step: 2 },
  ],
  areas: {
    "sample-area": {
      contractVersion: 1,
      configuration: {},
      regions: {
        content: { className: "content", variants: { "global.spacing": { wide: "wide" } } },
      },
      layout: {
        type: "stack",
        children: [
          { type: "slot", name: "heading" },
          { type: "slot", name: "content" },
        ],
      },
    },
  },
};
const contract = {
  id: "sample-area",
  version: 1,
  regions: ["heading", "content"],
  required: ["heading", "content"],
};
const entry = { installationId: "demo-install-1", enabled: true, package: demo };
const state: UiThemeSavedState = {
  organization_id: "tenant-a",
  theme_id: "demo",
  installation_id: "demo-install-1",
  revision: 2,
  configurations: { demo: { version: 1, values: { "global.spacing": "wide" } } },
};

describe("contrato público de apresentação incorporada", () => {
  it("o catálogo distribuído contém só Padrão e zero pacote adicional continua útil", () => {
    expect(installedUiThemes.map((e) => e.package.id)).toEqual(["padrao"]);
    expect(createUiThemeCatalog([]).map((e) => e.package.id)).toEqual(["padrao"]);
    expect(() => createUiThemeCatalog([{ ...installedUiThemes[0]!, enabled: false }])).toThrow();
    expect(resolveUiTheme([], null).package.id).toBe("padrao");
  });
  it("registra contribuição genérica e opções sem conhecer as três páginas iniciais", () => {
    const catalog = createUiThemeCatalog([entry]);
    const theme = resolveUiTheme(catalog, state);
    expect(theme.fallback).toBeNull();
    expect(resolveUiArea(theme, contract)).toBeTruthy();
    expect(regionClassName(theme, contract, "content")).toBe("content wide");
    expect(globalClassName(theme)).toBe("base space-wide");
    expect(resolveUiArea(theme, { ...contract, id: "not-covered" })).toBeNull();
    expect(createUiAreaCatalog([...registeredUiAreas, contract]).at(-1)?.id).toBe("sample-area");
  });
  it("regiões não tomam opções de outra área, e a base global só toma opções globais", () => {
    const pack = structuredClone(demo);
    pack.global!.variants = { "sample-area.details": { true: "incorrect" } };
    expect(uiThemePackageSchema.safeParse(pack).success).toBe(false);
    const cross = structuredClone(demo);
    cross.areas.other = { contractVersion: 1, configuration: {}, regions: {} };
    cross.options.push({ key: "other.visible", label: "Visível", type: "boolean", default: true });
    cross.areas["sample-area"]!.regions.content!.variants!["other.visible"] = { true: "incorrect" };
    expect(uiThemePackageSchema.safeParse(cross).success).toBe(false);
    expect(() => createUiAreaCatalog([contract, contract])).toThrow();
  });
  it("default é por opção e input malformado não injeta valor no componente", () => {
    expect(validateUiThemeOptions(demo, {})).toEqual({
      valid: true,
      values: { "global.spacing": "normal", "sample-area.details": true, "global.radius": 8 },
    });
    const result = validateUiThemeOptions(demo, {
      "global.spacing": "<style>",
      "global.radius": 7,
      extra: true,
    });
    expect(result.valid).toBe(false);
    expect(result.values["global.radius"]).toBe(8);
    expect(result.values["global.spacing"]).toBe("normal");
  });
  it.each([NaN, Infinity, -2, 18, 5])("range recusa valor inválido %s", (value) => {
    expect(validateUiThemeOptions(demo, { "global.radius": value }).valid).toBe(false);
  });
  it("o catálogo recusa duplicatas e identidade de instalação malformada", () => {
    expect(() => createUiThemeCatalog([entry, entry])).toThrow();
    expect(() => createUiThemeCatalog([{ ...entry, installationId: 'x" style=' }])).toThrow();
  });
  it("pacote não admite HTML, callbacks, scripts ou campo desconhecido", () => {
    expect(uiThemePackageSchema.safeParse({ ...demo, run: () => true }).success).toBe(false);
    expect(
      uiThemePackageSchema.safeParse({ ...demo, global: { className: 'x" onclick="alert(1)' } })
        .success,
    ).toBe(false);
    expect(
      uiThemePackageSchema.safeParse({ ...demo, options: [demo.options[0], demo.options[0]] })
        .success,
    ).toBe(false);
  });
  it("um slot não desaparece, duplica ou ganha autoridade por nome desconhecido", () => {
    const area = demo.areas["sample-area"]!;
    expect(compatibleArea(area, contract)).toBe(true);
    for (const children of [
      [{ type: "slot" as const, name: "heading" }],
      [
        { type: "slot" as const, name: "heading" },
        { type: "slot" as const, name: "heading" },
      ],
      [{ type: "slot" as const, name: "unknown" }],
    ])
      expect(compatibleArea({ ...area, layout: { type: "stack", children } }, contract)).toBe(
        false,
      );
    expect(compatibleArea({ ...area, contractVersion: 2 }, contract)).toBe(false);
  });
  it.each([
    [[], state, "unavailable"],
    [[{ ...entry, enabled: false }], state, "disabled"],
    [[{ ...entry, installationId: "demo-install-2" }], state, "reinstalled"],
    [
      [entry],
      { ...state, configurations: { demo: { version: 2, values: {} } } },
      "options_incompatible",
    ],
  ] as const)(
    "indisponibilidade preserva configuração e retorna ao Padrão (%s)",
    (catalog, saved, reason) => {
      const before = structuredClone(saved);
      const resolved = resolveUiTheme(catalog, saved);
      expect(resolved.package.id).toBe("padrao");
      expect(resolved.fallback).toBe(reason);
      expect(saved).toEqual(before);
    },
  );
  it("reinstalação com mesmo nome não reativa a decisão antiga", () => {
    const removed = resolveUiTheme([], state);
    expect(removed.package.id).toBe("padrao");
    const reinstalled = [{ ...entry, installationId: "demo-install-2" }];
    expect(resolveUiTheme(reinstalled, state).fallback).toBe("reinstalled");
    expect(
      resolveUiTheme(reinstalled, { ...state, installation_id: "demo-install-2" }).package.id,
    ).toBe("demo");
  });
});
