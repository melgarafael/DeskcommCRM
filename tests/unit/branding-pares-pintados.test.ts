import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PISOS, extrairRegua, melhorFrenteSobre, razaoDeContraste } from "@/lib/branding/contraste";
import type { Fonte, TemaDaRegua } from "@/lib/branding/contraste";
import { cssDaMarca } from "@/lib/branding/css";
import { GRAUS, compor, normalizarHex, rgbParaHex } from "@/lib/branding/rampa";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { camadaDoAmbiente, resolverMarca, type CorResolvida } from "@/lib/branding/resolve";

/**
 * A guarda que faltava: os pares que o produto REALMENTE PINTA.
 *
 * POR QUE ESTE ARQUIVO EXISTE, tendo `branding-contraste.test.ts` 37 casos verdes:
 * aqueles exercitam a FUNÇÃO DE DERIVAÇÃO (`medirPares` sobre a régua), não a
 * TELA. Os dois só coincidem enquanto a emissão entrega ao navegador o mesmo
 * objeto que a derivação mediu — e não entregava. Medido no browser em
 * 2026-08-12, com `APP_ACCENT_HEX="#0f172a"`: o anel de foco no tema escuro deu
 * **2,86** contra `--color-bg` e **2,37** contra `--color-surface-elevated`,
 * abaixo do piso 3,0 de WCAG 1.4.11 — com a suíte inteira verde, porque a
 * derivação mediu o stop deslocado (5,28 e 4,39) e o CSS emitiu o stop cru.
 *
 * Então este arquivo NÃO chama `medirPares`. Ele lê o TEXTO que `cssDaMarca`
 * produz, monta a cascata em miniatura (bloco emitido, 0,2,0, vencendo o
 * `globals.css`, 0,1,0) e mede o pixel resultante com as primitivas de cor. Um
 * defeito dentro de `resolverFonte`/`medirPares` fica VISÍVEL aqui em vez de ser
 * compartilhado — instrumento independente é o ponto, não duplicação por acaso.
 *
 * Os pares saem de `extrairRegua(app/globals.css)`, o arquivo de verdade — e não
 * da régua congelada, que é o que a derivação usa em runtime. Os dois são
 * provados iguais por `branding-regua-do-produto.test.ts`; ler o arquivo aqui
 * garante que, se um dia divergirem, este teste mede a folha que o navegador
 * baixa, não a cópia.
 */

const RAIZ = process.cwd();
const CSS = fs.readFileSync(path.join(RAIZ, "app/globals.css"), "utf8");
const REGUA = extrairRegua(CSS);

/** A mesma fixture adversarial versionada de `branding-contraste.test.ts`. */
const SEMENTES = [
  "#0f172a", "#f5c518", "#ffffff", "#000000", "#808080", "#dc2626", "#22c55e",
  "#f59e0b", "#2563eb", "#14b8a6", "#4b0082", "#e11d48", "#7c3aed", "#1a1f36",
  "#fafafa", "#506d48",
] as const;

/** Quantos pares cada tema tem no globals.css de hoje — o piso da vacuidade.
 * Tema único agora: claro usa o mesmo accent-soft translúcido do escuro, então
 * as contagens batem. 38 e nao 26 desde que `--color-link`/`-hover` entraram
 * com a superficie clara do conteudo: dois papeis a mais x seis superficies. */
const PARES_DE_HOJE = { claro: 38, escuro: 38, superficieClara: 38 } as const;

const TEMAS = [
  { nome: "claro" as const, seletor: ":root:root" },
  { nome: "escuro" as const, seletor: ':root:root[data-theme="dark"]' },
  /**
   * A area de conteudo sobre Paper.
   *
   * Entrar AQUI, e nao num teste proprio, e o ponto: tudo o que este arquivo
   * assere -- piso por par, vacuidade, "o emissor nao pinta superficie", "o
   * bloco nao contradiz o globals.css" -- passa a valer para ela sem uma linha
   * de asserção nova. Antes disso a superficie clara era a unica coisa que o
   * produto pinta e que nenhum portao media: a rampa chegava la deslocada por
   * uma conta feita contra Ink, e o `--color-accent-soft` do bloco era um
   * literal Signal Blue que nenhuma marca de revendedor alcancava.
   */
  { nome: "superficieClara" as const, seletor: ':root:root [data-superficie="clara"]' },
];

