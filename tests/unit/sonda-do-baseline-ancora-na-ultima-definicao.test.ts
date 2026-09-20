/**
 * SONDA ANCORADA NA PRIMEIRA DEFINIÇÃO MEDE A DEFINIÇÃO MORTA.
 *
 * O `supabase/baseline.sql` é `pg_dump --schema-only` + apêndice idempotente, e o
 * arquivo é aplicado INTEIRO e EM ORDEM. Então a mesma função aparece várias
 * vezes, e quem vale é a ÚLTIMA — a primeira é corpo de dump, morto desde o
 * apêndice. Uma sonda que ancora na primeira ocorrência mede o que o arquivo
 * dizia, não o que o banco instala, e afirma sobre o produto o oposto do que ele
 * faz. A doutrina está no `CLAUDE.md`, item 10 (entrou pelo #1365); esta cerca é
 * a metade executável: ela varre as sondas do repositório e reprova as que
 * ancoram na primeira.
 *
 * MEDIDO em 2026-09-20 (base: `origin/main`, este commit) COM ESTA VERSÃO do
 * instrumento — o instrumento não se mede:
 *
 *   - 146 arquivos de `tests/`+`scripts/` citam `baseline.sql`; 65 ligam um
 *     identificador ao CONTEÚDO dele (leem o arquivo, não só o nome);
 *   - 34 âncoras sobre o conteúdo: 13 na ÚLTIMA ocorrência ou varrendo todas
 *     (`matchAll`/`match` com `/g`), 7 com deslocamento declarado, 13 sobre
 *     texto que ocorre UMA vez (a primeira é a última — não há o que escolher) e
 *     1 na primeira ocorrência de texto repetido, declarada de propósito (a
 *     fronteira dump/apêndice, que mede ordem de arquivo, não definição);
 *   - 0 defeitos: as 6 sondas que mediam definição morta foram consertadas nesta
 *     (`fila-tem-uma-definicao-so`, `realtime-assinatura-tem-publicacao` e as
 *     quatro que ancoravam em fatia: `automacao-troca-de-funil-transfere-o-negocio`,
 *     `comanda-invariantes-no-schema`, `papel-do-agente-publicado`,
 *     `retencao-todo-piso-tem-dono`). O pior: o gate do realtime media a
 *     publicação do primeiro dos SEIS lotes `foreach t in array array[...]` —
 *     12 tabelas onde o arquivo instala 29.
 *
 * NÃO MEDIDO aqui: o comportamento em runtime (quem prova isso é `pnpm test:db`),
 * e sondas que ancoram em número de LINHA em vez de texto — a cerca só olha
 * âncoras sobre o texto do arquivo.
 *
 * As três formas certas (CLAUDE.md, item 10):
 *   (a) pergunte ao BANCO depois de aplicar (`pnpm test:db ...`) — é o que o
 *       cliente terá;
 *   (b) ancore na ÚLTIMA (`lastIndexOf`, `.at(-1)` sobre `matchAll`, ou as duas
 *       pontas de uma varredura em ORDEM — o baseline aplica todos os lotes);
 *   (c) `indexOf(literal, deslocamento)` — deslocamento declarado é escolha
 *       medida, não descuido.
 *
 * Uma âncora na PRIMEIRA pode ser de propósito (ex.: achar a fronteira
 * dump/apêndice). Nesse caso ela se declara na linha:
 *
 *     // sonda-do-baseline: primeira-de-proposito — <por quê>
 *
 * A cerca reprova a exceção órfã: declaração sem âncora de primeira ocorrência
 * que se repita é declaração vencida, e vira vermelho.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const BASELINE = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");

const DIRETORIOS = ["tests", "scripts"];
const EXTENSOES = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".sh", ".py"];
const PRAGMA = "sonda-do-baseline: primeira-de-proposito";

/** Um `ID.metodo("literal")` sobre um identificador ligado ao conteúdo do baseline. */
export type Ancoragem = {
  linha: number;
  metodo: string;
  literal: string;
  /** Quantas vezes o literal (ou o regex) casa no baseline inteiro. */
  repeticoes: number;
  /** Declarada como de propósito, com razão. */
  declarada: boolean;
  razao: string;
};

function arquivosDe(dir: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome === ".git" || nome === ".next") continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) achados.push(...arquivosDe(caminho));
    else if (EXTENSOES.some((e) => nome.endsWith(e))) achados.push(caminho);
  }
  return achados;
}

