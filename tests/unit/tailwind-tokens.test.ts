import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guardas da migração para o Tailwind 4 (config em CSS).
 *
 * O `tailwind.config.ts` deixou de existir: o que era `theme.extend` virou um
 * bloco `@theme inline` dentro de `app/globals.css`. Isso troca um arquivo que
 * o TypeScript conferia por um arquivo que ninguém confere — e três coisas
 * passam a poder quebrar em silêncio, com build verde e tela errada. Cada uma
 * tem um teste aqui.
 */

const RAIZ = process.cwd();
const CSS = fs.readFileSync(path.join(RAIZ, "app/globals.css"), "utf8");

/** Recorta `<seletor> { … }` por casamento de chave, ancorado em início de linha. */
function bloco(seletor: string): string {
  const rx = new RegExp(`^${seletor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m");
  const i = CSS.search(rx);
  if (i < 0) throw new Error(`não achei o bloco \`${seletor}\` em globals.css`);
  const fim = CSS.indexOf("\n}", i);
  if (fim < 0) throw new Error(`bloco \`${seletor}\` sem fechamento em globals.css`);
  return CSS.slice(i, fim);
}

/** Nomes de custom property declarados dentro de um bloco. */
function propsDe(texto: string): string[] {
  return [...texto.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].flatMap((m) => (m[1] ? [m[1]] : []));
}

