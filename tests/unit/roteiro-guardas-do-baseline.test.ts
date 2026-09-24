/**
 * As guardas do roteiro de atendimento no TEXTO do baseline (revisão
 * adversarial do #1559). O comportamento é provado em Postgres pelo invariante
 * `tests/invariants/roteiro-de-atendimento-rls-lgpd.test.ts` (job `invariants`);
 * aqui se mede o que só o arquivo sabe — POSIÇÃO:
 *
 *   - a deduplicação do roteiro vivo vem ANTES do reapontamento de
 *     `followup_enrollments` na fusão por nono dígito (bloco da 0198, que roda a
 *     cada `update.sh`). Depois dele, o 23505 do índice novo derrubaria o comando;
 *   - a superfície imutável e o "roteiro só manual" existem na migration 0394 e
 *     no apêndice, e o apêndice cria as funções ANTES da VARREDURA anon.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20260923210000_0394_fluxos_de_atendimento_base.sql"),
  "utf8",
);
const REAPONTA =
  "update public.followup_enrollments t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;";

describe("fusão por nono dígito × roteiro vivo", () => {
  it("o roteiro vivo excedente é encerrado ANTES de reapontar followup_enrollments", () => {
    const dedup = BASELINE.indexOf("-- Roteiro de atendimento vivo ('coletando', 0394): UM por contato");
    const reaponta = BASELINE.indexOf(REAPONTA);
    expect(dedup).toBeGreaterThan(0);
    expect(reaponta).toBeGreaterThan(dedup);
    // E não há outro reapontamento de followup_enrollments antes da deduplicação.
    expect(BASELINE.lastIndexOf("update public.followup_enrollments t set contact_id", dedup)).toBe(-1);
  });
});

describe("superfície imutável e roteiro só manual", () => {
  const varredura = BASELINE.indexOf("-- ---- VARREDURA anon:");
  it.each([
    "add constraint followup_flow_pointers_roteiro_so_manual",
    "create trigger trg_superficie_do_fluxo_imutavel",
    "create trigger trg_enrollment_superficie_coerente",
  ])("%s — na migration e no apêndice, antes da varredura anon", (trecho) => {
    expect(MIGRATION).toContain(trecho);
    const noBaseline = BASELINE.indexOf(trecho);
    expect(noBaseline).toBeGreaterThan(0);
    expect(noBaseline).toBeLessThan(varredura);
  });
});

describe("o roteiro encerra com humano, no opt-out e no prazo (0397)", () => {
  const MIGRATION_0397 = readFileSync(
    join(process.cwd(), "supabase", "migrations", "20260923230000_0397_roteiro_encerra_com_humano_e_prazo.sql"),
    "utf8",
  );
  const varredura = BASELINE.indexOf("-- ---- VARREDURA anon:");
  it.each([
    "create trigger trg_contato_encerra_roteiro_com_humano_ou_opt_out",
    "create or replace function public.fn_encerrar_roteiros_vencidos(",
    "revoke execute on function public.fn_encerrar_roteiros_vencidos(int) from anon;",
    "revoke execute on function public.fn_encerrar_roteiros_vencidos(int) from authenticated;",
  ])("%s — na migration e no apêndice, antes da varredura anon", (trecho) => {
    expect(MIGRATION_0397).toContain(trecho);
    const noBaseline = BASELINE.indexOf(trecho);
    expect(noBaseline).toBeGreaterThan(0);
    expect(noBaseline).toBeLessThan(varredura);
  });
});

