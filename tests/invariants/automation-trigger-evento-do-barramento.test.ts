import { beforeAll, describe, expect, it } from "vitest";

import { TRIGGER_EVENTS } from "@/lib/schemas/webhooks";
import { GOV_ORG, seedGov, sql } from "./gov-helpers";

/**
 * #4900 — O GATILHO DE CASO TEM DE SER GRAVÁVEL no Postgres de verdade.
 *
 * O parecer pegou o defeito antes do merge: a primeira versão gravava
 * `case_opened`/`case_closed` em `automation_rules.trigger_event` e traduzia
 * para `ai.case_*` no motor, mas o CHECK da coluna (`supabase/baseline.sql:5801`)
 * exige um PONTO no nome (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`) — a regra
 * morria no INSERT. Nenhum teste unitário via isso: todos usavam dublê, e o
 * dublê não tem CHECK.
 *
 * Aqui a régua é o banco. Três provas, todas em INSERT real:
 *   1. os dois gatilhos de caso entram;
 *   2. o nome curto do vocabulário antigo (`case_opened`) é RECUSADO — é a
 *      sabotagem: com o CHECK afrouxado, esta prova fica vermelha;
 *   3. TODO gatilho do catálogo entra, um a um. Gatilho novo com nome fora da
 *      régua reprova aqui antes de chegar à tela do operador.
 */

beforeAll(() => {
  seedGov();
});

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Tenta gravar uma regra com este gatilho; devolve o erro do Postgres, se houver. */
function grava(nome: string): { ok: boolean; erro: string } {
  try {
    sql(`
      insert into public.automation_rules (organization_id, name, trigger_event)
        values ('${GOV_ORG}', ${sqlString(`regra de ${nome}`)}, ${sqlString(nome)});
    `);
    return { ok: true, erro: "" };
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string };
    const stderr = typeof err.stderr === "string" ? err.stderr : (err.stderr?.toString("utf8") ?? "");
    return { ok: false, erro: `${stderr}${err.message ?? ""}` };
  }
}

describe("automation_rules.trigger_event aceita o nome do barramento (#4900)", () => {
  it("os dois gatilhos de caso entram no banco", () => {
    for (const nome of ["ai.case_opened", "ai.case_closed"]) {
      expect(grava(nome), nome).toMatchObject({ ok: true });
    }
  });

  it("o nome curto do vocabulário antigo é recusado pelo CHECK da coluna", () => {
    // A tradução existia porque `case_opened` parecia mais curto para gravar. O
    // banco nunca concordou — e CHECK que ninguém exercita é CHECK que o próximo
    // refactor afrouxa sem quebrar teste nenhum.
    for (const nome of ["case_opened", "case_closed"]) {
      const r = grava(nome);
      expect(r.ok, nome).toBe(false);
      expect(r.erro, nome).toContain("automation_rules_trigger_event_check");
    }
  });

  it("todo gatilho do catálogo é gravável — a mesma régua do banco", () => {
    const recusados = TRIGGER_EVENTS.filter((gatilho) => !grava(gatilho).ok);
    expect(recusados).toEqual([]);
  });
});
