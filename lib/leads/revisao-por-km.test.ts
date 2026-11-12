import { describe, expect, it } from "vitest";

import {
  configuracaoDeRevisaoPorKm,
  diasEntre,
  kmDoCampo,
  projetarProximaRevisao,
  somarDias,
  somarMeses,
} from "@/lib/leads/revisao-por-km";

/**
 * A TABELA DE CASOS da conta (#4376) — entrada → ritmo → data prevista.
 *
 * Os números são os da régua de mercado da issue: 3 000 km em 90 dias = 33,3
 * km/dia, e 7 000 km até o marco de 10 000 km caem em ~210 dias. Cada caso
 * desta tabela é uma linha do PR; os quatro de borda estão nomeados como tal.
 */

const CAMPOS_DO_FUNIL = [
  { key: "data_retirada", label: "Data da retirada", type: "date" },
  { key: "km_atual", label: "Km atual", type: "number" },
  { key: "proxima_revisao", label: "Próxima revisão", type: "date" },
  { key: "km_da_ultima_revisao", label: "Km da última revisão", type: "number" },
  { key: "data_da_ultima_revisao", label: "Data da última revisão", type: "date" },
  { key: "cor_do_veiculo", label: "Cor", type: "text" },
] as const;

function settingsCom(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fields: CAMPOS_DO_FUNIL,
    revisao_por_km: {
      campo_retirada: "data_retirada",
      campo_km: "km_atual",
      campo_saida: "proxima_revisao",
      campo_km_da_ultima_revisao: "km_da_ultima_revisao",
      campo_da_ultima_revisao: "data_da_ultima_revisao",
      intervalo_km: 10_000,
      prazo_meses: 12,
      dias_de_aviso: 30,
      ...extra,
    },
  };
}

function config(extra: Record<string, unknown> = {}) {
  const leitura = configuracaoDeRevisaoPorKm(settingsCom(extra));
  if (!leitura.ok) throw new Error(`configuração de teste inválida: ${leitura.motivo}`);
  return leitura.config;
}

describe("configuração do funil (#4376)", () => {
  it("funil sem a chave não é erro: a régua não foi pedida ali", () => {
    expect(configuracaoDeRevisaoPorKm({ fields: CAMPOS_DO_FUNIL })).toEqual({
      ok: false,
      motivo: "ausente",
    });
  });

  it("campo do CONTATO é recusado — a varredura do gatilho lê o card, não a ficha", () => {
    const settings = settingsCom();
    (settings.fields as unknown[]).push({
      key: "km_do_contato",
      label: "Km",
      type: "number",
      escopo: "contato",
    });
    const lido = configuracaoDeRevisaoPorKm({ ...settings, revisao_por_km: { ...(settings.revisao_por_km as object), campo_km: "km_do_contato" } });
    expect(lido).toEqual({ ok: false, motivo: "campo_do_contato", detalhe: "campo_km=km_do_contato" });
  });

  it("campo de saída que não é DATA é recusado, nomeando o campo", () => {
    const lido = configuracaoDeRevisaoPorKm(settingsCom({ campo_saida: "cor_do_veiculo" }));
    expect(lido).toEqual({
      ok: false,
      motivo: "tipo_do_campo",
      detalhe: "campo_saida=cor_do_veiculo:text",
    });
  });

  it("campo que o funil não tem é recusado (apontar para o nada não projeta)", () => {
    const lido = configuracaoDeRevisaoPorKm(settingsCom({ campo_retirada: "data_de_entrega" }));
    expect(lido).toEqual({
      ok: false,
      motivo: "campo_desconhecido_no_funil",
      detalhe: "campo_retirada=data_de_entrega",
    });
  });

  it("intervalo zero, prazo zero e aviso negativo são recusados", () => {
    expect(configuracaoDeRevisaoPorKm(settingsCom({ intervalo_km: 0 }))).toEqual({
      ok: false,
      motivo: "intervalo_invalido",
    });
    expect(configuracaoDeRevisaoPorKm(settingsCom({ prazo_meses: 0 }))).toEqual({
      ok: false,
      motivo: "prazo_invalido",
    });
    expect(configuracaoDeRevisaoPorKm(settingsCom({ dias_de_aviso: -1 }))).toEqual({
      ok: false,
      motivo: "aviso_invalido",
    });
  });

  it("os dois campos da revisão anterior andam juntos", () => {
    const lido = configuracaoDeRevisaoPorKm(
      settingsCom({ campo_km_da_ultima_revisao: "km_da_ultima_revisao", campo_da_ultima_revisao: undefined }),
    );
    expect(lido).toEqual({
      ok: false,
      motivo: "campo_obrigatorio",
      detalhe: "campo_da_ultima_revisao",
    });
  });
});