const corDe = (hex: string): CorResolvida => {
  const cor = resolverMarca([camadaDoAmbiente({ APP_ACCENT_HEX: hex })], REGUA_DO_PRODUTO).cor;
  if (!cor) throw new Error(`fixture ${hex} não resolveu — o teste mediria nada`);
  return cor;
};

// ── A cascata, em miniatura ──────────────────────────────────────────────────

type Bloco = Readonly<Record<string, string>>;
type Cor = { readonly hex: string; readonly alfa: number };

/** Os blocos do CSS emitido, lidos de volta do TEXTO (nunca do objeto). */
function lerBlocos(css: string): Record<string, Bloco> {
  const saida: Record<string, Bloco> = {};
  for (const bruto of css.split("}")) {
    const abre = bruto.indexOf("{");
    if (abre === -1) continue;
    const decls: Record<string, string> = {};
    for (const linha of bruto.slice(abre + 1).split(";")) {
      const corte = linha.indexOf(":");
      if (corte === -1) continue;
      decls[linha.slice(0, corte).trim()] = linha.slice(corte + 1).trim();
    }
    saida[bruto.slice(0, abre).trim()] = decls;
  }
  return saida;
}

const RGBA = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/;

/** `#abc`, `#aabbcc`, `rgb()`, `rgba()` — as três formas que o emissor produz. */
function lerCor(valor: string): Cor {
  const m = RGBA.exec(valor);
  if (m?.[1] && m[2] && m[3]) {
    return {
      hex: rgbParaHex({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }),
      alfa: m[4] === undefined ? 1 : Number(m[4]),
    };
  }
  // `normalizarHex` LANÇA em valor malformado, de propósito: um `catch` aqui
  // devolveria preto e o par mediria uma tela que não existe.
  return { hex: normalizarHex(valor), alfa: 1 };
}

/** `--color-accent-NNN` do bloco emitido, por índice de grau. */
function rampaEmitida(bloco: Bloco): Map<number, string> {
  const mapa = new Map<number, string>();
  for (const [i, grau] of GRAUS.entries()) {
    const valor = bloco[`--color-accent-${grau}`];
    if (valor !== undefined) mapa.set(i, lerCor(valor).hex);
  }
  return mapa;
}

function daRampa(fonte: Fonte, rampa: ReadonlyMap<number, string>): Cor {
  if (fonte.tipo === "grau") {
    const hex = rampa.get(fonte.indice);
    // Vacuidade: rampa incompleta viraria uma cor inventada e um par verde.
    if (hex === undefined) {
      throw new Error(`o bloco emitido não declara --color-accent-${GRAUS[fonte.indice]}`);
    }
    return { hex, alfa: fonte.alfa };
  }
  if (fonte.tipo === "literal") return { hex: fonte.hex, alfa: fonte.alfa };
  return { hex: melhorFrenteSobre(daRampa(fonte.sobre, rampa).hex), alfa: 1 };
}

/**
 * O pixel de um token na tela. A regra é a cascata e nada mais: o bloco emitido
 * tem especificidade 0,2,0 e vence o `globals.css` (0,1,0), então token que ele
 * declara vale pelo valor emitido; token que ele NÃO declara mantém o que o
 * `globals.css` diz — e o que o `globals.css` diz é `var(--color-accent-NNN)`,
 * que alcança a rampa JÁ emitida. É nessa segunda linha que o defeito morava.
 */
function pintado(
  token: string | null,
  fonte: Fonte,
  bloco: Bloco,
  rampa: ReadonlyMap<number, string>,
): Cor {
  const emitido = token === null ? undefined : bloco[token];
  return emitido === undefined ? daRampa(fonte, rampa) : lerCor(emitido);
}

function superficiesPintadas(
  tema: TemaDaRegua,
  bloco: Bloco,
  rampa: ReadonlyMap<number, string>,
): { chave: string; hex: string }[] {
  // As bases são literais do `globals.css` e o emissor não as toca (asserido em
  // "a cascata é a cascata", abaixo) — se um dia tocar, o teste reprova lá.
  const saida = tema.base.map((b) => ({ chave: b.chave, hex: b.hex }));
  for (const t of tema.tingidas) {
    const cor = pintado(t.chave, t.fonte, bloco, rampa);
    if (cor.alfa >= 1) {
      saida.push({ chave: t.chave, hex: cor.hex });
      continue;
    }
    // Translúcida é N superfícies, uma por base: `rgba()` a 16% sobre
    // `surface-elevated` é outro pixel que sobre `bg`, e a razão difere.
    for (const b of tema.base) {
      saida.push({ chave: `${t.chave}@${b.chave}`, hex: compor(cor.hex, cor.alfa, b.hex) });
    }
  }
  return saida;
}

