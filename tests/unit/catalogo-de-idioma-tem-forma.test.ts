import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { format } from "date-fns";
import { enUS, tr, zhCN } from "date-fns/locale";
import { describe, expect, it } from "vitest";

import { IDIOMA_PADRAO, IDIOMAS } from "@/lib/i18n/idiomas";
import { REGISTRO_DE_IDIOMAS } from "@/lib/i18n/registro";

/**
 * O CATÁLOGO DE UM IDIOMA TEM FORMA — e completude não é cobrada.
 *
 * ─── A linha de corte ──────────────────────────────────────────────────────
 *
 * A decisão do dono (doc 18, 2) é que frase sem tradução cai no português em
 * vez de reprovar quem contribui. Então nada aqui conta chave faltando. O que
 * reprova é o que quebraria a tela no dia em que o idioma for servido e que
 * ninguém veria antes: valor vazio, placeholder perdido (`{data}` que some da
 * frase e deixa o `.replace` sem alvo) e padrão de data que ainda carrega a
 * preposição portuguesa (`'de'`) ou que o date-fns recusa formatar.
 *
 * O catálogo mora em `lib/i18n/traducoes/<codigo>.json`, plano, com o texto em
 * português como chave — o formato que o PR #773 trouxe e o PROG-022 adotou.
 */

const RAIZ = join(__dirname, "..", "..");
const PASTA = join(RAIZ, "lib", "i18n", "traducoes");

/** Os `Locale` do date-fns de quem tem catálogo — só para o teste formatar. */
const LOCALE_DO_CATALOGO: Record<string, typeof zhCN> = { "zh-CN": zhCN, en: enUS, tr };

const catalogos = readdirSync(PASTA)
  .filter((arquivo) => arquivo.endsWith(".json"))
  .map((arquivo) => ({
    codigo: arquivo.replace(/\.json$/, ""),
    entradas: JSON.parse(readFileSync(join(PASTA, arquivo), "utf8")) as unknown,
  }));

const PLACEHOLDER = /\{\{?[A-Za-z_][A-Za-z0-9_]*\}?\}/g;
const placeholders = (texto: string) => (texto.match(PLACEHOLDER) ?? []).sort();

describe("todo catálogo de idioma", () => {
  it("existe ao menos um, para esta guarda não passar vazia", () => {
    expect(catalogos.length).toBeGreaterThan(0);
  });

  it.each(catalogos)("$codigo: é de um idioma registrado, e não do padrão", ({ codigo }) => {
    expect(REGISTRO_DE_IDIOMAS.map((idioma) => idioma.codigo)).toContain(codigo);
    // Em português a chave É o texto: um catálogo pt-BR só poderia divergir dela.
    expect(codigo).not.toBe(IDIOMA_PADRAO);
  });

  it.each(catalogos)("$codigo: é plano, de texto para texto não vazio", ({ entradas }) => {
    expect(typeof entradas === "object" && entradas !== null && !Array.isArray(entradas)).toBe(true);
    const ruins = Object.entries(entradas as Record<string, unknown>)
      .filter(([, valor]) => typeof valor !== "string" || valor.trim() === "")
      .map(([chave]) => chave);
    expect(ruins, `${ruins.length} entrada(s) vazia(s) ou que não são texto`).toEqual([]);
  });

  it.each(catalogos)("$codigo: nenhuma tradução perde ou inventa placeholder", ({ entradas }) => {
    const divergentes = Object.entries(entradas as Record<string, string>)
      .filter(([chave, valor]) => placeholders(chave).join() !== placeholders(valor).join())
      .map(([chave, valor]) => `${JSON.stringify(chave)} → ${JSON.stringify(valor)}`);
    expect(divergentes, `${divergentes.length} tradução(ões) com placeholder diferente da chave`).toEqual([]);
  });

  it.each(catalogos)("$codigo: todo padrão de data formata, e sem a preposição portuguesa", ({ codigo, entradas }) => {
    const locale = LOCALE_DO_CATALOGO[codigo];
    expect(locale, `falta o Locale do date-fns de "${codigo}" neste teste`).toBeTruthy();
    const padroes = Object.entries(entradas as Record<string, string>).filter(([chave]) =>
      /'(de|às)'/.test(chave),
    );
    const quebrados = padroes
      .filter(([, valor]) => {
        if (/'(de|às)'/.test(valor)) return true;
        try {
          format(new Date(2026, 8, 14, 9, 30), valor, { locale });
          return false;
        } catch {
          return true;
        }
      })
      .map(([chave, valor]) => `${JSON.stringify(chave)} → ${JSON.stringify(valor)}`);
    expect(quebrados, `${quebrados.length} padrão(ões) de data que não formatam ou carregam 'de'/'às'`).toEqual([]);
  });
});

