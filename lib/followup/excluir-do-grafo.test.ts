import { describe, expect, it } from "vitest";

import { semAresta, semArestasDoNo, semNo } from "./excluir-do-grafo";

describe("excluir do grafo de follow-up", () => {
  it("tira o nó e as arestas que entram ou saem dele", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const edges = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "c" },
      { id: "e3", source: "a", target: "c" },
    ];

    expect(semNo(nodes, "b").map((n) => n.id)).toEqual(["a", "c"]);
    expect(semArestasDoNo(edges, "b").map((e) => e.id)).toEqual(["e3"]);
  });

  it("tira só a aresta pedida", () => {
    expect(semAresta([{ id: "e1" }, { id: "e2" }], "e1")).toEqual([{ id: "e2" }]);
  });
});
