import { describe, expect, it } from "vitest";

import { agruparPorNicho } from "./grupos-por-nicho";

/** O mínimo que o agrupador lê de uma campanha: `search.niche`. */
function campanha(id: string, niche?: string | null) {
  return { id, search: niche === undefined ? null : ({ niche } as { niche: string }) };
}

describe("agruparPorNicho", () => {
  it("põe no MESMO grupo as campanhas do mesmo nicho, na ordem em que vieram", () => {
    const grupos = agruparPorNicho([
      campanha("a", "Padarias"),
      campanha("b", "Clínicas"),
      campanha("c", "Padarias"),
    ]);

    const padarias = grupos.find((g) => g.chave === "padarias");
    expect(padarias?.nicho).toBe("Padarias");
    // A ordem de dentro do grupo é a da entrada: `a` antes de `c`.
    expect(padarias?.campanhas.map((c) => c.id)).toEqual(["a", "c"]);
    expect(grupos.find((g) => g.chave === "clínicas")?.campanhas.map((c) => c.id)).toEqual(["b"]);
  });

  it("não reordena os grupos: cada um aparece onde a PRIMEIRA campanha dele aparece", () => {
    const grupos = agruparPorNicho([
      campanha("a", "Zebras"),
      campanha("b", "Águias"),
      campanha("c", "Zebras"),
    ]);

    // Ordem alfabética jogaria "Águias" para o topo e mudaria a lista de quem já usa.
    expect(grupos.map((g) => g.nicho)).toEqual(["Zebras", "Águias"]);
  });

  it("junta o nicho escrito com outra caixa e mostra o rótulo do primeiro", () => {
    const grupos = agruparPorNicho([campanha("a", "Padarias"), campanha("b", " padarias ")]);

    expect(grupos).toHaveLength(1);
    expect(grupos[0]?.nicho).toBe("Padarias");
    expect(grupos[0]?.campanhas.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("campanha SEM nicho cai num grupo próprio e nomeado — e não some", () => {
    const grupos = agruparPorNicho([
      campanha("sem-busca"),
      campanha("vazio", ""),
      campanha("so-espaco", "   "),
      campanha("com-nicho", "Padarias"),
    ]);

    const semNicho = grupos.find((g) => g.chave === null);
    expect(semNicho?.nicho).toBeNull();
    expect(semNicho?.campanhas.map((c) => c.id)).toEqual(["sem-busca", "vazio", "so-espaco"]);
    // Um grupo só para os três casos: nada de um cabeçalho vazio por campanha.
    expect(grupos.filter((g) => g.chave === null)).toHaveLength(1);
  });

  it("não perde nem duplica campanha: os grupos têm as MESMAS campanhas da lista", () => {
    const entrada = [
      campanha("a", "Padarias"),
      campanha("b"),
      campanha("c", "Clínicas"),
      campanha("d", "padarias"),
    ];

    const grupos = agruparPorNicho(entrada);
    // Agrupar MOVE a campanha `d` para junto das padarias — é o ponto da fatia. O
    // que não pode acontecer é sumir ou duplicar cartão: o conjunto é o mesmo.
    expect(grupos.flatMap((g) => g.campanhas.map((c) => c.id)).sort()).toEqual(
      entrada.map((c) => c.id).sort(),
    );
    expect(grupos.find((g) => g.chave === "padarias")?.campanhas.map((c) => c.id)).toEqual([
      "a",
      "d",
    ]);
  });

  it("lista vazia devolve nenhum grupo (o estado vazio é da tela, não daqui)", () => {
    expect(agruparPorNicho([])).toEqual([]);
  });
});
