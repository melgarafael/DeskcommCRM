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
