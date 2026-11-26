/**
 * Fork Ânima — veste os tokens do `app/globals.css` com o Design System Ânima.
 *
 *   pnpm exec tsx scripts/anima/gerar-tokens-ds.ts            # reescreve
 *   pnpm exec tsx scripts/anima/gerar-tokens-ds.ts --conferir # só confere (exit 1 se divergir)
 *
 * POR QUE UM GERADOR, E NÃO `var(--token-do-ds)` NO CSS
 * -----------------------------------------------------
 * O `globals.css` do upstream não é só CSS: `extrairRegua()` (lib/branding/contraste.ts) lê os
 * HEX LITERAIS dos blocos `:root` e `[data-theme="dark"]` para montar a régua de contraste que a
 * marca de runtime usa, e a congela em `lib/branding/regua-do-produto.ts` (gerado, comparado por
 * teste). Um `var()` ali quebra a extração. Além disso, os nomes do DS (`--primary`, `--radius-lg`…)
 * colidem com os do app, e o tema escuro do DS só vale sob `.dark`, não sob `[data-theme]`.
 *
 * Então os valores saem do PACOTE (`@anima-solutions/design-system/tokens/*.json`) e entram como
 * literais. Ninguém copia hex à mão: `make ds-update` reinstala o pacote e roda este script.
 *
 * O QUE O SCRIPT FAZ
 * ------------------
 * Só TROCA O VALOR de propriedades que já existem nos três blocos de token (`:root`,
 * `[data-theme="light"]`, `[data-theme="dark"]`). Não cria nem remove propriedade, não toca em
 * comentário: o diff contra o upstream fica restrito a valores. Propriedade ausente = erro (o
 * upstream mudou a estrutura; revisar à mão).
 *
 * Valores que o DS não traz são DERIVADOS de valores do DS, de forma declarada:
 *  - escala da cor de destaque (`--color-accent-50…950`): a escada de luminosidade do upstream com
 *    o matiz de `--brand-primary`, que entra literal no grau da luminosidade dele (ver
 *    `escalaDoProduto`). No escuro o destaque é o limão; no claro, o grau que a caminhada de
 *    contraste do upstream (`escolherAccent`) aprova (o limão sólido não passa 4,5:1 no claro);
 *  - escala de neutros: a escada de luminosidade do upstream (constantes abaixo) com o matiz do
 *    eixo preto↔branco da marca;
 *  - fundo atenuado de status: o papel com 15% de opacidade (regra do guia de cores do DS);
 *  - texto de status: o papel, escurecido/clareado só o necessário para 4,5:1 sobre o fundo atenuado.
 *
 * Ficam com o valor do upstream: cores de canal, cores de pessoa da agenda, overlay, movimento,
 * espaçamento, z-index e densidade.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  type Regua,
  extrairRegua,
  luminanciaRelativa,
  medirPares,
  melhorFrenteSobre,
  razaoDeContraste,
} from "@/lib/branding/contraste";
import {
  CURVA_C,
  ESCADA_L,
  GRAUS,
  type Grau,
  type Rampa,
  compor,
  deltaEOklab,
  hexParaOklab,
  hexParaOklch,
  linearParaHex,
  oklabParaLinear,
  oklchParaHex,
} from "@/lib/branding/rampa";

const RAIZ = process.cwd();
const CAMINHO_CSS = path.join(RAIZ, "app/globals.css");
const CAMINHO_REGUA = path.join(RAIZ, "lib/branding/regua-do-produto.ts");
const CONFERIR = process.argv.includes("--conferir");

// ── Leitura do pacote ────────────────────────────────────────────────────────

type No = { $type?: string; $value?: unknown; [k: string]: unknown };
type Cor = { hex: string; alfa: number };

const exigir = createRequire(import.meta.url);
const DIR_TOKENS = path.join(
  path.dirname(exigir.resolve("@anima-solutions/design-system/package.json")),
  "dist/tokens",
);
const VERSAO_DS: string = JSON.parse(
  fs.readFileSync(exigir.resolve("@anima-solutions/design-system/package.json"), "utf8"),
).version;

function lerJson(nome: string): No {
  return JSON.parse(fs.readFileSync(path.join(DIR_TOKENS, `${nome}.json`), "utf8")) as No;
}

const BASE = lerJson("base");
const TEMAS = { claro: lerJson("light"), escuro: lerJson("dark") } as const;
type NomeTema = keyof typeof TEMAS;

function noNoCaminho(raiz: No, caminho: string): No | undefined {
  let atual: unknown = raiz;
  for (const parte of caminho.split(".")) {
    if (!atual || typeof atual !== "object") return undefined;
    atual = (atual as Record<string, unknown>)[parte];
  }
  return atual as No | undefined;
}

function valorBruto(tema: NomeTema, caminho: string): unknown {
  const no = noNoCaminho(TEMAS[tema], caminho) ?? noNoCaminho(BASE, caminho);
  if (!no || !("$value" in no)) throw new Error(`DS ${VERSAO_DS}: token "${caminho}" não existe`);
  const v = no.$value;
  if (typeof v === "string" && /^\{[^}]+\}$/.test(v)) return valorBruto(tema, v.slice(1, -1));
  return v;
}

function cor(tema: NomeTema, caminho: string): Cor {
  const v = valorBruto(tema, caminho);
  if (typeof v === "string") return { hex: v.toLowerCase(), alfa: 1 };
  const o = v as { hex?: string; alpha?: number };
  if (!o?.hex) throw new Error(`DS: "${caminho}" não é cor`);
  return { hex: o.hex.toLowerCase(), alfa: o.alpha ?? 1 };
}

function hex(tema: NomeTema, caminho: string): string {
  const c = cor(tema, caminho);
  if (c.alfa !== 1) throw new Error(`DS: "${caminho}" tem transparência; use cor()`);
  return c.hex;
}

function px(v: unknown): string {
  const d = v as { value: number; unit: string };
  return d.value === 0 ? "0" : `${d.value}${d.unit}`;
}

function rgba({ hex: h, alfa }: Cor): string {
  const n = parseInt(h.slice(1), 16);
  const a = Math.round(alfa * 1000) / 1000;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function sombra(caminho: string): string {
  const v = valorBruto("claro", caminho);
  const camadas = (Array.isArray(v) ? v : [v]) as {
    color: { hex: string; alpha?: number };
    offsetX: unknown;
    offsetY: unknown;
    blur: unknown;
    spread: unknown;
    inset?: boolean;
  }[];
  return camadas
    .map((c) => {
      const partes = [px(c.offsetX), px(c.offsetY), px(c.blur), px(c.spread)];
      const corCss = rgba({ hex: c.color.hex, alfa: c.color.alpha ?? 1 });
      return `${c.inset ? "inset " : ""}${partes.join(" ")} ${corCss}`;
    })
    .join(", ");
}

// ── Derivações declaradas ────────────────────────────────────────────────────

/**
 * Escada de luminosidade (OKLab L) dos neutros do upstream, medida em `app/globals.css` na
 * v1.125.0. Preserva os degraus de contraste que o upstream desenhou (texto terciário, bordas);
 * só o matiz vem da marca.
 */
