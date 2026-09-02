import { describe, expect, it } from "vitest";

import { precoParaCentavos } from "@/lib/schemas/produtos";

/**
 * A PLANILHA DA LOJA VEM SUJA — e adivinhar errado é caro dos dois lados.
 *
 * "R$ 5.499,00", "5499,00", "5.499" e "5499" significam a mesma coisa para quem
 * digitou. Ler "5.499" como cinco reais e quarenta e nove centavos põe um iPhone
 * a cinco reais; ler "5,49" como quinhentos e quarenta e nove cobra cem vezes
 * mais. Os dois erros passam despercebidos numa importação de 300 linhas.
 *
 * A regra: o ÚLTIMO separador manda, e o critério é o TAMANHO do grupo depois
 * dele. Milhar tem sempre três dígitos — logo um ou dois só podem ser centavos.
 */
describe("preço em texto livre vira centavos", () => {
  it("lê as formas que a loja escreve", () => {
    expect(precoParaCentavos("R$ 5.499,00")).toBe(549900);
    expect(precoParaCentavos("5499,00")).toBe(549900);
    expect(precoParaCentavos("5.499")).toBe(549900);
    expect(precoParaCentavos("5499")).toBe(549900);
    expect(precoParaCentavos("R$5.499,90")).toBe(549990);
  });

  it("entende o formato americano sem confundir com milhar", () => {
    expect(precoParaCentavos("5,499.00")).toBe(549900);
    expect(precoParaCentavos("1299.90")).toBe(129990);
  });

  it("valores pequenos, onde o erro de escala é mais fácil", () => {
    expect(precoParaCentavos("49,90")).toBe(4990);
    expect(precoParaCentavos("0,99")).toBe(99);
    expect(precoParaCentavos("100")).toBe(10000);
  });

  it("UM dígito depois da vírgula é centavo, não milhar — é o que o Excel emite", () => {
    // O caso que faltava, e ele não é exótico: é o padrão. Uma célula formatada
    // como número exibindo `1.299,90` sai no CSV como `1299,9`, porque a
    // planilha corta o zero final. Enquanto a regra exigia DOIS dígitos, esse
    // um caía no ramo do milhar e o preço entrava dez vezes maior — sem recusa
    // e sem aviso, que é o pior desfecho possível para um campo de preço.
    //
    // O argumento que sustenta a regra nova, e que é o que impede este teste de
    // ser um remendo: grupo de milhar tem SEMPRE três dígitos. Um grupo de um
    // ou dois dígitos não pode ser milhar em nenhuma localidade.
    expect(precoParaCentavos("1299,9")).toBe(129990);
    expect(precoParaCentavos("1299.9")).toBe(129990);
    expect(precoParaCentavos("49,9")).toBe(4990);
    expect(precoParaCentavos("0,5")).toBe(50);
    // Milhar E um decimal na mesma célula — caminho distinto, porque existe um
    // separador ANTES do que decide. Achado por quem mediu o conserto por fora.
    expect(precoParaCentavos("1.299,9")).toBe(129990);

    // E três dígitos continuam sendo milhar, que é a outra metade da regra.
    expect(precoParaCentavos("5.499")).toBe(549900);
    expect(precoParaCentavos("1.299")).toBe(129900);
  });

  it("RECUSA a célula que tem qualquer outra coisa junto do número", () => {
    // A limpeza APAGAVA as letras e colava os dígitos do que sobrasse, então a
    // observação que a loja escreve ao lado do preço virava parte dele:
    //     "R$ 5.499,00 (promo ate 10)"  ->  R$ 54.990.010,00
    //     "de 89,90 por 49,90"          ->  R$ 899.049,90
    // Números plausíveis, e ninguém confere um a um numa planilha de 300 linhas.
    // Preço falha FECHADO: vira linha de erro com motivo, que a pessoa lê.
    expect(precoParaCentavos("R$ 5.499,00 (promo ate 10)")).toBeNull();
    expect(precoParaCentavos("de 89,90 por 49,90")).toBeNull();
    expect(precoParaCentavos("5499,00 a vista")).toBeNull();
    expect(precoParaCentavos("1e3")).toBeNull();
  });

  it("mas o símbolo da moeda e o espaço do Excel continuam sendo ruído conhecido", () => {
    // Recusar não pode virar recusar tudo: estas formas são as que a loja
    // realmente manda, e elas têm de continuar entrando.
    expect(precoParaCentavos("R$ 1.234.567,89")).toBe(123456789);
    expect(precoParaCentavos("  99,90  ")).toBe(9990);
    // O espaço não-quebrável que o Excel gera ao formatar como moeda.
    expect(precoParaCentavos("99,90\u00A0")).toBe(9990);
    expect(precoParaCentavos("r$99,90")).toBe(9990);
  });

  it("RECUSA o que não dá para ler, em vez de chutar", () => {
    // Recusar é a função: a linha entra no relatório de erro e a pessoa
    // corrige. Um chute vira preço errado dito a um cliente.
    expect(precoParaCentavos("")).toBeNull();
    expect(precoParaCentavos("sob consulta")).toBeNull();
    expect(precoParaCentavos("-50")).toBeNull();
    expect(precoParaCentavos("R$")).toBeNull();
  });
});
