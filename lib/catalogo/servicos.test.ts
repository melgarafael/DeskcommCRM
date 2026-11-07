import { describe, expect, it } from "vitest";

import {
  descreverServicoParaIA,
  menorPreco,
  montarServicos,
  rotuloAPartir,
  rotuloDoPreco,
  rotuloDoSinal,
  sinalEmCents,
  sufixoDaUnidade,
  unidadeCompativel,
  type LinhaDoCatalogo,
} from "./servicos";

/** O `Intl` emite NBSP (U+00A0) ou narrow NBSP (U+202F) entre símbolo e número. */
const semNbsp = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");

/**
 * O SERVIÇO DO CATÁLOGO — tipo, unidade, "a partir de" e sinal (issue #3372).
 *
 * Os casos são os exemplos da própria issue, porque é neles que o desenho foi
 * pensado: consultoria de 1h por R$ 350 com sinal de 30%, reunião de
 * diagnóstico grátis, plano de social media de 12 ou 20 posts, site com prazo.
 */

describe("unidade de cobrança × tipo de serviço", () => {
  it("aceita só a família de cada tipo — a mesma lista do CHECK do banco", () => {
    expect(unidadeCompativel("hora_marcada", "sessao")).toBe(true);
    expect(unidadeCompativel("hora_marcada", "hora")).toBe(true);
    expect(unidadeCompativel("projeto", "valor_fechado")).toBe(true);
    expect(unidadeCompativel("projeto", "hora")).toBe(true);
    expect(unidadeCompativel("recorrente", "mes")).toBe(true);
    expect(unidadeCompativel("recorrente", "trimestre")).toBe(true);
    expect(unidadeCompativel("recorrente", "ano")).toBe(true);
  });

  it("recusa projeto cobrado por mês e hora marcada cobrada por valor fechado", () => {
    // Contrato diferente, não vocabulário: quem quer cobrar por mês cadastra
    // Recorrente. O banco recusa com o mesmo par, e a rota responde 422 antes.
    expect(unidadeCompativel("projeto", "mes")).toBe(false);
    expect(unidadeCompativel("hora_marcada", "valor_fechado")).toBe(false);
    expect(unidadeCompativel("recorrente", "sessao")).toBe(false);
  });

  it("preço fechado não ganha sufixo — 'por projeto' soaria como parcela", () => {
    expect(sufixoDaUnidade("valor_fechado")).toBe("");
    expect(sufixoDaUnidade("mes")).toBe("por mês");
    expect(sufixoDaUnidade("sessao")).toBe("por sessão");
  });
});

describe("preço: 'a partir de' e grátis", () => {
  it("soma o sufixo da unidade no preço", () => {
    expect(semNbsp(rotuloDoPreco(120_000, "BRL", "mes"))).toBe("R$ 1.200,00 por mês");
    expect(semNbsp(rotuloDoPreco(450_000, "BRL", "valor_fechado"))).toBe("R$ 4.500,00");
  });

  it("preço zero é oferta gratuita e se diz Grátis — não 'R$ 0,00 por sessão'", () => {
    expect(rotuloDoPreco(0, "BRL", "sessao")).toBe("Grátis");
  });

  it("'a partir de' usa o MENOR preço das variações", () => {
    // 12 posts por R$ 1.200 e 20 posts + 4 reels por R$ 1.900 (exemplo da issue)
    expect(semNbsp(rotuloAPartir([120_000, 190_000], "BRL", "mes"))).toBe(
      "a partir de R$ 1.200,00 por mês",
    );
  });

  it("um preço só não é escada — nada de 'a partir de'", () => {
    expect(semNbsp(rotuloAPartir([120_000], "BRL", "mes"))).toBe("R$ 1.200,00 por mês");
    expect(semNbsp(rotuloAPartir([120_000, 120_000], "BRL", "mes"))).toBe("R$ 1.200,00 por mês");
  });

  it("menor preço é o menor mesmo quando a ordem chega trocada", () => {
    expect(menorPreco([{ preco_cents: 190_000 }, { preco_cents: 120_000 }])).toBe(120_000);
    expect(menorPreco([])).toBeNull();
  });
});

describe("sinal calculado", () => {
  it("30% de R$ 350,00 é R$ 105,00 — o caso da issue", () => {
    expect(sinalEmCents(35_000, { tipo: "percentual", percentual: 30 })).toBe(10_500);
    expect(semNbsp(rotuloDoSinal(10_500, "BRL", 30) ?? "")).toBe("sinal de R$ 105,00 (30%)");
  });

  it("sinal fixo não tem percentual para mostrar", () => {
    expect(sinalEmCents(35_000, { tipo: "fixo", cents: 5_000 })).toBe(5_000);
    expect(semNbsp(rotuloDoSinal(5_000, "BRL", null) ?? "")).toBe("sinal de R$ 50,00");
  });

  it("sem sinal é null, e zero não vira 'sinal de R$ 0,00'", () => {
    expect(sinalEmCents(35_000, null)).toBeNull();
    expect(rotuloDoSinal(null, "BRL", 30)).toBeNull();
  });
});