const ESCADA_NEUTROS: Record<NomeTema, readonly number[]> = {
  claro: [0.982, 0.9583, 0.9165, 0.8485, 0.7165, 0.5735, 0.4646, 0.3832, 0.2931, 0.2186, 0.1591],
  escuro: [0.9665, 0.9182, 0.7816, 0.6358, 0.4806, 0.3781, 0.3128, 0.2675, 0.2257, 0.195, 0.1495],
};

function neutros(tema: NomeTema): string[] {
  const branco = hexParaOklab(hex(tema, "color.brand-white"));
  const preto = hexParaOklab(hex(tema, "color.brand-black"));
  return ESCADA_NEUTROS[tema].map((L) => {
    const t = Math.max(0, Math.min(1, (branco.L - L) / (branco.L - preto.L)));
    return linearParaHex(
      oklabParaLinear({
        L,
        a: branco.a + (preto.a - branco.a) * t,
        b: branco.b + (preto.b - branco.b) * t,
      }),
    );
  });
}

/** Ajusta só a luminosidade até o texto passar `piso` sobre todos os fundos. */
function frenteLegivel(corDoPapel: string, fundos: string[], piso = 4.5): string {
  const ok = (c: string) => fundos.every((f) => razaoDeContraste(c, f) >= piso);
  if (ok(corDoPapel)) return corDoPapel;
  const escurecer = luminanciaRelativa(fundos[0]!) > 0.18;
  const { L, C, h } = hexParaOklch(corDoPapel);
  for (let passo = 1; passo <= 200; passo++) {
    const novoL = escurecer ? L - passo * 0.005 : L + passo * 0.005;
    if (novoL <= 0 || novoL >= 1) break;
    const candidato = oklchParaHex({ L: novoL, C, h });
    if (ok(candidato)) return candidato;
  }
  throw new Error(`não achei frente legível para ${corDoPapel}`);
}

