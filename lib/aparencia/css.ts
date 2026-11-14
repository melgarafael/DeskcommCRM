/**
 * O CSS DE UM TEMPLATE — tokens do produto e da casca, escopados pelo id.
 *
 * ── Escopo: o template só pinta quem o carrega ─────────────────────────────
 *
 * Dois escopos, e os dois carregam o id do template em TODO seletor
 * (`aparencia.test.ts` reprova o que não carregar):
 *
 *  - `escopoDoTemplate(id)` → `body:has([data-aparencia="id"])` e o par escuro.
 *    É o que pinta o `/app` da organização. O marcador vive DENTRO do `<body>`
 *    (`app/app/layout.tsx`), e o escopo é o `body` — não o marcador — porque
 *    modal, menu suspenso e toast nascem em portal, fora dele.
 *  - `escopoDaAmostra(id)` → um elemento com `data-aparencia-amostra="id"` e
 *    `data-aparencia-modo`. É a miniatura da galeria: o modo vem do atributo e
 *    não do `<html>`, para a tela mostrar claro e escuro lado a lado.
 *
 * ── A cor de ação passa pelo gerador da marca ──────────────────────────────
 *
 * O template declara só a SEMENTE (`acento`). A rampa de 11 paradas, os papéis
 * (`--color-accent`, `-fg`, `-soft`, `-hover`) e o texto por cima saem de
 * `resolverMarca` + `cssDaMarca`, com a régua do produto trocando só as três
 * superfícies de base pelas do template — então o contraste é conferido contra
 * o fundo em que a cor vai de fato aparecer.
 *
 * `incluirAcento: false` existe para a organização que definiu a PRÓPRIA cor
 * na tela Marca: a cor da empresa vence a do template, sempre.
 */

import { luminanciaRelativa } from "@/lib/branding/contraste";
import { cssDaMarca, escopoDeAparencia, type EscopoDeAparencia } from "@/lib/branding/css";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { camadaDaOrganizacao, resolverMarca } from "@/lib/branding/resolve";
import type { Regua } from "@/lib/branding/contraste";

import { logger } from "@/lib/logger";

import { cssDaCorSecundaria, type Aparencia } from "./ajustes";
import { templatePorId, type CoresDoModo, type Template } from "./catalogo";
import { FONTES } from "./fontes";

export type EscopoDaAparencia = EscopoDeAparencia;

/** O escopo que pinta o `/app` da organização que escolheu o template. */
export function escopoDoTemplate(id: string): EscopoDaAparencia {
  return escopoDeAparencia("sistema", id);
}

/** O escopo da miniatura da galeria. */
export function escopoDaAmostra(id: string): EscopoDaAparencia {
  return escopoDeAparencia("amostra", id);
}

type Declaracao = readonly [string, string];

