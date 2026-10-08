import { describe, expect, it } from "vitest";

import {
  embutirMencoes,
  idsDeMencaoEstrutural,
  mencaoAtingeUsuario,
  montarMencao,
  partesDoCorpo,
  podarMencoes,
  textoLegivelDeMencao,
  tokensDeMencao,
} from "./mentions";

describe("menções em nota", () => {
  const user = { id: "u-1", email: "ana.silva@clinica.com", full_name: "Ana Silva" };

  it("extrai tokens", () => {
    expect(tokensDeMencao("oi @Ana e @ana.silva")).toEqual(["ana", "ana.silva"]);
  });

  it("casa e-mail, local-part e primeiro nome", () => {
    expect(mencaoAtingeUsuario("fala @ana.silva@clinica.com", user)).toBe(true);
    expect(mencaoAtingeUsuario("fala @ana.silva", user)).toBe(true);
    expect(mencaoAtingeUsuario("fala @Ana", user)).toBe(true);
    expect(mencaoAtingeUsuario("sem menção", user)).toBe(false);
  });
});

/**
 * A menção ESTRUTURAL (#2372) — o que o autocompletar grava.
 *
 * O que está em disputa aqui não é "formato novo": é que a notificação deixe
 * de depender do texto. `@Ana` com duas Anas na org notificava as duas; com o
 * token, o id é o da pessoa ESCOLHIDA e mais ninguém.
 */
describe("menção estrutural", () => {
  const ana = { id: "2f9c1d80-0000-4000-8000-000000000001", email: "ana@clinica.com", full_name: "Ana Lima" };
  const outraAna = {
    id: "2f9c1d80-0000-4000-8000-000000000002",
    email: "souza@clinica.com",
    full_name: "Ana Souza",
  };

  it("monta o token com nome e id", () => {
    expect(montarMencao({ id: ana.id, nome: "Ana Lima" })).toBe(`@[Ana Lima](mencao:${ana.id})`);
  });

  it("lê os ids do corpo, sem repetir e em minúsculas", () => {
    const token = montarMencao({ id: ana.id.toUpperCase(), nome: "Ana Lima" });
    expect(idsDeMencaoEstrutural(`oi ${token} e ${token}`)).toEqual([ana.id]);
    expect(idsDeMencaoEstrutural("nota sem menção")).toEqual([]);
  });

  it("atinge o id do token e SÓ ele — a colega de mesmo primeiro nome não leva", () => {
    const corpo = `Fala com ${montarMencao({ id: ana.id, nome: "Ana Lima" })} sobre o orçamento`;
    expect(mencaoAtingeUsuario(corpo, ana)).toBe(true);
    expect(mencaoAtingeUsuario(corpo, outraAna)).toBe(false);
  });

  it("não atinge quem só tem o nome parecido com o do token", () => {
    // O token nomeia "Ana Lima"; quem tem id diferente não é alcançado, mesmo
    // sendo "Ana" de verdade. Texto é texto, id é id.
    const corpo = montarMencao({ id: ana.id, nome: "Ana Souza" });
    expect(mencaoAtingeUsuario(corpo, outraAna)).toBe(false);
  });

  it("o corpo legível mostra o nome, nunca o token", () => {
    const corpo = `oi ${montarMencao({ id: ana.id, nome: "Ana Lima" })} e @marcos`;
    expect(textoLegivelDeMencao(corpo)).toBe("oi @Ana Lima e @marcos");
    expect(textoLegivelDeMencao("nota sem menção")).toBe("nota sem menção");
    expect(textoLegivelDeMencao(corpo)).not.toContain("mencao:");
  });

  it("parte o corpo sem perder um byte e com a menção separada", () => {
    const token = montarMencao({ id: ana.id, nome: "Ana Lima" });
    const corpo = `fala com ${token} depois`;
    const partes = partesDoCorpo(corpo);

    expect(partes.map((p) => p.texto).join("")).toBe(corpo.replace(token, ""));
    expect(partes.find((p) => p.mencao)?.mencao).toEqual({ id: ana.id, nome: "Ana Lima" });
    expect(partesDoCorpo("nota sem menção")).toEqual([{ texto: "nota sem menção", mencao: null }]);
  });
});

/**
 * `embutirMencoes` — o passo que transforma o nome visível no id gravado.
 * As três garantias da docstring, uma a uma: quem quebra uma vira vermelho.
 */
