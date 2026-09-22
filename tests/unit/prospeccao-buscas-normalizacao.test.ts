/**
 * A TELA DE PROSPECÇÃO NÃO QUEBRA COM RESPOSTA INESPERADA.
 *
 * Guarda a regressão `buscas.some is not a function`: qualquer formato que
 * chegue da API/servidor vira lista — nunca um crash na tela inteira.
 */
import { describe, expect, it } from "vitest";

import { comoListaBuscas } from "@/app/app/prospeccao/_client";

const BUSCA = {
  id: "b1",
  categorias: ["Oficina"],
  cidade: "Canoinhas",
  estado: "SC",
  raio_km: 30,
  max_empresas: 500,
  provider: "osm_overpass",
  status: "queued",
  total_celulas: 10,
  celulas_processadas: 1,
  encontradas: 2,
  novas: 1,
  duplicadas: 1,
  erros: 0,
  requisicoes: 3,
  custo_estimado_cents: 0,
  ultimo_erro: null,
  created_at: "2026-09-05T00:00:00.000Z",
  finished_at: null,
};

describe("comoListaBuscas", () => {
  it("aceita a lista direta", () => {
    expect(comoListaBuscas([BUSCA])).toEqual([BUSCA]);
  });

  it("desembrulha o envelope canônico { data }", () => {
    expect(comoListaBuscas({ data: [BUSCA] })).toEqual([BUSCA]);
  });

  it("vira lista vazia em vez de quebrar a tela", () => {
    for (const estranho of [null, undefined, {}, { data: null }, "ops", 42]) {
      expect(comoListaBuscas(estranho)).toEqual([]);
    }
  });
});
