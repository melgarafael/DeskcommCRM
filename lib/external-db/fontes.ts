/**
 * FONTES LIBERADAS — o que o assistente e a grade podem ler de uma conexão.
 *
 * Duas coisas moram aqui, e só aqui:
 *   1. o ESQUEMA do que se guarda em `external_db_connections.sources` (jsonb).
 *      Anti-padrão 6 do CLAUDE.md é "jsonb lock-in: a UI lê caminho solto";
 *      este arquivo é o esquema central — quem lê ou escreve a lista passa por ele.
 *   2. as funções PURAS que decidem o que é visível. O núcleo (o `Dialeto`)
 *      aplica estas funções em UM lugar; nenhuma tool nem rota decide visibilidade
 *      por conta própria.
 *
 * ─── Falha fechada ──────────────────────────────────────────────────────────
 * O que vem do banco é validado aqui. Lista corrompida NUNCA vira "tudo
 * liberado": `lerFontesDoBanco` devolve `{ ok: false }` e o chamador trata como
 * lista VAZIA (nada visível).
 *
 * ─── Nomes exatos ───────────────────────────────────────────────────────────
 * A lista guarda os nomes REAIS do catálogo (a tela marca a partir do catálogo
 * ao vivo), então a comparação é exata. Fonte que sumiu do banco de origem é
 * ignorada, sem erro; a tela a sinaliza.
 */
import { z } from "zod";

import type { ModoDeFontes, TabelaExterna } from "./types";

/** Espelha o CHECK de `external_db_connections.source_mode` e `ModoDeFontes`. */
export const MODOS_DE_FONTES = ["all", "list"] as const satisfies readonly ModoDeFontes[];

export const MAX_FONTES = 200;
export const MAX_COLUNAS_POR_FONTE = 200;
export const MAX_DESCRICAO = 300;

export const fonteSchema = z
  .object({
    schema: z.string().trim().min(1).max(128),
    tabela: z.string().trim().min(1).max(128),
    /** `null` = todas as colunas visíveis ao usuário do banco; lista vazia não existe. */
    colunas: z.array(z.string().trim().min(1).max(128)).min(1).max(MAX_COLUNAS_POR_FONTE).nullable(),
    descricao: z.string().trim().max(MAX_DESCRICAO),
  })
  .strict();

export const fontesSchema = z
  .array(fonteSchema)
  .max(MAX_FONTES)
  .superRefine((fontes, ctx) => {
    const vistas = new Set<string>();
    fontes.forEach((fonte, indice) => {
      const chave = `${fonte.schema}\u0000${fonte.tabela}`;
      if (vistas.has(chave)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [indice],
          message: "fonte repetida (mesmo schema e mesma tabela)",
        });
      }
      vistas.add(chave);
    });
  });

export type Fonte = z.infer<typeof fonteSchema>;

export interface RegraDeFontes {
  modo: ModoDeFontes;
  fontes: readonly Fonte[];
}

/** Interpreta o que veio do banco. Falha FECHADA: lixo é `{ ok: false }`. */
export function lerFontesDoBanco(bruto: unknown): { ok: true; fontes: Fonte[] } | { ok: false } {
  const lido = fontesSchema.safeParse(bruto);
  return lido.success ? { ok: true, fontes: lido.data } : { ok: false };
}

function fonteDe(regra: RegraDeFontes, schema: string, tabela: string): Fonte | undefined {
  return regra.fontes.find((f) => f.schema === schema && f.tabela === tabela);
}

/** Esta tabela pode ser lida? `all` libera qualquer uma; `list` só a marcada. */
export function tabelaLiberada(regra: RegraDeFontes, schema: string, tabela: string): boolean {
  return regra.modo === "all" || fonteDe(regra, schema, tabela) !== undefined;
}

/**
 * O catálogo como o assistente e a grade o veem. Em `list`, só as fontes
 * marcadas, NA ORDEM DA LISTA, com a descrição do administrador e só as colunas
 * liberadas.
 */
export function aplicarAoCatalogo(regra: RegraDeFontes, tabelas: TabelaExterna[]): TabelaExterna[] {
  if (regra.modo === "all") return tabelas;

  const visiveis: TabelaExterna[] = [];
  for (const fonte of regra.fontes) {
    const real = tabelas.find((t) => t.schema === fonte.schema && t.nome === fonte.tabela);
    if (!real) continue; // sumiu do banco de origem: ignorada, sem erro

    const colunas = fonte.colunas === null ? real.colunas : real.colunas.filter((c) => fonte.colunas!.includes(c.nome));
    const visiveisPorNome = new Set(colunas.map((c) => c.nome));
    visiveis.push({
      ...real,
      colunas,
      // Uma coluna de chave escondida não pode vazar o NOME por aqui.
      chavePrimaria: real.chavePrimaria.filter((c) => visiveisPorNome.has(c)),
      ...(fonte.descricao ? { descricao: fonte.descricao } : {}),
    });
  }
  return visiveis;
}

/**
 * As colunas que podem ser usadas em projeção, FILTRO e ORDENAÇÃO. `null` quando
 * a tabela não existe OU não foi liberada — o chamador não distingue (e não
 * revela) uma coisa da outra.
 *
 * Filtro e ordenação contam como "uso": filtrar ou ordenar por uma coluna
 * escondida deixaria o assistente descobrir o conteúdo dela por tentativa.
 */
export function colunasLiberadas(regra: RegraDeFontes, tabela: TabelaExterna | null): Set<string> | null {
  if (tabela === null) return null;
  const real = new Set(tabela.colunas.map((c) => c.nome));
  if (regra.modo === "all") return real;

  const fonte = fonteDe(regra, tabela.schema, tabela.nome);
  if (!fonte) return null;
  if (fonte.colunas === null) return real;
  return new Set(fonte.colunas.filter((c) => real.has(c)));
}
