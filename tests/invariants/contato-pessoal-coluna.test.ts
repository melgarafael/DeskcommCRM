import { describe, expect, it } from "vitest";

import { columnExists, indexExists, seedGov, sql, GOV_ORG } from "./gov-helpers";

/**
 * A COLUNA DO CONTATO PESSOAL (spec 21, fatia 1, migration 0563).
 *
 * A marca mora em `contacts.is_personal`, coluna nova de propósito: reutilizar
 * `is_blocked` misturaria descadastro com pessoal na auditoria e nas regras
 * (spec §3.1). Quem marcou/quando fica só em auditoria + timeline, sem coluna
 * extra (spec §3.6) — por isso este arquivo cobra a coluna e o índice, e os
 * eventos novos são cobrados pelo teste da rota (`personal/route.test.ts`).
 *
 * ─── SABOTAGEM (prova no CI; cada item derruba os casos marcados) ──────────
 * - `DEFAULT true` na migration: contato nasce pessoal e a lista esvazia →
 *   caem "nasce desligado" e "contato novo nasce operacional".
 * - Tirar `'personal'` do CHECK: a saída de campanha de pessoal vira `23514` →
 *   cai "CHECK aceita personal".
 * - Tirar o `where (is_personal = true)` do índice: vira índice cheio que o
 *   filtro de pessoal não usa → cai "índice parcial".
 * Linha para reverter: `supabase/migrations/20261006030529_0563_contato_pessoal.sql`
 * (e o apêndice 0563 no fim de `supabase/baseline.sql`).
 */

const CONTATO_PROVA = "dddd1111-1111-4111-8111-111111111111";

describe("contato pessoal: coluna, default, índice e saída de campanha", () => {
  it("a coluna existe", () => {
    expect(columnExists("contacts", "is_personal")).toBe(true);
  });

  it("nasce desligado — default false NOT NULL", () => {
    const def = sql(
      `select column_default || '|' || is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'contacts' and column_name = 'is_personal';`,
    );
    expect(def).toBe("false|NO");
  });

  it("contato novo nasce operacional (sem precisar dizer)", () => {
    seedGov();
    sql(
      `insert into public.contacts (id, organization_id, display_name)
         values ('${CONTATO_PROVA}', '${GOV_ORG}', 'Prova pessoal')
         on conflict (id) do nothing;`,
    );
    const valor = sql(
      `select is_personal::text from public.contacts where id = '${CONTATO_PROVA}';`,
    );
    expect(valor).toBe("false");
  });

  it("índice parcial existe, só para os marcados", () => {
    expect(indexExists("idx_contacts_org_personal")).toBe(true);
    const def = sql(
      `select pg_get_indexdef(oid) from pg_class where relname = 'idx_contacts_org_personal';`,
    );
    expect(def).toContain("is_personal");
  });

  it("CHECK de destinatário de campanha aceita `personal`", () => {
    const def = sql(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'campaign_recipients_status_check';`,
    );
    expect(def).toContain("personal");
  });
});
