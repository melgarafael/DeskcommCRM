/**
 * O PARSER DO LEAD ADS — texto da Meta → dado, sem rede e sem banco.
 *
 * O primeiro caso lê `PAYLOAD_DOCUMENTADO_DA_META` verbatim: é o "payload
 * documentado" que dá sentido à fatia (o envelope de página, `field: "leadgen"`,
 * `value.leadgen_id` + `field_data[]`). Os outros medem as bordas que fazem a
 * diferença entre "não entrou porque não veio" e "não entrou porque o código
 * desistiu": resposta ausente, `leadgen_id` ausente, mudança que não é lead,
 * telefone que a régua não reconhece e nome em duas partes.
 */
import { describe, expect, it } from "vitest";

import { lerLeadsDoFormularioMeta } from "./payload";
import {
  ESPERADO_DO_EXEMPLO,
  PAYLOAD_DOCUMENTADO_DA_META,
  entregaDoLeadAds,
} from "./payload-de-exemplo";

describe("lerLeadsDoFormularioMeta", () => {
  it("lê o payload documentado da Meta: identidade, respostas e o instante do sinal", () => {
    const leitura = lerLeadsDoFormularioMeta(PAYLOAD_DOCUMENTADO_DA_META);
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;

    expect(leitura.descartados).toEqual([]);
    expect(leitura.leads).toHaveLength(1);
    const lead = leitura.leads[0]!;

    expect(lead.leadgenId).toBe(ESPERADO_DO_EXEMPLO.leadgenId);
    expect(lead.formId).toBe(ESPERADO_DO_EXEMPLO.formId);
    expect(lead.pageId).toBe(ESPERADO_DO_EXEMPLO.pageId);
    expect(lead.adId).toBe(ESPERADO_DO_EXEMPLO.adId);
    expect(lead.campaignId).toBe(ESPERADO_DO_EXEMPLO.campaignId);
    // `entry[].time` (o sinal) e `value.created_time` (quando a pessoa encheu).
    expect(lead.entradaEm).toBe(1793448000);
    expect(lead.criadoEm).toBe(1793447940);

    expect(lead.nome).toBe(ESPERADO_DO_EXEMPLO.nome);
    // O número chega como a pessoa digita e sai em E.164 canônico — é o que
    // `contacts.phone_number` aceita e o que faz o reaproveitamento por igualdade.
    expect(lead.telefone).toBe(ESPERADO_DO_EXEMPLO.telefone);
    expect(lead.email).toBe(ESPERADO_DO_EXEMPLO.email);

    // As RESPOSTAS do formulário, na ordem em que vieram, com a chave canônica.
    expect(lead.respostas.map((r) => r.campo)).toEqual([
      "full_name",
      "phone_number",
      "email",
      "qual_o_seu_objetivo",
      "cidade",
    ]);
    // As três de identidade NÃO aparecem como pergunta respondida no card.
    expect(lead.campos).toEqual({
      qual_o_seu_objetivo: "Comprar nos próximos 30 dias",
      cidade: "São Paulo",
    });
  });

  it("sem field_data: o parser devolve o lead ANÔNIMO — quem decide é a porta, depois da busca", () => {
    // Mudou na fatia 1-bis, e o motivo é de desenho: o aviso real da Meta NÃO traz
    // as respostas, então "sem field_data" deixou de ser sentença e passou a ser o
    // caso NORMAL. Quem decide o que fazer com ele é a rota, que tenta a busca
    // autenticada na Graph API (opção da fonte) e só então ignora o lead, com o
    // motivo certo (`sem_field_data` ou `sem_respostas_na_meta` — medido em
    // `app/api/v1/webhooks/meta-lead-ads/[token]/route.test.ts`).
    //
    // O que este caso garante é o que continua sendo do parser: o lead sai com os
    // IDS preservados e identidade nula, e não some no meio do caminho — sem os
    // ids não haveria nem como buscar as respostas nem como registrar qual lead
    // foi ignorado.
    const leitura = lerLeadsDoFormularioMeta(entregaDoLeadAds({ comRespostas: false }));
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.descartados).toEqual([]);
    expect(leitura.leads).toHaveLength(1);
    const lead = leitura.leads[0]!;
    expect(lead.leadgenId).toBe(ESPERADO_DO_EXEMPLO.leadgenId);
    expect(lead.pageId).toBe(ESPERADO_DO_EXEMPLO.pageId);
    expect(lead.respostas).toEqual([]);
    expect(lead.nome).toBeNull();
    expect(lead.telefone).toBeNull();
    expect(lead.email).toBeNull();
    expect(lead.campos).toEqual({});
  });

  it("sem leadgen_id: descarte nomeado, e não um lead sem identidade", () => {
    const leitura = lerLeadsDoFormularioMeta(entregaDoLeadAds({ comLeadgenId: false }));
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.leads).toEqual([]);
    expect(leitura.descartados).toEqual([{ leadgenId: null, motivo: "sem_leadgen_id" }]);
  });

  it("mudança que não é leadgen é ignorada — o mesmo endpoint assina outros eventos", () => {
    const corpo = JSON.stringify({
      object: "page",
      entry: [{ id: "102938475657483", time: 1793448000, changes: [{ field: "feed", value: {} }] }],
    });
    const leitura = lerLeadsDoFormularioMeta(corpo);
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.leads).toEqual([]);
    expect(leitura.descartados).toEqual([]);
  });

  it("JSON inválido não lança: é `json_invalido`", () => {
    expect(lerLeadsDoFormularioMeta("{ isso não é json")).toEqual({
      ok: false,
      motivo: "json_invalido",
    });
    // `for...of` sobre número lança — o corpo de topo errado cai no mesmo lugar.
    expect(lerLeadsDoFormularioMeta("42")).toEqual({ ok: false, motivo: "json_invalido" });
  });

  it("telefone que a régua não reconhece vira null, e a resposta crua continua visível", () => {
    const leitura = lerLeadsDoFormularioMeta(entregaDoLeadAds({ telefone: "não tenho" }));
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    const lead = leitura.leads[0]!;
    expect(lead.telefone).toBeNull();
    // O que a pessoa escreveu não se perde: é do valor cru que quem depura a
    // fonte precisa.
    expect(lead.respostas).toContainEqual({ campo: "phone_number", valor: "não tenho" });
  });

  it("nome em duas partes é composto quando não há `full_name`", () => {
    const corpo = JSON.stringify({
      object: "page",
      entry: [
        {
          id: "102938475657483",
          time: 1793448000,
          changes: [
            {
              field: "leadgen",
              value: {
                leadgen_id: "123",
                field_data: [
                  { name: "first_name", values: ["Maria"] },
                  { name: "last_name", values: ["Souza"] },
                  { name: "telefone", values: ["+5511988887777"] },
                ],
              },
            },
          ],
        },
      ],
    });
    const leitura = lerLeadsDoFormularioMeta(corpo);
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.leads[0]?.nome).toBe("Maria Souza");
    // Acento e caixa não escondem o campo: `telefone` casa pelo alias, e o
    // número sai normalizado.
    expect(leitura.leads[0]?.telefone).toBe("+5511988887777");
  });
});
