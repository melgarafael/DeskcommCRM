/**
 * Deduplicação e regras de conflito do import — lógica pura exercitada via
 * funções auxiliares + contrato documentado no processador.
 *
 * O cenário 4 linhas → 1 company + 2 people + 4 contacts mora no invariante
 * de banco (companies-people-import.test.ts) porque precisa de Postgres/RLS.
 */
import { describe, expect, it } from "vitest";

import { normalizeCnpj, normalizePersonName } from "@/lib/crm-b2b/normalize";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";

describe("regras de dedupe do import (fase 1)", () => {
  it("mesmo CNPJ normalizado agrupa empresa", () => {
    const a = normalizeCnpj("11.222.333/0001-81");
    const b = normalizeCnpj("11222333000181");
    expect(a).toBe(b);
    expect(a).toHaveLength(14);
  });

  it("pessoa agrupa por company + nome normalizado", () => {
    const key = (companyId: string, name: string) =>
      `${companyId}|${normalizePersonName(name)}`;
    expect(key("c1", "José da Silva")).toBe(key("c1", "jose  da   silva"));
    expect(key("c1", "José")).not.toBe(key("c2", "José"));
  });

  it("telefones distintos da mesma pessoa viram contacts distintos", () => {
    const p1 = normalizePhoneBR("85999991111");
    const p2 = normalizePhoneBR("85988881111");
    expect(p1).toBe("+5585999991111");
    expect(p2).toBe("+5585988881111");
    expect(p1).not.toBe(p2);
  });
});
