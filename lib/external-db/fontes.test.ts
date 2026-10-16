import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  aplicarAoCatalogo,
  colunasLiberadas,
  fontesSchema,
  lerFontesDoBanco,
  MAX_BYTES_DAS_FONTES,
  MAX_FONTES,
  tabelaLiberada,
  tamanhoComoJsonb,
  type Fonte,
  type RegraDeFontes,
} from "./fontes";
import type { TabelaExterna } from "./types";

const T = (schema: string, nome: string, cols: string[], pk: string[] = ["id"]): TabelaExterna => ({
  schema,
  nome,
  tipo: "tabela",
  colunas: cols.map((c, i) => ({ nome: c, tipo: "text", nulavel: true, posicao: i + 1 })),
  chavePrimaria: pk,
  estimativaLinhas: 10,
});

const CATALOGO: TabelaExterna[] = [
  T("public", "clientes", ["id", "nome", "cpf"]),
  T("public", "pedidos", ["id", "status"]),
  T("public", "wp_users", ["id", "user_pass"]),
  T("outro", "pedidos", ["id", "x"]),
];

const f = (schema: string, tabela: string, colunas: string[] | null = null, descricao = ""): Fonte => ({
  schema,
  tabela,
  colunas,
  descricao,
});

const lista = (...fontes: Fonte[]): RegraDeFontes => ({ modo: "list", fontes });
const TUDO: RegraDeFontes = { modo: "all", fontes: [] };

describe("fontesSchema", () => {
  it("aceita uma lista válida e apara os espaços", () => {
    const r = fontesSchema.parse([{ schema: " public ", tabela: "clientes", colunas: ["id"], descricao: " Quem compra " }]);
    expect(r[0]).toEqual({ schema: "public", tabela: "clientes", colunas: ["id"], descricao: "Quem compra" });
  });

  it("rejeita a mesma tabela duas vezes", () => {
    expect(() => fontesSchema.parse([f("public", "clientes"), f("public", "clientes")])).toThrow();
  });

  it("aceita o mesmo nome em schemas diferentes", () => {
    expect(() => fontesSchema.parse([f("public", "pedidos"), f("outro", "pedidos")])).not.toThrow();
  });

  it("rejeita lista de colunas vazia (null é que significa 'todas')", () => {
    expect(() => fontesSchema.parse([f("public", "clientes", [])])).toThrow();
  });

  it("rejeita descrição acima de 300 caracteres, campo extra e mais de 200 fontes", () => {
    expect(() => fontesSchema.parse([f("public", "a", null, "x".repeat(301))])).toThrow();
    expect(() => fontesSchema.parse([{ ...f("public", "a"), extra: 1 }])).toThrow();
    const demais = Array.from({ length: MAX_FONTES + 1 }, (_, i) => f("public", `t${i}`));
    expect(() => fontesSchema.parse(demais)).toThrow();
  });
});

describe("lerFontesDoBanco — falha FECHADA", () => {
  it("lixo no jsonb vira { ok: false }, nunca lista vazia que 'abre' nada", () => {
    expect(lerFontesDoBanco("não é array")).toEqual({ ok: false });
    expect(lerFontesDoBanco([{ schema: "public" }])).toEqual({ ok: false });
    expect(lerFontesDoBanco(null)).toEqual({ ok: false });
  });

  it("lista válida passa", () => {
    expect(lerFontesDoBanco([f("public", "clientes")])).toEqual({ ok: true, fontes: [f("public", "clientes")] });
  });
});

describe("aplicarAoCatalogo", () => {
  it("modo all devolve o catálogo como está (regressão zero para conexões antigas)", () => {
    expect(aplicarAoCatalogo(TUDO, CATALOGO)).toEqual(CATALOGO);
  });

  it("modo list devolve só as liberadas, NA ORDEM da lista", () => {
    const r = aplicarAoCatalogo(lista(f("public", "pedidos"), f("public", "clientes")), CATALOGO);
    expect(r.map((t) => `${t.schema}.${t.nome}`)).toEqual(["public.pedidos", "public.clientes"]);
  });

  it("wp_users fica de fora quando não está na lista", () => {
    const r = aplicarAoCatalogo(lista(f("public", "clientes")), CATALOGO);
    expect(r.some((t) => t.nome === "wp_users")).toBe(false);
  });

  it("mesma tabela em dois schemas: só a liberada aparece", () => {
    const r = aplicarAoCatalogo(lista(f("outro", "pedidos")), CATALOGO);
    expect(r.map((t) => `${t.schema}.${t.nome}`)).toEqual(["outro.pedidos"]);
  });

  it("colunas restritas escondem as outras — e a chave primária que ficou escondida", () => {
    const r = aplicarAoCatalogo(lista(f("public", "clientes", ["nome"])), CATALOGO);
    expect(r[0]?.colunas.map((c) => c.nome)).toEqual(["nome"]);
    expect(r[0]?.chavePrimaria).toEqual([]);
  });

  it("a descrição do administrador acompanha a tabela; descrição vazia não vira campo", () => {
    const r = aplicarAoCatalogo(lista(f("public", "clientes", null, "Quem compra de nós"), f("public", "pedidos")), CATALOGO);
    expect(r[0]?.descricao).toBe("Quem compra de nós");
    expect(r[1]).not.toHaveProperty("descricao");
  });

  it("fonte que sumiu do banco de origem é ignorada, sem erro", () => {
    const r = aplicarAoCatalogo(lista(f("public", "fantasma"), f("public", "clientes")), CATALOGO);
    expect(r.map((t) => t.nome)).toEqual(["clientes"]);
  });

  it("lista vazia em modo list não mostra nada", () => {
    expect(aplicarAoCatalogo(lista(), CATALOGO)).toEqual([]);
  });
});

