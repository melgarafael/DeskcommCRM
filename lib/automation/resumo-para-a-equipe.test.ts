import { describe, expect, it } from "vitest";

import { donoEFunilDoContexto } from "./resumo-do-evento";
import { montarResumoParaAEquipe, type EntradaDoResumo } from "./resumo-para-a-equipe";

/**
 * RESPONSÁVEL E FUNIL NO AVISO DA EQUIPE (#4802 — "quem vendeu").
 *
 * O caminho completo (leitura do banco + transporte) é provado em
 * `resumo-sem-texto-livre.test.ts`. Aqui ficam as bordas da função pura:
 * linha ausente quando não há nome, e a mesma limpeza do nome do cliente.
 */
function entrada(patch: Partial<EntradaDoResumo> = {}): EntradaDoResumo {
  return {
    idioma: "pt-BR",
    regra: "Venda fechada",
    lead: { value_cents: 50_000, currency: "BRL" },
    contato: { name: "Ana Lima", phone_number: "+5571988068310" },
    ...patch,
  };
}

describe("montarResumoParaAEquipe — responsável e funil", () => {
  it("escreve as duas linhas quando há nome", () => {
    const linhas = montarResumoParaAEquipe(
      entrada({ responsavel: "Carla Souza", funil: "Funil de vendas" }),
    ).split("\n");
    expect(linhas).toContain("Responsável: Carla Souza");
    expect(linhas).toContain("Funil: Funil de vendas");
  });

  it("sem nome, nenhuma linha — vazio e espaço não afirmam um responsável", () => {
    for (const vazio of [undefined, null, "", "   "]) {
      const texto = montarResumoParaAEquipe(entrada({ responsavel: vazio, funil: vazio }));
      expect(texto).not.toContain("Responsável:");
      expect(texto).not.toContain("Funil:");
    }
  });

  it("link no nome do funil não passa — a mesma limpeza do nome do cliente", () => {
    const texto = montarResumoParaAEquipe(entrada({ funil: "Vendas https://golpe.example.com" }));
    expect(texto).not.toContain("golpe.example.com");
    expect(texto.split("\n")).toContain("Funil: Vendas");
  });

  it("em espanhol, os rótulos seguem o idioma da organização", () => {
    const linhas = montarResumoParaAEquipe(
      entrada({ idioma: "es", responsavel: "Carla", funil: "Ventas" }),
    ).split("\n");
    expect(linhas).toContain("Responsable: Carla");
    expect(linhas).toContain("Embudo: Ventas");
  });
});

describe("donoEFunilDoContexto", () => {
  it("lê só os ids, e o que não é texto vira null", () => {
    expect(
      donoEFunilDoContexto({ owner_kind: "ai", owner_user_id: 7, pipeline_id: "" }),
    ).toEqual({ ownerKind: "ai", ownerUserId: null, pipelineId: null });
    expect(donoEFunilDoContexto(null)).toEqual({ ownerKind: null, ownerUserId: null, pipelineId: null });
  });
});