const PRINCIPAL: LinhaDoCatalogo = {
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "SOCIAL",
  nome: "Social media",
  descricao: "Gestão de redes sociais",
  preco_cents: 120_000,
  moeda: "BRL",
  ativo: true,
  tipo_servico: "recorrente",
  unidade_cobranca: "mes",
  prazo_dias_uteis: null,
  sinal_tipo: "percentual",
  sinal_percentual: 30,
  sinal_cents: null,
  pai_id: null,
  fotos: ["capa.jpg"],
  instrucoes_ia: "Nunca prometer prazo menor que 30 dias.",
  ia_oferece: true,
  ia_agenda: false,
  revision: 3,
};

const VARIACAO: LinhaDoCatalogo = {
  ...PRINCIPAL,
  id: "22222222-2222-4222-8222-222222222222",
  codigo: "SOCIAL-20",
  nome: "Social media 20 posts + 4 reels",
  preco_cents: 190_000,
  // A variação NÃO carrega detalhe de serviço — o CHECK do banco a proíbe.
  tipo_servico: null,
  unidade_cobranca: null,
  prazo_dias_uteis: null,
  sinal_tipo: null,
  sinal_percentual: null,
  sinal_cents: null,
  pai_id: PRINCIPAL.id,
};

describe("montarServicos", () => {
  it("agrupa principal + variações e calcula 'a partir de' no principal", () => {
    const [servico] = montarServicos([PRINCIPAL, VARIACAO]);
    expect(servico?.variacoes).toHaveLength(1);
    expect(servico?.variacoes[0]?.nome).toBe("Social media 20 posts + 4 reels");
    expect(semNbsp(servico?.preco_a_partir ?? "")).toBe("a partir de R$ 1.200,00 por mês");
    expect(servico?.preco_a_partir_cents).toBe(120_000);
  });

  it("o sinal é calculado POR VARIAÇÃO, não copiado do principal", () => {
    const [servico] = montarServicos([PRINCIPAL, VARIACAO]);
    // 30% de R$ 1.200 = 360; 30% de R$ 1.900 = 570.
    expect(servico?.sinal?.cents).toBe(36_000);
    expect(servico?.variacoes[0]?.sinal_cents).toBe(57_000);
  });

  it("variação sem o principal na lista não vira serviço inventado", () => {
    // Acontece de verdade: o principal arquivado e a variação ativa.
    const montados = montarServicos([VARIACAO]);
    expect(montados).toHaveLength(0);
  });

  it("produto de prateleira não entra como serviço", () => {
    const produto: LinhaDoCatalogo = {
      ...PRINCIPAL,
      id: "33333333-3333-4333-8333-333333333333",
      tipo_servico: null,
      unidade_cobranca: null,
      sinal_tipo: null,
      sinal_percentual: null,
    };
    expect(montarServicos([produto])).toHaveLength(0);
  });

  it("prazo em dias úteis aparece no projeto", () => {
    const projeto: LinhaDoCatalogo = {
      ...PRINCIPAL,
      id: "44444444-4444-4444-8444-444444444444",
      codigo: "SITE",
      nome: "Site institucional",
      preco_cents: 450_000,
      tipo_servico: "projeto",
      unidade_cobranca: "valor_fechado",
      prazo_dias_uteis: 30,
      sinal_tipo: "percentual",
      sinal_percentual: 50,
    };
    const [montado] = montarServicos([projeto]);
    expect(montado?.prazo_dias_uteis).toBe(30);
    expect(montado?.sinal?.cents).toBe(225_000);
  });
});

describe("o que o agente recebe na busca", () => {
  it("leva tipo, unidade, 'a partir de', variações e sinal", () => {
    const [servico] = montarServicos([PRINCIPAL, VARIACAO]);
    const descricao = descreverServicoParaIA(servico!);

    expect(descricao.tipo).toBe("plano recorrente");
    expect(descricao.unidade).toBe("por mês");
    expect(semNbsp(String(descricao.preco_a_partir))).toContain("R$ 1.200,00");
    const variacoes = descricao.variacoes as Array<{ nome: string; preco: string }>;
    expect(variacoes).toHaveLength(1);
    expect(variacoes[0]?.nome).toBe("Social media 20 posts + 4 reels");
    expect(semNbsp(String(descricao.sinal))).toContain("R$ 360,00");
  });

  it("instruções internas vão MARCADAS — orientam, nunca se repetem ao cliente", () => {
    const [servico] = montarServicos([PRINCIPAL]);
    const descricao = descreverServicoParaIA(servico!);
    expect(descricao.instrucoes_internas_nao_repita_ao_cliente).toBe(
      "Nunca prometer prazo menor que 30 dias.",
    );
  });

  it("serviço que a IA não agenda diz isso ao modelo, em vez de deixar reservar", () => {
    const [servico] = montarServicos([PRINCIPAL]);
    const descricao = descreverServicoParaIA(servico!);
    expect(String(descricao.agendamento)).toContain("a equipe marca");
  });
});
