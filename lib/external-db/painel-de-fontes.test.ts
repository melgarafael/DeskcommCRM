import { describe, expect, it } from "vitest";

import { MAX_COLUNAS_POR_FONTE, MAX_DESCRICAO, MAX_FONTES, type Fonte } from "./fontes";
import {
  alternarColuna,
  alternarTabela,
  colunasIniciais,
  contarLiberadas,
  definirDescricao,
  desmarcarVisiveis,
  estaMarcada,
  filtrarCatalogo,
  fontesNaoEncontradas,
  listaValida,
  marcarVisiveis,
  rascunhoMudou,
  tabelaSemColunaDoCliente,
  usarColunasMarcadas,
  usarTodasAsColunas,
  type TabelaDoCatalogo,
} from "./painel-de-fontes";

function tab(nome: string, colunas: string[], extra: Partial<TabelaDoCatalogo> = {}): TabelaDoCatalogo {
  return { schema: "public", nome, tipo: "tabela", colunas: colunas.map((c) => ({ nome: c })), ...extra };
}

const PEDIDOS = tab("pedidos", ["id", "telefone", "total"]);
const USUARIOS = tab("wp_users", ["id", "user_pass"]);
const VISAO = tab("v_pedidos", ["id", "total"], { tipo: "view" });

function fonte(t: TabelaDoCatalogo, extra: Partial<Fonte> = {}): Fonte {
  return { schema: t.schema, tabela: t.nome, colunas: t.colunas.map((c) => c.nome), descricao: "", ...extra };
}

describe("alternarTabela", () => {
  it("marca com TODAS as colunas explícitas e descrição vazia, e desmarca ao repetir", () => {
    const marcada = alternarTabela([], PEDIDOS, null);
    expect(marcada).toEqual([{ schema: "public", tabela: "pedidos", colunas: ["id", "telefone", "total"], descricao: "" }]);
    expect(estaMarcada(marcada, "public", "pedidos")).toBe(true);
    expect(alternarTabela(marcada, PEDIDOS, null)).toEqual([]);
  });

  it("não altera a lista recebida", () => {
    const original: Fonte[] = [fonte(PEDIDOS)];
    const copia = JSON.parse(JSON.stringify(original)) as Fonte[];
    alternarTabela(original, USUARIOS, null);
    alternarTabela(original, PEDIDOS, null);
    expect(original).toEqual(copia);
  });

  it("respeita o teto de fontes: a 201ª não entra", () => {
    const cheia = Array.from({ length: MAX_FONTES }, (_, i) => fonte(tab(`t${i}`, ["id"])));
    const depois = alternarTabela(cheia, USUARIOS, null);
    expect(depois).toHaveLength(MAX_FONTES);
    expect(estaMarcada(depois, "public", "wp_users")).toBe(false);
  });

  it("recusa tabela sem nenhuma coluna (lista vazia não existe)", () => {
    expect(alternarTabela([], tab("vazia", []), null)).toEqual([]);
  });
});

describe("colunasIniciais", () => {
  it("passa de 200 colunas: corta em 200 mas a coluna do cliente entra sempre", () => {
    const nomes = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const grande = tab("grande", nomes);
    const sem = colunasIniciais(grande, null);
    expect(sem).toHaveLength(MAX_COLUNAS_POR_FONTE);
    expect(sem).not.toContain("c249");
    const com = colunasIniciais(grande, "c249");
    expect(com).toHaveLength(MAX_COLUNAS_POR_FONTE);
    expect(com).toContain("c249");
  });
});

describe("alternarColuna", () => {
  it("desmarca e remarca mantendo a ordem do catálogo", () => {
    const l0 = [fonte(PEDIDOS)];
    const l1 = alternarColuna(l0, PEDIDOS, "telefone", null);
    expect(l1[0]!.colunas).toEqual(["id", "total"]);
    const l2 = alternarColuna(l1, PEDIDOS, "telefone", null);
    expect(l2[0]!.colunas).toEqual(["id", "telefone", "total"]);
  });

  it("a coluna do cliente NÃO se desmarca", () => {
    const l0 = [fonte(PEDIDOS)];
    const l1 = alternarColuna(l0, PEDIDOS, "telefone", "telefone");
    expect(l1[0]!.colunas).toEqual(["id", "telefone", "total"]);
  });

  it("a última coluna NÃO se desmarca (lista vazia não existe)", () => {
    const l0 = [fonte(PEDIDOS, { colunas: ["id"] })];
    expect(alternarColuna(l0, PEDIDOS, "id", null)[0]!.colunas).toEqual(["id"]);
  });

  it("coluna que não existe no catálogo é ignorada", () => {
    const l0 = [fonte(PEDIDOS, { colunas: ["id"] })];
    expect(alternarColuna(l0, PEDIDOS, "fantasma", null)[0]!.colunas).toEqual(["id"]);
  });

  it("a partir de `null` (todas) vira lista explícita ao desmarcar uma", () => {
    const l0 = [fonte(PEDIDOS, { colunas: null })];
    expect(alternarColuna(l0, PEDIDOS, "total", null)[0]!.colunas).toEqual(["id", "telefone"]);
  });

  it("tabela não marcada: nada muda", () => {
    expect(alternarColuna([], PEDIDOS, "id", null)).toEqual([]);
  });
});

