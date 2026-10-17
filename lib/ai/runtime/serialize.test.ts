import { describe, expect, it } from "vitest";

import { serializeSteps } from "./serialize";

const SENTINELA = "__SENTINELA_WOOCOMMERCE_42__";

describe("serializeSteps — regra de escopo da D8 (receitas do banco externo)", () => {
  it("o rastro de crm_consultar_receita NÃO contém nenhum valor de linha nem valor de busca (sentinela)", () => {
    const steps = [
      {
        stepNumber: 1,
        toolCalls: [
          {
            toolName: "crm_consultar_receita",
            input: { acao: "executar", instancia_id: "inst-1", busca: { busca: SENTINELA, preco_max: 100 } },
          },
        ],
        toolResults: [
          {
            toolName: "crm_consultar_receita",
            output: {
              instancia: { id: "inst-1", receita: "woocommerce-produtos", rotulo: "Produtos" },
              colunas: ["id", "titulo", "preco"],
              linhas: [
                { id: "1", titulo: `Camisa ${SENTINELA}`, preco: 49.9 },
                { id: "2", titulo: "Calça", preco: 89.9 },
              ],
              linhas_devolvidas: 2,
              truncado: false,
            },
          },
        ],
      },
    ];

    const serializado = serializeSteps(steps);
    const json = JSON.stringify(serializado);

    // O valor sentinela da linha NÃO pode aparecer no rastro.
    expect(json).not.toContain(SENTINELA);
    expect(json).not.toContain("Camisa");
    expect(json).not.toContain("49.9");

    // Os argumentos guardam só o NOME da chave de busca, nunca o valor.
    expect(json).toContain("busca");
    expect(json).not.toContain(SENTINELA); // o valor da busca também não entra

    // Mas o resumo (contagem, colunas, truncado) SIM aparece.
    expect(json).toContain("linhas_devolvidas");
    expect(json).toContain("2");
    expect(json).toContain("colunas");
    expect(json).toContain("id");
    expect(json).toContain("titulo");
    expect(json).toContain("itens resumidos pelo rastro");
  });

  it("outras tools continuam tendo o resultado serializado normalmente (regra é por nome de tool)", () => {
    const steps = [
      {
        stepNumber: 1,
        toolCalls: [{ toolName: "crm_query_external_data", input: { tabela: "clientes" } }],
        toolResults: [
          {
            toolName: "crm_query_external_data",
            output: { linhas: [{ id: "1", nome: "Ana" }], linhas_devolvidas: 1 },
          },
        ],
      },
    ];

    const serializado = serializeSteps(steps);
    const json = JSON.stringify(serializado);

    // crm_query_external_data NÃO é crm_consultar_receita: o conteúdo continua no rastro.
    expect(json).toContain("Ana");
    expect(json).toContain("clientes");
  });
});
