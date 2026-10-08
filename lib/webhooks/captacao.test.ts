// @vitest-environment node
//
// O RÓTULO DA RECUSA TEM DE DIZER O QUE FALHOU (#2297, caminho 4) ─────────────
//
// `erro_ao_criar_lead` prometia "confira se o funil e a etapa da fonte ainda
// existem" para TODA recusa de `createLeadHandler` — e essa promessa só é
// verdadeira para os códigos que são sobre funil ou etapa. Uma recusa da régua
// de campos obrigatórios (ou uma falha interna) mostrava a frase errada na tela
// "Leads recebidos", que é onde quem depura a fonte procura por que nada entrou.
//
// A isenção da rota (`exigirCamposDaEtapa: false`, decisão do #2295) não é
// tocada aqui: isto é vocabulário do RÓTULO, não da régua.
//
// Sabotagem esperada: voltar `motivoDaRecusaDaCriacao` para um
// `return "erro_ao_criar_lead"` deixa os três primeiros casos vermelhos.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";
import { DICIONARIO } from "@/lib/i18n/dicionario";

import { MOTIVO_DA_RECUSA_LABEL, motivoDaRecusaDaCriacao, type MotivoDaRecusa } from "./captacao";

const api = (status: number, code: string) => new ApiError(status, code, undefined, "req-1", code);

describe("motivoDaRecusaDaCriacao (#2297, caminho 4)", () => {
  it("a régua vira `recusa_da_regra` — o rótulo fala de régua, não de funil", () => {
    expect(motivoDaRecusaDaCriacao(api(422, "required_fields_missing"))).toBe("recusa_da_regra");
  });

  it("funil/etapa sumidos continua sendo `erro_ao_criar_lead` — o rótulo original segue certo", () => {
    expect(motivoDaRecusaDaCriacao(api(404, "not_found"))).toBe("erro_ao_criar_lead");
    expect(motivoDaRecusaDaCriacao(api(422, "stage_pipeline_mismatch"))).toBe("erro_ao_criar_lead");
  });

  it("qualquer OUTRA recusa cai em `erro_inesperado` — o rótulo deixa de mentir", () => {
    expect(motivoDaRecusaDaCriacao(api(500, "internal_error"))).toBe("erro_inesperado");
    expect(motivoDaRecusaDaCriacao(new Error("rede caiu"))).toBe("erro_inesperado");
    expect(motivoDaRecusaDaCriacao(undefined)).toBe("erro_inesperado");
  });

  it("o vocabulário é exatamente o dos rótulos: motivo sem rótulo (ou rótulo órfão) reprova", () => {
    expect(Object.keys(MOTIVO_DA_RECUSA_LABEL).sort()).toEqual(
      [
        "assinatura_indecifravel",
        "assinatura_invalida",
        "campo_numerico_invalido",
        "erro_ao_criar_lead",
        "erro_inesperado",
        "recusa_da_regra",
        "sem_campo_mapeavel",
      ].sort(),
    );
    for (const motivo of Object.keys(MOTIVO_DA_RECUSA_LABEL) as MotivoDaRecusa[]) {
      expect(MOTIVO_DA_RECUSA_LABEL[motivo].trim().length).toBeGreaterThan(10);
    }
  });

  it("os rótulos novos dizem a causa, sem repetir a frase do funil/etapa", () => {
    expect(MOTIVO_DA_RECUSA_LABEL.recusa_da_regra).toContain("régua de campos obrigatórios");
    expect(MOTIVO_DA_RECUSA_LABEL.erro_inesperado).toContain("não é nem o funil nem a etapa");
    expect(MOTIVO_DA_RECUSA_LABEL.erro_ao_criar_lead).toContain("funil e a etapa da fonte");
  });

  it("todo rótulo tem tradução em es, en e zh-CN — chega ao `t()` por variável e nenhum varredor de tela o vê", () => {
    const en = JSON.parse(readFileSync("lib/i18n/traducoes/en.json", "utf8")) as Record<string, string>;
    const zh = JSON.parse(readFileSync("lib/i18n/traducoes/zh-CN.json", "utf8")) as Record<string, string>;
    const semTraducao = Object.values(MOTIVO_DA_RECUSA_LABEL).filter(
      (rotulo) => !DICIONARIO[rotulo]?.es || !en[rotulo] || !zh[rotulo],
    );
    expect(semTraducao).toEqual([]);
  });
});
