/**
 * A serialização dos tokens da marca em CSS — a única parte deste sistema que
 * escreve texto que o navegador executa. Falha FECHADA: na dúvida, `null`.
 *
 * ── Por que a allowlist é de FORMA de valor, e não de nome de token ───────────
 *
 * A tentação é listar os tokens permitidos (`--color-accent`, `--color-brand`,
 * …) e confiar no resto. Mas o conjunto interpolado vai crescer — a fase
 * seguinte acrescenta as semânticas, a de e-mail acrescenta outros — e, no dia
 * em que alguém acrescentar um token cujo valor é uma URL, uma allowlist de
 * NOMES aprova o token e não olha o valor. A guarda que não envelhece é a que
 * exige que TODO valor, de qualquer token, presente ou futuro, tenha uma das
 * três formas que este produto de fato emite: `#rrggbb`, `rgb()/rgba()` e
 * `var(--nome)`. Nome de token também é validado, porque `--x: 1; } body {` no
 * NOME escaparia do bloco tão bem quanto no valor.
 *
 * ── Por que dois blocos, e por que `:root:root` ───────────────────────────────
 *
 * A especificidade dobrada (`:root:root` = 0,2,0) é deliberada: ela vence o
 * `:root` (0,1,0) e o `[data-theme="dark"]` (0,1,0) do `app/globals.css` sem
 * depender de onde o `<link>` de CSS do Next aterrissa — em dev ele é injetado
 * por HMR, em produção o artefato é `standalone`, e a ordem difere. Empatar em
 * especificidade e depender da ordem é o bug que só aparece num dos dois.
 *
 * E, pelo mesmo motivo, os dois blocos declaram o MESMO conjunto de tokens: um
 * token emitido só no bloco claro venceria, com 0,2,0, o valor escuro do
 * `globals.css` também no tema escuro — a marca vazaria para o tema errado.
 *
 * ── Por que o ESCOPO é parâmetro, e por que ele é uma união de literais ───────
 *
 * A partir da marca por organização há DOIS emissores: a instalação, que pinta o
 * documento inteiro pela raiz, e a organização, que pinta só o que está dentro
 * de `/app`. O que muda entre eles é o seletor — a serialização, a allowlist e a
 * rede de segurança são as mesmas, e duplicar a função para trocar duas strings
 * criaria duas cópias que divergem na primeira correção de segurança.
 *
 * O tipo é a UNIÃO DOS DOIS LITERAIS, jamais `string`: o seletor entra direto em
 * `montarBloco` sem passar por validação nenhuma — a allowlist abaixo cobre nome
 * de token e forma de VALOR, e a rede de segurança do fim só pega `<` e `;}`,
 * não pega um `}` sozinho. Aceitar `string` abriria a única porta deste módulo
 * por onde texto de usuário (id de organização, slug, nome de empresa) chegaria
 * a um bloco que o navegador executa.
 *
 * ── O que NUNCA fazer: `element.style.setProperty` no `<html>` ────────────────
 *
 * Seria mais curto e é uma armadilha. Declaração inline vence `:root` E
 * `[data-theme="dark"]` ao mesmo tempo, então o valor claro passaria a valer
 * também no escuro: a alternância de tema continua trocando o atributo, o resto
 * da paleta troca, e só o accent fica preso — quebra sem sintoma óbvio, do tipo
 * que se descobre semanas depois.
 */

import type { Tema } from "./contraste";
import { GRAUS, stop } from "./rampa";
import type { CorResolvida } from "./resolve";

export type CodigoDoCss =
  | "nome_de_token_invalido"
  | "valor_fora_da_allowlist"
  | "saida_suspeita"
  | "token_nao_serializado";

export type MotivoDoCss = {
  readonly codigo: CodigoDoCss;
  readonly alvo: string | null;
  readonly detalhe: string;
};

export type CssDaMarca = {
  /** O texto pronto para o `<style>`, ou `null` — nunca uma string parcial. */
  readonly css: string | null;
  readonly motivos: readonly MotivoDoCss[];
};

/** `--nome-do-token`. Sem maiúscula, sem escape, sem espaço. */
const NOME_DE_TOKEN = /^--[a-z][a-z0-9-]*$/;

/**
 * As três formas de valor que este produto emite. Ancoradas nas duas pontas
 * (`^`/`$`) de propósito: sem âncora, `#ff0000; } body { x` casaria o prefixo e
 * passaria com o resto pendurado.
 */
