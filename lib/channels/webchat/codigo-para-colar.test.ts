import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { codigoParaColar, linkDireto } from "./codigo-para-colar";

const CHAVE = "wck_abc-DEF_123";

describe("codigoParaColar", () => {
  it("devolve a linha exata do script, sem espaço nem aspas soltas", () => {
    expect(codigoParaColar("https://crm.exemplo.com.br", CHAVE)).toBe(
      '<script src="https://crm.exemplo.com.br/webchat.js?k=wck_abc-DEF_123" async></script>',
    );
  });

  it("normaliza a origem com barra final", () => {
    expect(codigoParaColar("https://crm.exemplo.com.br/", CHAVE)).toBe(
      codigoParaColar("https://crm.exemplo.com.br", CHAVE),
    );
  });

  it("aceita http em loopback, que é como a instalação local responde", () => {
    expect(codigoParaColar("http://localhost:3000", CHAVE)).toBe(
      '<script src="http://localhost:3000/webchat.js?k=wck_abc-DEF_123" async></script>',
    );
  });

  it("recusa chave com caractere que sai da régua (aspas, marcação, sem prefixo, longa demais)", () => {
    const origem = "https://crm.exemplo.com.br";
    expect(() => codigoParaColar(origem, 'wck_x"><script>')).toThrow();
    expect(() => codigoParaColar(origem, "abc123")).toThrow();
    expect(() => codigoParaColar(origem, `wck_${"a".repeat(65)}`)).toThrow();
    expect(() => codigoParaColar(origem, "")).toThrow();
  });

  it("recusa origem que não é http(s)", () => {
    expect(() => codigoParaColar("javascript:alert(1)", CHAVE)).toThrow();
    expect(() => codigoParaColar("ftp://crm.exemplo.com.br", CHAVE)).toThrow();
    expect(() => codigoParaColar("não é um endereço", CHAVE)).toThrow();
  });
});

describe("linkDireto", () => {
  it("monta o endereço da conversa pela chave, sem barra dupla", () => {
    expect(linkDireto("https://crm.exemplo.com.br/", CHAVE)).toBe(
      "https://crm.exemplo.com.br/chat/wck_abc-DEF_123",
    );
  });

  it("recusa chave inválida também no link", () => {
    expect(() => linkDireto("https://crm.exemplo.com.br", "wck_ruim com espaço")).toThrow();
  });
});

describe("codigoParaColar: formato e posicao", () => {
  it("sem o terceiro parametro e identico a antes (padrao bolha/direita)", () => {
    expect(codigoParaColar("https://crm.exemplo.com.br", CHAVE)).toBe(
      '<script src="https://crm.exemplo.com.br/webchat.js?k=wck_abc-DEF_123" async></script>',
    );
  });

  it("formato painel e posicao esquerda vao na URL so o que difere do padrao", () => {
    expect(
      codigoParaColar("https://crm.exemplo.com.br", CHAVE, {
        formato: "painel",
        posicao: "esquerda",
      }),
    ).toBe(
      '<script src="https://crm.exemplo.com.br/webchat.js?k=wck_abc-DEF_123&f=painel&p=esquerda" async></script>',
    );
  });

  it("so o formato diferente do padrao vai na URL", () => {
    expect(
      codigoParaColar("https://crm.exemplo.com.br", CHAVE, { formato: "pagina" }),
    ).toBe(
      '<script src="https://crm.exemplo.com.br/webchat.js?k=wck_abc-DEF_123&f=pagina" async></script>',
    );
  });

  it("so a posicao diferente do padrao vai na URL", () => {
    expect(
      codigoParaColar("https://crm.exemplo.com.br", CHAVE, { posicao: "esquerda" }),
    ).toBe(
      '<script src="https://crm.exemplo.com.br/webchat.js?k=wck_abc-DEF_123&p=esquerda" async></script>',
    );
  });

  it("formato invalido recusa", () => {
    expect(() =>
      codigoParaColar("https://crm.exemplo.com.br", CHAVE, { formato: "invalido" as never }),
    ).toThrow();
  });

  it("posicao invalida recusa", () => {
    expect(() =>
      codigoParaColar("https://crm.exemplo.com.br", CHAVE, { posicao: "centro" as never }),
    ).toThrow();
  });

  it("embutido devolve duas linhas: div alvo e script com data-webchat-alvo", () => {
    const resultado = codigoParaColar("https://crm.exemplo.com.br", CHAVE, {
      formato: "embutido",
    });
    expect(resultado).toContain('<div id="webchat-aqui"></div>');
    expect(resultado).toContain(
      '<script src="https://crm.exemplo.com.br/webchat.js?k=wck_abc-DEF_123&f=embutido" data-webchat-alvo="#webchat-aqui" async></script>',
    );
    expect(resultado.split("\n")).toHaveLength(2);
  });

  it("painel nao adiciona data-webchat-alvo", () => {
    const resultado = codigoParaColar("https://crm.exemplo.com.br", CHAVE, {
      formato: "painel",
    });
    expect(resultado).not.toContain("data-webchat-alvo");
    expect(resultado).toContain("&f=painel");
  });

  it("embutido sem posicao usa a posicao padrao (nao coloca p= na URL)", () => {
    const resultado = codigoParaColar("https://crm.exemplo.com.br", CHAVE, {
      formato: "embutido",
    });
    expect(resultado).not.toContain("&p=");
  });
});

describe("codigo-para-colar roda no navegador", () => {
  it("não importa VALOR do config.ts (puxaria o ambiente do servidor para o cliente)", () => {
    const fonte = readFileSync(new URL("./codigo-para-colar.ts", import.meta.url), "utf8");
    const importsDoConfig = fonte
      .split(/\r?\n/)
      .filter((l) => /^import\b.*from\s+"\.\/config"/.test(l));
    expect(importsDoConfig.length).toBeGreaterThan(0);
    for (const linha of importsDoConfig) expect(linha).toMatch(/^import type\b/);
  });
});
