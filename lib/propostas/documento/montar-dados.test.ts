// lib/propostas/documento/montar-dados.test.ts
import { describe, expect, it } from "vitest";

import { LINHA_EM_BRANCO, montarDadosDoDocumento } from "./montar-dados";
import { dadosDoNegocio } from "./negocio-do-documento";
import { substituirVariaveis } from "./variaveis";

describe("montarDadosDoDocumento", () => {
  it("espalha o briefing_json no resultado", () => {
    const dados = montarDadosDoDocumento({ ...PROPOSTA_BASE, briefing_json: { project: { name: "Site Catálogo" } } }, null);
    expect(dados).toMatchObject({ project: { name: "Site Catálogo" } });
  });

  it("numero é sempre null (renderer reafirma, não confia — Global Constraint da M2)", () => {
    const dados = montarDadosDoDocumento({ ...PROPOSTA_BASE, briefing_json: { numero: 42 } }, null);
    expect(dados.numero).toBeNull();
  });

  it("briefing_json null não lança, devolve objeto só com numero", () => {
    expect(() => montarDadosDoDocumento(PROPOSTA_BASE, null)).not.toThrow();
    expect(montarDadosDoDocumento(PROPOSTA_BASE, null)).toMatchObject({ numero: null });
  });

  it("briefing_json que não é objeto (array, string) é ignorado, não lança", () => {
    expect(montarDadosDoDocumento({ ...PROPOSTA_BASE, briefing_json: ["x"] }, null)).toMatchObject({ numero: null });
    expect(montarDadosDoDocumento({ ...PROPOSTA_BASE, briefing_json: "texto solto" }, null)).toMatchObject({
      numero: null,
    });
  });
});

const PROPOSTA_BASE = {
  briefing_json: null,
  total_cents: 250000,
  moeda: "BRL",
  prazo_dias_uteis: 20,
  valid_until: "2026-10-16T00:00:00.000Z",
  created_at: "2026-09-26T00:00:00.000Z",
};

describe("montarDadosDoDocumento — preço, prazo e validade (nunca vêm do briefing)", () => {
  it("investment.total_formatted vem de total_cents + moeda, formatado por formatCents", () => {
    const dados = montarDadosDoDocumento(PROPOSTA_BASE, null);
    // formatCents usa NBSP entre símbolo e número — normaliza antes de
    // comparar com o literal (o literal do plano usa espaço comum).
    const total = (dados.investment as { total_formatted: string }).total_formatted.replace(/\u00a0/g, " ");
    expect(total).toBe("R$ 2.500,00");
  });

  it("schedule.estimated_days vem de prazo_dias_uteis, mesmo se o briefing tentar mandar outro valor", () => {
    const dados = montarDadosDoDocumento(
      { ...PROPOSTA_BASE, briefing_json: { schedule: { estimated_days: 999 } } },
      null,
    );
    expect(dados.schedule).toMatchObject({ estimated_days: 20 });
  });

  it("commercial_terms.validity_days é a diferença em dias entre valid_until e created_at", () => {
    const dados = montarDadosDoDocumento(PROPOSTA_BASE, null);
    expect(dados.commercial_terms).toMatchObject({ validity_days: 20 });
  });

  it("commercial_terms.validity_days é null quando a proposta não tem valid_until", () => {
    const dados = montarDadosDoDocumento({ ...PROPOSTA_BASE, valid_until: null }, null);
    expect(dados.commercial_terms).toMatchObject({ validity_days: null });
  });

  it("client.name vem do contato (name escolhido antes de display_name — regra da #906); client.company vem do briefing", () => {
    const dados = montarDadosDoDocumento(
      { ...PROPOSTA_BASE, briefing_json: { client: { company: "Imobiliária Rio" } } },
      { name: "João da Silva", display_name: "João" },
    );
    expect(dados.client).toMatchObject({
      name: "João da Silva",
      company: "Imobiliária Rio",
      company_or_name: "Imobiliária Rio",
    });
  });

  it("client.company_or_name cai para o nome do contato quando não há company no briefing", () => {
    const dados = montarDadosDoDocumento(PROPOSTA_BASE, { name: "João da Silva", display_name: null });
    expect(dados.client).toMatchObject({ name: "João da Silva", company_or_name: "João da Silva" });
  });

  it("contato null não lança — client.name cai para o que o briefing tiver, ou null", () => {
    expect(() => montarDadosDoDocumento(PROPOSTA_BASE, null)).not.toThrow();
    const dados = montarDadosDoDocumento(PROPOSTA_BASE, null);
    expect(dados.client).toMatchObject({ name: null, company_or_name: null });
  });
});

describe("montarDadosDoDocumento — aprovação (D2 da spec de 26/09)", () => {
  it("approval.date é sempre a linha em branco da assinatura", () => {
    const dados = montarDadosDoDocumento(PROPOSTA_BASE, null);
    expect(dados.approval).toEqual({ date: LINHA_EM_BRANCO });
  });

  it("o briefing não consegue preencher approval.date", () => {
    const dados = montarDadosDoDocumento({ ...PROPOSTA_BASE, briefing_json: { approval: { date: "01/01/2026" } } }, null);
    expect(dados.approval).toEqual({ date: LINHA_EM_BRANCO });
  });
});

/**
 * #4533 — o modelo lê os campos do negócio.
 *
 * O funil declara o TIPO de cada campo; é ele que decide o formato (moeda,
 * dd/mm/aaaa, Sim/Não, rótulo da opção). O valor de `currency` é gravado em
 * UNIDADES da moeda (`lib/leads/campo-de-moeda.ts`), por isso 250000 sai
 * "R$ 250.000,00" — ler como centavo mostraria cem vezes menos.
 */