/**
 * Identificadores que seguram o CONTEÚDO do baseline (`const x = ler("supabase/baseline.sql")`).
 *
 * Não basta o arquivo citar o baseline: uma sonda que lê o arquivo em outra
 * variável, ou que trabalha sobre linhas (`split("\n")`), não ancora em índice
 * de texto — e este scanner mede índice de texto.
 */
export function identificadoresLigados(fonte: string): Set<string> {
  const ids = new Set<string>();
  // O casamento NÃO consome o lado direito: com `=\s*([\s\S]{0,300}?);` o
  // casamento andava até o primeiro `;` e engolia a linha seguinte quando o lado
  // direito abre um literal (`const fonte = [`), de modo que o
  // `const x = ler("…/baseline.sql")` de dentro do literal nunca era visto.
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*/g;
  for (const m of fonte.matchAll(re)) {
    const fim = m.index! + m[0]!.length;
    if (fonte.slice(fim, fim + 300).includes("baseline.sql")) ids.add(m[1]!);
  }
  return ids;
}

/** Fim do literal: a `/` que fecha o regex (respeitando escape e classe) ou a aspa de abertura. */
function fimDoLiteral(fonte: string, abre: number): { fim: number; ehRegex: boolean } {
  const q = fonte[abre]!;
  if (q !== "/") return { fim: fonte.indexOf(q, abre + 1), ehRegex: false };
  let i = abre + 1;
  let dentroDeClasse = false;
  while (i < fonte.length) {
    const c = fonte[i]!;
    if (c === "\\") i += 2;
    else if (c === "[") {
      dentroDeClasse = true;
      i += 1;
    } else if (c === "]") {
      dentroDeClasse = false;
      i += 1;
    } else if (c === "/" && !dentroDeClasse) break;
    else i += 1;
  }
  return { fim: i, ehRegex: true };
}

/** Quantas vezes o literal casa no baseline inteiro. Regex inválido conta 0. */
export function repeticoesDe(literal: string, ehRegex: boolean, flags: string): number {
  if (!ehRegex) return BASELINE.split(literal).length - 1;
  const globais = flags.includes("m") ? "gm" : "g";
  try {
    return BASELINE.match(new RegExp(literal, globais))?.length ?? 0;
  } catch {
    return 0;
  }
}

