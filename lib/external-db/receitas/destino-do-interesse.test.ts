import { describe, expect, it } from "vitest";

import { destinoDoInteresseSchema, orientacaoDeInteresse } from "./destino-do-interesse";

const PIPE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAPA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DESTINO = { pipeline_id: PIPE, stage_id: ETAPA };

// O que cada caso guarda, e a linha que o deixa vermelho se for revertida:
//  - sem destino manda para a equipe → trocar o ramo `if (!destino)` por um que devolva um destino
//  - destino sumido manda para a equipe → tirar o ramo `if (!nomes)`
//  - com destino entrega os ids e a referência → tirar `referencia_do_item` do retorno
//  - o código do item vai ao cliente → tirar a frase `cód. <id>` da instrução (o agente perde o id no turno seguinte)
//  - o schema é fechado → tirar `.strict()`

describe("orientacaoDeInteresse", () => {
  it("sem destino: o agente NÃO abre negócio e passa a conversa para a equipe", () => {
    const o = orientacaoDeInteresse("wordpress-conteudo", null, null);

    expect(o.destino).toBeNull();
    expect(o).toMatchObject({ motivo: "sem_destino" });
    expect(o.instrucao).toContain("crm_request_human_handoff");
    expect(o.instrucao).toContain("NÃO abra negócio");
  });

  it("instância sem o campo (anterior à R5b) também é 'sem destino'", () => {
    expect(orientacaoDeInteresse("woocommerce-produtos", undefined, null)).toMatchObject({
      destino: null,
      motivo: "sem_destino",
    });
  });

  it("destino configurado mas o funil sumiu ou foi arquivado: passa para a equipe, com outro motivo", () => {
    const o = orientacaoDeInteresse("wordpress-conteudo", DESTINO, null);

    expect(o.destino).toBeNull();
    expect(o).toMatchObject({ motivo: "destino_indisponivel" });
    expect(o.instrucao).toContain("crm_request_human_handoff");
  });

  it("destino válido: entrega os ids, os nomes e o molde da referência", () => {
    const o = orientacaoDeInteresse("wordpress-conteudo", DESTINO, { funil: "Imóveis", etapa: "Interesse" });

    expect(o).toMatchObject({
      destino: { pipeline_id: PIPE, stage_id: ETAPA, funil: "Imóveis", etapa: "Interesse" },
      referencia_do_item: "wordpress-conteudo:<id do item>",
    });
    expect(o.instrucao).toContain("crm_create_lead");
    expect(o.instrucao).toContain("referencia_externa");
  });

  it("destino válido: manda mostrar o código do item ao cliente e só afirmar depois do sucesso", () => {
    const o = orientacaoDeInteresse("wordpress-conteudo", DESTINO, { funil: "Imóveis", etapa: "Interesse" });

    // Sem o código no texto mostrado, o turno em que o cliente escolhe não tem o id do item.
    expect(o.instrucao).toContain("cód. <id>");
    expect(o.instrucao).toContain("responder com sucesso");
  });
});

describe("destinoDoInteresseSchema", () => {
  it("aceita os dois ids", () => {
    expect(destinoDoInteresseSchema.safeParse(DESTINO).success).toBe(true);
  });

  it.each<[unknown, string]>([
    [{ pipeline_id: PIPE }, "sem etapa"],
    [{ stage_id: ETAPA }, "sem funil"],
    [{ pipeline_id: "x", stage_id: ETAPA }, "funil que não é uuid"],
    [{ ...DESTINO, extra: 1 }, "chave a mais"],
  ])("recusa %j (%s)", (valor) => {
    expect(destinoDoInteresseSchema.safeParse(valor).success).toBe(false);
  });
});
