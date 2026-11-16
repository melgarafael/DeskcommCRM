import { describe, expect, it } from "vitest";

import { criarProcedenciaDeImagens, descreverSemQuery, formatoDeImagemPorUrl } from "./imagem-por-url";

describe("formatoDeImagemPorUrl — só o formato, sem rede", () => {
  it.each([
    ["jpg", "https://exemplo.test/a/b.jpg", "image/jpeg"],
    ["jpeg", "https://exemplo.test/a/b.JPEG", "image/jpeg"],
    ["png", "https://exemplo.test/a/b.png", "image/png"],
    ["webp", "https://exemplo.test/a/b.webp", "image/webp"],
  ])("aceita %s e define o mime", (_nome, url, mime) => {
    const r = formatoDeImagemPorUrl(url);
    expect(r.ok).toBe(true);
    expect(r.ok && r.mime).toBe(mime);
  });

  it("a extensão decide pelo CAMINHO: a query-string não entra na conta", () => {
    expect(formatoDeImagemPorUrl("https://exemplo.test/x.jpg?ext=.gif&token=t").ok).toBe(true);
    expect(formatoDeImagemPorUrl("https://exemplo.test/x.gif?ext=.jpg")).toEqual({
      ok: false,
      motivo: "extensao_nao_aceita",
    });
  });

  it.each([
    ["gif (fora da lista desta fatia)", "https://exemplo.test/x.gif"],
    ["php", "https://exemplo.test/x.php"],
    ["sem extensão", "https://exemplo.test/foto"],
    ["extensão que é nome de propriedade de objeto", "https://exemplo.test/x.constructor"],
  ])("recusa %s", (_nome, url) => {
    expect(formatoDeImagemPorUrl(url)).toEqual({ ok: false, motivo: "extensao_nao_aceita" });
  });

  it("URL que não parseia volta como url_invalida", () => {
    expect(formatoDeImagemPorUrl("não é url")).toEqual({ ok: false, motivo: "url_invalida" });
  });
});

describe("descreverSemQuery — o que vai ao log não tem query (pode ter token)", () => {
  it("fica com host e caminho", () => {
    expect(descreverSemQuery("https://exemplo.test/a/x.jpg?token=segredo")).toBe("exemplo.test/a/x.jpg");
  });
  it("URL inválida vira marcador, nunca o texto cru", () => {
    expect(descreverSemQuery("não é url token=segredo")).toBe("(url inválida)");
  });
});

describe("criarProcedenciaDeImagens — só vale endereço que a ferramenta trouxe no turno", () => {
  const URL_DA_FOTO = "https://exemplo.test/casas/1.jpg";

  it("vale o campo que é o endereço inteiro, em qualquer profundidade", () => {
    const procedencia = criarProcedenciaDeImagens();
    procedencia.registrar({ linhas: [{ foto: URL_DA_FOTO }] }, {});
    procedencia.registrar({ linhas: [{ dados: { galeria: ["https://exemplo.test/casas/2.jpg?v=1"] } }] }, {});
    expect(procedencia.viu(URL_DA_FOTO)).toBe(true);
    expect(procedencia.viu("https://exemplo.test/casas/2.jpg?v=1")).toBe(true);
  });

  it("recusa o que nenhuma ferramenta devolveu, inclusive parecido", () => {
    const procedencia = criarProcedenciaDeImagens();
    expect(procedencia.viu(URL_DA_FOTO)).toBe(false);
    procedencia.registrar({ foto: URL_DA_FOTO }, {});
    expect(procedencia.viu("https://exemplo.test/casas/1.png")).toBe(false);
    expect(procedencia.viu("https://exemplo.test/casas/1.jpg?x=1")).toBe(false);
  });

  it("endereço no meio de um texto não conta", () => {
    const procedencia = criarProcedenciaDeImagens();
    procedencia.registrar({ linhas: [{ descricao: `A foto está em ${URL_DA_FOTO}.` }] }, {});
    procedencia.registrar({ linhas: [{ descricao: `A foto está em ${URL_DA_FOTO}` }] }, {});
    expect(procedencia.viu(URL_DA_FOTO)).toBe(false);
  });

  it("célula com vários endereços não autoriza nenhum deles", () => {
    const procedencia = criarProcedenciaDeImagens();
    procedencia.registrar({ linhas: [{ fotos: `${URL_DA_FOTO},https://exemplo.test/casas/2.jpg` }] }, {});
    procedencia.registrar({ linhas: [{ fotos: `${URL_DA_FOTO}|https://exemplo.test/casas/2.jpg` }] }, {});
    expect(procedencia.viu(URL_DA_FOTO)).toBe(false);
    expect(procedencia.viu("https://exemplo.test/casas/2.jpg")).toBe(false);
  });

  it("o endereço que estava nos argumentos da chamada não conta como trazido pela ferramenta", () => {
    const procedencia = criarProcedenciaDeImagens();
    procedencia.registrar({ filtros: [{ valor: URL_DA_FOTO }], linhas: [] }, { filtros: [{ valor: URL_DA_FOTO }] });
    expect(procedencia.viu(URL_DA_FOTO)).toBe(false);
  });

  it("cada turno começa vazio", () => {
    criarProcedenciaDeImagens().registrar({ foto: URL_DA_FOTO }, {});
    expect(criarProcedenciaDeImagens().viu(URL_DA_FOTO)).toBe(false);
  });
});
