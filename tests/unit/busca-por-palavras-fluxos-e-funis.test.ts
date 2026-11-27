/**
 * A BUSCA DAS LISTAS DE FOLLOW-UPS E DE FUNIS CASA POR PALAVRAS (#4593).
 *
 * O #4693 deixou escrito o que seguia aberto: «prospeccao site» ainda não acha
 * «Prospecção (Site)», porque o casamento era por TRECHO — o termo inteiro
 * tinha de aparecer colado no nome. E a busca só olhava o nome (e o endereço do
 * funil): o gatilho do fluxo e as etapas do funil ficavam de fora.
 *
 * A régua nova: cada palavra digitada tem de aparecer em ALGUM dos textos do
 * item, em qualquer ordem. Os textos são comparados um a um — nunca emendados —
 * para a junta entre dois campos não inventar um casamento.
 */
import { describe, expect, it } from "vitest";

import { filtrarFluxos } from "@/lib/followup/filtrar-fluxos";
import { rotuloDoGatilhoNaLista } from "@/lib/followup/rotulo-do-gatilho";
import { funisQueCasam } from "@/lib/pipelines/filtrar-funis";

const FLUXOS = [
  { id: "f1", name: "Kelly · retomada (oficinas mecânicas)", status: "active" as const, gatilho: "Etapa do funil" },
  { id: "f2", name: "Retomada pós-venda", status: "active" as const, gatilho: "Silêncio" },
  { id: "f3", name: "Boas-vindas", status: "draft" as const, gatilho: "Lead criado" },
];

const textosDoFluxo = (f: (typeof FLUXOS)[number]) => [f.gatilho];

const fluxos = (busca: string) =>
  filtrarFluxos(FLUXOS, { busca, status: "all", textosExtras: textosDoFluxo }).map((f) => f.id);

const FUNIS = [
  {
    id: "p1",
    name: "Prospecção (Site)",
    slug: "prospeccao-site",
    etapas: ["Novo contato", "Qualificado"],
  },
  {
    id: "p2",
    name: "Pós-venda",
    slug: "pos-venda",
    etapas: ["Aguardando pagamento", "Entregue"],
  },
  { id: "p3", name: "Locação", slug: "aluguel", etapas: [] },
];

const funis = (busca: string) => [...(funisQueCasam(FUNIS, busca) ?? [])];

describe("U1 — funis: as palavras casam em qualquer ordem", () => {
  it("«prospeccao site» acha «Prospecção (Site)», o caso que o #4693 deixou aberto", () => {
    expect(funis("prospeccao site")).toEqual(["p1"]);
  });

  it("a ordem invertida e espaço sobrando também acham", () => {
    expect(funis("site prospeccao")).toEqual(["p1"]);
    expect(funis("  SITE   Prospecção ")).toEqual(["p1"]);
  });

  it("TODAS as palavras precisam casar: uma que não existe esvazia o resultado", () => {
    expect(funis("prospeccao loja")).toEqual([]);
  });
});

describe("U2 — fluxos: as palavras casam em qualquer ordem", () => {
  it("«kelly oficina» e «oficina kelly» acham o fluxo de oficinas", () => {
    expect(fluxos("kelly oficina")).toEqual(["f1"]);
    expect(fluxos("oficina kelly")).toEqual(["f1"]);
  });

  it("uma palavra que não está em lugar nenhum esvazia o resultado", () => {
    expect(fluxos("kelly imobiliaria")).toEqual([]);
  });
});

describe("U3 — fluxos: o gatilho entra na busca", () => {
  it("«silencio» acha o fluxo armado por silêncio, sem acento", () => {
    expect(fluxos("silencio")).toEqual(["f2"]);
  });

  it("«retomada silencio» casa o nome com uma palavra e o gatilho com a outra", () => {
    // f1 também tem «retomada» no nome, mas o gatilho dele é etapa do funil.
    expect(fluxos("retomada silencio")).toEqual(["f2"]);
  });

  it("sem textos extras a busca segue só pelo nome, como antes", () => {
    expect(filtrarFluxos(FLUXOS, { busca: "silencio", status: "all" })).toEqual([]);
  });
});

describe("U5 — funis: os nomes das etapas entram na busca", () => {
  it("o nome de uma etapa acha o funil dela", () => {
    expect(funis("aguardando")).toEqual(["p2"]);
  });

  it("nome do funil e nome da etapa juntos também acham", () => {
    expect(funis("pos aguardando")).toEqual(["p2"]);
  });
});

describe("U6 — cada palavra casa num campo inteiro, nunca na junta entre dois", () => {
  it("palavras em campos diferentes do mesmo funil acham", () => {
    expect(funis("prospeccao qualificado")).toEqual(["p1"]);
  });

  it("o fim do nome emendado ao começo da etapa não vira palavra", () => {
    // «...(site)» + «novo contato» emendados dariam «site)novo» / «site) novo».
    expect(funis("site)novo")).toEqual([]);
    expect(funis("pos-vendaaguardando")).toEqual([]);
  });
});

describe("o rótulo do gatilho que a busca usa segue o que o editor mostra", () => {
  it("configuração sem `kind` é «Manual», como no editor", () => {
    expect(rotuloDoGatilhoNaLista(null)).toBe("Manual");
  });

  it("linha ainda sem a coluna (recém-escrita no cache) não ganha rótulo inventado", () => {
    expect(rotuloDoGatilhoNaLista(undefined)).toBeNull();
  });

  it("tipo desconhecido não ganha rótulo; tipo conhecido ganha o do seletor", () => {
    expect(rotuloDoGatilhoNaLista("conversation_end")).toBeNull();
    expect(rotuloDoGatilhoNaLista("toString")).toBeNull();
    expect(rotuloDoGatilhoNaLista("silence")).toBe("Silêncio");
  });
});