type ParPintado = {
  readonly papel: string;
  readonly superficie: string;
  readonly razao: number;
  readonly piso: number;
  readonly passa: boolean;
};

/** Todos os pares papel × superfície de um tema, medidos no pixel emitido. */
function paresPintados(tema: TemaDaRegua, bloco: Bloco): ParPintado[] {
  const rampa = rampaEmitida(bloco);
  const superficies = superficiesPintadas(tema, bloco, rampa);
  const pares: ParPintado[] = [];
  for (const papel of tema.papeis) {
    const frente = pintado(papel.token, papel.fonte, bloco, rampa);
    // `--color-accent-fg` é medido contra `--color-accent`: o `Fonte` que a
    // régua guarda (grau 6) é só a FORMA como o `globals.css` escreve esse
    // token, e na tela o fundo é o TOKEN, que o bloco emitido reescreve.
    const tokenDoAlvo = papel.token.endsWith("-fg")
      ? papel.token.slice(0, -"-fg".length)
      : null;
    const alvos =
      papel.contra === null
        ? superficies
        : papel.contra.map((f) => ({
            chave: tokenDoAlvo ?? papel.token,
            hex: pintado(tokenDoAlvo, f, bloco, rampa).hex,
          }));
    for (const alvo of alvos) {
      const cor = frente.alfa >= 1 ? frente.hex : compor(frente.hex, frente.alfa, alvo.hex);
      const piso = PISOS[papel.tipo];
      const razao = razaoDeContraste(cor, alvo.hex);
      pares.push({ papel: papel.token, superficie: alvo.chave, razao, piso, passa: razao >= piso });
    }
  }
  return pares;
}

/** Os pares dos dois temas de uma semente, prontos para asserir. */
type NomeDeSuperficie = (typeof TEMAS)[number]["nome"];

function pintadosDaSemente(hex: string): Record<NomeDeSuperficie, ParPintado[]> {
  const { css } = cssDaMarca(corDe(hex));
  if (css === null) throw new Error(`${hex}: o emissor recusou — não há tela para medir`);
  const blocos = lerBlocos(css);
  const saida = {} as Record<NomeDeSuperficie, ParPintado[]>;
  for (const { nome, seletor } of TEMAS) {
    const bloco = blocos[seletor];
    if (!bloco) throw new Error(`${hex}: o CSS emitido não tem o bloco ${seletor}`);
    saida[nome] = paresPintados(REGUA[nome], bloco);
  }
  return saida;
}

const foco = (pares: readonly ParPintado[], superficie: string): number =>
  pares.find((p) => p.papel.includes(":focus-visible") && p.superficie === superficie)?.razao ?? 0;

// ── Os testes ────────────────────────────────────────────────────────────────

