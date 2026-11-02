import { describe, expect, it } from "vitest";

import {
  chavesForaDaOrigem,
  chavesParaTraduzir,
  juntarCatalogo,
  placeholdersDe,
  validarLote,
} from "../../scripts/i18n/lotes";

describe("os lotes de tradução de um catálogo", () => {
  it("acha os placeholders na ordem em que aparecem", () => {
    expect(placeholdersDe("Olá {nome}, {{x}}")).toEqual(["{nome}", "{{x}}"]);
  });

  it("aceita o lote que preserva os placeholders, mesmo em outra posição", () => {
    expect(validarLote({ "Meta de {x}": "{x} hedefi" })).toEqual([]);
  });

  it("recusa o placeholder de chave dupla que virou chave simples", () => {
    expect(validarLote({ "Oi {{nome}}": "Merhaba {nome}" })).toEqual(["Oi {{nome}}"]);
  });

  it("recusa a tradução em branco", () => {
    expect(validarLote({ Salvar: " " })).toEqual(["Salvar"]);
  });

  it("pede só o que ainda não tem tradução, na união das fontes, em ordem", () => {
    expect(chavesParaTraduzir([{ a: {}, b: {} }, { b: "x", c: "y" }], { a: "A" })).toEqual(["b", "c"]);
  });

  it("recusa o pedaço de frase que perdeu o espaço da ponta, que cola nas palavras vizinhas", () => {
    expect(validarLote({ " (personalizada)": "(özel)", "Total: ": "Toplam:", " de ": " / " })).toEqual([
      " (personalizada)",
      "Total: ",
    ]);
  });

  it("recusa a chave que o tradutor alterou e que não existe no lote de origem", () => {
    const origem = { "Salvar “rascunho”": { es: "Guardar “borrador”" }, Sair: {} };
    expect(chavesForaDaOrigem({ 'Salvar "rascunho"': "Taslağı kaydet", Sair: "Çık" }, origem)).toEqual([
      'Salvar "rascunho"',
    ]);
  });

  it("junta os lotes por cima do catálogo, o último vence, as chaves em ordem", () => {
    const junto = juntarCatalogo({ b: "1" }, [{ a: "2" }, { b: "3" }]);
    expect(junto).toEqual({ a: "2", b: "3" });
    expect(Object.keys(junto)).toEqual(["a", "b"]);
  });
});
