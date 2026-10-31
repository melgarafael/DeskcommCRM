/**
 * A barra de rolagem segue o TEMA — e não um neutro fixo.
 *
 * A issue #3789: com um tema de extensão escolhido (a paleta `mist`, por
 * exemplo), a tela inteira mudava e a barra de rolagem continuava no greige da
 * paleta padrão. O motivo estava escrito em `app/globals.css`: a barra pedia
 * `--color-neutral-300` (claro) e `--color-neutral-600` (escuro), e os neutros
 * NÃO entram na allowlist do tema de extensão (`CHAVES_DE_TOKEN_DO_TEMA` em
 * `lib/extensions/tema.ts` — a lista é fechada e o `z.object(...).strict()`
 * recusa o resto). O bloco `body:has([data-tema-extensao])` sobrescreve borda,
 * superfície, texto e accent; os neutros ficam parados na paleta padrão, então
 * a barra era o ÚNICO pedaço da tela que não acompanhava o tema.
 *
 * A saída não é criar token (a allowlist é fechada e as paletas são registro
 * fechado): é a barra ler um token que o tema JÁ controla. `--color-border` é
 * declarado pelas cinco paletas de `app/design/lib/tokens.ts`, nos dois temas
 * (`surfaces.light.border` / `surfaces.dark.border`), e já muda entre claro e
 * escuro no `globals.css` — por isso o par claro/escuro sai de um `var()` só e
 * o bloco `[data-theme="dark"]` exclusivo da barra deixa de existir.
 *
 * ⚠️ ESTE TESTE É UMA CERCA, NÃO UMA PROVA de pixel: ele lê o CSS e as
 * paletas, e não pinta uma barra num navegador. O que ele impede é o caminho
 * pelo qual o defeito volta — e volta em silêncio, porque uma barra fora do
 * tom não parece erro, parece escolha de design.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PALETTES, type PaletteDef } from "@/app/design/lib/tokens";
import { CHAVES_DE_TOKEN_DO_TEMA, PALETAS_DE_TEMA } from "@/lib/extensions/tema";

const CSS = readFileSync(join(__dirname, "..", "..", "app", "globals.css"), "utf8");

/** O trecho do `globals.css` que pinta a barra de rolagem. */
function regiaoDaBarra(): string {
  const inicio = CSS.indexOf("/* Scrollbar");
  expect(inicio, "o bloco da barra de rolagem sumiu de `app/globals.css`").toBeGreaterThan(-1);
  const fim = CSS.indexOf("/* ---- XYFlow", inicio);
  expect(fim, "o bloco da barra perdeu o vizinho que delimita o fim dele").toBeGreaterThan(inicio);
  return CSS.slice(inicio, fim);
}

/** O CSS sem os comentários: prosa não pinta pixel, e o comentário do bloco cita
 * os nomes antigos de propósito (é a memória do defeito). */
function semComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** O corpo de uma regra de topo dentro de `@layer base`. */
function blocoDe(regiao: string, seletor: string): string {
  const inicio = regiao.indexOf(`\n  ${seletor} {`);
  expect(inicio, `não achei a regra \`${seletor}\` no bloco da barra`).toBeGreaterThan(-1);
  const fim = regiao.indexOf("\n  }", inicio);
  return regiao.slice(inicio, fim);
}

/** Todo `var(--color-…)` citado num trecho de CSS, sem repetição. */
function tokensUsados(texto: string): string[] {
  return [...new Set([...texto.matchAll(/var\((--color-[a-z0-9-]+)\)/g)].map((m) => m[1]!))];
}

/**
 * Os campos de `PALETTES[].surfaces` são camelCase; o CSS usa o nome do token.
 * Um campo novo sem correspondência aqui reprova — é o lembrete de que a régua
 * das paletas e a do CSS precisam andar juntas.
 */
const TOKEN_DA_SUPERFICIE: Record<string, string> = {
  bg: "--color-bg",
  surface: "--color-surface",
  surfaceElevated: "--color-surface-elevated",
  text: "--color-text",
  textMuted: "--color-text-muted",
  border: "--color-border",
};

function tokenDe(campo: string): string {
  const token = TOKEN_DA_SUPERFICIE[campo];
  expect(
    token,
    `campo novo em PALETTES.surfaces: \`${campo}\` — diga a que token do CSS ele corresponde`,
  ).toBeDefined();
  return token!;
}