describe("o que o produto pinta — todo par, toda semente", () => {
  it.each(SEMENTES)(
    "%s: nenhum papel abaixo do piso, nas tres superficies, no pixel emitido",
    (hex) => {
      const pintados = pintadosDaSemente(hex);
      for (const { nome } of TEMAS) {
        const pares = pintados[nome];
        // Vacuidade POR SEMENTE E POR TEMA: uma instrumentação que devolvesse
        // lista vazia passaria no filtro abaixo sem ter medido nada.
        expect(pares.length, `${hex}/${nome}: nenhum par medido`).toBeGreaterThanOrEqual(
          PARES_DE_HOJE[nome],
        );
        const reprovas = pares.filter((p) => !p.passa);
        expect(
          reprovas,
          `${hex}/${nome}: ` +
            reprovas
              .map((r) => `${r.papel}×${r.superficie}=${r.razao.toFixed(2)}<${r.piso}`)
              .join(" | "),
        ).toEqual([]);
      }
    },
  );

  it("a instrumentação vê os papéis frágeis — inclusive o de stop fixo por tema", () => {
    // O anel de foco usa stop FIXO por tema (500 no claro, 400 no escuro,
    // globals.css:376 e :381) e não passa por token nenhum — é exatamente a
    // categoria que a régua alcança e que a emissão deixava para trás. Se ele
    // sumir do conjunto medido, os pares acima ficam verdes sem cobri-lo.
    const pintados = pintadosDaSemente("#506d48");
    for (const { nome } of TEMAS) {
      const papeis = new Set(pintados[nome].map((p) => p.papel));
      expect([...papeis].some((p) => p.includes(":focus-visible")), nome).toBe(true);
      expect([...papeis], nome).toContain("--ring");
      expect(papeis.size, nome).toBe(REGUA[nome].papeis.length);
    }
    expect(pintados.claro).toHaveLength(PARES_DE_HOJE.claro);
    expect(pintados.escuro).toHaveLength(PARES_DE_HOJE.escuro);
    expect(pintados.superficieClara).toHaveLength(PARES_DE_HOJE.superficieClara);
  });

  it("a cascata é a cascata: o emissor não pinta superfície nem inventa token", () => {
    // Se o bloco emitido passasse a declarar `--color-bg`, as bases literais que
    // este teste usa como superfície virariam ficção e todos os pares acima
    // mediriam uma tela que não existe.
    const { css } = cssDaMarca(corDe("#2563eb"));
    const blocos = lerBlocos(css ?? "");
    for (const { seletor } of TEMAS) {
      const bloco = blocos[seletor] ?? {};
      for (const chave of ["--color-bg", "--color-surface", "--color-surface-elevated"]) {
        expect(bloco[chave], `${seletor} declarou ${chave}`).toBeUndefined();
      }
      // E a rampa sai inteira: 11 stops, senão `daRampa` lança.
      expect(rampaEmitida(bloco).size, seletor).toBe(11);
    }
  });
});

describe("o bloco emitido não pode contradizer o globals.css", () => {
  it("`--color-accent` É `var(--color-accent-NNN)`, como a folha declara", () => {
    // ESTA é a forma curta do defeito. O `globals.css` declara
    // `--color-accent: var(--color-accent-600)` (claro) e `var(--color-accent-400)`
    // (escuro). Quando a emissão mandava a rampa CRUA e os papéis DESLOCADOS, o
    // mesmo bloco dizia `--color-accent-400: #545f77` e `--color-accent: #828a9d`
    // — duas verdades, e quem lia a rampa direto (`--ring`, `::selection`,
    // `:focus-visible`, `focus-visible:ring-accent-500` nos componentes) ficava
    // com a de antes da caminhada.
    for (const hex of SEMENTES) {
      const { css } = cssDaMarca(corDe(hex));
      const blocos = lerBlocos(css ?? "");
      for (const { nome, seletor } of TEMAS) {
        const bloco = blocos[seletor] ?? {};
        const { indices } = REGUA[nome];
        const rotulo = `${hex}/${nome}`;
        expect(bloco["--color-accent"], `${rotulo}: --color-accent`).toBe(
          bloco[`--color-accent-${GRAUS[indices.accent]}`],
        );
        expect(bloco["--color-accent-hover"], `${rotulo}: --color-accent-hover`).toBe(
          bloco[`--color-accent-${GRAUS[indices.hover]}`],
        );
        // `--color-accent-soft` no escuro é translúcido (`rgba(…, 0.16)`): a
        // identidade vale sobre a TINTA, e o índice do soft de lá é nulo — o
        // token é reancorado no stop do accent (ver `resolverSoft`).
        const tinta = lerCor(bloco["--color-accent-soft"] ?? "#000000").hex;
        const ancora = GRAUS[indices.soft ?? indices.accent];
        expect(tinta, `${rotulo}: --color-accent-soft`).toBe(
          lerCor(bloco[`--color-accent-${ancora}`] ?? "#000000").hex,
        );
      }
    }
  });

  it("a caminhada de fato ANDA — e a emissão anda junto", () => {
    // Guarda de vacuidade da sabotagem: se nenhuma semente deslocasse, emitir a
    // rampa crua e emiti-la deslocada dariam o mesmo texto, e os testes acima
    // seriam verdes contra o defeito.
    //
    // 24 combos (semente × superficie) andam: 10 + 10 dos dois temas e 4 da
    // superficie clara.
    //
    // Ela anda MENOS que os temas, e isso e resultado, nao sorte: o
    // `--color-accent-hover` apontando para accent-700 no bloco da superficie
    // clara (globals.css) tira do caminho o par que reprovava por 0,05 e
    // empurrava quase toda marca um passo. Antes desse conserto eram 13 aqui.
    // Andar menos e o objetivo -- cada passo afasta a tela do hex que a pessoa
    // escolheu.
    let andaram = 0;
    for (const hex of SEMENTES) {
      const cor = corDe(hex);
      const { css } = cssDaMarca(cor);
      const blocos = lerBlocos(css ?? "");
      for (const { nome, seletor } of TEMAS) {
        const d = cor.derivada?.[nome].deslocamento ?? 0;
        if (d === 0) continue;
        andaram += 1;
        const rampa = rampaEmitida(blocos[seletor] ?? {});
        const crua = cor.derivada?.rampa ?? [];
        // A rampa emitida É a rampa da marca escorregada por `d`; a igualdade
        // com a crua seria a assinatura do defeito de volta.
        expect(rampa.get(REGUA[nome].indices.accent), `${hex}/${nome}`).not.toBe(
          crua[REGUA[nome].indices.accent],
        );
      }
    }
    expect(andaram).toBe(24);
  });
});