describe("usarTodasAsColunas / usarColunasMarcadas", () => {
  it("`null` só por escolha: usarTodasAsColunas grava null; usarColunasMarcadas volta à lista explícita", () => {
    const l0 = [fonte(PEDIDOS, { colunas: ["id"] })];
    const l1 = usarTodasAsColunas(l0, "public", "pedidos");
    expect(l1[0]!.colunas).toBeNull();
    const l2 = usarColunasMarcadas(l1, PEDIDOS, "telefone");
    expect(l2[0]!.colunas).toEqual(["id", "telefone", "total"]);
  });

  it("usarColunasMarcadas não mexe em fonte que já é explícita", () => {
    const l0 = [fonte(PEDIDOS, { colunas: ["id"] })];
    expect(usarColunasMarcadas(l0, PEDIDOS, null)[0]!.colunas).toEqual(["id"]);
  });
});

describe("definirDescricao", () => {
  it("corta no teto e só mexe na fonte certa", () => {
    const l0 = [fonte(PEDIDOS), fonte(USUARIOS)];
    const l1 = definirDescricao(l0, "public", "pedidos", "x".repeat(MAX_DESCRICAO + 50));
    expect(l1[0]!.descricao).toHaveLength(MAX_DESCRICAO);
    expect(l1[1]!.descricao).toBe("");
  });
});

describe("marcarVisiveis / desmarcarVisiveis", () => {
  it("marca só as ausentes, conta o que não coube, e desmarca só as visíveis", () => {
    const l0 = [fonte(PEDIDOS)];
    const r = marcarVisiveis(l0, [PEDIDOS, VISAO, tab("vazia", [])], null);
    expect(r.lista.map((f) => f.tabela)).toEqual(["pedidos", "v_pedidos"]);
    expect(r.cortadas).toBe(1);
    const depois = desmarcarVisiveis([...r.lista, fonte(USUARIOS)], [PEDIDOS, VISAO]);
    expect(depois.map((f) => f.tabela)).toEqual(["wp_users"]);
  });
});

describe("filtrarCatalogo", () => {
  const todas = [PEDIDOS, USUARIOS, VISAO];
  it("busca por trecho de schema.nome sem diferenciar caixa, e filtra só views", () => {
    expect(filtrarCatalogo(todas, { busca: "  WP_", soViews: false }).map((t) => t.nome)).toEqual(["wp_users"]);
    expect(filtrarCatalogo(todas, { busca: "public.ped", soViews: false }).map((t) => t.nome)).toEqual(["pedidos"]);
    expect(filtrarCatalogo(todas, { busca: "", soViews: true }).map((t) => t.nome)).toEqual(["v_pedidos"]);
    expect(filtrarCatalogo(todas, { busca: "", soViews: false })).toHaveLength(3);
  });
});

describe("fontesNaoEncontradas / contarLiberadas", () => {
  it("fonte que sumiu do catálogo é listada e não conta como liberada", () => {
    const lista = [fonte(PEDIDOS), { schema: "public", tabela: "apagada", colunas: ["id"], descricao: "" }];
    expect(fontesNaoEncontradas(lista, [PEDIDOS, USUARIOS]).map((f) => f.tabela)).toEqual(["apagada"]);
    expect(contarLiberadas(lista, [PEDIDOS, USUARIOS])).toEqual({ liberadas: 1, total: 2 });
  });
});

describe("rascunhoMudou", () => {
  const salvo = { modo: "list" as const, fontes: [fonte(PEDIDOS, { descricao: "a" })] };
  it("igual, mesmo com as chaves do objeto em outra ordem, não mudou", () => {
    const outraOrdem: Fonte = { descricao: "a", colunas: ["id", "telefone", "total"], tabela: "pedidos", schema: "public" };
    expect(rascunhoMudou(salvo, { modo: "list", fontes: [outraOrdem] })).toBe(false);
  });
  it("muda o modo, a descrição, as colunas (lista × null) ou a ordem das fontes → mudou", () => {
    expect(rascunhoMudou(salvo, { modo: "all", fontes: salvo.fontes })).toBe(true);
    expect(rascunhoMudou(salvo, { modo: "list", fontes: [fonte(PEDIDOS, { descricao: "b" })] })).toBe(true);
    expect(rascunhoMudou(salvo, { modo: "list", fontes: [fonte(PEDIDOS, { descricao: "a", colunas: null })] })).toBe(true);
    const dois = { modo: "list" as const, fontes: [fonte(PEDIDOS), fonte(USUARIOS)] };
    expect(rascunhoMudou(dois, { modo: "list", fontes: [fonte(USUARIOS), fonte(PEDIDOS)] })).toBe(true);
  });
});

describe("listaValida", () => {
  it("aceita lista boa; recusa descrição longa, fonte repetida e colunas vazias", () => {
    expect(listaValida([fonte(PEDIDOS)])).toBe(true);
    expect(listaValida([fonte(PEDIDOS, { descricao: "x".repeat(MAX_DESCRICAO + 1) })])).toBe(false);
    expect(listaValida([fonte(PEDIDOS), fonte(PEDIDOS)])).toBe(false);
    expect(listaValida([fonte(PEDIDOS, { colunas: [] })])).toBe(false);
  });
});

describe("tabelaSemColunaDoCliente", () => {
  it("só avisa quando a coluna do cliente existe na conexão mas não na tabela", () => {
    expect(tabelaSemColunaDoCliente(USUARIOS, "telefone")).toBe(true);
    expect(tabelaSemColunaDoCliente(PEDIDOS, "telefone")).toBe(false);
    expect(tabelaSemColunaDoCliente(USUARIOS, null)).toBe(false);
  });
});
