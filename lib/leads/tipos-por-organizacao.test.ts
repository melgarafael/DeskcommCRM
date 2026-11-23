import { describe, expect, it } from "vitest";

import { TIPOS_DE_LINK } from "./links-de-contato";
import {
  CHAVE_DOS_TIPOS_DE_LINK,
  normalizarTiposDeLink,
  settingsComTiposDeLink,
  TODOS_OS_TIPOS_DE_LINK,
  tiposDeLinkHabilitados,
} from "./tipos-por-organizacao";

describe("tiposDeLinkHabilitados — sem ajuste, nada muda", () => {
  it("⭐ organização sem a chave → catálogo INTEIRO, na ordem do catálogo", () => {
    expect(tiposDeLinkHabilitados({ routing: { mode: "manual" } })).toEqual([
      ...TODOS_OS_TIPOS_DE_LINK,
    ]);
    expect(tiposDeLinkHabilitados({})).toEqual(TIPOS_DE_LINK.map(({ id }) => id));
  });

  it("settings ausente ou que não é objeto → catálogo inteiro", () => {
    expect(tiposDeLinkHabilitados(null)).toEqual([...TODOS_OS_TIPOS_DE_LINK]);
    expect(tiposDeLinkHabilitados(undefined)).toEqual([...TODOS_OS_TIPOS_DE_LINK]);
    expect(tiposDeLinkHabilitados(["instagram"])).toEqual([...TODOS_OS_TIPOS_DE_LINK]);
    expect(tiposDeLinkHabilitados("instagram")).toEqual([...TODOS_OS_TIPOS_DE_LINK]);
  });

  it("⭐ ajuste válido → só os marcados, na ordem do CATÁLOGO", () => {
    expect(
      tiposDeLinkHabilitados({ [CHAVE_DOS_TIPOS_DE_LINK]: { tipos: ["linkedin", "instagram"] } }),
    ).toEqual(["instagram", "linkedin"]);
  });

  it("⭐ lixo na chave → catálogo inteiro, sem exceção", () => {
    const lixo: unknown[] = [
      { [CHAVE_DOS_TIPOS_DE_LINK]: { tipos: [] } },
      { [CHAVE_DOS_TIPOS_DE_LINK]: { tipos: "instagram" } },
      { [CHAVE_DOS_TIPOS_DE_LINK]: { tipos: null } },
      { [CHAVE_DOS_TIPOS_DE_LINK]: {} },
      { [CHAVE_DOS_TIPOS_DE_LINK]: ["instagram", "tipo_que_nao_existe"] },
      { [CHAVE_DOS_TIPOS_DE_LINK]: { tipos: ["instagram", 42] } },
      { [CHAVE_DOS_TIPOS_DE_LINK]: null },
    ];
    for (const settings of lixo) {
      expect(() => tiposDeLinkHabilitados(settings)).not.toThrow();
      expect(tiposDeLinkHabilitados(settings)).toEqual([...TODOS_OS_TIPOS_DE_LINK]);
    }
  });

  it("a lista crua (sem envelope) também é aceita", () => {
    expect(normalizarTiposDeLink(["site"])).toEqual(["site"]);
  });

  it("id repetido não duplica a saída", () => {
    expect(normalizarTiposDeLink({ tipos: ["site", "site", "instagram"] })).toEqual([
      "instagram",
      "site",
    ]);
  });
});

describe("settingsComTiposDeLink — preserva o resto do jsonb", () => {
  it("⭐ grava só a chave nova, na ordem do catálogo, e mantém as irmãs", () => {
    const atuais = { routing: { mode: "manual" }, links_de_contato: { outra: 1 } };
    expect(settingsComTiposDeLink(atuais, ["linkedin", "instagram"])).toEqual({
      routing: { mode: "manual" },
      links_de_contato: { outra: 1, tipos: ["instagram", "linkedin"] },
    });
  });

  it("settings nulo cria o objeto a partir do zero", () => {
    expect(settingsComTiposDeLink(null, ["site"])).toEqual({
      links_de_contato: { tipos: ["site"] },
    });
  });

  it("lista vazia cai no catálogo inteiro (o mesmo default da leitura)", () => {
    expect(settingsComTiposDeLink({}, [])).toEqual({
      links_de_contato: { tipos: [...TODOS_OS_TIPOS_DE_LINK] },
    });
  });
});
