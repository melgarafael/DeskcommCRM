/**
 * VALIDADOR DE CONSULTA DE RECEITA — a SEGUNDA trava, mesmo sendo o template
 * código revisado. Recebe o SQL já montado (placeholder `?`) e garante:
 *
 *  - um comando só, sem `;`
 *  - começa com `SELECT`
 *  - sem `--`, `/*`, `#`
 *  - sem `INTO`, `FOR UPDATE`, `LOCK`, `SLEEP(`, `BENCHMARK(`, `LOAD_FILE`, `OUTFILE`
 *  - toda tabela citada após FROM/JOIN está em `tabelasPermitidas`
 *
 * Qualquer violação lança `LeituraInvalidaError` com motivo legível.
 */
import { LeituraInvalidaError } from "../montagem";

const PROIBIDOS_TEXTO = ["--", "/*", "#"];
/**
 * Palavras perigosas, como PALAVRA INTEIRA (limite de palavra): `INTO` não casa dentro de `quinto` nem
 * `LOCK` dentro de `bloco_clock` (o sublinhado conta como letra). Os identificadores entre
 * crases saem do texto ANTES da checagem: nome de coluna não executa nada.
 */
const PROIBIDOS_PALAVRA: ReadonlyArray<{ nome: string; regex: RegExp }> = [
  { nome: "INTO", regex: /\bINTO\b/i },
  { nome: "FOR UPDATE", regex: /\bFOR\s+UPDATE\b/i },
  { nome: "LOCK", regex: /\bLOCK\b/i },
  { nome: "SLEEP(", regex: /\bSLEEP\s*\(/i },
  { nome: "BENCHMARK(", regex: /\bBENCHMARK\s*\(/i },
  { nome: "LOAD_FILE", regex: /\bLOAD_FILE\b/i },
  { nome: "OUTFILE", regex: /\bOUTFILE\b/i },
];

/** Tabelas que aparecem após FROM ou JOIN (case-insensitive, com ou without as). */
function tabelasDoSql(sql: string): string[] {
  const achadas: string[] = [];
  const re = /\b(?:from|join)\s+([`"']?)([a-zA-Z0-9_]+)\1\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    achadas.push(m[2]!);
  }
  return achadas;
}

export function validarConsultaDeReceita(sql: string, tabelasPermitidas: readonly string[]): void {
  const trim = sql.trim();

  // Um comando só, sem ponto-e-vírgula.
  if (trim.includes(";")) {
    throw new LeituraInvalidaError("consulta_nao_pode_ter_mais_de_um_comando");
  }

  // Começa com SELECT.
  if (!/^select\b/i.test(trim)) {
    throw new LeituraInvalidaError("consulta_deve_comecar_com_select");
  }

  // Sem comentários.
  for (const proibido of PROIBIDOS_TEXTO) {
    if (trim.includes(proibido)) {
      throw new LeituraInvalidaError(`comentario_proibido:${proibido}`);
    }
  }

  // Sem palavras perigosas (palavra inteira, sem os identificadores entre crases).
  const semIdentificadores = trim.replace(/`(?:[^`]|``)*`/g, "``");
  for (const { nome, regex } of PROIBIDOS_PALAVRA) {
    if (regex.test(semIdentificadores)) {
      throw new LeituraInvalidaError(`palavra_proibida:${nome}`);
    }
  }

  // Toda tabela citada deve estar na permitida.
  const permitidas = new Set(tabelasPermitidas.map((t) => t.toLowerCase()));
  for (const tabela of tabelasDoSql(sql)) {
    if (!permitidas.has(tabela.toLowerCase())) {
      throw new LeituraInvalidaError(`tabela_nao_liberada:${tabela}`);
    }
  }
}
