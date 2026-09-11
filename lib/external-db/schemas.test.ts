import { describe, expect, it } from "vitest";

import { LIMITE_MAX, LIMITE_PADRAO } from "./leitura";
import { atualizarConexaoSchema, criarConexaoSchema, leituraQuerySchema, MODOS_TLS } from "./schemas";

const VALIDO = {
  label: "Postgres do outro CRM",
  host: "db.exemplo.com",
  database_name: "outro_crm",
  username: "leitor",
  password: "segredo",
};

describe("criarConexaoSchema", () => {
  it("aplica defaults de porta, TLS e enabled", () => {
    const r = criarConexaoSchema.parse(VALIDO);
    expect(r.port).toBe(5432);
    expect(r.ssl_mode).toBe("require");
    expect(r.enabled).toBe(true);
  });

  it("recusa campo desconhecido (strict) — não aceita coluna cifrada crua", () => {
    expect(() => criarConexaoSchema.parse({ ...VALIDO, password_encrypted: "\\xaa" })).toThrow();
  });

  it("recusa label/host vazios e porta fora da faixa", () => {
    expect(() => criarConexaoSchema.parse({ ...VALIDO, label: "   " })).toThrow();
    expect(() => criarConexaoSchema.parse({ ...VALIDO, host: "" })).toThrow();
    expect(() => criarConexaoSchema.parse({ ...VALIDO, port: 70000 })).toThrow();
  });

  it("só aceita os `ssl_mode` do CHECK do banco", () => {
    for (const modo of MODOS_TLS) {
      expect(criarConexaoSchema.parse({ ...VALIDO, ssl_mode: modo }).ssl_mode).toBe(modo);
    }
    expect(() => criarConexaoSchema.parse({ ...VALIDO, ssl_mode: "allow" })).toThrow();
  });
});

describe("atualizarConexaoSchema", () => {
  it("aceita patch parcial sem senha", () => {
    const r = atualizarConexaoSchema.parse({ label: "Novo nome" });
    expect(r).toEqual({ label: "Novo nome" });
  });

  it("campo desconhecido é recusado", () => {
    expect(() => atualizarConexaoSchema.parse({ nope: 1 })).toThrow();
  });
});

describe("leituraQuerySchema", () => {
  it("coage strings da querystring e usa defaults", () => {
    const r = leituraQuerySchema.parse({});
    expect(r.limit).toBe(LIMITE_PADRAO);
    expect(r.offset).toBe(0);

    const r2 = leituraQuerySchema.parse({ limit: "10", offset: "20" });
    expect(r2.limit).toBe(10);
    expect(r2.offset).toBe(20);
  });

  it("não deixa o limite passar do teto do núcleo", () => {
    expect(() => leituraQuerySchema.parse({ limit: String(LIMITE_MAX + 1) })).toThrow();
  });
});
