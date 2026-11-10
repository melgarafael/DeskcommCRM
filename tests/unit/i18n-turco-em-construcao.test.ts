import { describe, expect, it } from "vitest";
import { IDIOMAS_COM_CATALOGO } from "@/lib/i18n/catalogos";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMAS, normalizarIdioma, parseAcceptLanguage } from "@/lib/i18n/idiomas";
import { REGISTRO_DE_IDIOMAS } from "@/lib/i18n/registro";

/**
 * O turco entra em construção, como o chinês (doc de decisão 198): o catálogo
 * `lib/i18n/traducoes/tr.json` existe, mas não aparece para ninguém, não pesa
 * na carga e não cobra tradução de quem acrescenta frase em português.
 */
describe("o turco está registrado, mas em construção", () => {
  it("o registro o tem como em_construcao", () => {
    expect(REGISTRO_DE_IDIOMAS.find((idioma) => idioma.codigo === "tr")?.nivel).toBe("em_construcao");
  });
  it("não é visível: não está em IDIOMAS e não normaliza", () => {
    expect(IDIOMAS).not.toContain("tr");
    expect(normalizarIdioma("tr")).toBe("pt-BR");
  });
  it("o navegador em turco não leva ao turco; o próximo idioma visível vence", () => {
    expect(parseAcceptLanguage("tr-TR,tr;q=0.9")).toBeNull();
    expect(parseAcceptLanguage("tr-TR,tr;q=0.9,es;q=0.5")).toBe("es");
  });
  it("nenhum catálogo é lido enquanto nenhum idioma de catálogo é visível", () => {
    expect(IDIOMAS_COM_CATALOGO).toEqual([]);
  });
  it("o espanhol continua vindo do dicionário", () => {
    expect(traduzir("Plano atual", "es")).toBe("Plan actual");
  });
});
