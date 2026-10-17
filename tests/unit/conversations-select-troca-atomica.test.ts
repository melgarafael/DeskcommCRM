import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A TROCA DE `conversations_select` É ATÔMICA (migration 0661, #2542).
 *
 * O apêndice da 0661 é o ÚNICO lugar do baseline que cria `conversations_select`
 * (a definição da 0035 saiu do corpo). O `update.sh` aplica o baseline sem
 * ON_ERROR_STOP e em autocommit: com `drop policy` e `create policy` soltos, um
 * create que falhasse deixaria `conversations` com RLS e SEM policy de leitura —
 * o inbox some para todos na VPS. Num único `do`, a falha desfaz o drop.
 * Mesma classe do #2670 (troca de restrição no apêndice).
 */
const RAIZ = join(__dirname, "..", "..", "supabase");
const MIGRATION = readdirSync(join(RAIZ, "migrations")).find((f) =>
  /_0661_atendimento_conjunto_participantes\.sql$/.test(f),
);

function trocaAtomica(sql: string): boolean {
  const bloco = /do \$conversations_select\$ begin([\s\S]*?)end \$conversations_select\$;/.exec(sql);
  if (!bloco) return false;
  const corpo = bloco[1] ?? "";
  const fora = sql.replace(bloco[0], "");
  return (
    corpo.includes('drop policy if exists "conversations_select" on public.conversations;') &&
    corpo.includes('create policy "conversations_select" on public.conversations') &&
    !/create policy "conversations_select"/.test(fora)
  );
}

describe("conversations_select: drop e create no mesmo bloco DO", () => {
  it("controle: a migration 0661 existe", () => {
    expect(MIGRATION).toBeDefined();
  });

  it("na migration 0661", () => {
    const sql = readFileSync(join(RAIZ, "migrations", MIGRATION ?? ""), "utf8");
    expect(trocaAtomica(sql)).toBe(true);
  });

  it("no baseline (o que o update.sh aplica)", () => {
    const sql = readFileSync(join(RAIZ, "baseline.sql"), "utf8");
    expect(trocaAtomica(sql)).toBe(true);
  });
});