describe("calendário puro", () => {
  it("conta dias entre datas e anda em dias", () => {
    expect(diasEntre("2026-01-01", "2026-04-01")).toBe(90);
    expect(somarDias("2026-01-01", 210)).toBe("2026-07-30");
    expect(diasEntre("2026-04-01", "2026-01-01")).toBe(-90);
  });

  it("somar meses é aniversário, com o dia preso ao fim do mês", () => {
    expect(somarMeses("2026-01-15", 12)).toBe("2027-01-15");
    expect(somarMeses("2026-01-31", 1)).toBe("2026-02-28");
    expect(somarMeses("2024-02-29", 12)).toBe("2025-02-28");
  });

  it("km aceita número e o texto do formulário, e recusa o que não é número", () => {
    expect(kmDoCampo(12000)).toBe(12000);
    expect(kmDoCampo("12000")).toBe(12000);
    expect(kmDoCampo("12.000")).toBe(12000);
    expect(kmDoCampo("12000,5")).toBe(12000.5);
    expect(kmDoCampo("uns 12 mil")).toBeNull();
    expect(kmDoCampo("")).toBeNull();
    expect(kmDoCampo(-5)).toBeNull();
  });
});

type Caso = {
  nome: string;
  campos: Record<string, unknown>;
  hoje: string;
  esperado: Record<string, unknown>;
};

