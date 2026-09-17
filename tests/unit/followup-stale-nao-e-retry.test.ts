/**
 * Catraca: `followup_stale` não pode voltar a ser SQLSTATE 40001.
 *
 * 40001 é serialization_failure — o cliente retenta a transação. O patch de
 * follow-up usa essa mensagem para revisão velha e enrollment sumido, que não
 * se curam com retry. Medido: 6000 erros/min, CPU 100%, mais de 24h.
 *
 * Este arquivo lê o SQL que o self-host aplica. A prova com Postgres de
 * verdade fica no invariante de agenda (fn_followup_patch recusa reativação
 * inválida pela mensagem, não pelo 40001).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isFollowupCasRecusado } from "@/lib/atendimento/fronteira";

const RAIZ = join(__dirname, "../..");
const BASELINE = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");
const MIGRATION = readFileSync(
  join(RAIZ, "supabase/migrations/20260914195200_0245_followup_stale_nao_e_retry.sql"),
  "utf8",
);

describe("followup_stale não é retry de serialização", () => {
  it("baseline e migration 0245 levantam P0001, nunca 40001", () => {
    const velho = /raise exception 'followup_stale' using errcode='40001'/;
    const novo = /raise exception 'followup_stale' using errcode='P0001'/;
    expect(BASELINE).not.toMatch(velho);
    expect(MIGRATION).not.toMatch(velho);
    expect(BASELINE).toMatch(novo);
    expect(MIGRATION).toMatch(novo);
  });

  it("o motor trata P0001 e 40001 como o mesmo recuso permanente", () => {
    expect(isFollowupCasRecusado({ code: "P0001", message: "followup_stale" })).toBe(true);
    expect(isFollowupCasRecusado({ code: "40001" })).toBe(true);
    expect(isFollowupCasRecusado({ code: "23505" })).toBe(false);
  });
});
