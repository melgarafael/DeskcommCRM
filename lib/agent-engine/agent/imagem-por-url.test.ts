import { describe, expect, it } from "vitest";

import { descreverSemQuery, formatoDeImagemPorUrl } from "./imagem-por-url";

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
