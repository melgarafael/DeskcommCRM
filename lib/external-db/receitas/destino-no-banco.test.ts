import { describe, expect, it } from "vitest";

import { nomesDoDestinoValido, primeiroDestinoInvalido } from "./destino-no-banco";

const ORG = "11111111-1111-4111-8111-111111111111";
const PIPE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAPA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DESTINO = { pipeline_id: PIPE, stage_id: ETAPA };

// O que cada caso guarda, e a linha que o deixa vermelho se for revertida:
//  - filtra organização/funil/etapa/arquivado/ganho/perda → tirar o `.eq` correspondente de `nomesDoDestinoValido`
//  - funil inexistente → null → tirar `if (!funil) return null`
//  - etapa de outro funil / de encerramento → null → tirar `if (!etapa) return null`
//  - devolve o índice da primeira inválida → trocar `return i` por `return null`

type Filtro = [string, unknown];

/** Dublê encadeável por tabela: guarda os filtros e responde com o que o caso mandou. */
function dubleDoBanco(respostas: { crm_pipelines: unknown; crm_stages: unknown }) {
  const filtrosPorTabela: Record<string, Filtro[]> = {};
  const cliente = {
    from: (tabela: "crm_pipelines" | "crm_stages") => {
      const filtros: Filtro[] = [];
      filtrosPorTabela[tabela] = filtros;
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return q;
        },
        maybeSingle: async () => ({ data: respostas[tabela], error: null }),
      };
      return q;
    },
  } as never;
  return { cliente, filtrosPorTabela };
}

describe("nomesDoDestinoValido", () => {
  it("devolve os nomes quando funil e etapa servem", async () => {
    const { cliente } = dubleDoBanco({
      crm_pipelines: { id: PIPE, name: "Imóveis" },
      crm_stages: { id: ETAPA, name: "Interesse" },
    });

    expect(await nomesDoDestinoValido(cliente, ORG, DESTINO)).toEqual({ funil: "Imóveis", etapa: "Interesse" });
  });

  it("filtra a organização, o funil ativo, a etapa DO funil, ativa e sem encerramento", async () => {
    const { cliente, filtrosPorTabela } = dubleDoBanco({
      crm_pipelines: { id: PIPE, name: "Imóveis" },
      crm_stages: { id: ETAPA, name: "Interesse" },
    });

    await nomesDoDestinoValido(cliente, ORG, DESTINO);

    expect(filtrosPorTabela.crm_pipelines).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["id", PIPE],
        ["is_archived", false],
      ]),
    );
    expect(filtrosPorTabela.crm_stages).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["id", ETAPA],
        ["pipeline_id", PIPE],
        ["is_archived", false],
        ["is_won", false],
        ["is_lost", false],
      ]),
    );
  });

  it("funil que não existe nesta organização (ou arquivado): null", async () => {
    const { cliente } = dubleDoBanco({ crm_pipelines: null, crm_stages: { id: ETAPA, name: "Interesse" } });

    expect(await nomesDoDestinoValido(cliente, ORG, DESTINO)).toBeNull();
  });

  it("etapa que não é do funil, arquivada ou de encerramento: null", async () => {
    const { cliente } = dubleDoBanco({ crm_pipelines: { id: PIPE, name: "Imóveis" }, crm_stages: null });

    expect(await nomesDoDestinoValido(cliente, ORG, DESTINO)).toBeNull();
  });
});

describe("primeiroDestinoInvalido", () => {
  it("instância sem destino não consulta nada e não é inválida", async () => {
    const { cliente, filtrosPorTabela } = dubleDoBanco({ crm_pipelines: null, crm_stages: null });

    expect(await primeiroDestinoInvalido(cliente, ORG, [{}, { destino_do_interesse: null }])).toBeNull();
    expect(Object.keys(filtrosPorTabela)).toHaveLength(0);
  });

  it("devolve o ÍNDICE da primeira instância com destino que não serve", async () => {
    const { cliente } = dubleDoBanco({ crm_pipelines: null, crm_stages: null });

    expect(await primeiroDestinoInvalido(cliente, ORG, [{}, { destino_do_interesse: DESTINO }])).toBe(1);
  });

  it("todos servem: null", async () => {
    const { cliente } = dubleDoBanco({
      crm_pipelines: { id: PIPE, name: "Imóveis" },
      crm_stages: { id: ETAPA, name: "Interesse" },
    });

    expect(await primeiroDestinoInvalido(cliente, ORG, [{ destino_do_interesse: DESTINO }])).toBeNull();
  });
});
