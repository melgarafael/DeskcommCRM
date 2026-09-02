/**
 * Legibilidade e separação de cor do whitelabel — os três eixos que decidem se a marca
 * do cliente pode virar a cor do produto sem quebrar quem usa a ferramenta.
 *
 * Os três, e por que cada um é independente:
 *
 *  (a) **Contraste vertical, por PAPEL × SUPERFÍCIE.** Checar só o stop da semente é
 *      um gate que nasce verde e mente. Medido na Sage: `accent-600` contra `--color-bg`
 *      dá 5,51 — mas o anel de foco usa `accent-500` (`globals.css`, `:focus-visible`) e
 *      dá 3,79 contra bg e 3,60 contra `surface-elevated`. Com a semente pousada num
 *      piso de 3,0, o anel pousaria em ~2,07 e o gate continuaria verde. Por isso os
 *      pares saem EXTRAÍDOS do `globals.css` (`extrairRegua`), nunca listados à mão:
 *      lista à mão só pega quem foi inscrito.
 *
 *  (b) **Separação de matiz por ΔE sob dicromacia, não por ângulo.** A régua de ângulo
 *      ordena invertido — medido e reproduzido aqui:
 *        oliva `#7f8c3a` × warning claro: ΔH 44,7° (passaria) mas ΔE_deuteranopia 0,0231
 *        verde-água `#1abc9c` × success claro: ΔH 27,2° (mal passaria) mas ΔE 0,1262
 *      Maior ângulo, PIOR separação. A régua correta simula a dicromacia (matrizes
 *      Machado 2009) e mede ΔE em OKLab sobre a cor simulada.
 *
 *  (c) **Quem se move são as NOSSAS semânticas, nunca o accent.** O accent é a única
 *      cor deste sistema que não nos pertence: é a marca real de uma empresa, e torcê-la
 *      é falha de produto. `success`/`warning`/`error`/`info` rotacionam para longe até
 *      folgar. Quando não há saída, o algoritmo NÃO falha nem distorce — devolve um
 *      motivo dizendo que a redundância não-cromática (ícone, rótulo, forma) precisa ser
 *      ligada naquele papel. É o laço de retorno do invariante 7 da doutrina Sistema
 *      Vivo: a peça diz o que muda no sistema quando ela não consegue resolver.
 *
 * Tudo aqui é função pura. `extrairRegua` recebe o TEXTO do CSS, não o caminho: o
 * módulo não toca em `fs` (roda no servidor e no navegador) e a extração fica testável.
 */

import type { Grau, Oklch, Rampa } from "./rampa";
import {
  compor,
  deltaEOklab,
  ehHexValido,
  GRAUS,
  hexParaLinear,
  hexParaOklch,
  hexParaRgb,
  linearParaHex,
  normalizarHex,
  oklchParaHex,
  rampaDeSemente,
  stop,
} from "./rampa";

// ── Contraste WCAG ───────────────────────────────────────────────────────────

