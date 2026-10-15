/**
 * LÓGICA PURA do painel "O que o assistente pode ver" (Fatia 2b).
 *
 * Nada aqui importa React nem fala com a rede: o painel (`PainelDeFontes.tsx`)
 * guarda um RASCUNHO (`{ modo, fontes }`) e cada gesto da pessoa vira uma destas
 * funções, que devolvem uma lista NOVA (a recebida nunca é alterada). O formato
 * da lista e os tetos moram em `./fontes` — este arquivo só os respeita.
 *
 * Três regras que a tela herda da spec:
 *   1. Marcar uma tabela grava as colunas EXPLÍCITAS (a lista de nomes de hoje).
 *      `colunas: null` ("todas, inclusive as futuras") só por escolha consciente.
 *   2. A coluna que identifica o cliente nas conversas (#2280) fica sempre
 *      liberada: sem ela, conversar com a tabela dá erro sempre.
 *   3. Lista vazia de colunas não existe, e a lista nunca passa dos tetos.
 */
import { MAX_COLUNAS_POR_FONTE, MAX_DESCRICAO, MAX_FONTES, fontesSchema, type Fonte } from "./fontes";

/** O que o painel precisa saber de uma tabela do catálogo (a `TabelaExterna` do servidor cabe aqui). */
export interface TabelaDoCatalogo {
  schema: string;
  nome: string;
  tipo: "tabela" | "view" | "outro";
  colunas: ReadonlyArray<{ nome: string }>;
}

function chave(schema: string, tabela: string): string {
  return `${schema}\u0000${tabela}`;
}

export function indiceDaFonte(lista: readonly Fonte[], schema: string, tabela: string): number {
  return lista.findIndex((f) => f.schema === schema && f.tabela === tabela);
}

export function estaMarcada(lista: readonly Fonte[], schema: string, tabela: string): boolean {
  return indiceDaFonte(lista, schema, tabela) >= 0;
}

/**
 * Colunas de uma fonte nova: todas, na ordem do catálogo. Acima do teto, corta —
 * mas a coluna do cliente entra sempre.
 */
export function colunasIniciais(tabela: TabelaDoCatalogo, colunaDoCliente: string | null): string[] {
  const nomes = tabela.colunas.map((c) => c.nome);
  if (nomes.length <= MAX_COLUNAS_POR_FONTE) return nomes;
  const corte = nomes.slice(0, MAX_COLUNAS_POR_FONTE);
  if (colunaDoCliente !== null && nomes.includes(colunaDoCliente) && !corte.includes(colunaDoCliente)) {
    return [...corte.slice(0, MAX_COLUNAS_POR_FONTE - 1), colunaDoCliente];
  }
  return corte;
}

/** Marca (com todas as colunas explícitas) ou desmarca. Respeita o teto e recusa tabela sem colunas. */
export function alternarTabela(
  lista: readonly Fonte[],
  tabela: TabelaDoCatalogo,
  colunaDoCliente: string | null,
): Fonte[] {
  const i = indiceDaFonte(lista, tabela.schema, tabela.nome);
  if (i >= 0) return lista.filter((_, k) => k !== i);
  if (lista.length >= MAX_FONTES) return [...lista];
  const colunas = colunasIniciais(tabela, colunaDoCliente);
  if (colunas.length === 0) return [...lista];
  return [...lista, { schema: tabela.schema, tabela: tabela.nome, colunas, descricao: "" }];
}

/**
 * Liga/desliga UMA coluna de uma fonte já marcada. Recusa (devolve a lista como
 * está) desligar a coluna do cliente ou a última coluna. A partir de `null`
 * ("todas") a fonte vira lista explícita.
 */
export function alternarColuna(
  lista: readonly Fonte[],
  tabela: TabelaDoCatalogo,
  coluna: string,
  colunaDoCliente: string | null,
): Fonte[] {
  const i = indiceDaFonte(lista, tabela.schema, tabela.nome);
  if (i < 0) return [...lista];
  const f = lista[i]!;
  const todas = tabela.colunas.map((c) => c.nome);
  const atuais = new Set(f.colunas ?? todas);
  if (atuais.has(coluna)) {
    if (coluna === colunaDoCliente) return [...lista];
    if (atuais.size <= 1) return [...lista];
    atuais.delete(coluna);
  } else {
    if (!todas.includes(coluna)) return [...lista];
    if (atuais.size >= MAX_COLUNAS_POR_FONTE) return [...lista];
    atuais.add(coluna);
  }
  const colunas = todas.filter((nome) => atuais.has(nome));
  return lista.map((x, k) => (k === i ? { ...x, colunas } : x));
}