function declaracoesDoModo(t: Template, c: CoresDoModo): Declaracao[] {
  const f = t.forma;
  return [
    ["--color-bg", c.fundo],
    ["--color-surface", c.superficie],
    ["--color-surface-elevated", c.elevada],
    ["--color-text", c.texto],
    ["--color-text-muted", c.textoSuave],
    ["--color-text-subtle", c.textoSutil],
    ["--color-border", c.borda],
    ["--color-border-strong", c.bordaForte],
    // Os aliases shadcn são declarados no `:root` como `var(--color-…)`, e
    // custom property resolve ONDE é declarada: sem repeti-los aqui, quem lê
    // `var(--card)` continuaria vendo a superfície de fábrica.
    ["--background", "var(--color-bg)"],
    ["--foreground", "var(--color-text)"],
    ["--card", "var(--color-surface)"],
    ["--card-foreground", "var(--color-text)"],
    ["--popover", "var(--color-surface)"],
    ["--popover-foreground", "var(--color-text)"],
    ["--secondary", "var(--color-surface-elevated)"],
    ["--secondary-foreground", "var(--color-text)"],
    ["--muted", "var(--color-surface-elevated)"],
    ["--muted-foreground", "var(--color-text-muted)"],
    ["--border", "var(--color-border)"],
    ["--input", "var(--color-border)"],
    ["--radius-sm", f.raios[0]],
    ["--radius-md", f.raios[1]],
    ["--radius-lg", f.raios[2]],
    ["--radius-xl", f.raios[3]],
    ["--radius", "var(--radius-md)"],
    ["--shadow-xs", c.sombras[0]],
    ["--shadow-sm", c.sombras[1]],
    ["--shadow-md", c.sombras[2]],
    ["--shadow-lg", c.sombras[3]],
    ["--shadow-xl", c.sombras[4]],
    ["--aparencia-fonte-texto", FONTES[t.fonteTexto].pilha],
    ["--aparencia-fonte-titulo", FONTES[t.fonteTitulo].pilha],
    ["--aparencia-titulo-peso", f.tituloPeso],
    ["--aparencia-titulo-espaco", f.tituloEspaco],
    ["--aparencia-casca", c.casca],
    ["--aparencia-casca-sutil", c.cascaSutil],
    ["--aparencia-conteudo", c.conteudo],
    ["--aparencia-conteudo-sombra", c.conteudoSombra],
    ["--aparencia-conteudo-respiro", f.conteudoRespiro],
    ["--aparencia-conteudo-raio", f.conteudoRaio],
    ["--aparencia-topo", c.topo],
    ["--aparencia-menu-fundo", c.menu.fundo],
    ["--aparencia-menu-fundo-solido", c.menu.fundoSolido],
    ["--aparencia-menu-texto", c.menu.texto],
    ["--aparencia-menu-texto-suave", c.menu.textoSuave],
    ["--aparencia-menu-borda", c.menu.borda],
    ["--aparencia-menu-ativo-fundo", c.menu.ativoFundo],
    ["--aparencia-menu-ativo-fundo-solido", c.menu.ativoFundoSolido],
    ["--aparencia-menu-ativo-texto", c.menu.ativoTexto],
    ["--aparencia-menu-brilho", c.menu.brilho],
    ["--aparencia-menu-indicador", c.menu.indicador],
    ["--aparencia-menu-indicador-largura", f.indicadorLargura],
    ["--aparencia-menu-recuo-y", f.menuRecuoY],
    ["--aparencia-menu-recuo-x", f.menuRecuoX],
    ["--aparencia-menu-raio", f.menuRaio],
    ["--aparencia-menu-raio-item", f.menuRaioItem],
    ["--aparencia-menu-desfoque", f.menuDesfoque],
    // Menu flutuante (com recuo) tem contorno próprio e nenhuma divisa com o
    // conteúdo; menu encostado tem a divisa à direita e nenhum contorno.
    ...(flutuante(t)
      ? ([
          ["--aparencia-menu-divisa", "transparent"],
          ["--aparencia-menu-contorno", `1px solid ${c.menu.borda}`],
        ] as const)
      : ([
          ["--aparencia-menu-divisa", c.menu.borda],
          ["--aparencia-menu-contorno", "0 solid transparent"],
        ] as const)),
  ];
}

function flutuante(t: Template): boolean {
  return t.forma.menuRecuoX !== "0px";
}

/** Valor de token: nada que feche a declaração, a regra, ou abra uma tag. */
const VALOR_SEGURO = /^[^;{}<>\\]+$/;
const NOME_DE_TOKEN = /^--[a-z0-9-]+$/;

function bloco(seletor: string, decls: readonly Declaracao[]): string | null {
  for (const [nome, valor] of decls) {
    if (!NOME_DE_TOKEN.test(nome) || !VALOR_SEGURO.test(valor)) return null;
  }
  return `${seletor} {\n${decls.map(([n, v]) => `  ${n}: ${v};`).join("\n")}\n}`;
}

/**
 * O LOGO NUM MENU ESCURO DE TEMPLATE CLARO (Obsidiana, Safira, Néon, Vinho).
 *
 * O `Sidebar` escolhe entre o logo claro e o do escuro pelo modo da PÁGINA
 * (`dark:hidden`/`dark:block`). Num template cujo menu é escuro no modo claro,
 * isso poria o logo claro do revendedor sobre fundo escuro. Para esses, no
 * bloco claro: o menu mostra o logo do escuro quando ele existe, e, quando não
 * existe, o mesmo selo branco que o produto já usa no modo escuro.
 *
 * Declarações FIXAS, de uma lista fechada de propriedades; só o seletor varia,
 * e ele carrega o id do template (o teste de vazamento confere).
 */
const PROPRIEDADES_DAS_REGRAS_FIXAS = new Set(["display", "background-color", "padding", "box-shadow"]);

