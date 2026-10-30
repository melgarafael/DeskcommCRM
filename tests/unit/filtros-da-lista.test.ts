import { describe, expect, it } from "vitest";

import {
  donoDoFiltro,
  filtrosDaLista,
  filtrosForaDaLista,
  lerFiltrosDaLista,
  paramsDosFiltrosDaLista,
} from "@/lib/kanban/filtros-da-lista";

/**
 * A regra que traduz a barra de filtros do funil para a consulta da Lista
 * (#3172, fatia 2). A tela e a rota usam ESTE módulo dos dois lados, então a
 * ida (`paramsDosFiltrosDaLista`) e a volta (`lerFiltrosDaLista`) têm de
 * concordar — é o caso de ida-e-volta abaixo.
 */
const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("filtrosDaLista", () => {
  it("leva Responsável e Status; \"Todos\" vira ausência", () => {
    expect(filtrosDaLista({ owner: ANA, status: "lost", search: "x" })).toEqual({
      owner: ANA,
      status: "lost",
    });
    expect(filtrosDaLista({ owner: "any", status: "all" })).toEqual({});
  });
});

describe("paramsDosFiltrosDaLista", () => {
  it("ordem FIXA — é a identidade do filtro na chave de cache", () => {
    expect(paramsDosFiltrosDaLista({ status: "won", owner: ANA })).toBe(`owner=${ANA}&status=won`);
    expect(paramsDosFiltrosDaLista({})).toBe("");
  });

  it("ida e volta: o que a tela escreve é o que a rota lê", () => {
    for (const f of [
      { owner: ANA },
      { owner: `agent:${AGENTE}`, status: "open" as const },
      { owner: "unassigned", status: "lost" as const },
    ]) {
      const lido = lerFiltrosDaLista(new URLSearchParams(paramsDosFiltrosDaLista(f)));
      expect(lido).toEqual({ ok: true, filtros: f });
    }
  });
});

describe("filtrosForaDaLista", () => {
  it("lista só os ATIVOS que a Lista ainda não aplica", () => {
    expect(
      filtrosForaDaLista({
        owner: ANA,
        search: "  ",
        tag: [],
        overdueOnly: true,
        lostReason: "Preço",
        lostCategory: "Comercial",
      }),
    ).toEqual(["atrasados", "motivo", "categoria"]);
    expect(filtrosForaDaLista({ search: "pizza", tag: "vip" })).toEqual(["busca", "etiqueta"]);
    expect(filtrosForaDaLista({ owner: ANA, status: "open" })).toEqual([]);
  });
});

describe("donoDoFiltro", () => {
  it("pessoa, agente e ninguém viram a coluna certa", () => {
    expect(donoDoFiltro(ANA)).toEqual({ coluna: "owner_user_id", id: ANA });
    expect(donoDoFiltro(`agent:${AGENTE}`)).toEqual({ coluna: "owner_agent_id", id: AGENTE });
    expect(donoDoFiltro("unassigned")).toBe("ninguem");
  });
});

describe("lerFiltrosDaLista", () => {
  it("valor desconhecido é erro, com o campo — nunca \"sem filtro\"", () => {
    expect(lerFiltrosDaLista(new URLSearchParams("owner=vania"))).toEqual({ ok: false, campo: "owner" });
    expect(lerFiltrosDaLista(new URLSearchParams("owner=agent:"))).toEqual({ ok: false, campo: "owner" });
    expect(lerFiltrosDaLista(new URLSearchParams("status=archived"))).toEqual({ ok: false, campo: "status" });
  });
});