describe("controle positivo — o produto sem marca não pode se mexer", () => {
  it("a Signal Blue reproduz, pintada, os números do design system", () => {
    // `#3b6fd4` é a semente do próprio produto: ela não desloca nada, e os
    // pares pintados têm que dar o que o `globals.css` sempre deu. Se estes
    // números mudarem, o conserto vazou para quem não pediu.
    const cor = corDe("#3b6fd4");
    expect(cor.derivada?.claro.deslocamento).toBe(0);
    expect(cor.derivada?.escuro.deslocamento).toBe(0);

    const p = pintadosDaSemente("#3b6fd4");
    // Tema único agora: claro e escuro dão os MESMOS números — a paleta é a
    // mesma nos dois blocos do CSS.
    expect(foco(p.claro, "--color-bg")).toBeCloseTo(4.06, 2);
    expect(foco(p.claro, "--color-surface-elevated")).toBeCloseTo(3.41, 2);
    expect(foco(p.escuro, "--color-bg")).toBeCloseTo(4.06, 2);
    expect(foco(p.escuro, "--color-surface-elevated")).toBeCloseTo(3.41, 2);
    // O par que mais aperta é o anel contra a superfície composta com o
    // `-soft` translúcido (accent misturado 8% sobre `surface`/`surface-
    // elevated`) — ainda acima do piso 3,0, mas com folga menor que os pares
    // diretos acima. É o mesmo par que o comentário no topo do `globals.css`
    // documenta como o que quase reprova (Oxford Blue é próxima do accent).
    expect(foco(p.escuro, "--color-accent-soft@--color-surface")).toBeCloseTo(3.54, 2);
    expect(foco(p.escuro, "--color-accent-soft@--color-surface-elevated")).toBeCloseTo(3.15, 2);
  });

  it("sem marca configurada nada é injetado, e a tela fica como está", () => {
    // O caminho de fábrica: `null` sem motivo. Nenhum bloco no `<head>`, nenhum
    // token vencido, o `globals.css` intacto — que é a instalação correta.
    expect(cssDaMarca(null)).toEqual({ css: null, motivos: [] });
  });
});

describe("a navy #0f172a — o defeito que a prova em tela achou", () => {
  it("os quatro números do anel de foco, agora acima do piso", () => {
    // ANTES (medido no browser, servidor de dev na 3111, com a paleta Sage):
    // claro 10,77 e 10,22; escuro 2,86 e 2,37 — os dois de baixo abaixo do piso
    // 3,0. Com a paleta Ink (tema único), claro e escuro dão o MESMO número
    // agora: 5,58 e 4,70, os dois folgados acima do piso — a navy passa direto
    // no seu próprio stop 600 nos dois blocos, sem precisar andar.
    const p = pintadosDaSemente("#0f172a");
    expect(foco(p.claro, "--color-bg")).toBeCloseTo(5.58, 2);
    expect(foco(p.claro, "--color-surface-elevated")).toBeCloseTo(4.7, 2);
    expect(foco(p.escuro, "--color-bg")).toBeCloseTo(5.58, 2);
    expect(foco(p.escuro, "--color-surface-elevated")).toBeCloseTo(4.7, 2);
    for (const superficie of ["--color-bg", "--color-surface-elevated"] as const) {
      expect(foco(p.claro, superficie), superficie).toBeGreaterThanOrEqual(PISOS.componente);
      expect(foco(p.escuro, superficie), superficie).toBeGreaterThanOrEqual(PISOS.componente);
    }
  });
});
