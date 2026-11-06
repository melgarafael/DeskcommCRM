import { describe, expect, it } from "vitest";
import { contemAssuntoComercialNaSaida, contemAssuntoComercialRestrito, comercialExigeHumano, restricaoComercialBarra } from "./assunto-comercial";

describe("valores e negociação somente humanos", () => {
  it.each(["Quanto custa?", "Qual o preço dos óculos?", "Tem desconto?", "Pode parcelar?",
    "Passa o Pix", "Quero um orçamento", "Está grátis?", "A promoção vale?", "R$ 199,90",
    "Tenho boleto", "Quero pagar", "Preciso de reembolso",
    "Está caro", "Aceptan pago con tarjeta?", "Qual o valor?", "Condição de crédito", "Fica 299", "A partir de 199", "299,90",
    "Quanto custa o óculos?", "Fica R$ 250,00 em 3x", "Dá para fazer em 10x?", "São 10x de 29,90",
    "Quanto vocês cobram?", "Qual o valor da consulta?", "Tem 10% off?"])
    ("não entrega condição comercial: %s", s => expect(contemAssuntoComercialRestrito(s)).toBe(true));
  // Número sozinho não é preço. Os seis do meio entraram na triagem do #2877: data e
  // hora com ponto, frequência de remédio, porcentagem de saúde, "cobre" e "valor
  // nutricional" mandavam à equipe conversa de clínica e de agenda.
  it.each(["Rua das Flores, 2054", "Avenida dos Exemplos, 1317", "Sala 01",
    "(11) 4000-0000", "Abre às 8:30?", "Quero o Maps", "Falar com a unidade A", "Bom dia",
    "Tem armações?", "Segunda a sexta", "Gostei do atendimento",
    "dia 15.10 às 14.30", "Abrimos às 9.00", "Tome 1 comprimido 2x ao dia", "Estou com 40% de visão",
    "O plano cobre isso?", "Me fala o valor nutricional", "15/10 às 14:30"])
    ("não confunde rotina/endereço com preço: %s", s => expect(contemAssuntoComercialRestrito(s)).toBe(false));
  it("falha de leitura não vira permissão", async () => {
    await expect(comercialExigeHumano({ query: async () => { throw Error("offline"); } }, "org"))
      .rejects.toThrow("offline");
  });
  it.each([true, false, "true", undefined])("só booleano true liga: %s", async enabled => {
    expect(await comercialExigeHumano({ query: async () => ({ rows: [{ enabled }] }) }, "org"))
      .toBe(enabled === true);
  });
  it("lê a camada da organização em org_guardrail_layers, não a distribuição", async () => {
    const chamadas: Array<{ sql: string; values: unknown[] }> = [];
    await comercialExigeHumano({ query: async (sql, values) => { chamadas.push({ sql, values }); return { rows: [] }; } }, "org");
    expect(chamadas[0]?.sql).toMatch(/from org_guardrail_layers/);
    expect(chamadas[0]?.values).toEqual(["org", "restricao_comercial"]);
  });
  // A trava de SAÍDA (#3270, defeito 3): só barra envio, então pega o que a
  // entrada deixa passar de propósito.
  const SO_NA_SAIDA = ["O total é 299.90 BRL", "EUR 40", "Total: 299.90 USD", "O valor é 300",
    "Por 299.90 você leva", "Leva por 299.90", "299.90 cada", "cem euros", "R$",
    "Hay descuento", "En 3 cuotas", "Cuesta 40", "The price is 30", "It costs 40", "We have a discount"];
  it.each(SO_NA_SAIDA)("a saída barra o que a entrada deixa passar: %s", s => {
    expect(contemAssuntoComercialRestrito(s)).toBe(false);
    expect(contemAssuntoComercialNaSaida(s)).toBe(true);
  });
  it.each(["trezentos reais", "Fica R$ 250,00 em 3x", "Pagamento à vista", "Pode pagar no boleto ou pix",
    "Qual o preço?", "Tem desconto?", "Em 3 parcelas"])
    ("a saída pega tudo que a entrada pega: %s", s => expect(contemAssuntoComercialNaSaida(s)).toBe(true));
  // Número sozinho e data/hora com ponto continuam fora também na saída.
  it.each(["Rua das Flores, 2054", "Sala 01", "(11) 4000-0000", "Abre às 8:30?", "dia 15.10 às 14.30",
    "Abrimos às 9.00", "Tome 1 comprimido 2x ao dia", "Estou com 40% de visão", "15/10 às 14:30",
    "Seu horário ficou para 14.30, combinado?", "Temos 3 unidades"])
    ("a saída não confunde rotina com preço: %s", s => expect(contemAssuntoComercialNaSaida(s)).toBe(false));
});