const ALFA_DO_FUNDO_DE_STATUS = 0.15;
const STATUS = { success: "success", warning: "warning", error: "destructive", info: "info" };

// ── Mapeamento ───────────────────────────────────────────────────────────────

type Decls = Record<string, string>;

function valoresDoTema(tema: NomeTema): Decls {
  const fundo = hex(tema, "color.background");
  const superficie = hex(tema, "color.card");
  const n = neutros(tema);
  const d: Decls = {
    "--color-bg": fundo,
    "--color-surface": superficie,
    "--color-surface-elevated": hex(tema, "color.surface"),
    "--color-text": hex(tema, "color.foreground"),
    "--color-text-muted": hex(tema, "color.muted-foreground"),
    "--color-text-subtle": tema === "claro" ? n[5]! : n[4]!,
    "--color-border": compor(
      cor(tema, "color.border").hex,
      cor(tema, "color.border").alfa,
      superficie,
    ),
    "--color-border-strong": tema === "claro" ? n[3]! : n[5]!,
    "--shadow-xs": sombra("shadow.xs"),
    "--shadow-sm": sombra("shadow.sm"),
    "--shadow-md": sombra("shadow.md"),
    "--shadow-lg": sombra("shadow.lg"),
    "--shadow-xl": sombra("shadow.lg"), // o DS para no lg
  };
  GRAUS.forEach((g, i) => (d[`--color-neutral-${g}`] = n[i]!));
  for (const [app, ds] of Object.entries(STATUS)) {
    const c = hex(tema, `color.${ds}`);
    d[`--color-${app}`] = c;
    d[`--color-${app}-bg`] = rgba({ hex: c, alfa: ALFA_DO_FUNDO_DE_STATUS });
    d[`--color-${app}-fg`] = frenteLegivel(c, [
      compor(c, ALFA_DO_FUNDO_DE_STATUS, superficie),
      compor(c, ALFA_DO_FUNDO_DE_STATUS, fundo),
    ]);
  }
  return d;
}

function valoresDaRaiz(): Decls {
  // Escala de raios: decisão aprovada em 2026-11-26 (botões/campos 12px, cards/diálogos 28px).
  return {
    "--radius-sm": px(valorBruto("claro", "radius.xl")),
    "--radius-md": px(valorBruto("claro", "radius.md")),
    "--radius-lg": px(valorBruto("claro", "radius.4xl")),
    "--radius-xl": px(valorBruto("claro", "radius.2xl")),
  };
}

function grauMaisProximo(rampa: readonly string[], alvo: string): Grau {
  let melhor = 0;
  rampa.forEach((h, i) => {
    if (deltaEOklab(h, alvo) < deltaEOklab(rampa[melhor]!, alvo)) melhor = i;
  });
  return GRAUS[melhor]!;
}

