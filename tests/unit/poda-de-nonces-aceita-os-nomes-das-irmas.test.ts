/**
 * A PODA DE NONCES DE OAUTH ACEITA OS NOMES QUE O CRON MANDA.
 *
 * ## O defeito que este gate fecha
 *
 * O PostgREST resolve sobrecarga pelo NOME do argumento, nunca pela posição. O
 * cron `app/api/v1/cron/data-retention/route.ts` drena TODAS as podas pelo mesmo
 * laço de lotes, mandando sempre `{ p_retencao_dias, p_limite }` (linha 163) — e
 * `public.fn_expurgar_nonces_de_oauth` nasceu na migration 0190 com
 * `(p_dias int, p_lote int default 500)`: mesmos dois `int`, na mesma ordem,
 * outros nomes. Para quem resolve por nome isso é OUTRA função: a chamada não
 * encontrava sobrecarga, o cron respondia `PGRST202` todos os dias, a tabela
 * `public.calendar_oauth_nonces` (a que impede reuso do `state` do login Google)
 * crescia para sempre e a varredura de anonimizações LGPD do mesmo bloco ficava
 * inalcançada, porque roda depois das podas (issue #966).
 *
 * Nada disso aparece em `typecheck`, `lint`, `build` ou `e2e` — a chamada é uma
 * STRING e o nome do parâmetro é texto dentro de um arquivo `.sql`. Um rename de
 * parâmetro é invisível para o compilador.
 *
 * ## O contrato que este teste exige
 *
 * 1. o cron fala DOIS nomes, e são `p_retencao_dias`/`p_limite`;
 * 2. as SETE podas que o mesmo laço chama declaram exatamente esses dois, na
 *    mesma ordem — foi a sétima que ficou para trás;
 * 3. a INSTALAÇÃO NOVA recebe o conserto (`supabase/baseline.sql`, que o
 *    `update.sh` reaplica) e a EXISTENTE também (migration 0364), com a MESMA
 *    assinatura nos dois caminhos;
 * 4. os dois caminhos DERRUBAM a assinatura antiga com
 *    `drop function if exists public.fn_expurgar_nonces_de_oauth(int, int)`
 *    ANTES do `create`: `create or replace` NÃO troca nome de parâmetro de
 *    entrada — o Postgres recusa com "cannot change name of input parameter" —
 *    e sem o drop a instalação que já existe continuaria com a função antiga e a
 *    issue não fecharia;
 * 5. a migration 0364 reaplica os ACLs que o drop leva junto (os da 0192).
 *
 * ## Por que aqui, em `tests/unit`, e não em `pnpm test:db`
 *
 * `test:db` precisa de Docker e de um Postgres semeado. Este teste lê os DOIS
 * lados do contrato — o que o código envia e o que o schema declara — em texto,
 * e roda em qualquer `pnpm test:unit`. O que ele não prova é o runtime: que o
 * Postgres só aceita a troca de nome com o `drop` antes é medido em `test:db`;
 * aqui o drop é exigido como TEXTO, na ordem certa.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BASELINE = readFileSync("supabase/baseline.sql", "utf8");
const CRON = readFileSync("app/api/v1/cron/data-retention/route.ts", "utf8");
const MIGRATION = readFileSync(
  "supabase/migrations/20260920120000_0364_a_poda_de_nonces_aceita_os_nomes_das_irmas.sql",
  "utf8",
);

/** Os dois nomes que o cron manda em `db.rpc(nome, { ... })`. */
const NOMES_DO_CRON = ["p_retencao_dias", "p_limite"];

/** As SETE podas drenadas pelo mesmo laço (`drenar`), na ordem do arquivo. */
const PODAS = [
  "fn_podar_fila_de_jobs",
  "fn_expurgar_auditoria_vencida",
  "fn_expurgar_espelho_da_agenda",
  "fn_expurgar_nonces_de_oauth",
  "fn_expurgar_conversa_do_caso_vencida",
  "fn_expurgar_passagens_vencidas",
  "fn_expurgar_avisos_de_caso_vencidos",
];

const ALVO = "fn_expurgar_nonces_de_oauth";

