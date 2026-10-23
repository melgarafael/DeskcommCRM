/**
 * Teste unitário de `quotarIdentificadorMysql` e `escaparLikeMysql`,
 * agora num arquivo só (lib/external-db/receitas/sql-mysql.ts) para ser
 * reutilizado por todas as famílias de receitas.
 */
import { describe, expect, it } from "vitest";

import { quotarIdentificadorMysql, escaparLikeMysql } from "./sql-mysql";

describe("quotarIdentificadorMysql", () => {
  it("coloca o nome entre crases", () => {
    expect(quotarIdentificadorMysql("wp_posts")).toBe("`wp_posts`");
  });

  it("dobra a crase interna (identificador com crase vira `` a``b ``)", () => {
    expect(quotarIdentificadorMysql("a`b")).toBe("`a``b`");
  });

  it("não muda nomes comuns de tabela", () => {
    expect(quotarIdentificadorMysql("wp_postmeta")).toBe("`wp_postmeta`");
    expect(quotarIdentificadorMysql("mp")).toBe("`mp`");
  });
});

describe("escaparLikeMysql", () => {
  it("escape de !, % e _ com o prefixo !", () => {
    expect(escaparLikeMysql("a!b%c_d")).toBe("a!!b!%c!_d");
  });

  it("não altera textos sem curingas", () => {
    expect(escaparLikeMysql("camisa")).toBe("camisa");
    expect(escaparLikeMysql("")).toBe("");
  });
});
