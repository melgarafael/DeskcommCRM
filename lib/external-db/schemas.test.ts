import { describe, expect, it } from "vitest";

import { LIMITE_FILTROS, LIMITE_LINHAS, LIMITE_PADRAO_DA_GRADE, LIMITE_RESPOSTA_BYTES } from "./limites";
import {
  atualizarConexaoSchema,
  criarConexaoSchema,
  leituraQuerySchema,
  MODOS_TLS,
  salvarCatalogoSchema,
} from "./schemas";

const VALIDO = {
  label: "Postgres do outro CRM",
  host: "db.exemplo.com",
  database_name: "outro_crm",
  username: "leitor",
  password: "segredo",
};

describe("criarConexaoSchema", () => {
  it("aplica defaults de porta, TLS, enabled e limites de leitura", () => {
    const r = criarConexaoSchema.parse(VALIDO);
    expect(r.port).toBe(5432);
    expect(r.ssl_mode).toBe("require");
    expect(r.enabled).toBe(true);
    expect(r.max_rows).toBe(LIMITE_LINHAS.padrao);
    expect(r.max_filters).toBe(LIMITE_FILTROS.padrao);
    expect(r.max_response_bytes).toBe(LIMITE_RESPOSTA_BYTES.padrao);
  });

  it("respeita limites dentro da faixa e recusa fora dela", () => {
    const r = criarConexaoSchema.parse({ ...VALIDO, max_rows: 1500, max_filters: 60, max_response_bytes: 200000 });
    expect(r.max_rows).toBe(1500);
    expect(r.max_filters).toBe(60);
    expect(r.max_response_bytes).toBe(200000);

    expect(() => criarConexaoSchema.parse({ ...VALIDO, max_rows: LIMITE_LINHAS.maximo + 1 })).toThrow();
    expect(() => criarConexaoSchema.parse({ ...VALIDO, max_filters: -1 })).toThrow();
    expect(() =>
      criarConexaoSchema.parse({ ...VALIDO, max_response_bytes: LIMITE_RESPOSTA_BYTES.minimo - 1 }),
    ).toThrow();
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

describe("salvarCatalogoSchema", () => {
  const BASE = {
    connection_id: "11111111-1111-4111-8111-111111111111",
    schema_name: "public",
    table_name: "motos",
    col_nome: "nome",
  };

  it("aceita o mínimo e aplica defaults das regras", () => {
    const r = salvarCatalogoSchema.parse(BASE);
    expect(r.busca_operador).toBe("contem");
    expect(r.enabled).toBe(true);
    expect(r.similaridade_deterministica).toBe(false);
    expect(r.similares_qtd).toBe(3);
    expect(r.ordem).toEqual({});
  });

  it("recusa ORDEM repetida (não pode usar o mesmo número duas vezes)", () => {
    const r = salvarCatalogoSchema.safeParse({
      ...BASE,
      ordem: { cilindrada: 1, preco: 1 },
    });
    expect(r.success).toBe(false);
  });

  it("aceita ordem com números distintos", () => {
    const r = salvarCatalogoSchema.parse({
      ...BASE,
      ordem: { cilindrada: 1, preco: 2 },
    });
    expect(r.ordem).toEqual({ cilindrada: 1, preco: 2 });
  });

  it("recusa papel desconhecido e quantidade fora da faixa", () => {
    expect(salvarCatalogoSchema.safeParse({ ...BASE, ordem: { foo: 1 } }).success).toBe(false);
    expect(salvarCatalogoSchema.safeParse({ ...BASE, similares_qtd: 99 }).success).toBe(false);
  });
});

describe("leituraQuerySchema", () => {
  it("coage strings da querystring e usa defaults", () => {
    const r = leituraQuerySchema.parse({});
    expect(r.limit).toBe(LIMITE_PADRAO_DA_GRADE);
    expect(r.offset).toBe(0);

    const r2 = leituraQuerySchema.parse({ limit: "10", offset: "20" });
    expect(r2.limit).toBe(10);
    expect(r2.offset).toBe(20);
  });

  it("não deixa o limite passar do teto absoluto", () => {
    expect(() => leituraQuerySchema.parse({ limit: String(LIMITE_LINHAS.maximo + 1) })).toThrow();
  });
});
