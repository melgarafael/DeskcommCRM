/**
 * A régua da MEDIANA e do RECORTE por etiqueta (issue #3212), sem banco.
 *
 * O que este arquivo prova, e o que ele NÃO prova:
 *
 *   · aqui a régua é medida em código puro — a definição de mediana, a
 *     normalização da etiqueta e o não-caso ("sem etiqueta ninguém sai da conta");
 *   · que o SQL do banco devolve ESTES mesmos números é outra prova, e ela mora
 *     em `tests/invariants/mediana-e-recorte-por-etiqueta.test.ts` (`pnpm test:db`),
 *     porque nenhum teste de texto alcança o `percentile_cont`;
 *   · que a MÉDIA não mudou é medido lá também, contra uma função de referência
 *     com o corpo de `origin/main`.
 */
import { describe, expect, it } from "vitest";

import {
  contatoCarregaEtiqueta,
  mediana,
  normalizarEtiqueta,
} from "./mediana-e-recorte-por-etiqueta";

describe("mediana — o valor do meio, com a ausência preservada", () => {
  it("amostra VAZIA devolve null — não medida, NUNCA zero", () => {
    expect(mediana([])).toBeNull();
    // O zero é o defeito que este teste existe para impedir: "ninguém respondeu"
    // não é "respondeu na hora zero".
    expect(mediana([])).not.toBe(0);
  });

  it("amostra de UM elemento é ela mesma", () => {
    expect(mediana([42])).toBe(42);
  });

  it("tamanho ÍMPAR devolve o elemento do meio", () => {
    expect(mediana([5, 1, 3])).toBe(3);
    expect(mediana([900, 60, 300, 120, 30])).toBe(120);
  });

  it("tamanho PAR devolve a média dos DOIS do meio", () => {
    // O caso da tela: 60 s e 120 s nos extremos não podem arrastar o número.
    expect(mediana([60, 120, 300, 900])).toBe(210);
    // O que a mediana NÃO é: a média aritmética da amostra.
    expect(mediana([60, 120, 300, 900])).not.toBe(345);
  });

  it("a MÉDIA de um atendimento longo não arrasta a mediana", () => {
    // 25 dias entre a entrada e a 1ª resposta, e três respostas rápidas: a média
    // vai a horas, a mediana fica nos segundos. É a razão de existir da fatia.
    const amostra = [10, 20, 30, 25 * 86_400 + 1800];
    expect(mediana(amostra)).toBe(25);
    expect(amostra.reduce((a, b) => a + b, 0) / amostra.length).toBeGreaterThan(1000);
  });

  it("não muta a amostra de quem chama", () => {
    const amostra = [3, 1, 2];
    mediana(amostra);
    expect(amostra).toEqual([3, 1, 2]);
  });
});

describe("normalizarEtiqueta — a porta da rota", () => {
  it("espaços das pontas saem", () => {
    expect(normalizarEtiqueta("  fornecedor  ")).toBe("fornecedor");
  });

  it("vazio e só-espaço são AUSÊNCIA de etiqueta, não etiqueta vazia", () => {
    expect(normalizarEtiqueta("")).toBeNull();
    expect(normalizarEtiqueta("   ")).toBeNull();
    expect(normalizarEtiqueta(null)).toBeNull();
    expect(normalizarEtiqueta(undefined)).toBeNull();
  });

  it("a caixa é PRESERVADA aqui — quem compara em caixa baixa é o predicado", () => {
    expect(normalizarEtiqueta("Fornecedor")).toBe("Fornecedor");
  });
});

describe("contatoCarregaEtiqueta — o predicado do recorte", () => {
  it("acha a etiqueta exata", () => {
    expect(contatoCarregaEtiqueta(["cliente", "fornecedor"], "fornecedor")).toBe(true);
  });

  it("a comparação é normalizada dos DOIS lados — `Fornecedor ` do operador casa", () => {
    expect(contatoCarregaEtiqueta([" Fornecedor "], "fornecedor")).toBe(true);
    expect(contatoCarregaEtiqueta(["fornecedor"], " FORNECEDOR ")).toBe(true);
  });

  it("não casa etiqueta parecida, só a igual", () => {
    expect(contatoCarregaEtiqueta(["fornecedores"], "fornecedor")).toBe(false);
    expect(contatoCarregaEtiqueta(["fornecedor_antigo"], "fornecedor")).toBe(false);
  });

  it("contato sem tags (null/vazio/outro tipo) nunca é excluído", () => {
    expect(contatoCarregaEtiqueta(null, "fornecedor")).toBe(false);
    expect(contatoCarregaEtiqueta(undefined, "fornecedor")).toBe(false);
    expect(contatoCarregaEtiqueta([], "fornecedor")).toBe(false);
    expect(contatoCarregaEtiqueta(["cliente"], "fornecedor")).toBe(false);
  });

  it("SEM etiqueta pedida ninguém sai da conta — o não-caso é o recorte desligado", () => {
    expect(contatoCarregaEtiqueta(["fornecedor"], null)).toBe(false);
    expect(contatoCarregaEtiqueta(["fornecedor"], "")).toBe(false);
    expect(contatoCarregaEtiqueta(["fornecedor"], "   ")).toBe(false);
  });
});
