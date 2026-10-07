import postcss, { type Root } from "postcss";

import { valorDaInstalacao } from "@/lib/instalacao/config";

export const CHAVE_CSS_PERSONALIZADO = "APP_CUSTOM_CSS";
export const CSS_PERSONALIZADO_MAX_BYTES = 16 * 1024;

const TTL_MEMO_MS = 30_000;
/**
 * O que FECHA a exfiltração por CSS é esta lista, e não o filtro de funções:
 * nenhuma propriedade daqui aceita `<image>` ou `<url>` (não há `background`,
 * `background-image`, `border-image`, `list-style`, `cursor`, `mask`, `filter`
 * nem `content`). Ampliar a lista exige rever essa pergunta para a propriedade
 * nova; `tests/unit/css-personalizado-marca.test.ts` reprova a ampliação até a
 * lista revisada de lá ser atualizada junto.
 */
export const PROPRIEDADES_VISUAIS: ReadonlySet<string> = new Set([
  "color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-width",
  "border-style",
  "box-shadow",
  "outline-color",
  "outline-width",
  "outline-style",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "text-transform",
  "text-underline-offset",
]);

const PARTE_DO_SELETOR = String.raw`(?:\.[A-Za-z_][A-Za-z0-9_-]*)+(?::(?:hover|focus|focus-visible|active|disabled|checked|first-child|last-child))*`;
const SELETOR_VISUAL = new RegExp(
  `^${PARTE_DO_SELETOR}(?:(?:\\s+|\\s*>\\s*)${PARTE_DO_SELETOR})*$`,
);
const VALOR_CSS_SEGURO = /^[#A-Za-z0-9_.,%() "'/+\-]+$/;
/**
 * Lista do que PODE, e não do que não pode: uma lista de bloqueio deixava passar
 * `src()`, `paint()` e `-moz-element()`, que carregam recurso. Toda função do
 * valor tem de estar aqui; parêntese sem nome (agrupamento dentro de `calc`)
 * passa.
 */
const FUNCOES_PERMITIDAS = new Set(["rgb", "rgba", "hsl", "hsla", "var", "calc", "min", "max", "clamp"]);
const CHAMADA_DE_FUNCAO = /([A-Za-z0-9_-]*)\s*\(/g;
const CARACTERES_NAO_PERMITIDOS = /[\\<\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

type ResultadoCss = {
  readonly css: string | null;
  readonly erro: string | null;
  readonly regras: number;
  readonly declaracoes: number;
};

export type ValidacaoCssPersonalizado = ResultadoCss;

function soFuncoesPermitidas(valor: string): boolean {
  for (const [, nome = ""] of valor.matchAll(CHAMADA_DE_FUNCAO)) {
    if (nome !== "" && !FUNCOES_PERMITIDAS.has(nome.toLowerCase())) return false;
  }
  return true;
}

function recusar(erro: string): ResultadoCss {
  return { css: null, erro, regras: 0, declaracoes: 0 };
}

/**
 * CSS de marca deliberadamente limitado a seletores de classes e propriedades
 * visuais. Não aceita código, regras de layout que ocultem controles, at-rules,
 * recursos remotos, escapes ou conteúdo capaz de sair da tag `<style>`.
 */
export function validarCssPersonalizado(entrada: string): ResultadoCss {
  const fonte = entrada.trim();
  if (!fonte) return { css: null, erro: null, regras: 0, declaracoes: 0 };
  if (new TextEncoder().encode(fonte).byteLength > CSS_PERSONALIZADO_MAX_BYTES) {
    return recusar("O CSS passou do limite de 16 KB.");
  }
  if (CARACTERES_NAO_PERMITIDOS.test(fonte)) {
    return recusar("Remova escapes, caracteres de controle e sinais de HTML (< ou >).");
  }

  // Antes do parse, e no texto inteiro: dentro do valor ou do seletor o PostCSS
  // não cria nó de comentário — esconde o texto cru em `raws`, e é o cru que
  // sai no `toString()`.
  if (fonte.includes("/*")) {
    return recusar("Use apenas regras CSS simples; comentários e diretivas @ não são aceitos.");
  }

  let raiz: Root;
  try {
    raiz = postcss.parse(fonte, { from: undefined });
  } catch {
    return recusar("O CSS tem sintaxe inválida. Confira chaves, seletores e declarações.");
  }

  let regras = 0;
  let declaracoes = 0;
  let erro: string | null = null;

  raiz.each((no) => {
    if (no.type !== "rule") {
      erro = "Use apenas regras CSS simples; comentários e diretivas @ não são aceitos.";
      return false;
    }
    regras += 1;
    if (regras > 100) {
      erro = "O CSS pode ter no máximo 100 regras.";
      return false;
    }

    const seletores = no.selector.split(",").map((seletor) => seletor.trim());
    if (seletores.length === 0 || seletores.some((seletor) => !SELETOR_VISUAL.test(seletor))) {
      erro =
        "Use seletores formados por classes, como .text-muted-foreground ou .rounded-md:hover.";
      return false;
    }

    if (no.nodes.length === 0) {
      erro = "Cada regra precisa ter ao menos uma declaração visual.";
      return false;
    }
    for (const filho of no.nodes) {
      if (filho.type !== "decl") {
        erro = "Regras aninhadas e comentários não são aceitos.";
        return false;
      }
      declaracoes += 1;
      if (declaracoes > 500) {
        erro = "O CSS pode ter no máximo 500 declarações.";
        return false;
      }
      if (!PROPRIEDADES_VISUAIS.has(filho.prop.toLowerCase())) {
        erro = "Essa propriedade não é permitida; use apenas propriedades visuais.";
        return false;
      }
      if (
        filho.important ||
        !VALOR_CSS_SEGURO.test(filho.value) ||
        !soFuncoesPermitidas(filho.value)
      ) {
        erro = "Valor CSS recusado. URLs, funções dinâmicas e !important não são permitidos.";
        return false;
      }
      if (filho.value.length > 256) {
        erro = "Cada valor CSS pode ter no máximo 256 caracteres.";
        return false;
      }
    }
    if (erro !== null) return false;
  });

  if (erro) return recusar(erro);
  if (regras === 0) return recusar("Informe ao menos uma regra CSS.");

  // A especificidade reforçada deixa os ajustes visuais da instalação vencerem
  // utilitários de tema sem depender da ordem dos estilos emitidos pelo Next.
  raiz.walkRules((regra) => {
    regra.selector = regra.selector
      .split(",")
      .map((seletor) => `:root:root ${seletor.trim()}`)
      .join(", ");
  });

  return { css: raiz.toString(), erro: null, regras, declaracoes };
}

type CacheCss = {
  readonly valor: string;
  readonly validacao: ResultadoCss;
  readonly expiraEm: number;
};
type EstadoGlobal = typeof globalThis & {
  __cssPersonalizadoDaInstalacao?: CacheCss;
  __geracaoCssPersonalizadoDaInstalacao?: number;
};

/**
 * Leitura memoizada: a folha é aplicada em toda rota, mas lida do banco poucas
 * vezes. O memo guarda o resultado VALIDADO junto com o texto — o layout raiz
 * pede a folha em toda tela, e o parse roda uma vez por leitura do banco.
 */
async function lerDaInstalacao(): Promise<CacheCss> {
  const global = globalThis as EstadoGlobal;
  const atual = global.__cssPersonalizadoDaInstalacao;
  if (atual && atual.expiraEm > Date.now()) return atual;

  const geracao = global.__geracaoCssPersonalizadoDaInstalacao ?? 0;
  const { valor } = await valorDaInstalacao(CHAVE_CSS_PERSONALIZADO);
  const css = valor ?? "";
  const lido: CacheCss = {
    valor: css,
    validacao: validarCssPersonalizado(css),
    expiraEm: Date.now() + TTL_MEMO_MS,
  };
  if ((global.__geracaoCssPersonalizadoDaInstalacao ?? 0) === geracao) {
    global.__cssPersonalizadoDaInstalacao = lido;
  }
  return lido;
}

/** O texto gravado, como o administrador escreveu (o editor de `/admin/marca`). */
export async function cssPersonalizadoDaInstalacao(): Promise<string> {
  return (await lerDaInstalacao()).valor;
}

/** A folha gravada, já validada e escopada — o que o layout raiz aplica. */
export async function validacaoDoCssDaInstalacao(): Promise<ResultadoCss> {
  return (await lerDaInstalacao()).validacao;
}

export function invalidarCssPersonalizadoDaInstalacao(): void {
  const global = globalThis as EstadoGlobal;
  global.__geracaoCssPersonalizadoDaInstalacao =
    (global.__geracaoCssPersonalizadoDaInstalacao ?? 0) + 1;
  delete global.__cssPersonalizadoDaInstalacao;
}
