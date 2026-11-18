import { logger } from "@/lib/logger";

/**
 * A folha de CSS personalizado que o layout raiz aplica, ou `null`.
 *
 * São DUAS folhas desde a #4463 — a do tema claro (chave `APP_CUSTOM_CSS`) e a do
 * escuro (`APP_CUSTOM_CSS_DARK`) —, e o layout recebe as duas num `<style>` só.
 * A do escuro sai prefixada com `:root:root[data-theme="dark"]`, então a ordem
 * entre elas não decide nada: cada uma casa com o seu tema.
 *
 * Se QUALQUER uma das duas estiver inválida, nenhuma é aplicada: meia folha
 * aprovada é pior que nenhuma, porque o cliente veria a marca pela metade e não
 * saberia qual dos dois campos corrigir.
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
    const { validacaoDoCssDaInstalacao, validacaoDoCssEscuroDaInstalacao } =
      await import("./css-personalizado");
    const [claro, escuro] = await Promise.all([
      validacaoDoCssDaInstalacao(),
      validacaoDoCssEscuroDaInstalacao(),
    ]);
    const invalida = [claro, escuro].find((validacao) => validacao.erro);
    if (invalida) {
      logger.warn("marca da instalação: CSS personalizado recusado; folha não aplicada", {
        codigo: "custom_css_invalid",
        escopo: invalida === claro ? "claro" : "escuro",
      });
      return null;
    }
    const partes = [claro.css, escuro.css].filter((css): css is string => Boolean(css));
    return partes.length > 0 ? partes.join("\n") : null;
  } catch (erro) {
    logger.warn("marca da instalação: CSS personalizado indisponível; folha não aplicada", {
      codigo: "custom_css_unavailable",
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}