/** Escolha consciente: "todas, inclusive as que forem criadas depois". */
export function usarTodasAsColunas(lista: readonly Fonte[], schema: string, tabela: string): Fonte[] {
  return lista.map((f) => (f.schema === schema && f.tabela === tabela ? { ...f, colunas: null } : f));
}

/** Volta de `null` para a lista explícita (todas as colunas de hoje). Fonte que já é explícita não muda. */
export function usarColunasMarcadas(
  lista: readonly Fonte[],
  tabela: TabelaDoCatalogo,
  colunaDoCliente: string | null,
): Fonte[] {
  return lista.map((f) =>
    f.schema === tabela.schema && f.tabela === tabela.nome && f.colunas === null
      ? { ...f, colunas: colunasIniciais(tabela, colunaDoCliente) }
      : f,
  );
}

export function definirDescricao(lista: readonly Fonte[], schema: string, tabela: string, texto: string): Fonte[] {
  const descricao = texto.slice(0, MAX_DESCRICAO);
  return lista.map((f) => (f.schema === schema && f.tabela === tabela ? { ...f, descricao } : f));
}

/** "Marcar todas as visíveis": lista EXPLÍCITA (não é o modo `all`). `cortadas` = as que não couberam. */
export function marcarVisiveis(
  lista: readonly Fonte[],
  visiveis: readonly TabelaDoCatalogo[],
  colunaDoCliente: string | null,
): { lista: Fonte[]; cortadas: number } {
  let atual: Fonte[] = [...lista];
  let cortadas = 0;
  for (const tabela of visiveis) {
    if (estaMarcada(atual, tabela.schema, tabela.nome)) continue;
    const depois = alternarTabela(atual, tabela, colunaDoCliente);
    if (depois.length === atual.length) {
      cortadas += 1;
      continue;
    }
    atual = depois;
  }
  return { lista: atual, cortadas };
}

export function desmarcarVisiveis(lista: readonly Fonte[], visiveis: readonly TabelaDoCatalogo[]): Fonte[] {
  const fora = new Set(visiveis.map((t) => chave(t.schema, t.nome)));
  return lista.filter((f) => !fora.has(chave(f.schema, f.tabela)));
}

export function filtrarCatalogo<T extends TabelaDoCatalogo>(
  catalogo: readonly T[],
  filtro: { busca: string; soViews: boolean },
): T[] {
  const termo = filtro.busca.trim().toLowerCase();
  return catalogo.filter((t) => {
    if (filtro.soViews && t.tipo !== "view") return false;
    if (termo === "") return true;
    return `${t.schema}.${t.nome}`.toLowerCase().includes(termo);
  });
}

/** Fontes marcadas que não existem mais no catálogo do banco de origem. */
export function fontesNaoEncontradas(lista: readonly Fonte[], catalogo: readonly TabelaDoCatalogo[]): Fonte[] {
  const existentes = new Set(catalogo.map((t) => chave(t.schema, t.nome)));
  return lista.filter((f) => !existentes.has(chave(f.schema, f.tabela)));
}

export function contarLiberadas(
  lista: readonly Fonte[],
  catalogo: readonly TabelaDoCatalogo[],
): { liberadas: number; total: number } {
  const existentes = new Set(catalogo.map((t) => chave(t.schema, t.nome)));
  return {
    liberadas: lista.filter((f) => existentes.has(chave(f.schema, f.tabela))).length,
    total: catalogo.length,
  };
}

function colunasIguais(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((nome, i) => nome === b[i]);
}

/** Compara campo a campo (não por `JSON.stringify`, que depende da ordem das chaves). A ORDEM das fontes conta. */
export function rascunhoMudou(
  salvo: { modo: string; fontes: readonly Fonte[] },
  rascunho: { modo: string; fontes: readonly Fonte[] },
): boolean {
  if (salvo.modo !== rascunho.modo) return true;
  if (salvo.fontes.length !== rascunho.fontes.length) return true;
  return salvo.fontes.some((a, i) => {
    const b = rascunho.fontes[i]!;
    return a.schema !== b.schema || a.tabela !== b.tabela || a.descricao !== b.descricao || !colunasIguais(a.colunas, b.colunas);
  });
}

/** A lista passaria no `PUT`? (mesmo esquema do servidor) */
export function listaValida(lista: readonly Fonte[]): boolean {
  return fontesSchema.safeParse(lista).success;
}

/** Aviso (nunca bloqueio): a conexão filtra por cliente, mas esta tabela não tem a coluna. */
export function tabelaSemColunaDoCliente(tabela: TabelaDoCatalogo, colunaDoCliente: string | null): boolean {
  if (colunaDoCliente === null) return false;
  return !tabela.colunas.some((c) => c.nome === colunaDoCliente);
}