function regrasDoLogo(t: Template, escopo: EscopoDaAparencia): string | null {
  if (luminanciaRelativa(t.cores.claro.menu.fundoSolido) >= 0.18) return null;
  const [[claro]] = escopo;
  const regras: [string, Declaracao[]][] = [
    [`${claro} [data-casca="menu"] [data-logo="claro"]`, [["display", "none"]]],
    [`${claro} [data-casca="menu"] [data-logo="escuro"]`, [["display", "block"]]],
    [
      `${claro} [data-casca="menu"] [data-logo-selo]`,
      [
        ["background-color", "#ffffff"],
        ["padding", "4px 8px"],
        ["box-shadow", "var(--shadow-sm)"],
      ],
    ],
  ];
  const blocos: string[] = [];
  for (const [seletor, decls] of regras) {
    for (const [nome, valor] of decls) {
      if (!PROPRIEDADES_DAS_REGRAS_FIXAS.has(nome) || !VALOR_SEGURO.test(valor)) return null;
    }
    blocos.push(`${seletor} {\n${decls.map(([n, v]) => `  ${n}: ${v};`).join("\n")}\n}`);
  }
  return blocos.join("\n");
}

function reguaDoTemplate(t: Template): Regua {
  const base = (c: CoresDoModo) => [
    { chave: "--color-bg", hex: c.fundo },
    { chave: "--color-surface", hex: c.superficie },
    { chave: "--color-surface-elevated", hex: c.elevada },
  ];
  return {
    ...REGUA_DO_PRODUTO,
    claro: { ...REGUA_DO_PRODUTO.claro, base: base(t.cores.claro) },
    escuro: { ...REGUA_DO_PRODUTO.escuro, base: base(t.cores.escuro) },
  };
}

/**
 * Memo por template: a derivação é pura (mesma semente, mesma régua, mesmo
 * resultado), e o layout de `/app` a pediria a cada render.
 */
const MEMO_DO_ACENTO = new Map<string, string | null>();

function cssDoAcento(t: Template, escopo: EscopoDaAparencia): string | null {
  const chave = `${t.id}|${escopo.map(([s]) => s).join("|")}`;
  if (MEMO_DO_ACENTO.has(chave)) return MEMO_DO_ACENTO.get(chave)!;
  const marca = resolverMarca(
    [camadaDaOrganizacao({ accent_hex: t.cores.claro.acento, accent_dark_hex: t.cores.escuro.acento })],
    reguaDoTemplate(t),
  );
  const { css } = cssDaMarca(marca.cor, escopo);
  MEMO_DO_ACENTO.set(chave, css);
  return css;
}

export type OpcoesDoCss = {
  readonly escopo: EscopoDaAparencia;
  /** `false` quando a organização tem cor própria na tela Marca. */
  readonly incluirAcento?: boolean;
};

/**
 * O CSS do template, ou `null` — nunca uma string parcial. Um valor fora da
 * régua derruba o bloco inteiro: meio template aplicado é pior que nenhum.
 */
export function cssDoTemplate(t: Template | null, { escopo, incluirAcento = true }: OpcoesDoCss): string | null {
  if (!t) return null;
  const blocos: string[] = [];
  for (const [seletor, tema] of escopo) {
    const b = bloco(seletor, declaracoesDoModo(t, t.cores[tema]));
    if (b === null) return null;
    blocos.push(b);
  }
  if (incluirAcento) {
    const acento = cssDoAcento(t, escopo);
    if (acento) blocos.push(acento);
  }
  const logo = regrasDoLogo(t, escopo);
  if (logo) blocos.push(logo);
  return blocos.join("\n");
}

/**
 * O CSS que o layout de `/app` injeta para a organização: o template escolhido
 * e a segunda cor, ou `null` (o caso comum — quem nunca abriu a tela).
 *
 * NUNCA lança: roda no layout que embrulha `/app` inteiro, e um throw ali é 500
 * em todas as telas, inclusive na Aparência, onde se desfaria a escolha. Falha
 * vira "sem template", com aviso no log.
 */
export function cssDaAparenciaDaOrganizacao(a: Aparencia, temCorPropria: boolean): string | null {
  try {
    const t = templatePorId(a.template);
    const partes = [
      t ? cssDoTemplate(t, { escopo: escopoDoTemplate(t.id), incluirAcento: !temCorPropria }) : null,
      cssDaCorSecundaria(a.cor_secundaria),
    ].filter((p): p is string => Boolean(p));
    return partes.length > 0 ? partes.join("\n") : null;
  } catch (erro) {
    logger.warn("aparência da organização: CSS não montado; segue a aparência de fábrica", {
      codigo: "aparencia_css_falhou",
      template: a.template,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}
