import { describe, expect, it } from "vitest";

import { LEADS_POR_REQUISICAO, intervaloDaColuna, lotesDeIds } from "@/lib/kanban/selecao";

/**
 * A aritmética da seleção múltipla no quadro (`lib/kanban/selecao.ts`).
 *
 * Ela é testada aqui, e não pela tela, porque os três modos de errar dela são
 * SILENCIOSOS: intervalo invertido devolve lista vazia, âncora que saiu da
 * coluna devolve `undefined` no meio do slice, e lote acima do teto da rota
 * devolve `bulk_too_large` — e os três aparecem para quem clica como "não
 * selecionou nada", que se lê como clique perdido, não como defeito.
 */

describe("lotesDeIds — quebra a seleção no teto que a rota aceita", () => {
  it("mantém uma seleção pequena num lote só", () => {
    expect(lotesDeIds(["a", "b", "c"])).toEqual([["a", "b", "c"]]);
  });

  it("não quebra exatamente no teto", () => {
    const ids = Array.from({ length: LEADS_POR_REQUISICAO }, (_, i) => `id-${i}`);
    expect(lotesDeIds(ids)).toHaveLength(1);
  });

  it("quebra acima do teto sem perder nem duplicar id", () => {
    const ids = Array.from({ length: 123 }, (_, i) => `id-${i}`);
    const lotes = lotesDeIds(ids);
    expect(lotes).toHaveLength(3);
    expect(lotes.every((l) => l.length <= LEADS_POR_REQUISICAO)).toBe(true);
    expect(lotes.flat()).toEqual(ids);
  });

  it("seleção vazia não gera lote nenhum (nenhuma chamada à rota)", () => {
    expect(lotesDeIds([])).toEqual([]);
  });
});

describe("intervaloDaColuna — o shift+clique", () => {
  const coluna = ["a", "b", "c", "d", "e"];

  it("pega o trecho entre âncora e alvo, inclusive", () => {
    expect(intervaloDaColuna(coluna, "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("de baixo para cima devolve o MESMO trecho, não vazio", () => {
    expect(intervaloDaColuna(coluna, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("sem âncora seleciona só o alvo", () => {
    expect(intervaloDaColuna(coluna, null, "c")).toEqual(["c"]);
  });

  it("âncora que saiu da coluna (filtro, card movido) cai no alvo, não em undefined", () => {
    expect(intervaloDaColuna(coluna, "sumiu", "c")).toEqual(["c"]);
  });

  it("alvo fora da coluna não seleciona nada", () => {
    expect(intervaloDaColuna(coluna, "a", "sumiu")).toEqual([]);
  });

  it("âncora igual ao alvo devolve um id só", () => {
    expect(intervaloDaColuna(coluna, "c", "c")).toEqual(["c"]);
  });
});