describe("embutirMencoes", () => {
  const ana = { id: "id-da-ana", nome: "Ana Lima" };
  const carlos = { id: "id-do-carlos", nome: "Carlos Dias" };

  it("troca o nome escolhido pelo token com o id", () => {
    expect(embutirMencoes("fala com @Ana Lima sobre o orçamento", [ana])).toBe(
      "fala com @[Ana Lima](mencao:id-da-ana) sobre o orçamento",
    );
  });

  it("escolhe duas pessoas → dois tokens, um de cada", () => {
    const saida = embutirMencoes("@Ana Lima e @Carlos Dias", [ana, carlos]);
    expect(saida).toContain(`@[Ana Lima](mencao:${ana.id})`);
    expect(saida).toContain(`@[Carlos Dias](mencao:${carlos.id})`);
  });

  it("nome contido em outro: escolher Ana antes de Ana Lima não põe o token da Ana em cima da Ana Lima", () => {
    // Na ordem de escolha, `@Ana` casaria dentro de `@Ana Lima`: a Ana Lima
    // perdia a menção por id e o `@Ana` que sobrava avisava todas as Anas.
    const soAna = { id: "id-da-outra-ana", nome: "Ana" };
    const saida = embutirMencoes("@Ana Lima falou com @Ana", [soAna, ana]);
    expect(saida).toBe(`@[Ana Lima](mencao:${ana.id}) falou com @[Ana](mencao:${soAna.id})`);
    expect(tokensDeMencao(saida)).toEqual([]);
  });

  it("a MESMA pessoa escolhida duas vezes vira duas menções", () => {
    const saida = embutirMencoes("@Ana Lima fala com @Ana Lima", [ana, ana]);
    expect(saida.match(/mencao:id-da-ana/g)).toHaveLength(2);
  });

  it("nome continuado à mão: grava quem foi ESCOLHIDO e deixa o resto como texto", () => {
    // O limite de palavra é `(?!\p{L}\p{N})`, não fim-de-nome: não dá para
    // distinguir "@Ana Lima" + frase de "@Ana Lima" + " Silva" digitado na
    // mão. Quando acontece, o que importa é para QUEM o aviso sai — e esse é
    // a pessoa clicada na lista, nunca uma inferência sobre o texto.
    const saida = embutirMencoes("oi @Ana Lima Silva", [ana]);
    expect(saida).toBe("oi @[Ana Lima](mencao:id-da-ana) Silva");
    expect(textoLegivelDeMencao(saida)).toBe("oi @Ana Lima Silva");
  });

  it("não encosta em nome que só começa igual: @Ana Lima123 fica intocado", () => {
    expect(embutirMencoes("oi @Ana Lima123", [ana])).toBe("oi @Ana Lima123");
  });

  it("não muda nada num segundo passe (idempotente)", () => {
    const umaVez = embutirMencoes("fala @Ana Lima", [ana]);
    expect(embutirMencoes(umaVez, [ana])).toBe(umaVez);
  });

  it("quem apagou o nome não ganha token nenhum", () => {
    expect(embutirMencoes("fala com Ana de novo", [ana])).toBe("fala com Ana de novo");
    expect(embutirMencoes("", [ana])).toBe("");
    expect(embutirMencoes("fala @Ana Lima", [])).toBe("fala @Ana Lima");
  });

  it("nome com caractere de regex não vira erro: Ana (HQ) casa literal", () => {
    const heroi = { id: "id-heroi", nome: "Ana (HQ)" };
    expect(embutirMencoes("oi @Ana (HQ)", [heroi])).toBe("oi @[Ana (HQ)](mencao:id-heroi)");
  });
});

/**
 * `podarMencoes` — a escolha apagada sai da lista antes de virar notificação
 * para a pessoa errada (#2463).
 *
 * A régua de presença tem de ser a MESMA do `embutirMencoes`: se a poda
 * aceitasse `@Ana Lima123` como ocorrência, a escolha morta voltaria a roubar
 * a ocorrência da próxima Ana na saída.
 */
describe("podarMencoes", () => {
  const ana1 = { id: "id-ana-1", nome: "Ana Lima" };
  const ana2 = { id: "id-ana-2", nome: "Ana Lima" };
  const carlos = { id: "id-carlos", nome: "Carlos Dias" };

  it("nome continua no texto: a escolha fica", () => {
    expect(podarMencoes("fala com @Ana Lima sobre o orçamento", [ana1])).toEqual([ana1]);
  });

  it("apagou o nome: a escolha sai", () => {
    expect(podarMencoes("fala com ", [ana1])).toEqual([]);
    expect(podarMencoes("", [ana1])).toEqual([]);
  });

  it("a régua é a MESMA do embutir: `@Ana Lima123` não segura a escolha", () => {
    // Com `includes()` cru, esta escolha sobreviveria e voltaria a roubar a
    // ocorrência da próxima Ana — o defeito da issue, só mais difícil de ver.
    expect(podarMencoes("oi @Ana Lima123", [ana1])).toEqual([]);
    expect(embutirMencoes("oi @Ana Lima123", [ana1])).toBe("oi @Ana Lima123");
  });

  it("escolha sem nome não segura nada", () => {
    expect(podarMencoes("@xyz", [{ id: "u-1", nome: "   " }])).toEqual([]);
  });

  it("edição que deixa o texto sem NENHUMA menção derruba todas", () => {
    expect(podarMencoes("fala com ", [ana1, carlos])).toEqual([]);
  });

  it("só a escolha cujo nome sumiu sai — a outra fica", () => {
    expect(podarMencoes("fala com @Carlos Dias", [ana1, carlos])).toEqual([carlos]);
  });

  it("duas ocorrências legítimas: as duas escolhas ficam (o pareamento é do embutir)", () => {
    expect(podarMencoes("@Ana Lima e @Ana Lima", [ana1, ana2])).toEqual([ana1, ana2]);
  });

  it("mesma referência quando nada saiu — o setState por tecla não re-renderiza à toa", () => {
    const lista = [ana1];
    expect(podarMencoes("fala com @Ana Lima", lista)).toBe(lista);
  });
});
