/**
 * A PRECEDÊNCIA DO IDIOMA DO E-MAIL (#4302) — destinatário → organização →
 * instalação → pt-BR.
 *
 * Por que isto é teste e não comentário: a ordem é a REGRA do produto. Um molde
 * que consulte as fontes por conta própria acerta hoje e diverge no mês que
 * vem; e foi assim que o e-mail ficou em português com a tela em espanhol.
 * Aqui a regra é uma função só, e cada elo tem um caso que o derruba.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { idiomaDaInstalacao, idiomaDoEmail } from "./idioma-do-email";

describe("(b) precedência: destinatário vence organização, organização vence instalação", () => {
  it("o destinatário manda, mesmo com organização e instalação em outro idioma", () => {
    expect(
      idiomaDoEmail({ destinatario: "es", organizacao: "pt-BR", instalacao: "pt-BR" }),
    ).toBe("es");
  });

  it("sem preferência do destinatário, vale a organização", () => {
    expect(idiomaDoEmail({ destinatario: null, organizacao: "es", instalacao: "pt-BR" })).toBe("es");
  });

  it("sem destinatário nem organização, vale o APP_LOCALE da instalação", () => {
    expect(idiomaDoEmail({ instalacao: "es" })).toBe("es");
    expect(idiomaDoEmail({ destinatario: "", organizacao: "  ", instalacao: "es" })).toBe("es");
  });

  it("sem nenhuma das três, cai em pt-BR", () => {
    expect(idiomaDoEmail()).toBe("pt-BR");
    expect(idiomaDoEmail({})).toBe("pt-BR");
    expect(idiomaDoEmail({ destinatario: null, organizacao: null, instalacao: null })).toBe("pt-BR");
  });

  it("a etiqueta regional casa pelo primário (`es-MX`, `es-419`, `pt-PT`)", () => {
    expect(idiomaDoEmail({ destinatario: "es-MX" })).toBe("es");
    expect(idiomaDoEmail({ organizacao: "es-419" })).toBe("es");
    expect(idiomaDoEmail({ destinatario: "pt-PT" })).toBe("pt-BR");
    // E a regional de quem PREFERE português não rouba a vez da organização.
    expect(idiomaDoEmail({ destinatario: "pt-PT", organizacao: "es" })).toBe("pt-BR");
  });
});

describe("(c) locale desconhecido ou lixo não quebra — e sai pt-BR", () => {
  it("um locale que o produto não serve cai no padrão, sem lançar", () => {
    for (const lixo of ["xx-YY", "klingon", "en-GB", "es_ES", "??", "  "]) {
      expect(() => idiomaDoEmail({ destinatario: lixo }), `lançou com ${lixo}`).not.toThrow();
      expect(idiomaDoEmail({ destinatario: lixo }), `não caiu no padrão com ${lixo}`).toBe("pt-BR");
    }
  });

  it("valor que nem string é (jsonb torto no user_metadata) também degrada", () => {
    // `user_metadata` é jsonb: o campo já chegou como número e como objeto em
    // instalações antigas, e um `.split` num deles derrubaria o envio.
    const tortos = [42, {}, [], true] as unknown as string[];
    for (const torto of tortos) {
      expect(() => idiomaDoEmail({ destinatario: torto })).not.toThrow();
      expect(idiomaDoEmail({ destinatario: torto })).toBe("pt-BR");
    }
  });

  it("lixo no destinatário não esconde a organização válida", () => {
    expect(idiomaDoEmail({ destinatario: "xx-YY", organizacao: "es" })).toBe("es");
  });

  it("`en` hoje é idioma em construção: degrada para pt-BR em vez de inventar texto", () => {
    // Medido em `lib/i18n/registro.ts`: `en` está em `em_construcao`, e o
    // catálogo (`lib/i18n/traducoes/en.json`) NÃO é importado — `catalogos.ts`
    // só carrega idioma visível. Servir e-mail em inglês exigiria promover o
    // idioma na interface inteira; no dia em que isso acontecer, os moldes já
    // seguem o dicionário sem tocar em molde nenhum.
    expect(idiomaDoEmail({ destinatario: "en" })).toBe("pt-BR");
  });
});

describe("APP_LOCALE da instalação", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lê o idioma que o instalador gravou", () => {
    vi.stubEnv("APP_LOCALE", "es");
    expect(idiomaDaInstalacao()).toBe("es");
  });

  it("ausente ou inválido cai em pt-BR — env não derruba o envio", () => {
    vi.stubEnv("APP_LOCALE", "");
    expect(idiomaDaInstalacao()).toBe("pt-BR");
    vi.stubEnv("APP_LOCALE", "2");
    expect(idiomaDaInstalacao()).toBe("pt-BR");
    vi.stubEnv("APP_LOCALE", "en");
    expect(idiomaDaInstalacao()).toBe("pt-BR");
  });
});
