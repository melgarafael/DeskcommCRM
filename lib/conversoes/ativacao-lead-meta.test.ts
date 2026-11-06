import { describe, expect, it } from "vitest";

import { ativacaoLeadMeta, leadNasceuAposAtivacao } from "./ativacao-lead-meta";

describe("corte do nascimento causal", () => {
  it("desliga por padrão e com data inválida", () => {
    expect(ativacaoLeadMeta(null)).toBeNull();
    expect(ativacaoLeadMeta("2026-10-16T01:00:00")).toBeNull();
    expect(leadNasceuAposAtivacao(null, "2026-10-16T01:01:00Z")).toBe(false);
  });

  it("usa os microssegundos do banco e não envia nascimento anterior no mesmo milissegundo", () => {
    const corte = "2026-10-16T01:00:00.123456+00:00";
    expect(leadNasceuAposAtivacao(corte, "2026-10-16T01:00:00.123455+00:00")).toBe(false);
    expect(leadNasceuAposAtivacao(corte, "2026-10-16T01:00:00.123456+00:00")).toBe(false);
    expect(leadNasceuAposAtivacao(corte, "2026-10-16T01:00:00.123457+00:00")).toBe(true);
  });
});
