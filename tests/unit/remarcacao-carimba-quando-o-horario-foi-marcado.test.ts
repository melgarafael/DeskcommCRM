/**
 * A REMARCAÇÃO CARIMBA QUANDO O HORÁRIO FOI MARCIDO (#2230) — nos DOIS artefatos.
 *
 * Toda mudança de schema deste repo sai em dois lugares: `supabase/migrations/`
 * (o que o Supabase CLI aplica em ordem) e o apêndice do `supabase/baseline.sql`
 * (o que o `install.sh`/`update.sh` do self-host aplica). `pnpm test:db` roda só
 * o baseline, e o clone que atualiza roda só a cadeia — divergir os dois é cada
 * público receber um produto diferente com o gate verde. O corpo das funções já
 * é coberto por `apendice-do-baseline-nao-diverge-da-cadeia.test.ts`; aqui se
 * mede o que aquele parser não enxerga: a COLUNA, o guard e a POSIÇÃO do bloco.
 *
 * Três coisas são propriedade do TEXTO, e por isso se medem aqui:
 *
 * 1. **A coluna e o gatilho existem nos dois** — sem a coluna em um dos lados, a
 *    rota lê `undefined` naquele clone e a régua volta a ser `created_at` sem
 *    erro nenhum: o defeito nasceria calado do lado que não foi atualizado.
 * 2. **O guard é `is distinct from`** — `fn_appointment_change` monta o SET com
 *    `case when p_patch?'starts_at' then … else starts_at end`, ou seja, SEMPRE
 *    nomeia a coluna. Sem o guard, TODO UPDATE de nota ou de status (e o RPC é o
 *    único caminho de escrita da tabela) reposicionaria a régua e mataria a
 *    véspera armada — o defeito oposto, e igualmente silencioso.
 * 3. **A função entra ANTES da varredura anon** — a varredura (migration 0116)
 *    cura o `ALTER DEFAULT PRIVILEGES` que faz toda função nova nascer com
 *    EXECUTE para `anon`, e só cura o que veio antes dela. O apêndice cresce por
 *    acréscimo no FIM do arquivo, que é exatamente o movimento natural de quem
 *    acrescenta uma migration.
 *
 * O comportamento — a varredura das 18:35 NÃO mandar a véspera da reunião
 * remarcada — é exercitado sem banco em
 * `lib/agenda/aviso-do-compromisso-lembrete.test.ts`; o que o banco faz com o
 * gatilho é de `pnpm test:db`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(process.cwd(), "supabase");
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");
const MIGRATION = readFileSync(
  join(RAIZ, "migrations", "20261004110000_0536_remarcacao_carimba_o_horario.sql"),
  "utf8",
);

/** O cabeçalho do bloco da 0116 — de propósito, o último do apêndice que cria função. */
const VARREDURA = /^-- ---- VARREDURA anon:/m;

/** Comentário não prova nada: o que tem de estar é no COMANDO. */
function semComentarios(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
}

const COLUNA = "add column if not exists starts_at_marked_at timestamptz";
const GUARD = "if new.starts_at is distinct from old.starts_at then";
const CARIMBO = "new.starts_at_marked_at := clock_timestamp();";
const GATILHO = "create trigger trg_starts_at_marked_at";
const BLOCO = "-- ---- a remarcação carimba quando o horário foi marcado (migration 0536) ----";

describe("a remarcação carimba quando o horário foi marcado (#2230)", () => {
  it("o instrumento acha o que precisa achar (guarda de vacuidade)", () => {
    // Sem isto, um cabeçalho `-- manifest:` ausente ou um marcador reescrito
    // fariam as asserções abaixo passarem por ausência de dado.
    expect(MIGRATION.split("\n")[0]).toMatch(/^-- manifest: \S/);
    expect(VARREDURA.test(BASELINE), "bloco da varredura anon não encontrado").toBe(true);
    expect(BASELINE.indexOf(BLOCO)).toBeGreaterThan(0);
    expect(BASELINE.indexOf(GATILHO)).toBeGreaterThan(0);
  });

  it.each([
    ["a migration", MIGRATION],
    ["o baseline", BASELINE],
  ])("%s declara a coluna e o gatilho", (_nome, artefato) => {
    const sql = semComentarios(artefato);
    expect(sql).toContain(COLUNA);
    expect(sql).toContain("create or replace function public.fn_starts_at_marked_at()");
    expect(sql).toContain(GATILHO);
    // `before update of starts_at` — o carimbo só anda quando a coluna do
    // horário entra no SET; nota, link do Meet e status não disparam.
    expect(sql).toMatch(/before update of starts_at on public\.calendar_appointments/);
  });

  it.each([
    ["a migration", MIGRATION],
    ["o baseline", BASELINE],
  ])("%s usa o guard `is distinct from` — nomear a coluna no SET não é mudá-la", (_nome, artefato) => {
    const sql = semComentarios(artefato);
    expect(sql).toContain(GUARD);
    expect(sql).toContain(CARIMBO);
    // O guard precede o carimbo, senão toda escrita reposicionaria a régua.
    expect(sql.indexOf(GUARD)).toBeLessThan(sql.indexOf(CARIMBO));
    // E o corpo devolve `new`, com o carimbo gravado — gatilho BEFORE de verdade.
    expect(sql).toContain("return new;");
  });

  it("o bloco do baseline fica ANTES da varredura anon — a função nova nasce curada", () => {
    const varredura = BASELINE.search(VARREDURA);
    expect(varredura).toBeGreaterThan(0);
    expect(BASELINE.indexOf(BLOCO)).toBeLessThan(varredura);
    // E o gatilho também: ele precisa existir depois de quem cria a função.
    expect(BASELINE.indexOf(GATILHO)).toBeLessThan(varredura);
  });

  it("a coluna não tem backfill — a linha nunca remarcada segue sob `created_at`", () => {
    // Um `update … set starts_at_marked_at = created_at` mudaria o comportamento
    // de dado legado sem a issue ter pedido: a régua antiga já estava certa para
    // quem nunca moveu a reunião, e falha fechada aqui é não perder lembrete.
    expect(semComentarios(MIGRATION)).not.toMatch(/update\s+public\.calendar_appointments/i);
    expect(BASELINE).not.toMatch(/\bset\s+starts_at_marked_at/i);
  });

  it("o número e o carimbo da migration são únicos", () => {
    const arquivos = readdirSync(join(RAIZ, "migrations")).filter((f) => f.endsWith(".sql"));
    const mesmoCarimbo = arquivos.filter((f) => f.startsWith("20261004110000_"));
    const mesmoNumero = arquivos.filter((f) => /^\d{14}_0536_/.test(f));
    expect(mesmoCarimbo).toEqual(["20261004110000_0536_remarcacao_carimba_o_horario.sql"]);
    expect(mesmoNumero).toEqual(mesmoCarimbo);
  });
});
