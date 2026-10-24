import { format } from "date-fns";
import { describe, expect, it } from "vitest";
import { traduzir } from "@/lib/i18n/dicionario";
import { localeDeData } from "@/lib/i18n/datas";
import { IDIOMAS, normalizarIdioma, parseAcceptLanguage } from "@/lib/i18n/idiomas";

describe("o turco é servido pelo catálogo JSON", () => {
  it("é um idioma visível e normaliza", () => {
    expect(IDIOMAS).toContain("tr");
    expect(normalizarIdioma("tr")).toBe("tr");
  });
  it("o navegador em turco cai no turco", () => {
    expect(parseAcceptLanguage("tr-TR,tr;q=0.9,en;q=0.8")).toBe("tr");
  });
  it("traduz pela entrada do catálogo e degrada para o português", () => {
    expect(traduzir("Plano atual", "tr")).toBe("Mevcut plan");
    expect(traduzir("frase que não existe em catálogo nenhum", "tr")).toBe("frase que não existe em catálogo nenhum");
  });
  it("o espanhol continua vindo do dicionário", () => {
    expect(traduzir("Plano atual", "es")).toBe("Plan actual");
  });
  it("a data em turco usa o Locale tr", () => {
    expect(format(new Date(2026, 9, 19), "EEEE, d MMMM", { locale: localeDeData("tr") })).toBe("Pazartesi, 19 Ekim");
  });
});
