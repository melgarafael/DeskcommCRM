import { logger } from "@/lib/logger";

/**
 * A folha de CSS personalizado que o layout raiz aplica, ou `null`.
 *
 * NUNCA lança: roda em `app/layout.tsx`, e um throw ali é 500 em todas as
 * telas (CLAUDE.md › Marca própria). Por isso o validador entra por import
 * DINÂMICO dentro do `try`: ele traz o PostCSS, que é externo ao bundle do
 * Next — se o pacote faltar na imagem standalone, o efeito é a instalação
 * perder o CSS personalizado (com aviso no log), não perder as telas.
 */
export async function folhaPersonalizadaDaInstalacao(desligada: boolean): Promise<string | null> {
  if (desligada) return null;
  try {
    const { validacaoDoCssDaInstalacao } = await import("./css-personalizado");
    const validacao = await validacaoDoCssDaInstalacao();
    if (validacao.erro) {
      logger.warn("marca da instalação: CSS personalizado recusado; folha não aplicada", {
        codigo: "custom_css_invalid",
      });
      return null;
    }
    return validacao.css;
  } catch (erro) {
    logger.warn("marca da instalação: CSS personalizado indisponível; folha não aplicada", {
      codigo: "custom_css_unavailable",
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}