/** O único arquivo que pode importar um catálogo (ver o cabeçalho dele). */
const LEITOR = "lib/i18n/catalogos.ts";

const IMPORTACAO = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/**
 * Os catálogos que uma fonte importa, pelo código do idioma.
 *
 * Pelo caminho RESOLVIDO, e não pelo texto do import: `./traducoes/tr.json`
 * de dentro de `lib/i18n` não contém `i18n/traducoes/`, e passava pela versão
 * anterior desta guarda. Cobre `from` (import e re-export), `import()`
 * dinâmico e `require`.
 */
function catalogosImportados(caminho: string, fonte: string): string[] {
  const codigos: string[] = [];
  for (const [, alvo = ""] of fonte.matchAll(IMPORTACAO)) {
    const resolvido = alvo.startsWith("@/")
      ? join(RAIZ, alvo.slice(2))
      : alvo.startsWith(".")
        ? resolve(dirname(caminho), alvo)
        : null;
    if (!resolvido) continue;
    const dentro = relative(PASTA, resolvido);
    if (!dentro || dentro.startsWith("..") || isAbsolute(dentro)) continue;
    codigos.push(dentro.replace(/\.json$/, ""));
  }
  return codigos;
}

describe("o catálogo só viaja para o navegador pelo leitor, e só o de quem aparece", () => {
  it("o detector acha import estático, relativo e dinâmico", () => {
    const em = (arquivo: string) => join(RAIZ, arquivo);
    expect(catalogosImportados(em("app/x.tsx"), 'import en from "@/lib/i18n/traducoes/en.json";')).toEqual(["en"]);
    expect(catalogosImportados(em("lib/i18n/x.ts"), 'import tr from "./traducoes/tr.json";')).toEqual(["tr"]);
    expect(
      catalogosImportados(em("lib/outro/x.ts"), 'const c = await import("../i18n/traducoes/zh-CN.json");'),
    ).toEqual(["zh-CN"]);
    expect(catalogosImportados(em("lib/i18n/x.ts"), 'import { a } from "./traducoes-util";')).toEqual([]);
  });

  it(`só ${LEITOR} importa catálogo, e nunca o de um idioma em construção`, () => {
    // Um catálogo importado vai no pacote de TODO usuário. O de um idioma em
    // construção não é servido a ninguém: seriam centenas de KB por uma língua
    // que ninguém pode escolher. O de um idioma visível entra uma vez, pelo
    // leitor — espalhado por telas, cada uma o arrastaria de novo.
    const visiveis = new Set<string>(IDIOMAS);
    const indevidos: string[] = [];
    const varrer = (pasta: string) => {
      for (const entrada of readdirSync(pasta, { withFileTypes: true })) {
        if (entrada.name === "node_modules" || entrada.name.startsWith(".")) continue;
        const caminho = join(pasta, entrada.name);
        if (entrada.isDirectory()) varrer(caminho);
        else if (/\.(ts|tsx|js|mjs)$/.test(entrada.name) && !/\.test\./.test(entrada.name)) {
          const rel = relative(RAIZ, caminho).split(sep).join("/");
          for (const codigo of catalogosImportados(caminho, readFileSync(caminho, "utf8"))) {
            if (!visiveis.has(codigo)) indevidos.push(`${rel} → ${codigo}.json (idioma em construção)`);
            else if (rel !== LEITOR) indevidos.push(`${rel} → ${codigo}.json (só ${LEITOR} lê catálogo)`);
          }
        }
      }
    };
    for (const area of ["app", "components", "lib", "hooks", "workers"]) varrer(join(RAIZ, area));
    expect(indevidos).toEqual([]);
  });
});
