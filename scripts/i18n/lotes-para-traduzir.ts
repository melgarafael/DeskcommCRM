/**
 * Parte o que falta traduzir de um catálogo em lotes para traduzir à parte.
 *
 *   pnpm tsx scripts/i18n/lotes-para-traduzir.ts --idioma tr --tamanho 400 --saida <pasta>
 *
 * O que falta é a união das chaves do dicionário com as de `traducoes/en.json`,
 * menos o que o catálogo do idioma já tem. Cada lote leva o espanhol e o inglês
 * da frase como contexto: `{ "<chave pt>": { "es"?: string, "en"?: string } }`.
 *
 * Recusa pasta que já tem lote: um lote velho ao lado dos novos, com a mesma
 * numeração, juntaria tradução de uma frase na chave de outra rodada.
 * Casca fina de I/O; a lógica é `./lotes.ts`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DICIONARIO } from "../../lib/i18n/dicionario";
import en from "../../lib/i18n/traducoes/en.json";
import { chavesParaTraduzir } from "./lotes";

function argumento(nome: string): string {
  const posicao = process.argv.indexOf(`--${nome}`);
  const valor = posicao >= 0 ? process.argv[posicao + 1] : undefined;
  if (!valor) {
    console.error(`falta --${nome}`);
    process.exit(2);
  }
  return valor;
}

const idioma = argumento("idioma");
const tamanho = Number.parseInt(argumento("tamanho"), 10);
const saida = resolve(argumento("saida"));
if (!Number.isInteger(tamanho) || tamanho < 1) {
  console.error("--tamanho precisa ser um inteiro positivo");
  process.exit(2);
}

const ingles = en as Record<string, string>;
const arquivoDoCatalogo = join(__dirname, "..", "..", "lib", "i18n", "traducoes", `${idioma}.json`);
const catalogo = existsSync(arquivoDoCatalogo)
  ? (JSON.parse(readFileSync(arquivoDoCatalogo, "utf8")) as Record<string, string>)
  : {};
const naColuna = Object.fromEntries(
  Object.entries(DICIONARIO).flatMap(([chave, linha]) => {
    const valor = (linha as Record<string, string | undefined>)[idioma];
    return valor ? [[chave, valor]] : [];
  }),
);

const chaves = chavesParaTraduzir([DICIONARIO, ingles], { ...naColuna, ...catalogo });

mkdirSync(saida, { recursive: true });
const velhos = readdirSync(saida).filter((arquivo) => /^lote-\d+/.test(arquivo));
if (velhos.length > 0) {
  console.error(`${saida} já tem ${velhos.length} arquivo(s) de lote; use uma pasta vazia`);
  process.exit(1);
}

let lotes = 0;
for (let inicio = 0; inicio < chaves.length; inicio += tamanho) {
  lotes += 1;
  const lote: Record<string, { es?: string; en?: string }> = {};
  for (const chave of chaves.slice(inicio, inicio + tamanho)) {
    lote[chave] = { es: DICIONARIO[chave]?.es, en: ingles[chave] };
  }
  const nome = `lote-${String(lotes).padStart(3, "0")}.json`;
  writeFileSync(join(saida, nome), `${JSON.stringify(lote, null, 2)}\n`, "utf8");
}

console.info(`${chaves.length} chave(s) para traduzir em "${idioma}", em ${lotes} lote(s) de até ${tamanho}, em ${saida}`);
