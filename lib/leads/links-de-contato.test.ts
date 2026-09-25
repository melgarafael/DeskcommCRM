import { describe, expect, it } from "vitest";

import {
  aplicarLinks,
  chaveDoLink,
  lerLinks,
  linksParaExibir,
  normalizarLink,
  TAMANHO_MAXIMO_DO_LINK,
  tiposInvalidos,
} from "./links-de-contato";

describe("normalizarLink — o que vira href", () => {
  it("põe https em endereço sem esquema", () => {
    expect(normalizarLink("exemplo.com.br/loja")).toBe("https://exemplo.com.br/loja");
  });

  it("mantém URL completa, com query string", () => {
    expect(normalizarLink("https://maps.app.goo.gl/abc?g_st=ic")).toBe(
      "https://maps.app.goo.gl/abc?g_st=ic",
    );
  });

  it("aceita http também", () => {
    expect(normalizarLink("http://exemplo.com.br")).toBe("http://exemplo.com.br/");
  });

  it("⭐ @usuario é recusado — e @loja.exemplo NÃO vira o domínio loja.exemplo", () => {
    // O código que embarca não nomeia host de rede social, então não há como
    // transformar handle em endereço. O perigo real não é recusar: é aceitar por
    // engano, porque `https://@loja.exemplo` é um URL válido de host
    // `loja.exemplo`.
    expect(normalizarLink("@loja")).toBeNull();
    expect(normalizarLink("@loja.exemplo")).toBeNull();
    expect(normalizarLink("@")).toBeNull();
    expect(normalizarLink("@com espaço")).toBeNull();
  });

  it("⭐ recusa esquemas perigosos — o valor vira <a href>", () => {
    expect(normalizarLink("javascript:alert(1)")).toBeNull();
    expect(normalizarLink("JAVASCRIPT:alert(1)")).toBeNull();
    expect(normalizarLink("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(normalizarLink("ftp://exemplo.com/arquivo")).toBeNull();
    expect(normalizarLink("vbscript:msgbox(1)")).toBeNull();
    expect(normalizarLink("file:///etc/passwd")).toBeNull();
  });

  it("recusa o que não é endereço", () => {
    expect(normalizarLink("loja")).toBeNull();
    expect(normalizarLink("   ")).toBeNull();
    expect(normalizarLink(null)).toBeNull();
    expect(normalizarLink(undefined)).toBeNull();
  });

  it("recusa texto acima do teto", () => {
    expect(normalizarLink(`https://exemplo.com/${"a".repeat(TAMANHO_MAXIMO_DO_LINK)}`)).toBeNull();
  });
});

describe("lerLinks / linksParaExibir", () => {
  it("lê só valores string preenchidos, das chaves do catálogo", () => {
    const links = lerLinks({
      link_instagram: "  instagram.com/loja  ",
      link_site: "",
      link_youtube: 42,
      link_desconhecido: "https://x.com",
      cor_favorita: "azul",
    });
    expect(links).toEqual({ instagram: "instagram.com/loja" });
  });

  it("⭐ exibe só o que é válido, na ordem do catálogo", () => {
    const itens = linksParaExibir({
      link_site: "exemplo.com.br",
      link_instagram: "instagram.com/loja",
      link_facebook: "javascript:alert(1)",
      link_tiktok: "@loja",
    });
    expect(itens).toEqual([
      { tipo: "instagram", href: "https://instagram.com/loja" },
      { tipo: "site", href: "https://exemplo.com.br/" },
    ]);
  });

  it("aceita custom_fields ausente", () => {
    expect(lerLinks(null)).toEqual({});
    expect(linksParaExibir(undefined)).toEqual([]);
  });
});

describe("aplicarLinks — o objeto completo que o PATCH vai trocar", () => {
  it("⭐ preserva os campos que não são link (o PATCH substitui o objeto inteiro)", () => {
    const novo = aplicarLinks(
      { cor_favorita: "azul", numero_de_filiais: 3, link_instagram: "antigo.exemplo.com" },
      { instagram: "novo.exemplo.com", site: "exemplo.com.br" },
    );
    expect(novo).toEqual({
      cor_favorita: "azul",
      numero_de_filiais: 3,
      link_instagram: "novo.exemplo.com",
      link_site: "exemplo.com.br",
    });
  });

  it("vazio apaga a chave, não grava string vazia", () => {
    const novo = aplicarLinks(
      { link_instagram: "antigo.exemplo.com", link_site: "exemplo.com.br" },
      { instagram: "   ", site: "exemplo.com.br" },
    );
    expect(novo).toEqual({ link_site: "exemplo.com.br" });
    expect(chaveDoLink("instagram") in novo).toBe(false);
  });

  it("não toca em campo personalizado que só parece link (fora do catálogo)", () => {
    const novo = aplicarLinks({ link_do_fornecedor: "X-1" }, { site: "exemplo.com.br" });
    expect(novo).toEqual({ link_do_fornecedor: "X-1", link_site: "exemplo.com.br" });
  });

  it("aceita custom_fields ausente", () => {
    expect(aplicarLinks(null, { site: "exemplo.com.br" })).toEqual({ link_site: "exemplo.com.br" });
  });
});

describe("tiposInvalidos", () => {
  it("aponta o que está preenchido e não vira link", () => {
    expect(
      tiposInvalidos({
        instagram: "@loja",
        site: "loja",
        facebook: "javascript:x",
        youtube: "",
        outro: "exemplo.com.br",
      }),
    ).toEqual(["instagram", "site", "facebook"]);
  });

  it("vazio não é inválido", () => {
    expect(tiposInvalidos({})).toEqual([]);
    expect(tiposInvalidos({ site: "  " })).toEqual([]);
  });
});