describe("Tailwind 4 — a ponte token → utilitário", () => {
  it("não voltou a existir config em JS nem diretiva `@tailwind`", () => {
    // Os dois convivem tecnicamente (`@config` existe no v4), mas conviver é o
    // problema: com um `tailwind.config.ts` de volta, metade dos tokens passa a
    // vir de um arquivo e metade do outro, e a divergência só aparece na tela.
    expect(fs.existsSync(path.join(RAIZ, "tailwind.config.ts"))).toBe(false);
    expect(fs.existsSync(path.join(RAIZ, "tailwind.config.js"))).toBe(false);
    expect(CSS).not.toMatch(/^@tailwind\s/m);
    expect(CSS).toMatch(/^@import "tailwindcss"/m);
  });

  it("mantém os blocos de token FORA de `@layer` — é o que neutraliza a auto-referência", () => {
    // `@theme inline` emite, dentro de `@layer theme`, linhas do tipo
    // `--color-bg: var(--color-bg)`, porque os nomes de token do produto já
    // ocupam o namespace `--color-*` do Tailwind. Elas são inofensivas por UM
    // motivo só: declaração sem layer vence declaração em layer, e o `:root`
    // autoral está sem layer. Embrulhar `:root` num `@layer` inverteria a
    // precedência, a auto-referência passaria a valer, e TODA cor do produto
    // viraria inválida — tela em branco e preto, com build verde.
    // O que se procura é o bloco que DECLARA token. `@layer base` legitimamente
    // tem um `[data-theme="dark"] { color-scheme: dark }` — regra de tema, não
    // definição de token; ela pode morar em layer sem consequência nenhuma.
    for (const l of CSS.matchAll(/^@layer\s+([a-z]+)\s*\{/gim)) {
      const inicio = l.index ?? 0;
      const fim = CSS.indexOf("\n}", inicio);
      const corpo = CSS.slice(inicio, fim < 0 ? CSS.length : fim);
      const regras = corpo.matchAll(/^\s*(:root|\[data-theme="(?:light|dark)"\])\s*\{/gm);
      for (const r of regras) {
        const de = r.index ?? 0;
        const ate = corpo.indexOf("}", de);
        const dentro = corpo.slice(de, ate < 0 ? corpo.length : ate);
        expect(
          /^\s*--[a-z0-9-]+\s*:/im.test(dentro),
          `\`${r[1]}\` declara token dentro de @layer ${l[1]} — isso liga a auto-referência`,
        ).toBe(false);
      }
    }
  });

  it("todo token que o `@theme inline` consome existe no `:root`", () => {
    // Um `var(--color-foo)` no @theme apontando para nada não gera erro: o
    // utilitário nasce, aplica um valor vazio, e o elemento fica sem cor. Este
    // teste é o que transforma o erro de digitação em falha de CI.
    const raiz = new Set(propsDe(bloco(":root")));
    const tema = bloco("@theme inline");
    const consumidos = [...tema.matchAll(/var\((--[a-z0-9-]+)\)/gi)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );

    expect(consumidos.length).toBeGreaterThan(50);

    // As duas fontes são injetadas pelo `next/font` como custom property no
    // `<html>` (app/layout.tsx), não pelo `:root` do CSS — por isso não caem na
    // regra acima. A isenção não é um buraco: o teste confere logo abaixo que
    // elas continuam sendo declaradas lá.
    const DE_FORA_DO_CSS = ["--font-atkinson", "--font-mono"];
    const layout = fs.readFileSync(path.join(RAIZ, "app/layout.tsx"), "utf8");
    for (const v of DE_FORA_DO_CSS) {
      expect(layout, `${v} deixou de ser declarada pelo next/font`).toContain(`"${v}"`);
    }

    const orfaos = [...new Set(consumidos)].filter(
      (v) => !raiz.has(v) && !DE_FORA_DO_CSS.includes(v),
    );
    expect(orfaos, `tokens referenciados no @theme mas ausentes do :root`).toEqual([]);
  });

  it("o `@source` cobre toda pasta que realmente escreve className", () => {
    // `source(none)` desliga a descoberta automática. O preço é este: pasta de
    // UI nova fora da lista perde TODAS as classes, sem erro de build — a tela
    // simplesmente renderiza sem estilo.
    const declarados = [...CSS.matchAll(/^@source\s+"\.\.\/([a-z-]+)"/gim)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
    expect(declarados.length).toBeGreaterThan(0);

    const raizesComClasse = fs
      .readdirSync(RAIZ, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => d.name)
      .filter((nome) => {
        // Só interessa pasta que entrega UI ao browser. `tests/` e `docs/`
        // escrevem className em fixture e em exemplo, e ficam de fora de
        // propósito — varrê-las publicaria CSS que nenhuma tela usa.
        if (["tests", "docs", "scripts", "supabase", "public", "tasks", "loop"].includes(nome)) {
          return false;
        }
        return temClassName(path.join(RAIZ, nome));
      });

    const faltando = raizesComClasse.filter((n) => !declarados.includes(n));
    expect(faltando, "pasta com className fora do @source de app/globals.css").toEqual([]);
  });
});

describe("Tailwind 4 — utilitários que mudaram de significado", () => {
  const ARQUIVOS = listarFontes(["app", "components", "lib", "hooks"]);

  it("não usa `rounded` puro — no v4 ele é 0.25rem, não o `--radius-md` do produto", () => {
    // No v3 este projeto redefinia o DEFAULT de borderRadius para
    // `var(--radius-md)` (8px). O v4 não tem esse DEFAULT sobrescrevível — nem
    // por `@utility rounded`, que o embutido vence. Deixar `rounded` puro
    // encolhe o raio de 8px para 4px em silêncio.
    //
    // O `:` dentro do lookbehind é CARGA, não enfeite — quem "simplificar"
    // essa classe de caractere reabre um buraco que este PR já pagou uma vez.
    // Sem ele a guarda só enxerga `rounded` precedido de espaço ou aspas, e
    // passa VERDE por `hover:rounded`, `md:rounded` e
    // `data-[state=active]:rounded`, que encolhem o raio exatamente igual — só
    // que sob condição, que é pior, porque nem na tela salta.
    //
    // A história é o argumento, e ela está no `git log` deste arquivo. As
    // guardas de `outline-none` e `flex-*` têm o `:` desde o PRIMEIRO commit
    // da migração (72d2ed4c): quem as escreveu já conhecia a variante. A linha
    // do `rounded` — a troca principal do PR, 60 linhas varridas contra o
    // merge-base 165e8f0f — nasceu sem ele. Depois o
    // `data-[state=active]:shadow` de `components/ui/tabs.tsx` escapou por
    // essa ausência exata e ganhou o commit 966d8f93, cujo assunto diz
    // literalmente "a sombra da aba ativa tinha o mesmo defeito do `rounded`";
    // a guarda nova nasceu COM o `:` e a do `rounded` continuou sem. Ou seja:
    // consertou-se a instância e não a classe, e esta linha era a instância
    // que sobrou. Para reprovar de novo, se alguém duvidar: plante
    // `hover:rounded` num `className` de `components/` e rode este arquivo.
    const culpados = ocorrencias(ARQUIVOS, /(?<=[\s"'`:])rounded(?=[\s"'`!]|$)/g);
    expect(culpados, "use `rounded-md` (8px) ou o grau explícito").toEqual([]);
  });

  it("não usa `outline-none` — no v4 esse nome virou `outline-hidden`", () => {
    // O `outline-none` do v4 é outra coisa (`outline-style: none`) e não
    // preserva o contorno transparente que o modo de alto contraste do sistema
    // precisa. Trocar por engano degrada acessibilidade sem quebrar nada.
    const culpados = ocorrencias(ARQUIVOS, /(?<=[\s"'`:])outline-none(?=[\s"'`!]|$)/g);
    expect(culpados, "use `outline-hidden`").toEqual([]);
  });

  it("não usa `shadow` puro — o v4 embute um preto fixo, cego ao tema escuro", () => {
    // Irmão exato do caso `rounded` acima, e a razão de ele existir: o v3
    // redefinia DOIS defaults contra token do produto —
    // `borderRadius.DEFAULT: var(--radius-md)` e `boxShadow.DEFAULT:
    // var(--shadow-sm)`. A migração varreu o primeiro e passou reto pelo
    // segundo, porque `shadow` não tem hífen e não casa nenhuma varredura de
    // `shadow-*`.
    //
    // Medido com o `@tailwindcss/cli` 4.3.3 contra este mesmo globals.css:
    //   .shadow    → 0 1px 3px 0 rgb(0 0 0 / 0.1), …   ← literal, FIXO
    //   .shadow-sm → var(--shadow-sm)                  ← o token, que muda no escuro
    // O `--shadow-sm` do produto é rgba(20,18,14,…) no claro e rgba(0,0,0,.40)
    // no escuro. `shadow` puro perde a diferença sem erro nenhum: build verde,
    // aba ativa com sombra errada em 11 telas.
    //
    // Não dá para consertar pelo `@theme`: o `.shadow` do v4 é embutido com
    // valor literal e o embutido vence — igual ao `rounded`.
    const culpados = ocorrencias(ARQUIVOS, /(?<=[\s"'`:])shadow(?=[\s"'`!]|$)/g);
    expect(culpados, "use `shadow-sm` (o `--shadow-sm` do produto) ou o grau explícito").toEqual([]);
  });

  it("não usa `flex-shrink-*` / `flex-grow-*` — renomeados para `shrink-*` / `grow-*`", () => {
    const culpados = ocorrencias(ARQUIVOS, /(?<=[\s"'`:])flex-(shrink|grow)(-\d+)?(?=[\s"'`!]|$)/g);
    expect(culpados, "use `shrink-*` / `grow-*`").toEqual([]);
  });
});

describe("Tailwind 4 — `space-*` põe a margem no filho ANTERIOR", () => {
  it("o rótulo declara display de bloco — senão a margem do grupo evapora", () => {
    // O v3 gerava `.space-y-N > :not([hidden]) ~ :not([hidden]) { margin-top }`
    // — margem no filho SEGUINTE. O v4 gera
    // `:where(.space-y-N > :not(:last-child)) { margin-block-end }` — margem no
    // filho ANTERIOR. Num grupo `<Label>` + campo, o anterior é o rótulo; e
    // `<label>` nasce `display: inline`, que IGNORA margem vertical.
    //
    // Resultado medido na migração: todo grupo de formulário perdia exatamente
    // um `--space-N`, colando rótulo e campo. Não gera erro, não muda teste, e
    // some no meio de 91 arquivos alterados.
    const fonte = fs.readFileSync(path.join(RAIZ, "components/ui/label.tsx"), "utf8");
    const classes = /cva\(\s*\n?\s*"([^"]+)"/.exec(fonte)?.[1] ?? "";
    expect(classes, "não achei a string de classe do labelVariants").not.toBe("");
    expect(
      /\b(block|inline-block|flex|inline-flex|grid|inline-grid|table)\b/.test(classes),
      `labelVariants voltou a ser inline: "${classes}"`,
    ).toBe(true);
  });

  it("nenhum `<label>` cru dentro de container espaçado fica sem display", () => {
    // A mesma armadilha do `Label`, na forma solta. Um `<label>` escrito à mão
    // como primeiro filho de um `space-y-*` perde o respiro do grupo — e o
    // componente consertado não o alcança. Achados 10 assim na migração
    // (audit, CapturasTab, onboarding/funil).
    //
    // A heurística é a janela de 3 linhas acima: em JSX o container espaçado
    // abre logo antes do rótulo. Ela erra para menos (rótulo longe do
    // container abridor passa), nunca para mais — e o complemento é a sonda
    // `tests/sonda-tailwind-4-antes-depois.ts`, que mede na TELA quem é inline
    // de verdade. Estática acha barato, sonda acha certo.
    const DISPLAY = /\b(block|inline-block|flex|inline-flex|grid|inline-grid|table)\b/;
    const suspeitos: string[] = [];
    for (const f of listarFontes(["app", "components"])) {
      if (!f.endsWith(".tsx")) continue;
      const linhas = fs.readFileSync(f, "utf8").split("\n");
      linhas.forEach((linha, i) => {
        const m = /<label[^>]*className="([^"]*)"/.exec(linha);
        if (!m || DISPLAY.test(m[1] ?? "")) return;
        const contexto = linhas.slice(Math.max(0, i - 3), i).join("\n");
        if (/space-[xy]-[0-9.]+/.test(contexto)) {
          suspeitos.push(`${path.relative(RAIZ, f)}:${i + 1}`);
        }
      });
    }
    expect(suspeitos, "adicione `block` — senão a margem do grupo evapora").toEqual([]);
  });

  it("nenhum componente de rótulo do design system fica sem display", () => {
    // Generaliza o de cima: qualquer `<label` cru que este projeto renderize
    // dentro de um grupo espaçado tem o mesmo problema. Aqui a guarda é sobre
    // os componentes de UI, que são os reusados; rótulo solto em tela é achado
    // de sonda (`tests/sonda-tailwind-4-antes-depois.ts`), não de unidade.
    const dir = path.join(RAIZ, "components/ui");
    const suspeitos: string[] = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      for (const m of src.matchAll(/<label\s+className="([^"]*)"/g)) {
        const c = m[1] ?? "";
        if (!/\b(block|inline-block|flex|inline-flex|grid|table)\b/.test(c)) {
          suspeitos.push(`components/ui/${f}: <label className="${c.slice(0, 50)}">`);
        }
      }
    }
    expect(suspeitos, "rótulo inline dentro de componente de UI").toEqual([]);
  });
});

// ── auxiliares ────────────────────────────────────────────────────────────

function listarFontes(raizes: string[]): string[] {
  const saida: string[] = [];
  const anda = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name === "node_modules" || d.name.startsWith(".")) continue;
        anda(p);
      } else if (/\.tsx?$/.test(d.name) && !/\.(test|spec)\.tsx?$/.test(d.name)) {
        saida.push(p);
      }
    }
  };
  for (const r of raizes) {
    const p = path.join(RAIZ, r);
    if (fs.existsSync(p)) anda(p);
  }
  return saida;
}

// ⚠️ O LOOKAHEAD `(?=[\s"\'`!]|$)` DAS QUATRO REGEXES, e por que ele tem `!` e `$`.
//
// Esta é a TERCEIRA vez que o mesmo defeito aparece neste arquivo, e as duas
// primeiras foram consertadas por INSTÂNCIA — que é justamente o que deixou a
// terceira nascer:
//
//   1ª  `data-[state=active]:shadow` escapou porque o LOOKBEHIND não tinha `:`.
//       Conserto: pôr `:` na regex do `shadow`.
//   2ª  `hover:rounded` escapou pelo MESMO motivo, na regex do `rounded`, que
//       tinha ficado de fora do conserto anterior.
//       Conserto: pôr `:` na regex do `rounded`.
//   3ª  `rounded!` e `rounded` no FIM DA LINHA escapavam pelo LOOKAHEAD, que era
//       `(?=[\s"\'`])` nas quatro — cego para o sufixo `!` (a forma `important`
//       do Tailwind 4) e para o fim de linha, que acontece em toda classe que
//       cai no fim de um template literal multi-linha.
//
// O conserto da 3ª foi aplicado nas QUATRO ao mesmo tempo, de propósito. As duas
// primeiras vezes trataram o sítio que doía e deixaram os irmãos com o mesmo
// buraco; a lição é que o furo é da FORMA da regex, não da classe que ela caça.
//
// Provado por plantio, com a previsão escrita antes: com o lookahead velho, dos
// três violadores (`rounded!`, `rounded` no fim de linha, `rounded ` com espaço)
// a guarda pegava UM. Com o novo, pega os três — e `rounded-md`, `rounded-lg`,
// `rounded-full!` continuam passando, que é o controle que impede uma regex de
// "acertar" reprovando tudo.
//
// O que este lookahead NÃO cobre, escrito para ninguém supor que cobre: classe
// colada em outra sem separador (`roundedpx-2` não é classe válida, então não
// importa), e classe montada por concatenação em tempo de execução
// (`"round" + "ed"`), que nenhuma varredura de texto pega.
function ocorrencias(arquivos: string[], rx: RegExp): string[] {
  const achados: string[] = [];
  for (const f of arquivos) {
    const linhas = fs.readFileSync(f, "utf8").split("\n");
    linhas.forEach((linha, i) => {
      // Prosa não é classe. `lib/ai/cost.ts` documenta "rounded up" e viraria
      // culpado; a heurística de linha de comentário é grosseira mas suficiente,
      // porque nenhuma classe do produto mora em linha iniciada por `*` ou `//`.
      const cru = linha.trimStart();
      if (cru.startsWith("*") || cru.startsWith("//") || cru.startsWith("/*")) return;
      if (new RegExp(rx.source, rx.flags.replace("g", "")).test(linha)) {
        achados.push(`${path.relative(RAIZ, f)}:${i + 1}`);
      }
    });
  }
  return achados;
}

function temClassName(dir: string): boolean {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === "node_modules" || d.name.startsWith(".")) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (temClassName(p)) return true;
    } else if (/\.tsx$/.test(d.name) && fs.readFileSync(p, "utf8").includes("className=")) {
      return true;
    }
  }
  return false;
}

/**
 * O `/60` que nunca pintou — e que a migração fez pintar.
 *
 * No v3 este projeto mapeava os tokens de cor para `var(--color-…)`, um valor
 * de cor COMPLETO. O modificador de alpha do v3 só sabia injetar opacidade em
 * canais (`rgb(var(--x) / <alpha-value>)`); diante de um `var()` inteiro ele
 * não tinha onde encaixar o número e **descartava o `/NN` em silêncio**. Ou
 * seja: `text-muted-foreground/60` renderizava cor cheia, e a transparência que
 * o autor escreveu nunca existiu na tela.
 *
 * O v4 resolve alpha por `color-mix()`, que funciona com qualquer valor. Medido
 * neste mesmo globals.css:
 *   .text-muted-foreground\/60 → color-mix(in oklab,
 *                                  var(--color-text-muted) 60%, transparent)
 * A transparência passa a valer de verdade — e aí o que era decoração morta
 * vira contraste real. No tema claro o rótulo de grupo do menu caía de 6.98:1
 * para 2.77:1, abaixo do mínimo AA de 4.5:1, e reprovava o `expectNoBlockingA11y`
 * de `tests/e2e/rbac-roles.spec.ts` com violação `color-contrast` (serious).
 *
 * Esta guarda não tem lista de nomes proibidos: ela LÊ a paleta do globals.css,
 * resolve o token nos DOIS temas e calcula o contraste. Um alpha que passe
 * folgado continua permitido; um que derrube o texto abaixo de 4.5:1 reprova
 * sozinho, sem ninguém precisar lembrar de atualizar lista nenhuma. É a
 * diferença entre prender a instância e prender a classe — e ela se paga: a
 * varredura à mão que precedeu esta guarda cobriu quatro famílias de token e
 * passou reto por `text-warning/80`, que a versão calculada achou de graça.
 *
 * Duas decisões de MEDIDA, ambas para não gerar falso vermelho (guarda que
 * mente é guarda que a próxima pessoa desliga):
 *
 *  1. `<x>-foreground` é medido contra `--color-<x>`, não contra o fundo da
 *     página. `text-primary-foreground` é o texto DENTRO do balão `bg-primary`;
 *     medi-lo sobre `--color-surface` dá 1.00:1 — número sem sentido, porque
 *     essa combinação não existe na tela.
 *  2. Linha com `aria-hidden` é pulada. São ícones decorativos, que o próprio
 *     axe não submete à regra `color-contrast` por não serem texto.
 */
describe("Tailwind 4 — alpha em cor de texto agora PINTA, então precisa passar no contraste", () => {
  const MINIMO_AA = 4.5;
  /** Fundos de página, por nome de token (sem o prefixo `--color-`). */
  const FUNDOS_DE_PAGINA = ["surface", "bg", "surface-elevated"];

  /** `#rgb`/`#rrggbb` → canais. Devolve null para o que não sabemos medir. */
  function canais(v: string): [number, number, number] | null {
    const s = v.trim();
    const m6 = /^#([0-9a-f]{6})$/i.exec(s);
    if (m6?.[1]) {
      const h = m6[1];
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    }
    const m3 = /^#([0-9a-f]{3})$/i.exec(s);
    if (m3?.[1]) {
      const h = m3[1];
      return [0, 1, 2].map((i) => parseInt(h[i]! + h[i]!, 16)) as [number, number, number];
    }
    return null;
  }

  /** Declarações `--x: valor` de um bloco, como mapa. */
  function mapaDe(texto: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const d of texto.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
      if (d[1] && d[2] && !m.has(d[1])) m.set(d[1], d[2].trim());
    }
    return m;
  }

  const TEMA = {
    claro: mapaDe(bloco(":root")),
    escuro: mapaDe(bloco('[data-theme="dark"]')),
  };
  const PONTE = mapaDe(bloco("@theme inline"));

  /**
   * Resolve o token até um hex, seguindo `var(--color-y)` pela ponte do
   * `@theme` e pela paleta do tema. Devolve null quando não chega a um hex — e
   * quem chama TRATA o null como "não sei medir", nunca como "passou".
   */
  function corDoToken(nome: string, tema: "claro" | "escuro"): [number, number, number] | null {
    let atual = `--color-${nome}`;
    for (let i = 0; i < 8; i++) {
      const bruto = TEMA[tema].get(atual) ?? PONTE.get(atual);
      if (!bruto) return null;
      const direto = canais(bruto);
      if (direto) return direto;
      const via = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(bruto);
      if (!via?.[1]) return null;
      if (via[1] === atual) {
        // `--x: var(--x)` é a ponte do `@theme inline` apontando para a
        // primitiva de mesmo nome; a paleta do tema é quem tem o valor.
        const prim = TEMA[tema].get(atual);
        return prim ? canais(prim) : null;
      }
      atual = via[1];
    }
    return null;
  }

  function luminancia([r, g, b]: [number, number, number]): number {
    const c = [r, g, b].map((v) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contraste(fg: [number, number, number], bg: [number, number, number]): number {
    const [a, b] = [luminancia(fg), luminancia(bg)].sort((x, y) => y - x) as [number, number];
    return (a + 0.05) / (b + 0.05);
  }

  function sobre(
    fg: [number, number, number],
    bg: [number, number, number],
    alpha: number,
  ): [number, number, number] {
    return fg.map((f, i) => Math.round(f * alpha + bg[i]! * (1 - alpha))) as [
      number,
      number,
      number,
    ];
  }

  /** Os fundos contra os quais ESTE token é medido — ver decisão (1) acima. */
  function fundosDe(token: string): string[] {
    const par = /^(.+)-foreground$/.exec(token)?.[1];
    if (!par) return FUNDOS_DE_PAGINA;
    // `muted-foreground` e irmãos neutros resolvem para um fundo de página; aí
    // medir contra os três é mais fiel do que contra o par nominal, porque é
    // assim que eles aparecem na tela (texto secundário sobre card, bg, etc.).
    const corDoPar = corDoToken(par, "claro");
    const ehFundoDePagina = FUNDOS_DE_PAGINA.some((f) => {
      const c = corDoToken(f, "claro");
      return c && corDoPar && c.join() === corDoPar.join();
    });
    return ehFundoDePagina || !corDoPar ? FUNDOS_DE_PAGINA : [par];
  }

  it("nenhum `text-<token>/<alpha>` cai abaixo de 4.5:1 em nenhum dos dois temas", () => {
    const ARQUIVOS = listarFontes(["app", "components", "lib", "hooks"]);
    const rx = /(?<=[\s"'`:])text-([a-z][a-z0-9-]*)\/(\d{1,3})(?=[\s"'`!]|$)/g;

    const reprovados: string[] = [];
    const naoMedidos: string[] = [];
    let medidos = 0;

    for (const f of ARQUIVOS) {
      const linhas = fs.readFileSync(f, "utf8").split("\n");
      linhas.forEach((linha, i) => {
        const cru = linha.trimStart();
        if (cru.startsWith("*") || cru.startsWith("//") || cru.startsWith("/*")) return;
        if (linha.includes("aria-hidden")) return; // ver decisão (2) acima
        for (const m of linha.matchAll(rx)) {
          const token = m[1]!;
          const alpha = Number(m[2]) / 100;
          const onde = `${path.relative(RAIZ, f)}:${i + 1}  text-${token}/${m[2]}`;
          for (const tema of ["claro", "escuro"] as const) {
            const cor = corDoToken(token, tema);
            if (!cor) {
              // Sonda cega que devolve verde é indistinguível de guarda morta:
              // registra em vez de silenciar.
              naoMedidos.push(`${onde} [${tema}]`);
              continue;
            }
            for (const nomeFundo of fundosDe(token)) {
              const bg = corDoToken(nomeFundo, tema);
              if (!bg) {
                naoMedidos.push(`${onde} [${tema}] fundo ${nomeFundo}`);
                continue;
              }
              medidos++;
              const r = contraste(sobre(cor, bg, alpha), bg);
              if (r < MINIMO_AA) {
                reprovados.push(
                  `${onde} → ${r.toFixed(2)}:1 sobre --color-${nomeFundo} (${tema}); ` +
                    `sem o /${m[2]} seria ${contraste(cor, bg).toFixed(2)}:1`,
                );
              }
            }
          }
        }
      });
    }

    // Controle positivo: a árvore comprovadamente TEM alphas de cor de texto.
    // Se a contagem de medições zerar, a guarda cegou (regex, paleta renomeada,
    // `bloco()` mudando de forma) e o verde seria falso.
    expect(medidos, `guarda cega: nenhum alpha medido. Não-medidos: ${naoMedidos.join(", ")}`)
      .toBeGreaterThan(0);

    expect(
      [...new Set(reprovados)].sort(),
      "o alpha PINTA no v4: ou tire o `/NN` (restaura o que a produção já mostra) ou use um alpha que passe",
    ).toEqual([]);
  });
});