const FORMAS_DE_VALOR: readonly RegExp[] = [
  /^#[0-9a-f]{3}$/i,
  /^#[0-9a-f]{6}$/i,
  /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/,
  /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d{1,4})\s*\)$/,
  /^var\(--[a-z][a-z0-9-]*\)$/,
];

/**
 * Sequências que não podem existir na saída, checadas no texto JÁ montado.
 *
 * `<` porque o bloco é escrito com `dangerouslySetInnerHTML` dentro de um
 * `<style>`: um `</style>` no meio fecha o elemento e o que vem depois é HTML.
 * `;}` porque é a assinatura de uma declaração que fechou o bloco sozinha.
 *
 * A saída legítima nunca casa `;}` porque cada declaração termina em `;\n` e o
 * `}` fica na linha seguinte — a quebra de linha é load-bearing, não estética.
 */
const SEQUENCIAS_SUSPEITAS = ["<", ";}"] as const;

/** Corta o valor para caber num log e tira hex de dentro (ver `resolve.ts`). */
function paraDiagnostico(valor: string): string {
  const curto = valor.length > 32 ? `${valor.slice(0, 32)}…` : valor;
  return curto.replace(/#[0-9a-fA-F]{3,8}/g, "#…");
}

type Declaracao = readonly [nome: string, valor: string];

function declaracoesDoTema(cor: CorResolvida, tema: Tema): Declaracao[] {
  // `--color-brand` sai SEMPRE que há semente, inclusive quando ela não pinta
  // (marca acromática, papel só de identidade). É onde a cor do cliente existe
  // mesmo sem virar accent — e é o token que a tela de marca e o cabeçalho de
  // e-mail vão ler. Hoje ele não tem consumidor dentro do produto: declarar uma
  // custom property inerte não muda pixel nenhum, e sem ela o motivo
  // `marca_acromatica` ("a cor fica só em --color-brand") seria mentira.
  const saida: Declaracao[] = [["--color-brand", cor.semente]];
  const derivada = cor.derivada;
  if (!derivada) return saida;

  const t =
    tema === "claro"
      ? derivada.claro
      : tema === "escuro"
        ? derivada.escuro
        : derivada.superficieClara;

  // Os 11 stops saem JÁ DESLOCADOS, e por isso podem diferir entre os dois
  // blocos. Os rótulos vêm de `GRAUS` (rampa.ts) e não de uma lista repetida
  // aqui: duas listas de graus divergem, e a que perde é a que ninguém olha.
  //
  // ── POR QUE deslocado (o defeito que a prova em tela achou) ────────────────
  //
  // `escolherAccent` (contraste.ts) desliza a rampa INTEIRA até todo papel caber
  // no seu piso — é o que o comentário dela sempre disse ("anda a rampa inteira
  // junta: accent, hover, anel, soft"). Emitir os stops CRUS enquanto os papéis
  // saíam deslocados fazia o bloco emitido CONTRADIZER o `app/globals.css`:
  // medido no browser com `APP_ACCENT_HEX="#0f172a"` (navy), o tema escuro anda
  // -1 e o bloco declarava `--color-accent-400: #545f77` ao lado de
  // `--color-accent: #828a9d` — sendo que o globals.css declara, ele mesmo,
  // `--color-accent: var(--color-accent-400)`. Duas verdades no mesmo bloco.
  //
  // Quem lia a rampa DIRETO ficava com a cor de antes da caminhada. O anel de
  // foco (`globals.css`, `:focus-visible`) media então, no escuro: 2,86 contra
  // `--color-bg` e 2,37 contra `--color-surface-elevated`, abaixo do piso 3,0 de
  // WCAG 1.4.11 (não-textual) — que é nível AA e que o produto cumpria antes
  // deste épico (6,31 e 5,23 com a Sage).
  //
  // E não era UM papel: 68 pares reprovavam em 9 das 16 sementes da fixture
  // adversarial, em três papéis do globals.css (`--ring`, `:focus-visible` e
  // `::selection`) mais 7 usos diretos de `*-accent-{400,500}` em componentes —
  // 4 deles anéis de foco de `button`/`badge`/`input`/`textarea`. Por isso o
  // conserto NÃO foi um token novo de foco (`--color-focus-ring`): ele fecharia
  // o anel do globals.css e deixaria as irmãs de fora — inclusive `::selection`,
  // cujo par é fundo E texto tirados os dois da rampa, que só se corrige movendo
  // a rampa, e os `focus-visible:ring-accent-500` dos componentes, que nem
  // passam por token nenhum.
  //
  // Deslocar aqui faz `medirPares` descrever exatamente o pixel que o navegador
  // pinta — hoje e para todo consumidor futuro de `var(--color-accent-NNN)`.
  //
  // O preço, declarado: com deslocamento grande as pontas colapsam (`#f5c518`
  // anda +3 no claro, e 700/800/900/950 pousam todas no último stop). É o mesmo
  // preço que `--color-accent-soft` já pagava sozinho, e é o que a caminhada
  // sempre significou. Com d=0 — a Sage e toda marca que já cabe — a saída é
  // idêntica à de antes, byte a byte.
  for (const [i, grau] of GRAUS.entries()) {
    saida.push([`--color-accent-${grau}`, stop(derivada.rampa, i + t.deslocamento)]);
  }

  saida.push(
    ["--color-accent", t.accent],
    ["--color-accent-fg", t.accentFg],
    ["--color-accent-hover", t.accentHover],
    ["--color-accent-soft", t.accentSoft],
  );
  return saida;
}

/**
 * O escopo da INSTALAÇÃO: o documento inteiro, pela raiz.
 *
 * `:root` casa exclusivamente o `<html>`, e o `<html>` é do layout raiz — o
 * mesmo que serve `/login`, a tela de erro e o onboarding. É onde a marca de
 * quem hospeda tem de valer.
 */
export const ESCOPO_DA_INSTALACAO = [
  [":root:root", "claro"],
  [':root:root[data-theme="dark"]', "escuro"],
  /**
   * A area de conteudo sobre Paper. Combinador DESCENDENTE, e nao compound:
   * `[data-superficie="clara"]` esta numa div de pagina, nunca no `<html>` --
   * um `:root:root[data-superficie="clara"]` nao casaria nada, do mesmo modo
   * que o cabecalho de `ESCOPO_DA_ORGANIZACAO` descreve para o gate escuro.
   *
   * Especificidade (0,3,0) contra os (0,1,0) do `[data-superficie="clara"]` do
   * `app/globals.css`. Aqui os dois disputam DE VERDADE -- casam a mesma div --
   * entao a conta importa, ao contrario do par `:root` x `body` acima.
   *
   * Sem tema no seletor: os dois blocos de tema carregam valores identicos hoje
   * (o produto tem uma aparencia so), e a superficie clara e ortogonal ao
   * alternador. Uma entrada por tema emitiria dois blocos com os mesmos bytes.
   */
  [':root:root [data-superficie="clara"]', "superficie-clara"],
] as const;

/**
 * O escopo da ORGANIZAÇÃO: o `<body>`, enquanto existir a subárvore de `/app`.
 *
 * ── Por que `<body>`, e não uma div do shell ─────────────────────────────────
 *
 * 7 componentes de `components/ui` montam em Radix Portal e NENHUM passa
 * `container` (`alert-dialog`, `dialog`, `dropdown-menu`, `popover`, `select`,
 * `sheet`, `tooltip`; `grep -rn "container=" components/ui/*.tsx` = 0), portanto
 * todos portam para `document.body`. O `Toaster` chega lá por outro caminho, de
 * `app/layout.tsx`. Ancorado numa div, a PÁGINA mostraria a cor da organização e
 * o menu aberto por cima mostraria a da instalação — sintoma que passa em
 * revisão de código e só aparece com o menu aberto.
 *
 * ── Por que `:has()`, e não um atributo escrito no `<body>` ──────────────────
 *
 * O `<body>` pertence ao layout raiz e sobrevive à navegação client-side do
 * logout (Server Action + `redirect`, sem full reload). Um atributo escrito nele
 * teria de ser apagado por alguém, e "alguém" é o que falha. `:has()` deriva o
 * escopo do DOM: a regra deixa de casar no instante em que o marcador some junto
 * com a subárvore de `/app` — sem código de limpeza para esquecer.
 *
 * ── Por que o gate escuro é combinador DESCENDENTE ───────────────────────────
 *
 * `[data-theme="dark"]` só é escrito no `<html>` (`app/layout.tsx`,
 * `lib/theme.tsx`). Um compound `body[data-theme="dark"]:has(…)` nunca casaria
 * nada: regra silenciosa, zero erro no console, e a cor da organização
 * simplesmente ausente no tema escuro.
 *
 * ── A especificidade, medida — e por que ela não decide nada ─────────────────
 *
 * `body:has([data-marca-org])` = (0,1,1); com o gate escuro, (0,2,1). Contra
 * (0,2,0) e (0,3,0) da instalação. Os dois conjuntos NUNCA disputam: `:root`
 * casa só o `<html>` e estes casam só o `<body>`, e especificidade só arbitra
 * declarações que casam o MESMO elemento. Quem decide para todo elemento pintado
 * é a PROXIMIDADE de herança — o `<body>` é descendente do `<html>`, então o que
 * ele declara sombreia o que veio de cima para o documento inteiro. Os números
 * existem para provar que não há empate a resolver por ordem de documento, que é
 * o bug que o cabeçalho deste arquivo diz não querer ter.
 */
export const ESCOPO_DA_ORGANIZACAO = [
  ["body:has([data-marca-org])", "claro"],
  ['[data-theme="dark"] body:has([data-marca-org])', "escuro"],
  /** A area de conteudo sobre Paper -- ver o par na instalacao. (0,2,1). */
  ['body:has([data-marca-org]) [data-superficie="clara"]', "superficie-clara"],
] as const;

export type EscopoDaMarca = typeof ESCOPO_DA_INSTALACAO | typeof ESCOPO_DA_ORGANIZACAO;

function montarBloco(seletor: string, decls: readonly Declaracao[]): string {
  const linhas = decls.map(([nome, valor]) => `  ${nome}: ${valor};`);
  return `${seletor} {\n${linhas.join("\n")}\n}`;
}

/**
 * Os tokens da marca em CSS, ou `null` com o motivo.
 *
 * `null` NÃO é falha: sem marca configurada não há o que injetar, e o produto
 * fica com a cor dele — que é uma instalação correta. Falha é `null` com motivo
 * de recusa, e aí o motivo diz qual token e que forma foi rejeitada.
 *
 * O escopo tem default para os dois call sites que existiam antes da marca por
 * organização continuarem escrevendo o MESMO texto, byte a byte: a instalação é
 * quem pinta o documento inteiro, e ela não deveria precisar dizer isso.
 */
export function cssDaMarca(
  cor: CorResolvida | null,
  escopo: EscopoDaMarca = ESCOPO_DA_INSTALACAO,
): CssDaMarca {
  if (!cor) return { css: null, motivos: [] };

  const motivos: MotivoDoCss[] = [];

  // As semânticas (`--color-success` e irmãs) SÃO reconciliadas pela derivação,
  // mas não são serializadas nesta fase — e isso precisa aparecer, senão o
  // motivo "girada 25° para folgar do accent" descreveria um movimento que a
  // tela não faz. Cada semântica tem dois companheiros (`-bg` e `-fg`) que o
  // `globals.css` declara como literais próprios, e a régua extraída não os
  // carrega: emitir só a base deixaria o chip com fundo e texto de um matiz e
  // borda de outro — pior que não mover. Fechar isso exige a régua carregar os
  // companheiros, ou seja, mexer em `lib/branding/contraste.ts`.
  for (const m of cor.derivada?.motivos ?? []) {
    if (m.codigo !== "semantica_deslocada") continue;
    motivos.push({
      codigo: "token_nao_serializado",
      alvo: m.alvo,
      detalhe:
        `a derivação moveu esta semântica no tema ${m.tema ?? "?"}, mas o CSS desta ` +
        `fase não a emite: os companheiros -bg/-fg não vêm da régua`,
    });
  }

  const blocos: string[] = [];
  for (const [seletor, tema] of escopo) {
    const decls = declaracoesDoTema(cor, tema);
    for (const [nome, valor] of decls) {
      if (!NOME_DE_TOKEN.test(nome)) {
        motivos.push({
          codigo: "nome_de_token_invalido",
          alvo: paraDiagnostico(nome),
          detalhe: "nome de custom property fora da forma --nome-assim",
        });
        return { css: null, motivos };
      }
      if (!FORMAS_DE_VALOR.some((forma) => forma.test(valor))) {
        motivos.push({
          codigo: "valor_fora_da_allowlist",
          alvo: nome,
          detalhe: `valor não é #rrggbb, rgb()/rgba() nem var(--…): ${paraDiagnostico(valor)}`,
        });
        return { css: null, motivos };
      }
    }
    blocos.push(montarBloco(seletor, decls));
  }

  const css = blocos.join("\n");
  const suspeita = SEQUENCIAS_SUSPEITAS.find((s) => css.includes(s));
  if (suspeita !== undefined) {
    // Rede de segurança: se ela disparar, a allowlist acima tem um furo. Devolver
    // a saída "quase certa" seria injetar o furo na página.
    motivos.push({
      codigo: "saida_suspeita",
      alvo: null,
      detalhe: `a saída montada contém ${JSON.stringify(suspeita)}`,
    });
    return { css: null, motivos };
  }

  return { css, motivos };
}