const FUNIL_DO_NEGOCIO = {
  fields: [
    { key: "endereco_do_imovel", label: "Endereço do imóvel", type: "text" },
    { key: "valor_do_aluguel", label: "Valor do aluguel", type: "currency" },
    { key: "data_de_entrada", label: "Data de entrada", type: "date" },
    { key: "aceita_pet", label: "Aceita pet", type: "boolean" },
    {
      key: "tipo",
      label: "Tipo do imóvel",
      type: "select",
      options: [{ value: "paris-franca", label: "Paris (França)" }],
    },
    { key: "comodidades", label: "Comodidades", type: "multiselect", options: [
      { value: "piscina", label: "Piscina" },
      { value: "academia", label: "Academia" },
    ] },
    { key: "bairro", label: "Bairro", type: "text" },
  ],
};

const NEGOCIO_BASE = {
  titulo: "Aluguel — apartamento no Centro",
  etapa: "Proposta enviada",
  responsavel_nome: "Ana Souza",
  responsavel_telefone: "+5511999998888",
  moeda: "BRL",
  custom_fields: {
    endereco_do_imovel: "Rua X, 10",
    valor_do_aluguel: 250000,
    data_de_entrada: "2026-12-01",
    aceita_pet: true,
    tipo: "paris-franca",
    comodidades: ["piscina", "academia"],
  },
};

describe("montarDadosDoDocumento — o negócio (#4533)", () => {
  it("expõe lead.<chave> formatado pelo TIPO do campo, mais título, etapa e responsável", () => {
    const dados = montarDadosDoDocumento(
      PROPOSTA_BASE,
      null,
      dadosDoNegocio(NEGOCIO_BASE, FUNIL_DO_NEGOCIO, "BRL"),
    );
    const lead = dados.lead as Record<string, unknown>;

    expect(lead.endereco_do_imovel).toBe("Rua X, 10");
    // formatCents usa NBSP entre símbolo e número — normaliza antes de comparar.
    expect((lead.valor_do_aluguel as string).replace(/\u00a0/g, " ")).toBe("R$ 250.000,00");
    expect(lead.data_de_entrada).toBe("01/12/2026");
    expect(lead.aceita_pet).toBe("Sim");
    expect(lead.tipo).toBe("Paris (França)");
    expect(lead.comodidades).toBe("Piscina, Academia");
    expect(lead.titulo).toBe("Aluguel — apartamento no Centro");
    expect(lead.etapa).toBe("Proposta enviada");
    expect(lead.responsavel_nome).toBe("Ana Souza");
    expect(lead.responsavel_telefone).toBe("+5511999998888");
  });

  it("campo VAZIO não vira string vazia: sai [a definir] e entra em faltantes", () => {
    const dados = montarDadosDoDocumento(
      PROPOSTA_BASE,
      null,
      dadosDoNegocio(NEGOCIO_BASE, FUNIL_DO_NEGOCIO, "BRL"),
    );
    expect((dados.lead as Record<string, unknown>).bairro).toBeUndefined();

    const { textoRenderizado, faltantes } = substituirVariaveis(
      "Bairro: {{lead.bairro}} — imóvel: {{lead.endereco_do_imovel}}",
      dados,
    );
    expect(textoRenderizado).toBe("Bairro: [a definir] — imóvel: Rua X, 10");
    expect(faltantes).toEqual(["lead.bairro"]);
  });

  it("data que não existe fica como está gravada, em vez de virar [a definir]", () => {
    const dados = montarDadosDoDocumento(
      PROPOSTA_BASE,
      null,
      dadosDoNegocio(
        { ...NEGOCIO_BASE, custom_fields: { data_de_entrada: "2026-02-31" } },
        FUNIL_DO_NEGOCIO,
        "BRL",
      ),
    );
    expect((dados.lead as Record<string, unknown>).data_de_entrada).toBe("2026-02-31");
  });

  it("o card vence o briefing em {{lead.*}}: fato do negócio não é texto da IA", () => {
    const dados = montarDadosDoDocumento(
      { ...PROPOSTA_BASE, briefing_json: { lead: { endereco_do_imovel: "inventado pela IA" } } },
      null,
      dadosDoNegocio(NEGOCIO_BASE, FUNIL_DO_NEGOCIO, "BRL"),
    );
    expect((dados.lead as Record<string, unknown>).endereco_do_imovel).toBe("Rua X, 10");
  });

  it("REGRESSÃO: sem negócio (lead_id nulo ou leitura falhando) o dataset é o de hoje, sem `lead`", () => {
    const semNegocio = montarDadosDoDocumento(PROPOSTA_BASE, null);
    expect(semNegocio).not.toHaveProperty("lead");
    expect(montarDadosDoDocumento(PROPOSTA_BASE, null, null)).toEqual(semNegocio);
    // Card lido mas sem nenhum valor: nada a acrescentar — mesmo dataset.
    expect(montarDadosDoDocumento(PROPOSTA_BASE, null, {})).toEqual(semNegocio);
    expect(montarDadosDoDocumento(PROPOSTA_BASE, null, dadosDoNegocio(
      { titulo: null, etapa: null, responsavel_nome: null, responsavel_telefone: null, moeda: null, custom_fields: null },
      null,
      "BRL",
    ))).toEqual(semNegocio);
  });
});
