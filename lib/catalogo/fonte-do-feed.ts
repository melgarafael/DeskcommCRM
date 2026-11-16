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

/** O que a tela de Produtos recebe da fonte desta empresa. */
export interface FonteDoFeedNaTela {
  /** Inteira para `manager`+; abaixo disso, só o host (`loja.com.br/…`). */
  url: string;
  formato: "json" | "csv";
  /** Já formatada no idioma de quem lê; `null` = nunca leu. */
  ultimaLeitura: string | null;
  resumo: ResumoDaFonte | null;
  falhasSeguidas: number;
  ultimoErro: string | null;
}

/**
 * Só o host: a URL do feed costuma levar o token de acesso do sistema da
 * revenda (`?token=…`, caminho com chave), e quem atende não precisa dele para
 * saber de onde o catálogo vem. `URL.host` já deixa de fora `usuario:senha@`.
 */
export function urlMascarada(url: string): string {
  try {
    return `${new URL(url).host}/…`;
  } catch {
    return "…";
  }
}

/**
 * A linha de `catalog_feed_sources` no formato da tela. A máscara mora AQUI,
 * no servidor, e não no componente: esconder no navegador ainda entregaria a
 * URL inteira no payload da página. A RLS segue deixando a empresa toda LER a
 * linha (decisão do contribuidor, mantida); o que muda é o que a tela entrega.
 */
export function fonteDoFeedNaTela(
  linha: {
    url: string;
    formato: string;
    ultima_leitura_em: string | null;
    ultimo_resumo: unknown;
    falhas_seguidas: number;
    ultimo_erro: string | null;
  },
  opcoes: { podeVerUrl: boolean; formatarData: (iso: string) => string },
): FonteDoFeedNaTela {
  return {
    url: opcoes.podeVerUrl ? linha.url : urlMascarada(linha.url),
    formato: linha.formato === "csv" ? "csv" : "json",
    ultimaLeitura: linha.ultima_leitura_em ? opcoes.formatarData(linha.ultima_leitura_em) : null,
    resumo: resumoDaFonte(linha.ultimo_resumo),
    falhasSeguidas: linha.falhas_seguidas,
    ultimoErro: linha.ultimo_erro,
  };
}