/** Os tokens que a paleta declara nos DOIS temas (só o par vale). */
function tokensDaPaleta(paleta: PaletteDef): string[] {
  const doClaro = Object.keys(paleta.surfaces.light).map(tokenDe);
  const doEscuro = new Set(Object.keys(paleta.surfaces.dark).map(tokenDe));
  return doClaro.filter((token) => doEscuro.has(token));
}

function luminancia(hex: string): number {
  const valor = hex.replace("#", "");
  const cheio =
    valor.length === 3
      ? valor
          .split("")
          .map((c) => c + c)
          .join("")
      : valor;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const canal = parseInt(cheio.slice(i, i + 2), 16) / 255;
    return canal <= 0.03928 ? canal / 12.92 : ((canal + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contraste(a: string, b: string): number {
  const [clara, escura] = [luminancia(a), luminancia(b)].sort((x, y) => y - x) as [number, number];
  return (clara + 0.05) / (escura + 0.05);
}

describe("a barra de rolagem lê o tema, não os neutros fixos", () => {
  it("não cita nenhum `--color-neutral-*` no bloco da barra", () => {
    // O caminho exato pelo qual o defeito volta: um neutro tem par por tema,
    // então ELE PARECE theme-aware — mas o tema de extensão não pode tocá-lo.
    expect(semComentarios(regiaoDaBarra())).not.toMatch(/--color-neutral-/);
  });

  it("pinta a barra (`scrollbar-color`) com o token de borda do tema", () => {
    const universal = blocoDe(regiaoDaBarra(), "*");
    expect(universal).toMatch(/scrollbar-color:\s*var\(--color-border\)\s+transparent\s*;/);
  });

  it("pinta o polegar do WebKit com o mesmo token de borda", () => {
    const polegar = blocoDe(regiaoDaBarra(), "::-webkit-scrollbar-thumb");
    expect(polegar).toMatch(/background-color:\s*var\(--color-border\)\s*;/);
  });

  it("o hover do polegar também sai do tema", () => {
    const hover = blocoDe(regiaoDaBarra(), "::-webkit-scrollbar-thumb:hover");
    expect(tokensUsados(hover).length).toBeGreaterThan(0);
  });

  it("não tem bloco escuro separado: o token já troca com `[data-theme]`", () => {
    // Um bloco `[data-theme="dark"]` só para a barra é o segundo caminho de
    // volta: ele fixa uma cor por tema e esquece o tema de extensão.
    expect(semComentarios(regiaoDaBarra())).not.toMatch(/\[data-theme="dark"\]/);
  });
});

describe("o token escolhido existe onde a extensão pode declará-lo", () => {
  const tokensDaBarra = (): string[] => tokensUsados(semComentarios(regiaoDaBarra()));

  it("a barra usa pelo menos um token", () => {
    expect(tokensDaBarra().length).toBeGreaterThan(0);
  });

  it("todo token da barra está na allowlist fechada do tema de extensão", () => {
    const allowlist = new Set<string>(CHAVES_DE_TOKEN_DO_TEMA);
    for (const token of tokensDaBarra()) {
      expect(allowlist.has(token), `\`${token}\` não é sobrescrevível por um tema de extensão`).toBe(
        true,
      );
    }
  });

  it("as cinco paletas são as mesmas da allowlist do tema", () => {
    expect(Object.keys(PALETTES).sort()).toEqual([...PALETAS_DE_TEMA].sort());
  });

  it("todo token da barra é declarado pelas cinco paletas, nos dois temas", () => {
    // A armadilha da #3791: token que existe no CSS mas não nas paletas fica
    // sem valor justamente na instalação que escolheu o tema — some, em silêncio.
    for (const [nome, paleta] of Object.entries(PALETTES)) {
      const declarados = new Set(tokensDaPaleta(paleta));
      for (const token of tokensDaBarra()) {
        expect(declarados.has(token), `a paleta \`${nome}\` não declara \`${token}\``).toBe(true);
      }
    }
  });

  it("o tom da barra não some sobre o fundo, nas cinco paletas e nos dois temas", () => {
    // "Resolve" não basta: `--color-border` é o tom mais claro da família. Se
    // um dia ele encostar no fundo, a barra deixa de ser vista — e o teste que
    // só confere o nome do token não acusaria.
    for (const [nome, paleta] of Object.entries(PALETTES)) {
      for (const tema of ["light", "dark"] as const) {
        const razao = contraste(paleta.surfaces[tema].border, paleta.surfaces[tema].bg);
        expect(
          razao,
          `paleta \`${nome}\` (${tema}): borda e fundo em ${razao.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(1.15);
      }
    }
  });
});