/**
 * Escala da cor de destaque do PRODUTO Ânima.
 *
 * Não é `rampaDeSemente()`: ela ancora a semente no grau 600 (o accent do claro), o que serve a
 * uma marca de tom médio. O limão do DS é claríssimo (OKLab L ≈ 0,94); ancorado no 600, os graus
 * 50–600 viram quase-brancos e as regras FIXAS do upstream fora dos blocos de token
 * (`:focus-visible` no 500, `::selection` no 200/950, `--color-ring` no 500) somem no claro.
 *
 * Aqui a escala segue a escada de luminosidade do upstream (`ESCADA_L`) com o matiz da marca, e
 * o limão entra LITERAL no grau cuja luminosidade é a dele. Assim cada grau continua tendo a
 * luminosidade que o upstream desenhou, e o limão do DS é um grau real da escala.
 */
function escalaDoProduto(semente: string): { rampa: Rampa; grauDaSemente: Grau } {
  const { L: Ls, C: Cs, h } = hexParaOklch(semente);
  let k = 0;
  ESCADA_L.forEach((L, i) => {
    if (Math.abs(L - Ls) < Math.abs(ESCADA_L[k]! - Ls)) k = i;
  });
  const L0 = ESCADA_L[0]!;
  const L10 = ESCADA_L[10]!;
  const Lk = ESCADA_L[k]!;
  const picoC = Math.max(...CURVA_C);
  const stops = ESCADA_L.map((L, i) => {
    const Li =
      i === k
        ? Ls
        : i < k
          ? L0 + (L - L0) * ((Ls - L0) / (Lk - L0 || 1))
          : Ls + (L - Lk) * ((L10 - Ls) / (L10 - Lk));
    return oklchParaHex({ L: Li, C: (Cs * CURVA_C[i]!) / picoC, h });
  });
  stops[k] = semente.toLowerCase();
  return { rampa: stops as unknown as Rampa, grauDaSemente: GRAUS[k]! };
}

/**
 * Valores de destaque para um grau candidato do tema claro. No escuro o destaque é o limão do DS,
 * exatamente (decisão de identidade: o escuro é o tema principal).
 */
function valoresDeAccent(grauClaro: Grau): { raiz: Decls; claro: Decls; escuro: Decls } {
  const semente = hex("claro", "color.brand-primary");
  const { rampa, grauDaSemente } = escalaDoProduto(semente);
  const escala: Decls = {};
  GRAUS.forEach((g, i) => (escala[`--color-accent-${g}`] = rampa[i]!));
  const grau = (i: number) => GRAUS[Math.max(0, Math.min(10, i))]!;
  const v = (i: number) => `var(--color-accent-${grau(i)})`;
  const ring = (t: NomeTema) =>
    `var(--color-accent-${grauMaisProximo(rampa, hex(t, "color.ring"))})`;
  const iClaro = GRAUS.indexOf(grauClaro);
  const iEscuro = GRAUS.indexOf(grauDaSemente);
  return {
    raiz: escala,
    claro: {
      "--color-accent": v(iClaro),
      "--color-accent-fg": melhorFrenteSobre(rampa[iClaro]!),
      "--color-accent-hover": v(iClaro + 1),
      "--color-accent-soft": v(0),
      "--ring": ring("claro"),
    },
    escuro: {
      "--color-accent": v(iEscuro),
      "--color-accent-fg": hex("escuro", "color.primary-foreground"),
      "--color-accent-hover": v(iEscuro - 1),
      "--color-accent-soft": rgba({ hex: semente, alfa: 0.16 }),
      "--ring": ring("escuro"),
    },
  };
}

/** Mede o CSS como ficou escrito (deslocamento 0): todo papel × superfície, nos dois temas. */
function reprovas(regua: Regua) {
  return (["claro", "escuro"] as const).flatMap((t) =>
    medirPares(regua[t], regua.rampaDoProduto, 0)
      .filter((p) => !p.passa)
      .map((p) => ({ tema: t, ...p })),
  );
}

// ── Escrita no CSS ───────────────────────────────────────────────────────────

const SELETORES = {
  raiz: ":root",
  claro: '[data-theme="light"]',
  escuro: '[data-theme="dark"]',
} as const;

