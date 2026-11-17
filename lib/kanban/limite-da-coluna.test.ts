import { describe, expect, it } from "vitest";

import { midpoint } from "@/lib/kanban/fractional-indexing";
import { proximoNaEtapaInteira } from "@/lib/kanban/vizinho-na-etapa";
import {
  CARDS_POR_VEZ,
  cardsVisiveisDaColuna,
  colunaLimitada,
  limiteQueMostra,
} from "@/lib/kanban/limite-da-coluna";
import type { Lead } from "@/lib/types/leads";

function negocios(n: number): Lead[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `l-${String(i).padStart(4, "0")}`,
    stage_id: "s-perdido",
    position_in_stage: (i + 1) * 1000,
  })) as unknown as Lead[];
}

describe("limite da coluna (#4788)", () => {
  it("só ganho e perda são limitadas", () => {
    expect(colunaLimitada({ is_won: true })).toBe(true);
    expect(colunaLimitada({ is_lost: true })).toBe(true);
    expect(colunaLimitada({ is_won: false, is_lost: null })).toBe(false);
  });

  it("coluna aberta devolve a lista inteira; limitada corta o prefixo", () => {
    const todos = negocios(120);
    expect(cardsVisiveisDaColuna(todos, { limitada: false, limite: CARDS_POR_VEZ })).toBe(todos);
    expect(cardsVisiveisDaColuna(todos, { limitada: true, limite: CARDS_POR_VEZ })).toEqual(
      todos.slice(0, CARDS_POR_VEZ),
    );
  });

  it("os fixos sobem o limite até eles, e o limite nunca desce", () => {
    const todos = negocios(120);
    expect(limiteQueMostra(todos, { limitada: true, limite: 50, fixos: ["l-0079", null] })).toBe(80);
    expect(limiteQueMostra(todos, { limitada: true, limite: 100, fixos: ["l-0010"] })).toBe(100);
    expect(limiteQueMostra(todos, { limitada: true, limite: 50, fixos: ["fora-da-coluna"] })).toBe(50);
    expect(limiteQueMostra(todos, { limitada: false, limite: 50, fixos: ["l-0079"] })).toBe(50);
  });

  it("o corte é um PREFIXO: soltar no fim da parte mostrada cai entre o 50º e o 51º (escondido)", () => {
    const todos = negocios(120);
    // A conta do `KanbanBoard.handleDragEnd`: a lista de destino é a da etapa
    // inteira, o índice é o do dnd na parte mostrada.
    const arrastadoId = "l-de-outra-etapa";
    const destList = todos.filter((l) => l.id !== arrastadoId);
    const indice = CARDS_POR_VEZ; // logo abaixo do último mostrado
    const antes = destList[indice - 1]!;
    const depois = proximoNaEtapaInteira(antes, destList[indice] ?? null, todos, arrastadoId);
    expect(antes.id).toBe("l-0049");
    expect(depois?.id).toBe("l-0050"); // o primeiro escondido, não "nenhum"
    const pos = midpoint(antes.position_in_stage, depois?.position_in_stage ?? null);
    expect(pos).toBeGreaterThan(antes.position_in_stage);
    expect(pos).toBeLessThan(todos[50]!.position_in_stage);
  });
});