// Rodada 2 do #3270: preço que passava pelas duas réguas com a restrição ligada.
describe("valores que o redator escreve sem moeda nem vírgula", () => {
  const PASSAVAM = ["O investimento é de 2.500", "Consigo fazer por 1.800 se fechar hoje",
    "Consigo fazer por 1800 se fechar hoje", "Te faço 1800 se fechar hoje", "10 vezes sem juros",
    "Em 12 vezes no cartão", "A mensalidade é 199", "Son 500 pesos"];
  it.each(PASSAVAM)("a saída barra: %s", s => expect(contemAssuntoComercialNaSaida(s)).toBe(true));
  it.each(["Qual o investimento?", "Qual a mensalidade?", "Dá pra fazer em 10 vezes?", "Tem anuidade?"])
    ("a entrada desvia antes do roteador: %s", s => expect(contemAssuntoComercialRestrito(s)).toBe(true));
  it.each(["Os honorários ficam com o escritório", "Tem cupom?", "Dá um abatimento?", "São 10 vezes de 29"])
    ("termos de preço só da saída: %s", s => expect(contemAssuntoComercialNaSaida(s)).toBe(true));
  // Controle negativo de cada termo novo: contagem, ano, hora, frequência e academia.
  it.each(["Nossa taxa de sucesso é de 90%", "dia 15.10 às 14.30", "Seu retorno é 15 de outubro de 2026",
    "Já atendemos mais de 1.000 clientes", "Tome 2 vezes ao dia", "Venha 3 vezes por semana",
    "Treino com pesos livres", "Ligue (11) 4000-0000", "Atendemos de 14.30 às 18.00"])
    ("a saída não barra: %s", s => expect(contemAssuntoComercialNaSaida(s)).toBe(false));
  it.each(["Tome 2 vezes ao dia", "Já vim aqui 3 vezes", "Nossa taxa de sucesso é de 90%"])
    ("a entrada não desvia: %s", s => expect(contemAssuntoComercialRestrito(s)).toBe(false));
});

// Rodada 3 do #3270: "N vezes" só é parcela com contexto de pagamento.
describe("parcela na saída: só com contexto de pagamento", () => {
  it.each(["3x 600", "12x de 150", "12x150", "São 10 vezes de 29", "10 vezes sem juros",
    "Em 12 vezes no cartão", "Dá em até 6 vezes"])
    ("a saída barra: %s", s => expect(contemAssuntoComercialNaSaida(s)).toBe(true));
  it.each(["Você já remarcou 3 vezes", "Ligamos 2 vezes e ninguém atendeu", "Use 2 vezes diariamente",
    "Rua Augusta, 1500", "CEP 01310-100", "Traga uma foto 3x4", "Faça 3x12 repetições", "Tome 2x ao dia"])
    ("a saída não barra: %s", s => expect(contemAssuntoComercialNaSaida(s)).toBe(false));
});

// Rodada 4 do #3270: parcela com espaço e sem "de" passava ("10 vezes 99", "12x 50").
describe("parcela na saída: valor depois do espaço, sem 'de'", () => {
  it.each(["10 vezes 99", "12x 50", "3 vezes 200", "6x R$ 80", "São 10 vezes 99 no total", "Dá 12x 50 pra você"])
    ("a saída barra: %s", s => expect(contemAssuntoComercialNaSaida(s)).toBe(true));
  it.each(["Você já remarcou 3 vezes", "Ligamos 2 vezes e ninguém atendeu", "Use 2 vezes diariamente",
    "Tome 2x ao dia", "A sala 3x4 está livre", "Rua Augusta, 1500", "CEP 01310-100", "Caminhe 2x 30 minutos",
    "Faça 3 vezes 10 repetições", "Pingue 2 vezes 10 gotas", "Venha 2x 14:30", "Recorte 2x 80 cm",
    "Tome 3 vezes 1 comprimido", "Repita 2x 15 dias"])
    ("a saída não barra: %s", s => expect(contemAssuntoComercialNaSaida(s)).toBe(false));
});

describe("restricaoComercialBarra: a régua dos dois caminhos de envio", () => {
  const avisar = () => {};
  it("corpo sem preço não lê a escolha", async () => {
    let leu = false;
    expect(await restricaoComercialBarra("Bom dia", async () => (leu = true), avisar)).toBe(false);
    expect(leu).toBe(false);
  });
  it.each([true, false])("corpo com preço segue a escolha: %s", async ligada => {
    expect(await restricaoComercialBarra("por 1.800", async () => ligada, avisar)).toBe(ligada);
  });
  it("leitura que estoura conta como ligada", async () => {
    expect(await restricaoComercialBarra("por 1.800", async () => { throw Error("offline"); }, avisar)).toBe(true);
  });
});
