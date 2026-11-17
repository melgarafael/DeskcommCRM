import { describe, expect, it } from "vitest";

import { fonteDoFeedNaTela, urlMascarada } from "@/lib/catalogo/fonte-do-feed";

/**
 * A URL DO FEED pode levar o token do sistema da revenda. Inteira só para quem
 * pode editar (`manager`+); abaixo disso a tela recebe só o host — e é o
 * SERVIDOR que mascara, então o token nem chega ao navegador de quem atende.
 */
const LINHA = {
  url: "https://usuario:senha@loja.com.br:8443/api/estoque.json?token=SEGREDO123",
  formato: "json",
  ultima_leitura_em: null,
  ultimo_resumo: null,
  falhas_seguidas: 0,
  ultimo_erro: null,
};
const formatarData = (iso: string) => iso;

describe("a URL do feed na tela", () => {
  it("abaixo de manager: só o host, sem token, caminho nem credencial", () => {
    const tela = fonteDoFeedNaTela(LINHA, { podeVerUrl: false, formatarData });

    expect(tela.url).toBe("loja.com.br:8443/…");
    expect(tela.url).not.toContain("SEGREDO123");
    expect(tela.url).not.toContain("senha");
    expect(tela.url).not.toContain("estoque");
  });

  it("controle: manager+ vê a URL inteira (é quem a edita)", () => {
    expect(fonteDoFeedNaTela(LINHA, { podeVerUrl: true, formatarData }).url).toBe(LINHA.url);
  });

  it("URL ilegível vira reticências, nunca o texto cru", () => {
    expect(urlMascarada("não é url ?token=x")).toBe("…");
  });
});