/** WCAG 2.x §relative luminance — coeficientes sobre sRGB linearizado. */
export function luminanciaRelativa(hex: string): number {
  const [r, g, b] = hexParaLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function razaoDeContraste(a: string, b: string): number {
  const la = luminanciaRelativa(a);
  const lb = luminanciaRelativa(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Pisos por papel. Não são preferência: `texto` é WCAG 1.4.3 (Contrast Minimum) e
 * `componente` é 1.4.11 (Non-text Contrast), que rege borda, ícone e anel de foco.
 */
export const PISOS = { texto: 4.5, componente: 3.0 } as const;
export type TipoDePapel = keyof typeof PISOS;

/**
 * `--color-accent-fg` é CALCULADO, nunca fixo: `#ffffff` sobre um accent amarelo é
 * ilegível, e é justamente a marca amarela que o cliente cola sem avisar.
 *
 * Preto ou branco sempre resolve — o mínimo teórico de `max(razão vs preto, vs branco)`
 * é 4,58, acima do piso de 4,5. Este par nunca reprova; ele existe para garantir que o
 * cálculo aconteça, não para pegar defeito.
 */
export function melhorFrenteSobre(fundo: string): string {
  return razaoDeContraste("#ffffff", fundo) >= razaoDeContraste("#000000", fundo)
    ? "#ffffff"
    : "#000000";
}

// ── Dicromacia (Machado, Oliveira & Fernandes 2009 — severidade 1.0) ─────────

/**
 * Matrizes aplicadas sobre RGB **linear** (é o espaço em que foram publicadas; aplicar
 * sobre sRGB gama-codificado devolve outra cor e outra conclusão).
 *
 * Só as duas confusões vermelho-verde: juntas são ~8% dos homens, e são as que colidem
 * com a paleta de estado de qualquer CRM (success verde × error vermelho). Tritanopia
 * é ~0,01% e não muda nenhuma decisão desta função — incluí-la seria peso morto.
 */
const MACHADO = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
} as const;

export type Dicromacia = keyof typeof MACHADO;
export const DICROMACIAS = Object.keys(MACHADO) as readonly Dicromacia[];

export function simularDicromacia(hex: string, tipo: Dicromacia): string {
  const lin = hexParaLinear(hex);
  const m = MACHADO[tipo];
  const linha = (i: 0 | 1 | 2): number => {
    const l = m[i];
    return Math.max(0, Math.min(1, l[0] * lin[0] + l[1] * lin[1] + l[2] * lin[2]));
  };
  return linearParaHex([linha(0), linha(1), linha(2)]);
}

/**
 * A separação REAL entre duas cores: o pior caso entre as dicromacias. Média esconderia
 * a confusão que existe — basta uma visão em que as duas colapsam para o usuário perder
 * a informação.
 */
export function deltaESimulado(a: string, b: string): number {
  return Math.min(
    ...DICROMACIAS.map((d) => deltaEOklab(simularDicromacia(a, d), simularDicromacia(b, d))),
  );
}

/** Piso de separação sob dicromacia, na unidade CRUA do OKLab (não ×100). */
export const PISO_DE_SEPARACAO_SIMULADA = 0.05;

/**
 * Piso de croma que um accent precisa ter para marcar alguma coisa, e piso de distância
 * dele ao neutro do mesmo grau.
 *
 * O briefing pedia "ΔE ≥ 8", que é a convenção ×100. Medi antes de aceitar: na Sage,
 * `accent-600` contra `neutral-600` dá **0,0681** (6,81 na convenção ×100) e o stop 50
 * dá 0,0135. Um piso de 8 reprovaria o controle positivo do próprio produto. Fixei
 * 0,05 — a mesma unidade e a mesma ordem de grandeza do piso de dicromacia, uma unidade
 * só no arquivo inteiro — e apliquei ao stop EM USO por tema (0,0681 no claro, 0,1988
 * no escuro), que é o que o olho compara com a moldura neutra.
 */
export const PISO_DE_CROMA = 0.04;
export const PISO_DE_SEPARACAO_DO_NEUTRO = 0.05;

/**
 * Gatilho da marca acromática — o croma abaixo do qual o hex do cliente NÃO vira accent.
 *
 * Não é `PISO_DE_CROMA`, e a diferença foi medida, não estimada. Croma OKLab de cor
 * escura é pequeno em valor absoluto mesmo quando a cor é inequivocamente colorida:
 *
 *   `#0f172a` (navy — a identidade corporativa mais comum que existe): C = **0,039824**
 *   `#1a1f36` (a outra navy da fixture):                              C = **0,044430**
 *   `#808080`, `#000000`, `#ffffff`, `#fafafa`:                       C = **0,000000**
 *
 * Um gatilho em 0,04 decidiria no QUARTO decimal se a marca do cliente pinta a interface
 * — e as duas navies caem em lados opostos por 0,0002. Em 0,01 a decisão tem 40× de
 * margem contra cinza de verdade e 4× contra navy. `PISO_DE_CROMA` continua valendo,
 * mas como asserção sobre o accent que RESTA, não como gatilho.
 */
export const LIMIAR_ACROMATICO = 0.01;

/** Rotação máxima de uma semântica. Além disso ela deixa de significar o que significa:
 *  verde→ciano já são ~60°, e um "sucesso" azul não é sucesso para ninguém. */
export const ROTACAO_MAXIMA = 60;
const PASSO_DE_ROTACAO = 5;

// ── A régua: o que o `globals.css` de fato pinta ─────────────────────────────

/**
 * As tres SUPERFICIES que a derivacao mede.
 *
 * "claro" e "escuro" sao TEMAS (o alternador do usuario); "superficie-clara" e
 * a area de conteudo sobre Paper (`[data-superficie="clara"]` no globals.css),
 * que convive com qualquer um dos dois. O tipo e um so porque o que a regua faz
 * com eles e identico -- medir papeis contra bases e andar a rampa ate caberem.
 */
export type Tema = "claro" | "escuro" | "superficie-clara";

/** De onde uma cor vem. `grau` é o que o deslocamento do accent move. */
export type Fonte =
  | { readonly tipo: "grau"; readonly indice: number; readonly alfa: number }
  | { readonly tipo: "literal"; readonly hex: string; readonly alfa: number }
  | { readonly tipo: "frenteCalculada"; readonly sobre: Fonte };

export type Papel = {
  readonly token: string;
  readonly tipo: TipoDePapel;
  readonly fonte: Fonte;
  /** `null` = medir contra TODAS as superfícies do tema. */
  readonly contra: readonly Fonte[] | null;
};

export type TemaDaRegua = {
  readonly nome: Tema;
  /** Superfícies opacas — a base sobre a qual tudo o mais compõe. */
  readonly base: readonly { readonly chave: string; readonly hex: string }[];
  /** Superfícies tingidas pela rampa (`--color-accent-soft`). */
  readonly tingidas: readonly { readonly chave: string; readonly fonte: Fonte }[];
  readonly papeis: readonly Papel[];
  readonly semanticas: readonly { readonly nome: string; readonly hex: string }[];
  readonly neutros: Rampa;
  readonly indices: {
    readonly accent: number;
    readonly hover: number;
    readonly soft: number | null;
  };
  readonly alfaDoSoft: number;
};

export type Regua = {
  readonly rampaDoProduto: Rampa;
  readonly claro: TemaDaRegua;
  readonly escuro: TemaDaRegua;
  /**
   * A area de conteudo sobre Paper (`[data-superficie="clara"]`).
   *
   * Existe separada dos dois temas porque ela tem DESLOCAMENTO PROPRIO. Exigir
   * que um unico deslocamento sirva a Ink e a Paper ao mesmo tempo e um sistema
   * sobre-restrito: a rampa teria de agradar dois fundos em pontas opostas da
   * luminosidade, e quem pagaria seria o tema escuro, que e onde o produto
   * passa a maior parte do tempo. O `--color-link` do globals.css ja tinha
   * chegado a essa conclusao a mao -- accent-500 no escuro, accent-700 sobre
   * Paper; aqui a conclusao vira mecanismo.
   */
  readonly superficieClara: TemaDaRegua;
};

type Declaracao = { readonly prop: string; readonly valor: string };
type RegraCss = { readonly seletor: string; readonly decls: readonly Declaracao[] };

function varrerRegras(css: string): RegraCss[] {
  const limpo = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const saida: RegraCss[] = [];
  const visitar = (texto: string) => {
    let i = 0;
    let inicioDoSeletor = 0;
    while (i < texto.length) {
      const abre = texto.indexOf("{", i);
      if (abre === -1) return;
      let profundidade = 1;
      let j = abre + 1;
      while (j < texto.length && profundidade > 0) {
        if (texto[j] === "{") profundidade += 1;
        else if (texto[j] === "}") profundidade -= 1;
        j += 1;
      }
      // Só o que vem depois do último `;` é seletor: as at-rules sem bloco
      // (`@tailwind base;`) ficam no mesmo pedaço de texto e colariam no nome.
      const cru = texto.slice(inicioDoSeletor, abre);
      const seletor = cru.slice(cru.lastIndexOf(";") + 1).trim();
      const corpo = texto.slice(abre + 1, j - 1);
      // Corpo com chave é at-rule (@layer, @media, @keyframes): a regra folha está
      // dentro. Sem isso, `:focus-visible` e `::selection` — que só existem dentro de
      // `@layer base` — nunca seriam vistos, e a extração perderia os dois papéis mais
      // frágeis do sistema.
      if (corpo.includes("{")) visitar(corpo);
      else saida.push({ seletor, decls: lerDeclaracoes(corpo) });
      i = j;
      inicioDoSeletor = j;
    }
  };
  visitar(limpo);
  return saida;
}

function lerDeclaracoes(corpo: string): Declaracao[] {
  return corpo
    .split(";")
    .map((linha) => {
      const corte = linha.indexOf(":");
      if (corte === -1) return null;
      return {
        prop: linha.slice(0, corte).trim(),
        valor: linha.slice(corte + 1).trim(),
      };
    })
    .filter((d): d is Declaracao => d !== null && d.prop.length > 0);
}

const REF_ACCENT = /var\(\s*--color-accent-(\d{2,3})\s*\)/;
const RGBA = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/;

function grauParaIndice(rotulo: string): number | null {
  const i = (GRAUS as readonly number[]).indexOf(Number(rotulo));
  return i === -1 ? null : i;
}

/** Lê uma cor CSS como `Fonte`. Devolve `null` para o que não é cor (var indireta). */
function lerFonte(valor: string): Fonte | null {
  const ref = REF_ACCENT.exec(valor);
  if (ref?.[1]) {
    const indice = grauParaIndice(ref[1]);
    if (indice !== null) return { tipo: "grau", indice, alfa: 1 };
  }
  const rgba = RGBA.exec(valor);
  if (rgba?.[1] && rgba[2] && rgba[3]) {
    return {
      tipo: "literal",
      hex: normalizarHex(
        `#${[rgba[1], rgba[2], rgba[3]]
          .map((c) => Number(c).toString(16).padStart(2, "0"))
          .join("")}`,
      ),
      alfa: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  const hex = /#[0-9a-f]{3,8}\b/i.exec(valor);
  if (hex?.[0] && ehHexValido(hex[0].slice(0, 7))) {
    return { tipo: "literal", hex: normalizarHex(hex[0].slice(0, 7)), alfa: 1 };
  }
  return null;
}

const CHAVES_DE_BASE = ["--color-bg", "--color-surface", "--color-surface-elevated"] as const;
const SEMANTICAS = ["success", "warning", "error", "info"] as const;

/**
 * Extrai do TEXTO do `app/globals.css` tudo o que a derivação precisa medir.
 *
 * As regras de classificação são mecânicas, e essa é a razão de serem estas:
 *  - token terminado em `-fg` é TEXTO, medido contra o token de mesmo nome sem o sufixo;
 *  - token terminado em `-soft` é SUPERFÍCIE (algo é pintado nela), não papel;
 *  - regra que declara `background`+`color` juntos é um par de TEXTO já pronto (`::selection`);
 *  - qualquer outra referência direta a `var(--color-accent-NNN)` é COMPONENTE, medido
 *    contra todas as superfícies do tema.
 *
 * Referência INDIRETA (`--primary: var(--color-accent)`) é ignorada de propósito: é
 * alias do mesmo pixel, e medi-la duas vezes só inflaria a contagem de pares.
 */
export function extrairRegua(css: string): Regua {
  const regras = varrerRegras(css);
  const raiz = regras.find((r) => r.seletor === ":root");
  const escuro = regras.find(
    (r) => r.seletor.includes('[data-theme="dark"]') && r.decls.some((d) => d.prop === "--color-bg"),
  );
  if (!raiz || !escuro) {
    throw new Error("régua: não achei os blocos :root e [data-theme=\"dark\"] no CSS");
  }

  const superficieClara = regras.find((r) => r.seletor === '[data-superficie="clara"]');
  if (!superficieClara) {
    // Lançar, e nao cair num default: um default silencioso devolveria a
    // superficie ESCURA no lugar da clara, e a derivacao mediria Paper contra
    // pares de Ink -- verde na suite, errado na tela. O mesmo criterio dos dois
    // blocos acima.
    throw new Error('regua: nao achei o bloco [data-superficie="clara"] no CSS');
  }

  const rampaDoProduto = lerRampa(raiz.decls);

  return {
    rampaDoProduto,
    claro: montarTema("claro", raiz.decls, regras, false),
    escuro: montarTema("escuro", escuro.decls, regras, true),
    // `raiz.decls` como heranca: o bloco da superficie clara e uma SUBARVORE do
    // `:root` e so redeclara o que muda. Ver o @param de `montarTema`.
    superficieClara: montarTema("superficie-clara", superficieClara.decls, regras, false, raiz.decls),
  };
}

function lerRampa(decls: readonly Declaracao[]): Rampa {
  const stops = GRAUS.map((g) => {
    const d = decls.find((x) => x.prop === `--color-accent-${g}`);
    const f = d ? lerFonte(d.valor) : null;
    if (!f || f.tipo !== "literal") throw new Error(`régua: --color-accent-${g} ausente`);
    return f.hex;
  });
  return stops as unknown as Rampa;
}

function lerNeutros(decls: readonly Declaracao[]): Rampa {
  const stops = GRAUS.map((g) => {
    const d = decls.find((x) => x.prop === `--color-neutral-${g}`);
    const f = d ? lerFonte(d.valor) : null;
    if (!f || f.tipo !== "literal") throw new Error(`régua: --color-neutral-${g} ausente`);
    return f.hex;
  });
  return stops as unknown as Rampa;
}

/**
 * @param heranca Declaracoes do bloco ANCESTRAL, para uma subarvore que so
 * redeclara parte dos tokens. `[data-superficie="clara"]` troca as bases, as
 * semanticas e o soft, e NAO declara a rampa, os neutros nem `--color-accent` --
 * esses continuam valendo por heranca do `:root`, e sem eles aqui a montagem
 * lançaria em `lerNeutros`. Mesclar antes de medir tambem e o que faz os papeis
 * herdados (o `--color-accent` de um botao, por exemplo) serem medidos CONTRA
 * PAPER, que e a metade do buraco que esta funcao existe para fechar.
 *
 * Os dois temas passam `[]` e seguem byte a byte como antes.
 */
function montarTema(
  nome: Tema,
  decls: readonly Declaracao[],
  regras: readonly RegraCss[],
  ehEscuro: boolean,
  heranca: readonly Declaracao[] = [],
): TemaDaRegua {
  // O bloco proprio vence a heranca, prop a prop -- e a cascata do CSS.
  const proprias = new Set(decls.map((d) => d.prop));
  const efetivas: readonly Declaracao[] = [
    ...heranca.filter((h) => !proprias.has(h.prop)),
    ...decls,
  ];
  const base = CHAVES_DE_BASE.map((chave) => {
    const f = lerFonte(efetivas.find((d) => d.prop === chave)?.valor ?? "");
    if (!f || f.tipo !== "literal") throw new Error(`régua: ${chave} ausente em ${nome}`);
    return { chave, hex: f.hex };
  });

  const tingidas: { chave: string; fonte: Fonte }[] = [];
  const papeis: Papel[] = [];

  for (const d of efetivas) {
    if (!d.prop.startsWith("--")) continue;
    if (/^--color-(accent|neutral)-\d/.test(d.prop)) continue; // a rampa e os neutros, não papéis
    const fonte = lerFonte(d.valor);
    if (!fonte) continue;

    if (d.prop.endsWith("-soft")) {
      tingidas.push({ chave: d.prop, fonte });
      continue;
    }
    if (d.prop.endsWith("-fg")) {
      const baseToken = d.prop.slice(0, -"-fg".length);
      const alvo = lerFonte(efetivas.find((x) => x.prop === baseToken)?.valor ?? "");
      // Só o `-fg` de um token derivado da rampa interessa: `--color-success-fg` é cor
      // nossa medida contra fundo nosso, e a marca do cliente não o move.
      if (alvo?.tipo === "grau") {
        papeis.push({
          token: d.prop,
          tipo: "texto",
          fonte: { tipo: "frenteCalculada", sobre: alvo },
          contra: [alvo],
        });
      }
      continue;
    }
    if (fonte.tipo === "grau") {
      // ⚠️ `--color-link` cai aqui como "componente", piso 3,0 — e ele é TEXTO,
      // cujo piso é 4,5. Não é descuido: está medido, e fechar o buraco é uma
      // mudança de produto, não de folha de estilo.
      //
      // Medido ao trocar a classificação para "texto": das 16 sementes de
      // `tests/unit/branding-pares-pintados.test.ts`, CINCO passam a reprovar
      // (#ffffff, #000000, #808080, #dc2626, #fafafa), todas no mesmo par —
      // `--color-link × --color-accent-soft @ --color-surface-elevated = 4,30`.
      // Ou seja: o portão do whitelabel passaria a recusar marcas que aceita
      // hoje, e a derivação teria de mover a rampa para reacomodá-las.
      //
      // O link que o PRODUTO pinta está fora de risco (accent-500 sobre Ink =
      // 5,53; accent-700 sobre Paper = 6,29, ambos medidos). O que está
      // desprotegido é a marca de TERCEIRO: um revendedor cujo link caia em 3,2
      // passa neste portão. Fechar isso pede decidir o que fazer com as cinco
      // sementes — afrouxar o par do soft, mover a rampa, ou recusar a cor.
      papeis.push({ token: d.prop, tipo: "componente", fonte, contra: null });
    }
  }

  for (const regra of regras) {
    const doEscuro = regra.seletor.includes('[data-theme="dark"]');
    if (doEscuro !== ehEscuro) continue;
    if (regra.seletor === ":root" || regra.decls.some((d) => d.prop === "--color-bg")) continue;

    const fundo = regra.decls.find((d) => /^background(-color)?$/.test(d.prop));
    const frente = regra.decls.find((d) => d.prop === "color");
    if (fundo && frente) {
      const fFundo = lerFonte(fundo.valor);
      const fFrente = lerFonte(frente.valor);
      if (fFundo && fFrente && (fFundo.tipo === "grau" || fFrente.tipo === "grau")) {
        papeis.push({
          token: `${regra.seletor}/color`,
          tipo: "texto",
          fonte: fFrente,
          contra: [fFundo],
        });
      }
      continue;
    }
    for (const d of regra.decls) {
      if (!REF_ACCENT.test(d.valor)) continue;
      const fonte = lerFonte(d.valor);
      if (fonte?.tipo !== "grau") continue;
      papeis.push({
        token: `${regra.seletor}/${d.prop}`,
        tipo: "componente",
        fonte,
        contra: null,
      });
    }
  }

  const accent = lerFonte(efetivas.find((d) => d.prop === "--color-accent")?.valor ?? "");
  const hover = lerFonte(efetivas.find((d) => d.prop === "--color-accent-hover")?.valor ?? "");
  const soft = tingidas.find((t) => t.chave === "--color-accent-soft")?.fonte;
  if (accent?.tipo !== "grau" || hover?.tipo !== "grau" || !soft) {
    throw new Error(`régua: tokens de papel do accent ausentes em ${nome}`);
  }

  return {
    nome,
    base,
    tingidas,
    papeis,
    semanticas: SEMANTICAS.map((s) => {
      const f = lerFonte(efetivas.find((d) => d.prop === `--color-${s}`)?.valor ?? "");
      if (!f || f.tipo !== "literal") throw new Error(`régua: --color-${s} ausente em ${nome}`);
      return { nome: s, hex: f.hex };
    }),
    neutros: lerNeutros(efetivas),
    indices: {
      accent: accent.indice,
      hover: hover.indice,
      // `--color-accent-soft` no escuro é `rgba(130,160,119,0.16)` — verde Sage CRU, que
      // sobreviveria intacto a qualquer override da rampa. Sem índice, ele é reancorado
      // no stop do accent (ver `resolverSoft`); é a única forma de ele acompanhar a marca.
      soft: soft.tipo === "grau" ? soft.indice : null,
    },
    // `frenteCalculada` só é construída para token `-fg`, nunca para `-soft`; o ramo
    // existe para o compilador, e 1 (opaco) é o default seguro se alguém mudar isso.
    alfaDoSoft: soft.tipo === "frenteCalculada" ? 1 : soft.alfa,
  };
}

// ── Resolução de fontes sob um deslocamento ─────────────────────────────────

function resolverFonte(fonte: Fonte, rampa: Rampa, deslocamento: number): { hex: string; alfa: number } {
  if (fonte.tipo === "grau") {
    return { hex: stop(rampa, fonte.indice + deslocamento), alfa: fonte.alfa };
  }
  if (fonte.tipo === "literal") return { hex: fonte.hex, alfa: fonte.alfa };
  const sobre = resolverFonte(fonte.sobre, rampa, deslocamento);
  return { hex: melhorFrenteSobre(sobre.hex), alfa: 1 };
}

/**
 * Toda superfície do tema, já opaca. A tingida translúcida vira N superfícies — uma por
 * base — porque é isso que ela é na tela: `rgba(...)` a 16% sobre `surface-elevated` é
 * outro pixel que sobre `bg`, e a razão de contraste difere (4,99 · 4,59 · 4,02 na Sage
 * escura). Medir só uma delas escolheria a mais folgada por acidente.
 */
export function superficiesDoTema(
  tema: TemaDaRegua,
  rampa: Rampa,
  deslocamento: number,
): { chave: string; hex: string }[] {
  const saida = tema.base.map((b) => ({ ...b }));
  for (const t of tema.tingidas) {
    const { hex, alfa } = resolverFonte(t.fonte, rampa, deslocamento);
    // Fonte literal numa tingida = o token não referencia a rampa (o caso do escuro).
    // Reancoramos no stop que o tema pinta como accent: é o que faz a marca do cliente
    // chegar ao chip em vez de o verde do produto ficar lá para sempre.
    const tinta =
      t.fonte.tipo === "grau" ? hex : stop(rampa, tema.indices.accent + deslocamento);
    if (alfa >= 1) saida.push({ chave: t.chave, hex: tinta });
    else for (const b of tema.base) saida.push({ chave: `${t.chave}@${b.chave}`, hex: compor(tinta, alfa, b.hex) });
  }
  return saida;
}

export type ParMedido = {
  readonly papel: string;
  readonly superficie: string;
  readonly tipo: TipoDePapel;
  readonly razao: number;
  readonly piso: number;
  readonly passa: boolean;
};

/** Mede TODOS os pares (papel × superfície) do tema sob um deslocamento. */
export function medirPares(
  tema: TemaDaRegua,
  rampa: Rampa,
  deslocamento: number,
): ParMedido[] {
  const superficies = superficiesDoTema(tema, rampa, deslocamento);
  const pares: ParMedido[] = [];
  for (const papel of tema.papeis) {
    const frente = resolverFonte(papel.fonte, rampa, deslocamento);
    const alvos =
      papel.contra === null
        ? superficies
        : papel.contra.map((f) => {
            const r = resolverFonte(f, rampa, deslocamento);
            return { chave: papel.token, hex: r.hex };
          });
    for (const alvo of alvos) {
      const cor = frente.alfa >= 1 ? frente.hex : compor(frente.hex, frente.alfa, alvo.hex);
      const piso = PISOS[papel.tipo];
      const razao = razaoDeContraste(cor, alvo.hex);
      pares.push({
        papel: papel.token,
        superficie: alvo.chave,
        tipo: papel.tipo,
        razao,
        piso,
        passa: razao >= piso,
      });
    }
  }
  return pares;
}

// ── (a) A caminhada de contraste ────────────────────────────────────────────

export type EscolhaDeAccent = {
  /** Quantos stops a rampa inteira andou para o tema caber nos pisos. 0 = nenhum. */
  readonly deslocamento: number;
  readonly grauDoAccent: Grau;
  readonly pares: readonly ParMedido[];
  readonly reprovas: readonly ParMedido[];
  /** `null` quando todos os pares passam; código de degradação quando não há saída. */
  readonly motivo: "sem_deslocamento_que_satisfaz" | null;
};

/**
 * Escolhe quantos stops o tema anda na rampa para que TODO papel caiba no seu piso.
 *
 * Anda a rampa inteira junta (accent, hover, anel, soft), não só o accent: o design
 * system desenhou as distâncias relativas entre eles, e mover um sozinho destruiria a
 * hierarquia (hover que não se distingue do repouso).
 *
 * A ordem da busca prefere `0` — respeitar o hex do cliente é o padrão — e, em empate de
 * |d|, o sentido que AFASTA da superfície: no tema claro escurecer, no escuro clarear.
 *
 * O ramo degradado (`motivo` preenchido) não é erro: rampas sem contraste possível
 * existem (L uniforme, tudo claro, tudo escuro) e a resposta certa é entregar o melhor
 * deslocamento e DIZER que ele não fecha, não lançar exceção numa função que roda no
 * caminho de render do `app/layout.tsx`.
 */
export function escolherAccent(
  rampa: Rampa,
  tema: TemaDaRegua,
  alcance = 10,
): EscolhaDeAccent {
  // Afastar da superficie: no escuro clarear, em QUALQUER superficie clara
  // escurecer. "superficie-clara" entra com o mesmo sentido de "claro" porque
  // o que decide e a luminosidade do fundo, nao o nome do alternador.
  const sentidoUtil = tema.nome === "escuro" ? -1 : 1;
  const candidatos: number[] = [0];
  for (let d = 1; d <= alcance; d += 1) candidatos.push(d * sentidoUtil, -d * sentidoUtil);

  let melhor: { d: number; pares: ParMedido[]; reprovas: ParMedido[]; folga: number } | null = null;
  for (const d of candidatos) {
    const pares = medirPares(tema, rampa, d);
    const reprovas = pares.filter((p) => !p.passa);
    if (reprovas.length === 0) {
      return {
        deslocamento: d,
        grauDoAccent: grauEm(tema.indices.accent + d),
        pares,
        reprovas: [],
        motivo: null,
      };
    }
    // Critério do "menos pior": primeiro menos reprovas, depois a maior folga relativa
    // no par mais apertado. Razão bruta não serve de comparação entre pisos diferentes —
    // 3,2 sobre piso 3,0 é melhor que 4,4 sobre piso 4,5.
    const folga = Math.min(...pares.map((p) => p.razao / p.piso));
    if (
      melhor === null ||
      reprovas.length < melhor.reprovas.length ||
      (reprovas.length === melhor.reprovas.length && folga > melhor.folga)
    ) {
      melhor = { d, pares, reprovas, folga };
    }
  }

  const escolhido = melhor ?? { d: 0, pares: [], reprovas: [] };
  return {
    deslocamento: escolhido.d,
    grauDoAccent: grauEm(tema.indices.accent + escolhido.d),
    pares: escolhido.pares,
    reprovas: escolhido.reprovas,
    motivo: "sem_deslocamento_que_satisfaz",
  };
}

function grauEm(indice: number): Grau {
  return GRAUS[Math.max(0, Math.min(10, indice))] ?? GRAUS[6];
}

// ── (c) Reconciliação das semânticas ────────────────────────────────────────

export type MovimentoDeSemantica = {
  readonly nome: string;
  readonly de: string;
  readonly para: string;
  readonly rotacao: number;
  readonly separacaoAntes: number;
  readonly separacaoDepois: number;
};

export type Reconciliacao = {
  readonly cores: Readonly<Record<string, string>>;
  readonly movimentos: readonly MovimentoDeSemantica[];
  /** Semânticas que não têm rotação possível: a UI precisa de redundância não-cromática. */
  readonly semSaida: readonly { readonly nome: string; readonly separacao: number }[];
};

function girar(hex: string, graus: number): string {
  const o: Oklch = hexParaOklch(hex);
  return oklchParaHex({ L: o.L, C: o.C, h: (o.h + graus + 360) % 360 });
}

/**
 * Afasta as NOSSAS cores de estado do accent do cliente, sob dicromacia.
 *
 * Duas restrições, e a segunda é a que evita trocar um defeito por outro: a candidata
 * precisa (1) folgar do accent e (2) não chegar mais perto de uma irmã do que a original
 * já estava. O piso absoluto NÃO serve na restrição (2) porque a paleta do produto já
 * nasce colidida entre irmãs — medido no tema escuro: `success × warning` = 0,0446 e
 * `success × error` = 0,0314, ambos abaixo de 0,05. Exigir 0,05 ali tornaria a
 * reconciliação impossível por um motivo que não tem nada a ver com a marca do cliente.
 */
export function reconciliarSemanticas(
  accent: string,
  semanticas: readonly { readonly nome: string; readonly hex: string }[],
): Reconciliacao {
  const atual = new Map(semanticas.map((s) => [s.nome, s.hex]));
  const original = new Map(semanticas.map((s) => [s.nome, s.hex]));
  const movimentos: MovimentoDeSemantica[] = [];
  const semSaida: { nome: string; separacao: number }[] = [];

  for (const { nome, hex } of semanticas) {
    const antes = deltaESimulado(hex, accent);
    if (antes >= PISO_DE_SEPARACAO_SIMULADA) continue;

    const irmas = semanticas.filter((s) => s.nome !== nome);
    const naoPiora = (candidata: string): boolean =>
      irmas.every((irma) => {
        const corDaIrma = atual.get(irma.nome) ?? irma.hex;
        const base = Math.min(
          PISO_DE_SEPARACAO_SIMULADA,
          deltaESimulado(original.get(nome) ?? hex, corDaIrma),
        );
        return deltaESimulado(candidata, corDaIrma) >= base;
      });

    let achou: { cor: string; rotacao: number; separacao: number } | null = null;
    for (let passo = PASSO_DE_ROTACAO; passo <= ROTACAO_MAXIMA && !achou; passo += PASSO_DE_ROTACAO) {
      for (const sinal of [1, -1] as const) {
        const candidata = girar(hex, sinal * passo);
        const separacao = deltaESimulado(candidata, accent);
        if (separacao >= PISO_DE_SEPARACAO_SIMULADA && naoPiora(candidata)) {
          achou = { cor: candidata, rotacao: sinal * passo, separacao };
          break;
        }
      }
    }

    if (!achou) {
      semSaida.push({ nome, separacao: antes });
      continue;
    }
    atual.set(nome, achou.cor);
    movimentos.push({
      nome,
      de: hex,
      para: achou.cor,
      rotacao: achou.rotacao,
      separacaoAntes: antes,
      separacaoDepois: achou.separacao,
    });
  }

  return { cores: Object.fromEntries(atual), movimentos, semSaida };
}

// ── O resultado ─────────────────────────────────────────────────────────────

export type CodigoDeMotivo =
  | "marca_acromatica"
  | "accent_deslocado"
  | "accent_sem_contraste_possivel"
  | "semantica_deslocada"
  | "redundancia_nao_cromatica_necessaria";

/**
 * Diagnóstico emite FORMA, nunca IDENTIDADE: nenhum campo carrega o hex da marca do
 * cliente. Este objeto vai para log e para a tela de diagnóstico da instalação, e a cor
 * da marca de uma empresa não tem por que aparecer no log de outra.
 */
export type Motivo = {
  readonly codigo: CodigoDeMotivo;
  readonly tema: Tema | null;
  readonly alvo: string | null;
  readonly detalhe: string;
};

export type TokensDoTema = {
  readonly grauDoAccent: Grau;
  readonly deslocamento: number;
  /** `--color-accent` */
  readonly accent: string;
  /** `--color-accent-fg`, calculado (preto ou branco), nunca fixo. */
  readonly accentFg: string;
  /** `--color-accent-hover` */
  readonly accentHover: string;
  /** `--color-accent-soft`, já no formato CSS que o tema declara (hex ou `rgba()`). */
  readonly accentSoft: string;
  readonly semanticas: Readonly<Record<string, string>>;
  readonly pares: readonly ParMedido[];
};

export type Marca = {
  /** O hex do cliente, sempre — vai para `--color-brand`, mesmo quando não vira accent. */
  readonly marca: string;
  readonly rampa: Rampa;
  readonly origemDaRampa: "semente" | "produto";
  readonly claro: TokensDoTema;
  readonly escuro: TokensDoTema;
  /** Tokens da area de conteudo sobre Paper -- deslocamento proprio. Ver `Regua`. */
  readonly superficieClara: TokensDoTema;
  readonly motivos: readonly Motivo[];
};

/**
 * Emite `--color-accent-soft` no MESMO formato que o tema declara — hex quando opaco,
 * `rgba()` quando translúcido. Uniformizar para hex apagaria a translucidez que o tema
 * escuro usa de propósito (o chip precisa deixar a superfície aparecer); uniformizar
 * para `rgba()` mudaria o pixel do tema claro sem motivo.
 */
function cssDoSoft(tema: TemaDaRegua, rampa: Rampa, deslocamento: number): string {
  const tinta = stop(rampa, (tema.indices.soft ?? tema.indices.accent) + deslocamento);
  if (tema.alfaDoSoft >= 1) return tinta;
  const { r, g, b } = hexParaRgb(tinta);
  return `rgba(${r}, ${g}, ${b}, ${tema.alfaDoSoft})`;
}

function derivarTema(tema: TemaDaRegua, rampa: Rampa): { tokens: TokensDoTema; motivos: Motivo[] } {
  const escolha = escolherAccent(rampa, tema);
  const d = escolha.deslocamento;
  const accent = stop(rampa, tema.indices.accent + d);
  const reconciliacao = reconciliarSemanticas(accent, tema.semanticas);
  const motivos: Motivo[] = [];

  // Deslocar é decisão do sistema sobre a cor de OUTRA pessoa, e ela não pode acontecer
  // calada: um amarelo `#f5c518` não alcança 3:1 contra branco em nenhum universo, o
  // tema claro pousa no grau 900 e a interface fica verde-oliva. Sem este motivo o
  // cliente vê a cor mudar e conclui que o produto está quebrado.
  if (d !== 0) {
    motivos.push({
      codigo: "accent_deslocado",
      tema: tema.nome,
      alvo: "--color-accent",
      detalhe: `rampa andou ${d > 0 ? "+" : ""}${d} grau(s) até o ${escolha.grauDoAccent} para todo papel caber no piso`,
    });
  }

  if (escolha.motivo !== null) {
    motivos.push({
      codigo: "accent_sem_contraste_possivel",
      tema: tema.nome,
      alvo: null,
      detalhe:
        `nenhum deslocamento da rampa satisfaz os ${escolha.pares.length} pares; ` +
        `${escolha.reprovas.length} seguem abaixo do piso no melhor caso (d=${d})`,
    });
  }
  for (const m of reconciliacao.movimentos) {
    motivos.push({
      codigo: "semantica_deslocada",
      tema: tema.nome,
      alvo: m.nome,
      detalhe:
        `girada ${m.rotacao}° para folgar do accent sob dicromacia ` +
        `(ΔE ${m.separacaoAntes.toFixed(4)} → ${m.separacaoDepois.toFixed(4)})`,
    });
  }
  for (const s of reconciliacao.semSaida) {
    motivos.push({
      codigo: "redundancia_nao_cromatica_necessaria",
      tema: tema.nome,
      alvo: s.nome,
      detalhe:
        `sem rotação até ${ROTACAO_MAXIMA}° que separe do accent (ΔE ${s.separacao.toFixed(4)} ` +
        `< ${PISO_DE_SEPARACAO_SIMULADA}); ligar ícone/rótulo neste papel`,
    });
  }

  return {
    tokens: {
      grauDoAccent: escolha.grauDoAccent,
      deslocamento: d,
      accent,
      accentFg: melhorFrenteSobre(accent),
      accentHover: stop(rampa, tema.indices.hover + d),
      accentSoft: cssDoSoft(tema, rampa, d),
      semanticas: reconciliacao.cores,
      pares: escolha.pares,
    },
    motivos,
  };
}

/**
 * O ponto de entrada: um hex do cliente + a régua do design system → todos os tokens.
 *
 * Marca acromática (cinza, preto, branco) NÃO vira accent. Uma rampa de croma zero
 * some dentro dos neutros greige do produto — o "accent" deixaria de marcar qualquer
 * coisa, e a interface ficaria sem hierarquia. O accent do produto PERMANECE, o hex do
 * cliente vai para `--color-brand` (logo, selo, cabeçalho de e-mail), e a função devolve
 * o motivo — o cliente precisa saber por que a cor dele não pintou o botão.
 */
export function derivarMarca(semente: string, regua: Regua): Marca {
  const marca = normalizarHex(semente);
  const { C } = hexParaOklch(marca);
  const acromatica = C < LIMIAR_ACROMATICO;
  const rampa = acromatica ? regua.rampaDoProduto : rampaDeSemente(marca);

  const claro = derivarTema(regua.claro, rampa);
  const escuro = derivarTema(regua.escuro, rampa);
  const superficieClara = derivarTema(regua.superficieClara, rampa);
  const motivos: Motivo[] = [...claro.motivos, ...escuro.motivos, ...superficieClara.motivos];

  if (acromatica) {
    motivos.unshift({
      codigo: "marca_acromatica",
      tema: null,
      alvo: "--color-brand",
      detalhe:
        `croma ${C.toFixed(4)} abaixo do limiar ${LIMIAR_ACROMATICO}: a rampa do produto ` +
        `permanece como accent e a cor da marca fica só em --color-brand`,
    });
  }

  return {
    marca,
    rampa,
    origemDaRampa: acromatica ? "produto" : "semente",
    claro: claro.tokens,
    escuro: escuro.tokens,
    superficieClara: superficieClara.tokens,
    motivos,
  };
}

/** Separação entre o accent em uso e o neutro do mesmo grau — a guarda da acromaticidade. */
export function separacaoDoNeutro(tema: TemaDaRegua, accentGrau: Grau, accent: string): number {
  return deltaEOklab(accent, stop(tema.neutros, GRAUS.indexOf(accentGrau)));
}
