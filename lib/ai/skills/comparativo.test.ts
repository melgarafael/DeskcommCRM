import { describe, expect, it } from "vitest";

import { compararSkill, diffLinhas } from "./comparativo";

describe("compararSkill — o que mudou entre a cópia da org e a versão nova do catálogo", () => {
  it("corpos idênticos → nada mudou (mudou_em vazio)", () => {
    const versao = {
      description: "Objeção de frete.",
      body: "Linha um\nLinha dois",
      matcher: { any_keywords: ["frete"] },
    };
    const r = compararSkill(versao, versao);
    expect(r.mudou_em).toEqual([]);
    expect(r.descricao_mudou).toBe(false);
    expect(r.matcher_mudou).toBe(false);
    expect(r.corpo_mudou).toBe(false);
    expect(r.resumo).toBe("Nada mudou entre a cópia e o catálogo.");
  });

  it("descrição divergiu → mudou_em tem 'descricao'", () => {
    const r = compararSkill(
      { description: "Objeção de frete.", body: "X", matcher: { any_keywords: ["frete"] } },
      { description: "Objeção de frete v2.", body: "X", matcher: { any_keywords: ["frete"] } },
    );
    expect(r.mudou_em).toEqual(["descricao"]);
    expect(r.resumo).toBe("Mudou só a descrição");
  });

  it("palavra-chave adicionada e removida → matcher_mudou com os nomes exatos", () => {
    const r = compararSkill(
      { description: "D", body: "X", matcher: { any_keywords: ["frete", "entrega"] } },
      { description: "D", body: "X", matcher: { any_keywords: ["frete", "prazo"] } },
    );
    expect(r.matcher_mudou).toBe(true);
    expect(r.any_adicionadas).toEqual(["prazo"]);
    expect(r.any_removidas).toEqual(["entrega"]);
    // Passe SÓ nas palavras-chave não muda a descrição nem o corpo.
    expect(r.mudou_em).toEqual(["matcher"]);
  });

  it("procedimento ganhou linha → corpo_mudou e conta as linhas adicionadas/removidas", () => {
    const r = compararSkill(
      { description: "D", body: "Linha um\nLinha dois", matcher: { any_keywords: ["frete"] } },
      { description: "D", body: "Linha um\nLinha dois\nLinha tres", matcher: { any_keywords: ["frete"] } },
    );
    expect(r.corpo_mudou).toBe(true);
    expect(r.linhas_adicionadas).toBe(1);
    expect(r.linhas_removidas).toBe(0);
    expect(r.mudou_em).toEqual(["corpo"]);
    expect(r.resumo).toBe("Mudou só o procedimento (corpo)");
  });

  it("tudo divergiu → mudou_em com os três campos e resumo nomeado", () => {
    const r = compararSkill(
      {
        description: "Antiga",
        body: "Procedimento antigo",
        matcher: { any_keywords: ["a"], probe_keywords: ["p1"] },
      },
      {
        description: "Nova",
        body: "Procedimento novo, maior\ncom mais uma linha",
        matcher: { any_keywords: ["a", "b"] },
      },
    );
    expect(r.mudou_em).toEqual(["descricao", "matcher", "corpo"]);
    expect(r.resumo).toBe("Mudou a descrição, as palavras-chave de ativação e o procedimento (corpo)");
  });

  it("duas linhas adicionadas e uma removida no meio do corpo", () => {
    const r = compararSkill(
      { description: "D", body: "a\nb\nc", matcher: { any_keywords: ["x"] } },
      { description: "D", body: "a\nb2\nc\nz", matcher: { any_keywords: ["x"] } },
    );
    expect(r.linhas_adicionadas).toBe(2);
    expect(r.linhas_removidas).toBe(1);
    expect(r.corpo_mudou).toBe(true);
  });

  it("matcher `{}` (default da coluna) não lança: só o lado que tem palavras-chave conta", () => {
    const r = compararSkill(
      { description: "D", body: "X", matcher: {} },
      { description: "D", body: "X", matcher: { any_keywords: ["frete"] } },
    );
    expect(r.any_adicionadas).toEqual(["frete"]);
    expect(r.any_removidas).toEqual([]);
    expect(r.mudou_em).toEqual(["matcher"]);
  });
});

describe("diffLinhas — LCS por linha do procedimento", () => {
  it("corpos iguais → 0/0", () => {
    expect(diffLinhas("a\nb", "a\nb")).toEqual({ adicionadas: 0, removidas: 0 });
  });

  it("corpo vazio vs cheio → conta tudo como adicionado", () => {
    expect(diffLinhas("", "a\nb\nc")).toEqual({ adicionadas: 3, removidas: 0 });
  });

  it("reordenar linhas muda o procedimento (ordem importa), e o diff conta", () => {
    // "b,c" tem LCS 1: reordenar quebra a semelhança sequencial do procedimento.
    expect(diffLinhas("a\nb\nc", "c\nb\na")).toEqual({ adicionadas: 2, removidas: 2 });
  });
});