/**
 * O agente consegue escrever nos campos que o dono declarou no funil?
 *
 * A cadeia tinha quatro elos e três estavam prontos: `updateLeadSchema` aceitava
 * `custom_fields`, `updateLeadHandler` fazia o merge com o que já existia, e a
 * mudança virava atividade na linha do tempo. O quarto — o shape da FERRAMENTA —
 * não declarava a chave, e como o handler monta `{...rest}` a partir dele, o
 * valor era descartado antes de chegar ao schema que o aceitaria.
 *
 * O modo de falha era mudo: nenhum erro, nenhum log, o `crm_update_lead`
 * devolvia sucesso e o campo continuava vazio na ficha.
 *
 * Por isso o teste não se contenta em olhar o shape. Ele reproduz o caminho do
 * handler (destructuring + `updateLeadSchema.parse`) e cobra o valor do outro
 * lado — e traz o CONTROLE NEGATIVO junto: uma chave não declarada tem de
 * continuar sendo descartada, senão o teste passaria mesmo com o defeito de
 * volta, provando apenas que zod aceita objeto.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { updateLeadSchema } from "@/lib/schemas/leads";

import { crmUpdateLead } from "./leads";

/** O mesmo caminho do handler: tira `lead_id`, entrega o resto ao schema. */
function comoOHandlerFaz(entrada: Record<string, unknown>) {
  const doShape = z.object(crmUpdateLead.inputSchema).parse(entrada);
  const { lead_id: _ignorado, ...resto } = doShape as Record<string, unknown>;
  return updateLeadSchema.parse(resto);
}

const LEAD_ID = "11111111-2222-4333-8444-555555555555";

describe("crm_update_lead — campos personalizados do funil", () => {
  it("leva o valor até o schema que o handler usa", () => {
    const saida = comoOHandlerFaz({
      lead_id: LEAD_ID,
      custom_fields: { prescritor: "Dra. Ana", forma_farmaceutica: "capsula" },
    });

    expect(saida.custom_fields).toEqual({
      prescritor: "Dra. Ana",
      forma_farmaceutica: "capsula",
    });
  });

  it("aceita qualquer chave, porque quem as nomeia é o dono do funil", () => {
    // O vocabulário é do nicho: uma farmácia de manipulação declara `ativos`,
    // uma imobiliária declara `metragem`. O schema não pode ter uma lista.
    const saida = comoOHandlerFaz({
      lead_id: LEAD_ID,
      custom_fields: { metragem: 82, aceita_permuta: true, ativos: null },
    });

    expect(saida.custom_fields).toEqual({
      metragem: 82,
      aceita_permuta: true,
      ativos: null,
    });
  });

  it("continua descartando chave que a ferramenta não declara (controle)", () => {
    // Sem esta asserção, o teste acima passaria mesmo com o defeito de volta:
    // provaria só que `z.object` aceita um objeto, não que a chave sobrevive.
    const saida = comoOHandlerFaz({
      lead_id: LEAD_ID,
      title: "Fórmula da Dra. Ana",
      campo_que_ninguem_declarou: "some aqui",
    });

    expect(saida).not.toHaveProperty("campo_que_ninguem_declarou");
    expect(saida.title).toBe("Fórmula da Dra. Ana");
  });

  it("segue opcional — mexer só em tags não obriga a mandar custom_fields", () => {
    const saida = comoOHandlerFaz({ lead_id: LEAD_ID, tags: ["controlado"] });

    expect(saida.tags).toEqual(["controlado"]);
    expect(saida.custom_fields).toBeUndefined();
  });
});
