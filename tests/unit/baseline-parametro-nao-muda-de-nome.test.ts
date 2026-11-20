/**
 * NENHUMA DEFINIÇÃO DO BASELINE TROCA O NOME DE UM PARÂMETRO DE FUNÇÃO.
 *
 * ─── O incidente (atualização 1.118 → 1.119, relatada na comunidade) ────────
 *
 * O `update.sh` parou com
 *
 *     psql:/b.sql:70547: ERROR:  cannot change name of input parameter "c"
 *     psql:/b.sql:71097: ERROR:  cannot change name of input parameter "c"
 *
 * O corpo do dump criava `comando_da_conversa(c public.conversations)`, com o
 * parâmetro CHAMADO `c`, e o apêndice o redefine SEM nome (0404: com nome, a
 * PostgREST a exporia em `/rpc`). Num banco que já existe, o Postgres deixa um
 * `create or replace` DAR nome a um parâmetro sem nome. Por isso cada
 * atualização renomeava o parâmetro para `c` e dependia dos três `drop function`
 * do meio do arquivo para desfazer isso. Quando nenhum `drop` tinha efeito, os
 * `create or replace` sem nome do fim batiam no `c`. O Postgres só recusa trocar
 * um nome que JÁ existe. Medido num Postgres 17 descartável:
 *  - com um objeto dependendo da função, os drops falham e repetir nunca cura;
 *  - com duas aplicações do baseline ao mesmo tempo, sai exatamente o par de
 *    erros do relato.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * Para cada assinatura (nome + tipos de entrada), toda definição do arquivo
 * declara os MESMOS nomes de parâmetro de entrada da ÚLTIMA definição, que é a
 * que o banco instala. Assim nenhuma reaplicação muda nome, e nenhum passo do
 * arquivo depende de um `drop` anterior ter funcionado para não quebrar o
 * próximo. Trocar o nome de verdade exige trocá-lo em TODAS as definições, e a
 * cura do banco que já tem o nome velho (um `drop` condicional ANTES da primeira
 * definição) vem junto: ver o bloco `cura` antes do corpo de
 * `comando_da_conversa` no baseline.
 *
 * ─── O que este teste NÃO cobre ─────────────────────────────────────────────
 *
 * Ele lê o texto. Que um banco preso no estado do incidente se cura ao atualizar
 * é medido em `scripts/test-update-com-dados.sh`, com Postgres de verdade.
 * Funções criadas por `execute` dinâmico dentro de `do $$` ficam fora da leitura.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SQL = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

type Definicao = { linha: number; nomes: string[] };

const MODOS = new Set(["in", "out", "inout", "variadic"]);
// Tipos de mais de uma palavra que o dump escreve sem nome de parâmetro na frente.
const INICIO_DE_TIPO = new Set(["timestamp", "double", "character", "time", "bit", "interval", "national"]);

function argumentosEm(inicio: number): string {
  let profundidade = 0;
  for (let i = inicio; i < SQL.length; i++) {
    if (SQL[i] === "(") profundidade++;
    else if (SQL[i] === ")" && --profundidade === 0) return SQL.slice(inicio + 1, i);
  }
  throw new Error(`parêntese sem fechamento a partir do caractere ${inicio}`);
}

function separarNoTopo(lista: string): string[] {
  const partes: string[] = [];
  let atual = "";
  let profundidade = 0;
  for (const ch of lista) {
    if (ch === "(" || ch === "[") profundidade++;
    if (ch === ")" || ch === "]") profundidade--;
    if (ch === "," && profundidade === 0) {
      partes.push(atual);
      atual = "";
    } else atual += ch;
  }
  if (atual.trim()) partes.push(atual);
  return partes;
}

/** Só os parâmetros de ENTRADA: são eles que o Postgres proíbe renomear. */
function entradas(lista: string): { nome: string; tipo: string }[] {
  const saida: { nome: string; tipo: string }[] = [];
  for (const parte of separarNoTopo(lista)) {
    let tokens = parte
      .trim()
      .split(/\s+default\s+|\s*=\s*/i)[0]!
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let modo = "in";
    const primeiro = (tokens[0] ?? "").toLowerCase();
    if (MODOS.has(primeiro)) {
      modo = primeiro;
      tokens = tokens.slice(1);
    }
    if (modo === "out") continue;
    const cabeca = tokens[0] ?? "";
    const temNome = tokens.length >= 2 && !INICIO_DE_TIPO.has(cabeca.toLowerCase());
    const nome = temNome ? cabeca.replace(/"/g, "") : "";
    const tipo = (temNome ? tokens.slice(1) : tokens)
      .join(" ")
      .toLowerCase()
      .replace(/\b(public|pg_catalog)\./g, "")
      .replace("timestamp with time zone", "timestamptz");
    saida.push({ nome, tipo });
  }
  return saida;
}

function definicoes(): Map<string, Definicao[]> {
  const cabecalho = /^\s*create\s+(?:or\s+replace\s+)?function\s+"?(\w+)"?\."?(\w+)"?\s*\(/gim;
  const porAssinatura = new Map<string, Definicao[]>();
  for (const m of SQL.matchAll(cabecalho)) {
    const args = entradas(argumentosEm(m.index + m[0].length - 1));
    const chave = `${m[1]!.toLowerCase()}.${m[2]!.toLowerCase()}(${args.map((a) => a.tipo).join(", ")})`;
    const linha = SQL.slice(0, m.index).split("\n").length + (m[0].startsWith("\n") ? 1 : 0);
    const lista = porAssinatura.get(chave) ?? [];
    lista.push({ linha, nomes: args.map((a) => a.nome) });
    porAssinatura.set(chave, lista);
  }
  return porAssinatura;
}

describe("baseline: nenhuma definição troca o nome de um parâmetro de função", () => {
  const todas = definicoes();

  it("controle: a leitura acha as funções do arquivo e lê os nomes certos", () => {
    // Sem isto, um regex quebrado deixaria a cerca verde sobre zero funções.
    expect(todas.size).toBeGreaterThan(400);
    // Nomeado de propósito, definido uma vez só: o leitor tem de ver o `c`.
    expect(todas.get("public.tags_do_contato(conversations)")?.map((d) => d.nomes)).toEqual([["c"]]);
    // Tipo de várias palavras, com nome na frente.
    expect(
      todas.get("public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz, boolean)")?.at(-1)
        ?.nomes,
    ).toEqual(["p_status", "p_assigned_to_user_id", "p_bot_silenced_until", "p_force_human", "p_is_blocked", "p_agora", "p_is_group"]);
    // O caso do incidente: várias definições, a última SEM nome.
    const comando = todas.get("public.comando_da_conversa(conversations)") ?? [];
    expect(comando.length).toBeGreaterThanOrEqual(5);
    expect(comando.at(-1)?.nomes).toEqual([""]);
  });

  it("⭐ toda definição declara os mesmos nomes de entrada da última (a que o banco instala)", () => {
    const divergentes: string[] = [];
    for (const [assinatura, defs] of todas) {
      const final = defs.at(-1);
      if (!final) continue;
      for (const d of defs) {
        if (d.nomes.join(",") !== final.nomes.join(",")) {
          divergentes.push(
            `${assinatura}: baseline.sql:${d.linha} declara (${d.nomes.map((n) => n || "<sem nome>").join(", ")}), ` +
              `mas a última definição (baseline.sql:${final.linha}) declara (${final.nomes.map((n) => n || "<sem nome>").join(", ")})`,
          );
        }
      }
    }
    expect(
      divergentes,
      "Num banco que já existe, um `create or replace` que muda o nome de parâmetro ou falha " +
        "(`cannot change name of input parameter`) ou renomeia, e aí quebra o próximo. Use os nomes da última definição.",
    ).toEqual([]);
  });
});
