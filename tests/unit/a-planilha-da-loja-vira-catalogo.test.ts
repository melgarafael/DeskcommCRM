import { describe, expect, it } from "vitest";

import { lerPlanilha } from "@/lib/catalogo/planilha";

/**
 * A PLANILHA QUE A LOJA JÁ TEM VIRA CATÁLOGO.
 *
 * Ela não vem no formato que a gente gostaria: cabeçalho com acento, preço em
 * quatro grafias, linha em branco no meio, coluna a mais que ninguém pediu.
 * Nada disso é erro de quem mandou — é o arquivo real, exportado do Excel em
 * português.
 *
 * O que NÃO se aceita em silêncio é o ambíguo. Preço ilegível vira linha
 * recusada COM o valor cru na mensagem, para a pessoa achar a célula. Um chute
 * aqui vira preço errado dito a um cliente três dias depois.
 */

const planilha = (...linhas: string[]) => linhas.join("\n");

describe("lê o arquivo que a loja exporta", () => {
  it("aceita cabeçalho com acento, ponto-e-vírgula e preço em várias grafias", () => {
    // Excel pt-BR exporta com ";" — o parser detecta sozinho.
    const r = lerPlanilha(
      planilha(
        "Código;Produto;Preço;Marca",
        "IP15-128;iPhone 15 128GB;R$ 5.499,00;Apple",
        "PERF-212;212 VIP Men 100ml;449,90;Carolina Herrera",
        "FONE-01;Fone Bluetooth;199;Genérico",
      ),
    );

    expect("erro" in r).toBe(false);
    if ("erro" in r) return;
    expect(r.produtos).toHaveLength(3);
    expect(r.produtos[0]?.preco_cents).toBe(549900);
    expect(r.produtos[1]?.preco_cents).toBe(44990);
    expect(r.produtos[2]?.preco_cents).toBe(19900);
    expect(r.produtos[0]?.marca).toBe("Apple");
  });

  it("pula linha em branco no meio sem chamar de erro", () => {
    const r = lerPlanilha(planilha("nome,preco", "iPhone 15,5499", "", "MacBook Air,9999"));

    expect("erro" in r).toBe(false);
    if ("erro" in r) return;
    expect(r.produtos).toHaveLength(2);
    expect(r.erros).toEqual([]);
  });

  it("cada produto carrega a LINHA de onde veio", () => {
    // Sem isso, um erro que só o banco vê (constraint, código longo demais)
    // seria relatado sem endereço — e quem importou 300 linhas não teria como
    // achar a célula.
    const r = lerPlanilha(planilha("nome,preco", "iPhone 15,5499", "MacBook,9999"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos.map((p) => p.linha)).toEqual([2, 3]);
  });

  it("sem coluna de código, o NOME vira a identidade", () => {
    // É o que permite reimportar a planilha com preço novo e ATUALIZAR em vez
    // de duplicar — o gesto real da loja quando o dólar muda.
    const r = lerPlanilha(planilha("produto,valor", "iPhone 15 128GB,5499"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos[0]?.codigo).toBe("iPhone 15 128GB");
  });
});

describe("recusa o que não dá para ler — e diz onde", () => {
  it("preço ilegível vira erro COM o valor cru e o número da linha", () => {
    const r = lerPlanilha(
      planilha("nome,preco", "iPhone 15,5499", "MacBook,sob consulta", "AirPods,1299"),
    );

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos).toHaveLength(2);
    expect(r.erros).toHaveLength(1);
    // A linha 3 é a que a pessoa vê na planilha, contando o cabeçalho.
    expect(r.erros[0]?.linha).toBe(3);
    expect(r.erros[0]?.motivo).toContain("sob consulta");
  });

  it("recusa a planilha INTEIRA quando falta nome ou preço, antes de processar", () => {
    // Dizer isso de saída evita um relatório com 300 erros idênticos.
    const r = lerPlanilha(planilha("marca,categoria", "Apple,Celular"));

    expect("erro" in r).toBe(true);
    if (!("erro" in r)) return;
    expect(r.erro).toContain("preço");
  });

  it("código repetido na mesma planilha é recusado, não sobrescrito em silêncio", () => {
    const r = lerPlanilha(
      planilha("codigo,nome,preco", "IP15,iPhone 15,5499", "IP15,iPhone 15 Pro,7999"),
    );

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos).toHaveLength(1);
    expect(r.erros[0]?.motivo).toContain("repetido");
  });
});

describe("a coluna de estoque AUSENTE não é estoque zero", () => {
  it("sem coluna de quantidade, o produto não é controlado por estoque", () => {
    // A distinção decide se o agente enxerga o catálogo: marcado como
    // controlado com zero unidades, todo produto sumiria da busca.
    const r = lerPlanilha(planilha("nome,preco", "Decant 10ml,89,90"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos[0]?.controla_estoque).toBe(false);
  });

  it("com a coluna, o estoque é respeitado", () => {
    const r = lerPlanilha(planilha("nome,preco,estoque", "iPhone 15,5499,3"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos[0]?.controla_estoque).toBe(true);
    expect(r.produtos[0]?.quantidade).toBe(3);
  });
});

describe("coluna desconhecida é relatada, não ignorada em silêncio", () => {
  it("avisa o que não foi usado", () => {
    // Quem mandou a planilha precisa saber que a coluna "Fornecedor" não entrou
    // — senão vai procurar por ela depois e concluir que o sistema perdeu dado.
    const r = lerPlanilha(planilha("nome,preco,Fornecedor", "iPhone 15,5499,Distribuidora X"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.colunasIgnoradas).toEqual(["Fornecedor"]);
  });
});
