/**
 * A FONTE DO CATÁLOGO POR FEED vista de fora (#3587, PR #4179; módulo
 * `catalogo_por_feed`, doc 322 A): o que a rota, o cron e a tela de Produtos
 * combinam sobre `catalog_feed_sources`.
 */

/**
 * O `ref_kind` do aviso da Central "o catálogo por feed não está sincronizando".
 * Um aviso aberto por organização: o cron abre na 3ª falha seguida e resolve na
 * primeira leitura que dá certo; a rota resolve quando a pessoa aplica o feed
 * pela tela.
 */
export const REF_DO_AVISO = "catalog_feed_source";

export interface ResumoDaFonte {
  criados: number;
  atualizados: number;
  desativados: number;
  erros: number;
}

const contagem = (valor: unknown): number =>
  typeof valor === "number" && Number.isFinite(valor) && valor >= 0 ? valor : 0;

/**
 * `ultimo_resumo` (jsonb) lido num lugar só. Quem grava são dois: o cron
 * (`ResultadoDaFonte`) e a rota (o resumo da aplicação) — os dois trazem estas
 * quatro contagens. Qualquer outra forma vira zero, nunca exceção na tela.
 */
export function resumoDaFonte(bruto: unknown): ResumoDaFonte | null {
  if (bruto === null || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const r = bruto as Record<string, unknown>;
  return {
    criados: contagem(r.criados),
    atualizados: contagem(r.atualizados),
    desativados: contagem(r.desativados),
    erros: contagem(r.erros),
  };
}
