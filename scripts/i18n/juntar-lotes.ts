/**
 * Junta os lotes traduzidos no catálogo do idioma — a única porta de volta.
 *
 *   pnpm tsx scripts/i18n/juntar-lotes.ts --idioma tr --entrada <pasta>
 *
 * Lê `lote-NNN.<idioma>.json` (plano, `chave → tradução`) e confere cada um
 * contra o seu `lote-NNN.json` de origem. Qualquer entrada recusada — em branco,
 * com placeholder diferente da chave, ou com chave que não está na origem — é
 * listada e o comando sai com 1 sem escrever nada. Sem recusa, escreve
 * `lib/i18n/traducoes/<idioma>.json` com os lotes por cima do que já havia.
 * Casca fina de I/O; a lógica é `./lotes.ts`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { chavesForaDaOrigem, juntarCatalogo, validarLote } from "./lotes";

function argumento(nome: string): string {
  const posicao = process.argv.indexOf(`--${nome}`);
  const valor = posicao >= 0 ? process.argv[posicao + 1] : undefined;
  if (!valor) {
    console.error(`falta --${nome}`);
    process.exit(2);
  }
  return valor;
}

const lerJson = <T>(arquivo: string) => JSON.parse(readFileSync(arquivo, "utf8")) as T;

const idioma = argumento("idioma");
const entrada = resolve(argumento("entrada"));
const sufixo = `.${idioma}.json`;
const traduzidos = readdirSync(entrada)
  .filter((arquivo) => arquivo.startsWith("lote-") && arquivo.endsWith(sufixo))
  .sort();
if (traduzidos.length === 0) {
  console.error(`nenhum lote-*${sufixo} em ${entrada}`);
  process.exit(1);
}

const lotes: Record<string, string>[] = [];
const recusas: string[] = [];
for (const arquivo of traduzidos) {
  const lote = lerJson<Record<string, string>>(join(entrada, arquivo));
  for (const chave of validarLote(lote)) recusas.push(`${arquivo}: ${JSON.stringify(chave)} → ${JSON.stringify(lote[chave])}`);
  const origem = join(entrada, arquivo.slice(0, -sufixo.length) + ".json");
  if (existsSync(origem)) {
    for (const chave of chavesForaDaOrigem(lote, lerJson<Record<string, unknown>>(origem))) {
      recusas.push(`${arquivo}: ${JSON.stringify(chave)} não está em ${arquivo.slice(0, -sufixo.length)}.json`);
    }
  }
  lotes.push(lote);
}

if (recusas.length > 0) {
  console.error(`${recusas.length} entrada(s) recusada(s); nada foi escrito:`);
  for (const recusa of recusas) console.error(`  ${recusa}`);
  process.exit(1);
}

const destino = join(__dirname, "..", "..", "lib", "i18n", "traducoes", `${idioma}.json`);
const atual = existsSync(destino) ? lerJson<Record<string, string>>(destino) : {};
const catalogo = juntarCatalogo(atual, lotes);
writeFileSync(destino, `${JSON.stringify(catalogo, null, 2)}\n`, "utf8");
console.info(
  `${traduzidos.length} lote(s) juntado(s); ${Object.keys(catalogo).length} entrada(s) em lib/i18n/traducoes/${idioma}.json`,
);
