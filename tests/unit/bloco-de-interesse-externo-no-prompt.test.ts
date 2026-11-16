import { describe, expect, it } from "vitest";

import { blocosDeInteresseExternoResidentes } from "@/lib/agent-engine/agent/inbound-turn";

/**
 * O ENSINO DO INTERESSE NUM ITEM DO BANCO EXTERNO, TODO TURNO (Spec 25, R5c).
 *
 * Medido no espelho numa imobiliária montada do zero: o agente mostrou o imóvel e,
 * quando o cliente disse "tenho interesse nesse", escreveu "seu interesse está
 * registrado" sem chamar nada — três vezes. A orientação que a consulta da receita
 * devolve vive no resultado daquele turno, e resultado de ferramenta não acompanha a
 * conversa. O ensino precisa ser residente, como o da agenda.
 *
 * O que cada caso guarda, e a linha que o deixa vermelho se for revertida:
 *  1. Com as DUAS ferramentas o bloco entra, nomeando-as e mandando chamar no MESMO
 *     turno, sem funil, e só afirmar depois do sucesso
 *     → tirar o ramo `blocosResidentes.push(...blocosDeInteresseExternoResidentes(...))`
 *       de `inbound-turn.ts` (este teste não o vê; o de baixo, sim) ou esvaziar o bloco.
 *  2. Faltando qualquer das duas, nada entra: nomear ferramenta ausente faz o modelo
 *     tentar chamá-la
 *     → trocar o `&&` por `||` na função.
 */
const CONSULTAR = "crm_consultar_receita";
const CRIAR = "crm_create_lead";

describe("bloco do interesse num item do banco externo", () => {
  it("o agente com as duas ferramentas recebe o ensino completo", () => {
    const blocos = blocosDeInteresseExternoResidentes([CONSULTAR, CRIAR, "crm_add_case_note"]);

    expect(blocos).toHaveLength(1);
    const texto = blocos[0]!;
    expect(texto).toContain(CONSULTAR);
    expect(texto).toContain(CRIAR);
    expect(texto).toContain("referencia_externa");
    expect(texto).toContain("NESTE turno");
    expect(texto).toContain("NÃO informe `pipeline_id` nem `stage_id`");
    expect(texto).toContain("DEPOIS de `crm_create_lead` responder com sucesso");
    expect(texto).toContain("cód.");
  });

  it.each<[string, string[]]>([
    ["só consulta", [CONSULTAR]],
    ["só cria negócio", [CRIAR]],
    ["nenhuma das duas", ["crm_add_case_note"]],
    ["sem ferramenta", []],
  ])("%s: nada entra no prompt", (_nome, ferramentas) => {
    expect(blocosDeInteresseExternoResidentes(ferramentas)).toEqual([]);
  });
});