describe("tabelaLiberada e colunasLiberadas", () => {
  it("all libera qualquer tabela; list só a marcada (nome EXATO)", () => {
    expect(tabelaLiberada(TUDO, "public", "qualquer")).toBe(true);
    expect(tabelaLiberada(lista(f("public", "clientes")), "public", "clientes")).toBe(true);
    expect(tabelaLiberada(lista(f("public", "clientes")), "public", "Clientes")).toBe(false);
    expect(tabelaLiberada(lista(f("public", "clientes")), "outro", "clientes")).toBe(false);
  });

  it("colunasLiberadas: tabela inexistente é null; all devolve todas; restrita devolve a interseção", () => {
    expect(colunasLiberadas(TUDO, null)).toBeNull();
    expect(colunasLiberadas(TUDO, CATALOGO[0]!)).toEqual(new Set(["id", "nome", "cpf"]));
    expect(colunasLiberadas(lista(f("public", "clientes", ["nome", "inexistente"])), CATALOGO[0]!)).toEqual(new Set(["nome"]));
    expect(colunasLiberadas(lista(f("public", "clientes")), CATALOGO[0]!)).toEqual(new Set(["id", "nome", "cpf"]));
  });

  it("tabela fora da lista tem conjunto null mesmo existindo no catálogo", () => {
    expect(colunasLiberadas(lista(f("public", "clientes")), CATALOGO[2]!)).toBeNull();
  });
});

describe("teto de bytes (espelha o CHECK do banco)", () => {
  const fonteCheia = (i: number, colunas: string[]): Fonte => ({
    schema: "s",
    tabela: `t${i}`,
    colunas,
    descricao: "",
  });

  it("tamanhoComoJsonb mede como o jsonb: espaço depois de cada ':' e ','", () => {
    // `[{"schema":"a","tabela":"b","colunas":null,"descricao":""}]` (59 bytes
    // pelo JSON.stringify) vira `[{"schema": "a", ... }]` (66 bytes) no
    // `jsonb::text` do Postgres: 4 ':' + 3 ',' = 7 espaços a mais.
    expect(tamanhoComoJsonb([{ schema: "a", tabela: "b", colunas: null, descricao: "" }])).toBe(66);
    expect(Buffer.byteLength(JSON.stringify([{ schema: "a", tabela: "b", colunas: null, descricao: "" }]), "utf8")).toBe(59);
  });

  it("acento conta como 2 bytes", () => {
    expect(tamanhoComoJsonb(["é"])).toBe(6); // `[` + `"é"` (1 + 2 + 1) + `]`
  });

  it("aceita lista logo abaixo de 256 KiB", () => {
    const abaixo = Array.from({ length: 9 }, (_, i) => fonteCheia(i, Array(200).fill("a".repeat(128))));
    expect(tamanhoComoJsonb(abaixo)).toBeLessThanOrEqual(MAX_BYTES_DAS_FONTES);
    expect(() => fontesSchema.parse(abaixo)).not.toThrow();
  });

  it("recusa lista logo acima de 256 KiB com mensagem em português", () => {
    const acima = Array.from({ length: 10 }, (_, i) => fonteCheia(i, Array(200).fill("a".repeat(128))));
    expect(tamanhoComoJsonb(acima)).toBeGreaterThan(MAX_BYTES_DAS_FONTES);
    const lido = fontesSchema.safeParse(acima);
    expect(lido.success).toBe(false);
    if (!lido.success) {
      expect(lido.error.issues.map((i) => i.message).join(" ")).toContain("256 KiB");
    }
  });

  it("mede como o jsonb, não como o JSON.stringify", () => {
    // 200 fontes × 200 colunas de "aaa": cada ':' e ',' estrutural ganha um
    // espaço no `jsonb::text` (~41 mil bytes a mais). O ingênuo passa, o
    // banco cortaria — o Zod tem de recusar.
    const lista = Array.from({ length: 200 }, (_, i) => fonteCheia(i, Array(200).fill("aaa")));
    const ingenua = Buffer.byteLength(JSON.stringify(lista), "utf8");
    expect(ingenua).toBeLessThanOrEqual(MAX_BYTES_DAS_FONTES);
    expect(tamanhoComoJsonb(lista)).toBeGreaterThan(MAX_BYTES_DAS_FONTES);
    expect(fontesSchema.safeParse(lista).success).toBe(false);
  });

  it("conta bytes, não caracteres: caracteres passam, bytes estouram", () => {
    // "é" tem 1 caractere e 2 bytes: 100 fontes × 22 colunas de 64 "é" cabem
    // com folga em 240000 caracteres (153091), mas passam com folga de 280000
    // bytes (296790). Medido por cálculo avulso, não por estimativa.
    const lista = Array.from({ length: 100 }, (_, i) => fonteCheia(i, Array(22).fill("é".repeat(64))));
    expect(JSON.stringify(lista).length).toBeLessThanOrEqual(240000);
    expect(tamanhoComoJsonb(lista)).toBeGreaterThanOrEqual(280000);
    expect(fontesSchema.safeParse(lista).success).toBe(false);
  });

  it("MAX_BYTES_DAS_FONTES é o número do CHECK da migration 0618", () => {
    const sql = readFileSync("supabase/migrations/20261009071741_0618_banco_externo_fontes_liberadas.sql", "utf8");
    const casou = /octet_length\(sources::text\)\s*<=\s*(\d+)/.exec(sql);
    expect(casou?.[1]).toBe(String(MAX_BYTES_DAS_FONTES));
  });
});