function limitesDoBloco(css: string, seletor: string): [number, number] {
  const cabeca = `\n${seletor} {\n`;
  const inicio = css.indexOf(cabeca);
  if (inicio < 0) throw new Error(`bloco ${seletor} não encontrado no globals.css`);
  const fim = css.indexOf("\n}\n", inicio + cabeca.length);
  return [inicio + cabeca.length, fim];
}

function aplicar(css: string, seletor: string, decls: Decls): string {
  const [ini, fim] = limitesDoBloco(css, seletor);
  let bloco = css.slice(ini, fim);
  for (const [prop, valor] of Object.entries(decls)) {
    const re = new RegExp(`^(\\s*${prop.replace(/[-]/g, "\\-")}:\\s*)[^;]+;`, "m");
    const achados = bloco.match(new RegExp(re.source, "gm"))?.length ?? 0;
    if (achados !== 1) {
      throw new Error(`${seletor}: esperava 1 declaração de ${prop}, achei ${achados}`);
    }
    bloco = bloco.replace(re, `$1${valor};`);
  }
  return css.slice(0, ini) + bloco + css.slice(fim);
}

// ── Execução ─────────────────────────────────────────────────────────────────

const original = fs.readFileSync(CAMINHO_CSS, "utf8");
const claro = valoresDoTema("claro");
const escuro = valoresDoTema("escuro");

let css = original;
css = aplicar(css, SELETORES.raiz, { ...valoresDaRaiz(), ...claro });
css = aplicar(css, SELETORES.claro, claro);
css = aplicar(css, SELETORES.escuro, escuro);

// A cor de destaque depende das superfícies novas. No claro, parte do grau do upstream (600) e
// escurece até TODO par medido passar no piso, nos dois temas, no CSS como ficou escrito.
const semDestaque = css;
let escolhido: { grau: Grau; css: string } | null = null;
let ultimas: ReturnType<typeof reprovas> = [];
for (const grauClaro of GRAUS.slice(GRAUS.indexOf(600))) {
  const accent = valoresDeAccent(grauClaro);
  let tentativa = aplicar(semDestaque, SELETORES.raiz, { ...accent.raiz, ...accent.claro });
  tentativa = aplicar(tentativa, SELETORES.claro, accent.claro);
  tentativa = aplicar(tentativa, SELETORES.escuro, { ...accent.raiz, ...accent.escuro });
  ultimas = reprovas(extrairRegua(tentativa));
  if (ultimas.length === 0) {
    escolhido = { grau: grauClaro, css: tentativa };
    break;
  }
}
if (!escolhido) {
  throw new Error(`nenhum grau do claro passa nos pisos: ${JSON.stringify(ultimas, null, 1)}`);
}
css = escolhido.css;

const regua = extrairRegua(css);
const textoRegua = fs.readFileSync(CAMINHO_REGUA, "utf8");
const marcador = "export const REGUA_DO_PRODUTO: Regua = ";
const corte = textoRegua.indexOf(marcador);
if (corte < 0) throw new Error("regua-do-produto.ts mudou de forma; revisar o gerador");
const novaRegua =
  textoRegua.slice(0, corte + marcador.length) + JSON.stringify(regua, null, 2) + " as const;\n";

if (CONFERIR) {
  const reguaAtual = extrairRegua(original);
  const igual = css === original && JSON.stringify(reguaAtual) === JSON.stringify(regua);
  process.stdout.write(
    igual
      ? `tokens em dia com o DS ${VERSAO_DS}\n`
      : `globals.css divergente do DS ${VERSAO_DS}: rode sem --conferir\n`,
  );
  process.exit(igual ? 0 : 1);
}

fs.writeFileSync(CAMINHO_CSS, css);
fs.writeFileSync(CAMINHO_REGUA, novaRegua);
process.stdout.write(
  `tokens do DS ${VERSAO_DS} aplicados (destaque do claro no grau ${escolhido.grau}). ` +
    `Rode prettier em ${path.relative(RAIZ, CAMINHO_REGUA)}.\n`,
);
