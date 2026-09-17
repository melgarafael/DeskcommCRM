import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { describe, expect, it } from "vitest";

import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
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
const LOCALE_DO_CATALOGO: Record<string, typeof zhCN> = { "zh-CN": zhCN };

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

describe("o catálogo não viaja para o navegador antes de ser servido", () => {
  it("nenhum código de produto importa lib/i18n/traducoes", () => {
    // Um idioma em construção não é servido a ninguém. Importar o catálogo
    // numa tela poria centenas de KB no pacote de TODO usuário por uma língua
    // que ninguém pode escolher. A carga entra com o leitor (fatia 4 do PROG-022).
    const importadores: string[] = [];
    const varrer = (pasta: string) => {
      for (const entrada of readdirSync(pasta, { withFileTypes: true })) {
        if (entrada.name === "node_modules" || entrada.name.startsWith(".")) continue;
        const caminho = join(pasta, entrada.name);
        if (entrada.isDirectory()) varrer(caminho);
        else if (/\.(ts|tsx|js|mjs)$/.test(entrada.name) && !/\.test\./.test(entrada.name)) {
          if (/from\s+["'][^"']*i18n\/traducoes\//.test(readFileSync(caminho, "utf8"))) {
            importadores.push(relative(RAIZ, caminho));
          }
        }
      }
    };
    for (const area of ["app", "components", "lib", "hooks", "workers"]) varrer(join(RAIZ, area));
    expect(importadores).toEqual([]);
  });
});
