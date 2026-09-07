import { describe, expect, it } from "vitest";

import { lerPlanilhaDeLeads } from "./planilha";

/**
 * `traduzir()` real só troca a CHAVE que bate byte a byte com uma entrada do
 * dicionário; o resto degrada para o próprio texto. Ver o comentário gêmeo em
 * `lib/catalogo/planilha.test.ts` — de lá veio o bug real que motivou este
 * arquivo: um parêntese de fechamento colado DENTRO da chave traduzida não bate
 * com a entrada do dicionário (que não tem o parêntese), e a mensagem sai meio
 * em português. Um mock que traduz QUALQUER string não pega esse descasamento.
 */
const DICIONARIO_FAKE: Record<string, string> = {
  "A planilha está vazia.": "LA PLANILLA ESTÁ VACÍA.",
  "A planilha precisa de uma coluna com o nome do negócio ou do contato. Encontrei: ":
    "LA PLANILLA NECESITA UNA COLUMNA CON EL NOMBRE DEL NEGOCIO O DEL CONTACTO. ENCONTRÉ: ",
  "nenhuma coluna": "NINGUNA COLUMNA",
  "sem nome do negócio nem do contato": "SIN NOMBRE DEL NEGOCIO NI DEL CONTACTO",
  "valor não reconhecido (": "VALOR NO RECONOCIDO (",
  " — escreva assim: 1.200,00": " — ESCRÍBALO ASÍ: 1.200,00",
  "telefone não reconhecido (": "TELÉFONO NO RECONOCIDO (",
  " — o negócio entrou sem contato": " — EL NEGOCIO ENTRÓ SIN CONTACTO",
};
const gritar = (texto: string): string => DICIONARIO_FAKE[texto] ?? texto;

describe("lerPlanilhaDeLeads — mensagens de erro passam por t()", () => {
  it("planilha vazia", () => {
    const resultado = lerPlanilhaDeLeads("", gritar);
    expect(resultado).toEqual({ erro: "LA PLANILLA ESTÁ VACÍA." });
  });

  it("sem coluna de nome nem de contato", () => {
    const csv = "telefone\n11999999999\n";
    const resultado = lerPlanilhaDeLeads(csv, gritar);
    expect(resultado).toEqual({
      erro: "LA PLANILLA NECESITA UNA COLUMNA CON EL NOMBRE DEL NEGOCIO O DEL CONTACTO. ENCONTRÉ: telefone.",
    });
  });

  it("linha sem nome de negócio nem de contato", () => {
    const csv = "nome,telefone\n,11999999999\n";
    const resultado = lerPlanilhaDeLeads(csv, gritar);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe("SIN NOMBRE DEL NEGOCIO NI DEL CONTACTO");
  });

  it("valor não reconhecido — traduz por completo, incluindo o texto após o valor cru", () => {
    const csv = "nome,valor\nNegócio,abc\n";
    const resultado = lerPlanilhaDeLeads(csv, gritar);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe('VALOR NO RECONOCIDO ("abc") — ESCRÍBALO ASÍ: 1.200,00');
  });

  it("telefone não reconhecido — traduz por completo", () => {
    const csv = "nome,telefone\nNegócio,abc\n";
    const resultado = lerPlanilhaDeLeads(csv, gritar);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe(
      'TELÉFONO NO RECONOCIDO ("abc") — EL NEGOCIO ENTRÓ SIN CONTACTO',
    );
    // Telefone ilegível não derruba a linha: o lead entra mesmo assim.
    expect(resultado.leads).toHaveLength(1);
  });

  it("sem função t: comportamento idêntico ao de antes (degrada para o texto original)", () => {
    const csv = "nome,valor\nNegócio,abc\n";
    const resultado = lerPlanilhaDeLeads(csv);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe('valor não reconhecido ("abc") — escreva assim: 1.200,00');
  });
});