const TABELA: Caso[] = [
  {
    // 3.000 km em 90 dias = 33,3 km/dia; faltam 7.000 km para o marco de 10 mil
    // = 210 dias → 2026-04-01 + 210 = 2026-10-28.
    nome: "3.000 km em 90 dias → 33,3 km/dia → marco de 10 mil em 210 dias",
    campos: { data_retirada: "2026-01-01", km_atual: "3000" },
    hoje: "2026-04-01",
    esperado: {
      status: "projetada",
      data: "2026-10-28",
      dia_do_aviso: "2026-09-28",
      marco_km: 10_000,
      ritmo_km_por_dia: 33.3,
      dias_ate_a_revisao: 210,
      limitada_pelo_prazo: false,
      ajustada_pelo_aviso: false,
      ja_gravada: false,
    },
  },
  {
    // Borda 2: 500 km em 151 dias = 3,3 km/dia — o marco de 10 mil levaria
    // ~2.870 dias, então quem vence é o TETO de 12 meses (2027-01-01).
    nome: "BORDA 12 meses antes do km: quem roda pouco vence no aniversário da retirada",
    campos: { data_retirada: "2026-01-01", km_atual: 500 },
    hoje: "2026-06-01",
    esperado: {
      status: "projetada",
      data: "2027-01-01",
      dia_do_aviso: "2026-12-02",
      marco_km: 10_000,
      ritmo_km_por_dia: 3.3,
      limitada_pelo_prazo: true,
      ajustada_pelo_aviso: false,
    },
  },
  {
    // Borda 4: 38.000 km em 315 dias = 120,6 km/dia. O marco de 40 mil cairia em
    // 17 dias (2026-11-29), mas o aviso de 30 dias já teria passado — a data
    // sobe para hoje + 30 (2026-12-12), que é o dia em que o gatilho ainda pega.
    nome: "BORDA cliente que roda muito: revisão em 17 dias não cai em aviso vencido",
    campos: { data_retirada: "2026-01-01", km_atual: "38000" },
    hoje: "2026-11-12",
    esperado: {
      status: "projetada",
      data: "2026-12-12",
      dia_do_aviso: "2026-11-12",
      marco_km: 40_000,
      ritmo_km_por_dia: 120.6,
      limitada_pelo_prazo: false,
      ajustada_pelo_aviso: true,
    },
  },
  {
    // Borda 1: revisão feita com 10.500 km e leitura de 9.000 km depois disso é
    // dedo no teclado. Não projeta, não regride e não inventa ritmo negativo.
    nome: "BORDA km menor que o anterior: não projeta, mantém a data e não cria ritmo negativo",
    campos: {
      data_retirada: "2026-01-01",
      km_da_ultima_revisao: 10_500,
      data_da_ultima_revisao: "2026-03-01",
      km_atual: 9_000,
      proxima_revisao: "2027-03-01",
    },
    hoje: "2026-05-01",
    esperado: {
      status: "km_sem_avanco",
      km_atual: 9_000,
      km_base: 10_500,
      data_mantida: "2027-03-01",
    },
  },
  {
    // Borda 3: sem retirada (e sem revisão anterior) não há de onde contar. A
    // resposta é explícita — o card não pode ficar vazio em silêncio.
    nome: "BORDA sem data de retirada: resposta explícita, nenhuma data inventada",
    campos: { km_atual: 8_000 },
    hoje: "2026-05-01",
    esperado: { status: "sem_data_de_retirada" },
  },
  {
    // A revisão anterior é a base quando o funil a guarda: 2.500 km em 90 dias =
    // 27,8 km/dia; faltam 7.500 km para o marco de 20 mil = 270 dias.
    nome: "com revisão anterior: o marco seguinte é o de 20 mil (2027-05-27)",
    campos: {
      data_retirada: "2026-01-01",
      km_da_ultima_revisao: 10_000,
      data_da_ultima_revisao: "2026-06-01",
      km_atual: 12_500,
    },
    hoje: "2026-08-30",
    esperado: {
      status: "projetada",
      data: "2027-05-27",
      dia_do_aviso: "2027-04-27",
      marco_km: 20_000,
      km_base: 10_000,
      data_base: "2026-06-01",
      ritmo_km_por_dia: 27.8,
      limitada_pelo_prazo: false,
      ajustada_pelo_aviso: false,
    },
  },
  {
    nome: "km igual ao da base: sem ritmo, vence no prazo de 12 meses",
    campos: { data_retirada: "2026-02-10", km_atual: 0 },
    hoje: "2026-09-01",
    esperado: {
      status: "projetada",
      data: "2027-02-10",
      limitada_pelo_prazo: true,
      ritmo_km_por_dia: 0,
    },
  },
  {
    nome: "retirada e leitura no mesmo dia: sem ritmo (não divide por zero)",
    campos: { data_retirada: "2026-05-01", km_atual: 120 },
    hoje: "2026-05-01",
    esperado: { status: "sem_ritmo", motivo: "leitura_no_mesmo_dia" },
  },
  {
    nome: "retirada no futuro (data digitada errada): não projeta",
    campos: { data_retirada: "2026-12-01", km_atual: 120 },
    hoje: "2026-05-01",
    esperado: { status: "sem_ritmo", motivo: "data_base_no_futuro" },
  },
  {
    nome: "sem km no card: não projeta", 
    campos: { data_retirada: "2026-01-01" },
    hoje: "2026-05-01",
    esperado: { status: "sem_km" },
  },
  {
    nome: "a data já está no card: idempotente, nada a regravar",
    campos: { data_retirada: "2026-01-01", km_atual: "3000", proxima_revisao: "2026-10-28" },
    hoje: "2026-04-01",
    esperado: { status: "projetada", data: "2026-10-28", ja_gravada: true },
  },
];

describe("a conta — tabela de casos (#4376)", () => {
  for (const caso of TABELA) {
    it(caso.nome, () => {
      const resultado = projetarProximaRevisao({
        config: config(),
        campos: caso.campos,
        hoje: caso.hoje,
      });
      const esperado = caso.esperado;
      expect(resultado.status).toBe(esperado.status);
      for (const [chave, valor] of Object.entries(esperado)) {
        expect({ [chave]: (resultado as Record<string, unknown>)[chave] }).toEqual({ [chave]: valor });
      }
    });
  }

  it("o intervalo do funil manda no marco: 5.000 km projeta 15 mil, não 10 mil", () => {
    const resultado = projetarProximaRevisao({
      config: config({ intervalo_km: 5_000 }),
      campos: { data_retirada: "2026-01-01", km_atual: 12_000 },
      hoje: "2026-04-01",
    });
    expect(resultado).toMatchObject({ status: "projetada", marco_km: 15_000 });
  });

  it("o prazo do funil é lido da configuração: 6 meses vence antes do marco", () => {
    const resultado = projetarProximaRevisao({
      config: config({ prazo_meses: 6 }),
      campos: { data_retirada: "2026-01-01", km_atual: 1_000 },
      hoje: "2026-04-01",
    });
    expect(resultado).toMatchObject({ status: "projetada", data: "2026-07-01", limitada_pelo_prazo: true });
  });
});