const RE_CRIA = (fn: string) =>
  new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+"?public"?\\s*\\.\\s*"?${fn}"?\\s*\\(`,
    "gi",
  );

const RE_DERRUBA = new RegExp(
  `drop\\s+function\\s+if\\s+exists\\s+"?public"?\\s*\\.\\s*"?${ALVO}"?\\s*\\(\\s*int\\s*,\\s*int\\s*\\)`,
  "gi",
);

/**
 * Nomes dos parâmetros declarados em cada
 * `create or replace function public.<fn>(...)` do texto, na ordem da
 * declaração. Varre parêntese a parêntese para aguentar assinatura em várias
 * linhas (é assim que este schema escreve).
 */
function nomesDeclarados(texto: string, fn: string): string[][] {
  const achados: string[][] = [];
  for (const m of texto.matchAll(RE_CRIA(fn))) {
    const abre = (m.index ?? 0) + m[0].length - 1;
    let profundidade = 0;
    let fecha = -1;
    for (let i = abre; i < texto.length; i += 1) {
      if (texto[i] === "(") profundidade += 1;
      else if (texto[i] === ")") {
        profundidade -= 1;
        if (profundidade === 0) {
          fecha = i;
          break;
        }
      }
    }
    if (fecha === -1) continue;
    achados.push(
      texto
        .slice(abre + 1, fecha)
        .split(",")
        .map((p) => p.trim().split(/\s+/)[0] ?? "")
        .filter((nome) => nome.length > 0),
    );
  }
  return achados;
}

/** A assinatura em vigor num arquivo: a última declaração da função. */
function assinaturaEmVigor(texto: string, fn: string): string[] {
  const todas = nomesDeclarados(texto, fn);
  expect(todas.length, `${fn} não é declarada em create or replace no arquivo`).toBeGreaterThan(0);
  return todas[todas.length - 1]!;
}

describe("a poda de nonces de OAuth aceita os nomes das irmãs", () => {
  it("o cron fala dois nomes, e são estes", () => {
    const citados = [...new Set(CRON.match(/\bp_[a-z_]+\b/g) ?? [])].sort();
    expect(citados).toEqual([...NOMES_DO_CRON].sort());
    expect(CRON).toMatch(/await db\.rpc\(nome, \{\s*p_retencao_dias: dias,\s*p_limite: TAMANHO_DO_LOTE,/);
  });

  it("as sete podas do mesmo laço declaram exatamente os dois nomes", () => {
    for (const fn of PODAS) {
      expect(assinaturaEmVigor(BASELINE, fn), `${fn} não declara os nomes que o cron envia`)
        .toEqual(NOMES_DO_CRON);
    }
  });

  it("o cron chama as sete pelo mesmo laço", () => {
    for (const fn of PODAS) {
      expect(CRON, `${fn} não é chamada pelo cron`).toContain(`"${fn}"`);
    }
  });

  it("a instalação NOVA derruba a assinatura antiga antes de recriar (baseline)", () => {
    const derruba = [...BASELINE.matchAll(RE_DERRUBA)].map((m) => m.index ?? -1);
    const cria = [...BASELINE.matchAll(RE_CRIA(ALVO))].map((m) => m.index ?? -1);
    expect(derruba.length, "supabase/baseline.sql não derruba a assinatura (int, int)").toBeGreaterThan(0);
    expect(cria.length).toBeGreaterThan(0);
    expect(Math.min(...derruba)).toBeLessThan(Math.max(...cria));
  });

  it("a ATUALIZAÇÃO derruba a assinatura antiga antes de recriar (0364)", () => {
    const derruba = [...MIGRATION.matchAll(RE_DERRUBA)].map((m) => m.index ?? -1);
    const cria = [...MIGRATION.matchAll(RE_CRIA(ALVO))].map((m) => m.index ?? -1);
    expect(derruba.length, "a 0364 não derruba a assinatura (int, int)").toBeGreaterThan(0);
    expect(cria.length).toBeGreaterThan(0);
    expect(Math.min(...derruba)).toBeLessThan(Math.max(...cria));
  });

  it("instalação nova e instalação existente recebem a MESMA assinatura", () => {
    expect(assinaturaEmVigor(MIGRATION, ALVO)).toEqual(assinaturaEmVigor(BASELINE, ALVO));
    expect(assinaturaEmVigor(MIGRATION, ALVO)).toEqual(NOMES_DO_CRON);
    expect(MIGRATION).toMatch(
      /revoke execute on function public\.fn_expurgar_nonces_de_oauth\(int, int\) from public, anon, authenticated;/,
    );
    expect(MIGRATION).toMatch(
      /grant execute on function public\.fn_expurgar_nonces_de_oauth\(int, int\) to service_role;/,
    );
  });
});