/** As âncoras de PRIMEIRA ocorrência que medem texto repetido — os defeitos. */
export function varrer(fonte: string): Ancoragem[] {
  const ids = identificadoresLigados(fonte);
  if (ids.size === 0) return [];
  const linhas = fonte.split("\n");
  const defeitos: Ancoragem[] = [];
  const re =
    /([A-Za-z_$][\w$]*)\s*\.\s*(indexOf|lastIndexOf|search|match|matchAll)\s*\(\s*([/'`"])/g;

  for (const m of fonte.matchAll(re)) {
    // SEM a vírgula inicial: `[, a, b] = [x, y, z]` PULA o primeiro elemento, e o
    // resto desalinha — `receptor` virava o método, `ids.has(receptor)` dava
    // falso em toda âncora e a varredura devolvia [] sempre. O controle positivo
    // do primeiro teste existe exatamente para pegar esta classe de defeito.
    const [receptor, metodo] = [m[1]!, m[2]!];
    if (!ids.has(receptor)) continue;
    const abre = m.index! + m[0]!.length - 1;
    const { fim, ehRegex } = fimDoLiteral(fonte, abre);
    if (fim <= abre) continue;
    const literal = fonte.slice(abre + 1, fim);
    const resto = fonte.slice(fim + 1);
    const flags = ehRegex ? (/^[gimsuy]*/.exec(resto)?.[0] ?? "") : "";
    const fecha = resto.indexOf(")");

    // `indexOf(literal, deslocamento)` é deslocamento declarado; `match`/`matchAll`
    // com `/g` varre tudo, e `.at(-1)`/`[0]` depois é escolha explícita de quem lê.
    const comDeslocamento = (metodo === "indexOf") && fecha > 0 && resto.slice(0, fecha).includes(",");
    if (metodo === "lastIndexOf" || metodo === "matchAll" || comDeslocamento) continue;
    if (metodo === "match" && flags.includes("g")) continue;

    const linha = fonte.slice(0, m.index).split("\n").length;
    const textoDaLinha = linhas[linha - 1] ?? "";
    const anterior = linhas[linha - 2] ?? "";
    const declaracao = textoDaLinha.includes(PRAGMA) ? textoDaLinha : anterior.includes(PRAGMA) ? anterior : "";
    const razao = declaracao.slice(declaracao.indexOf(PRAGMA) + PRAGMA.length).replace(/^\s*—?\s*/, "").trim();
    const repeticoes = repeticoesDe(literal, ehRegex, flags);

    // Só é defeito quando o texto REPETE: com uma ocorrência só, a primeira é a última.
    if (repeticoes <= 1) continue;
    defeitos.push({ linha, metodo, literal, repeticoes, declarada: declaracao !== "", razao });
  }
  return defeitos;
}

describe("sonda do baseline ancora na ÚLTIMA definição (CLAUDE.md, item 10)", () => {
  it("o instrumento está vivo: acha leitor, acha âncora e conta repetição", () => {
    // Controle positivo sobre strings sintéticas: sem isto, um regex que parou de
    // casar devolve lista vazia, e lista vazia satisfaz "nenhum defeito".
    const fonte = [
      'const baseline = ler("supabase/baseline.sql");',
      'const morta = baseline.indexOf("create or replace function public.fn_meet_action");',
      'const viva = baseline.lastIndexOf("create or replace function public.fn_meet_action");',
      'const todas = [...baseline.matchAll(/create or replace function public\\.fn_meet_action/g)];',
      'const recortado = morta > 0 ? baseline.slice(morta) : "";',
      'const dentroDaFatia = recortado.indexOf("create or replace function public.fn_meet_action");',
      'const comDeslocamento = baseline.indexOf("create or replace function public.fn_meet_action", viva);',
    ].join("\n");

    const achadas = varrer(fonte);
    expect(achadas, "a varredura devia achar a âncora de PRIMEIRA do instrumento").toHaveLength(1);
    expect(achadas[0]!.linha).toBe(2);
    expect(achadas[0]!.literal).toContain("fn_meet_action");
    // A repetição é medida no baseline de verdade: `fn_meet_action` tem quatro
    // definições (medido em 20/09/2026 — é o caso que abriu o item 10).
    expect(achadas[0]!.repeticoes).toBeGreaterThan(1);
    expect(
      (BASELINE.match(/create or replace function public\.fn_meet_action\(/g) ?? []).length,
      "fn_meet_action deixou de ter várias definições: o controle perdeu o objeto",
    ).toBeGreaterThan(1);
    // E as formas certas NÃO são acusadas: última, todas, deslocamento e fatia.
    expect(identificadoresLigados(fonte).size).toBe(1);
  });

  it("o repositório está limpo: nenhuma sonda ancora na primeira ocorrência repetida", () => {
    const defeitos: { onde: string; detalhe: Ancoragem }[] = [];
    const orfas: string[] = [];
    let lidos = 0;
    let ancorados = 0;

    for (const caminho of DIRETORIOS.flatMap((d) => arquivosDe(join(RAIZ, d)))) {
      const fonte = readFileSync(caminho, "utf8");
      if (!fonte.includes("baseline.sql")) continue;
      lidos += 1;
      const onde = relative(RAIZ, caminho);
      // O instrumento não se mede: os `indexOf` do fixture dele são strings
      // sintéticas de controle, não âncoras contra o baseline.
      if (onde === relative(RAIZ, __filename)) continue;
      const achadas = varrer(fonte);
      if (identificadoresLigados(fonte).size > 0) ancorados += 1;
      for (const a of achadas) {
        if (a.declarada && a.razao.length >= 10) continue;
        defeitos.push({ onde, detalhe: a });
      }
      // Declaração órfã: existe no arquivo, mas nenhuma âncora de primeira que
      // repita — a razão escrita ali já não vale, e ninguém percebe.
      if (fonte.includes(PRAGMA) && achadas.length === 0) orfas.push(onde);
    }

    // Anti-apodrecimento: uma varredura que parou de andar passaria verde por vazio.
    expect(lidos, "nenhum arquivo lido — o caminhador quebrou").toBeGreaterThan(100);
    expect(ancorados, "nenhum arquivo ancora no conteúdo do baseline").toBeGreaterThan(30);

    expect(
      defeitos.map(
        (d) =>
          `${d.onde}:${d.detalhe.linha} ${d.detalhe.metodo}(${d.detalhe.literal.slice(0, 50)}) ` +
          `casa ${d.detalhe.repeticoes}x — ancore na ÚLTIMA (CLAUDE.md, item 10) ` +
          `ou declare \`${PRAGMA} — <por quê>\``,
      ),
      "sonda ancorada na PRIMEIRA definição mede a definição morta",
    ).toEqual([]);

    expect(orfas, `declaração \`${PRAGMA}\` sem âncora que a justifique`).toEqual([]);
  });
});
