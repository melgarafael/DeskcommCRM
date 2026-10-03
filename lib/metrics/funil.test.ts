/**
 * A conta da análise do funil (issue #1750).
 *
 * Os cinco pontos de aceite da issue, com dados fixados e sem banco:
 * conversão A→B de 75% com amostra, mediana de dias que IGNORA abertos e
 * perdidos, valor que NUNCA soma moedas diferentes, saída sem entrada na
 * janela que não infla a taxa, e vazio que explica em vez de devolver NaN.
 */
import { describe, expect, it } from "vitest";

import {
  calcularConversao,
  calcularDiasAteFechar,
  calcularOrigem,
  montarRelatorioDeFunil,
  temNaN,
  type AtividadeDeEtapa,
  type EtapaReferencia,
  type Janela,
  type LeadDaJanela,
  type LinhaDeConversao,
  type RelatorioDeFunil,
} from "./funil";

const JANELA: Janela = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

const ETAPAS: EtapaReferencia[] = [
  { id: "A", nome: "Contato", pipeline_id: "f1", posicao: 1 },
  { id: "B", nome: "Proposta", pipeline_id: "f1", posicao: 2 },
  { id: "C", nome: "Fechamento", pipeline_id: "f1", posicao: 3 },
];

const FUNIS = [{ id: "f1", nome: "Vendas", posicao: 1 }];

function lead(parcial: Partial<LeadDaJanela> & { id: string }): LeadDaJanela {
  return {
    pipeline_id: "f1",
    stage_id: "A",
    status: "open",
    source: "manual",
    value_cents: null,
    currency: null,
    created_at: "2026-09-10T12:00:00.000Z",
    closed_at: null,
    ...parcial,
  };
}

function passagem(leadId: string, de: string, para: string, quando: string): AtividadeDeEtapa {
  return { lead_id: leadId, de, para, quando };
}

/** Linha de conversão da etapa, para não depender da ordem do array. */
function linha(relatorio: RelatorioDeFunil, id: string): LinhaDeConversao {
  const achada = relatorio.conversao.etapas.find((l) => l.etapa.id === id);
  if (!achada) throw new Error(`etapa ${id} fora do relatório`);
  return achada;
}

describe("conversão por etapa (#1750)", () => {
  it("três que passaram A→B e um que parou em A dão 75%, com a amostra junto", () => {
    const relatorio = montarRelatorioDeFunil({
      janela: JANELA,
      etapas: ETAPAS,
      funis: FUNIS,
      leads: [
        lead({ id: "l1", stage_id: "B" }),
        lead({ id: "l2", stage_id: "B" }),
        lead({ id: "l3", stage_id: "B" }),
        lead({ id: "l4", stage_id: "A" }),
      ],
      atividades: [
        passagem("l1", "A", "B", "2026-09-12T10:00:00.000Z"),
        passagem("l2", "A", "B", "2026-09-13T10:00:00.000Z"),
        passagem("l3", "A", "B", "2026-09-14T10:00:00.000Z"),
      ],
    });

    const a = linha(relatorio, "A");
    expect(a.entraram).toBe(4);
    expect(a.passaram).toBe(3);
    expect(a.amostra).toBe(4);
    expect(a.taxa).toBe(0.75);
    // A taxa carrega a amostra: não existe número solto.
    expect(a.taxa).not.toBeNull();
    expect(temNaN(relatorio)).toBe(false);
  });

  it("etapa sem amostra devolve taxa nula, nunca 0 e nunca NaN", () => {
    const relatorio = montarRelatorioDeFunil({
      janela: JANELA,
      etapas: ETAPAS,
      funis: FUNIS,
      leads: [],
      atividades: [],
    });
    expect(relatorio.conversao.etapas).toEqual([]);
    expect(relatorio.vazio).not.toBeNull();
    expect(relatorio.vazio?.motivo).toContain("sem dado");
    expect(relatorio.dias_ate_fechar.mediana).toBeNull();
    expect(relatorio.origem.linhas).toEqual([]);
    expect(temNaN(relatorio)).toBe(false);
  });

  it("quem já estava na etapa antes da janela sai em saídas_sem_entrada e NÃO infla a taxa", () => {
    const relatorio = montarRelatorioDeFunil({
      janela: JANELA,
      etapas: ETAPAS,
      funis: FUNIS,
      // l1 nasceu ANTES da janela (01/08) e só se moveu dentro dela.
      leads: [lead({ id: "l1", created_at: "2026-08-01T00:00:00.000Z", stage_id: "B" })],
      atividades: [passagem("l1", "A", "B", "2026-09-12T10:00:00.000Z")],
    });

    const a = linha(relatorio, "A");
    expect(a.entraram).toBe(0);
    expect(a.passaram).toBe(0);
    expect(a.taxa).toBeNull();
    expect(a.saidas_sem_entrada_na_janela).toBe(1);
    // Invariante: passaram ⊆ entraram — a taxa nunca passa de 100%.
    for (const l of relatorio.conversao.etapas) {
      expect(l.passaram).toBeLessThanOrEqual(l.entraram);
    }
  });

  it("salto de etapa vira desvio e não passa pela taxa da seguinte", () => {
    const relatorio = montarRelatorioDeFunil({
      janela: JANELA,
      etapas: ETAPAS,
      funis: FUNIS,
      leads: [lead({ id: "l1", stage_id: "C" })],
      atividades: [passagem("l1", "A", "C", "2026-09-12T10:00:00.000Z")],
    });
    const a = linha(relatorio, "A");
    expect(a.entraram).toBe(1);
    expect(a.passaram).toBe(0);
    expect(a.taxa).toBe(0);
    expect(a.desvios).toBe(1);
    // A última etapa não tem seguinte: não há taxa a publicar.
    const c = linha(relatorio, "C");
    expect(c.proxima).toBeNull();
    expect(c.taxa).toBeNull();
  });

  it("só publica funis com vida na janela e ordena etapa por posição", () => {
    const comOutroFunil: EtapaReferencia[] = [
      ...ETAPAS,
      { id: "X", nome: "Outro funil", pipeline_id: "f2", posicao: 1 },
    ];
    const relatorio = montarRelatorioDeFunil({
      janela: JANELA,
      etapas: comOutroFunil,
      funis: [...FUNIS, { id: "f2", nome: "Parcerias", posicao: 2 }],
      leads: [lead({ id: "l1", stage_id: "A" })],
      atividades: [],
    });
    expect(relatorio.conversao.etapas.map((l) => l.etapa.id)).toEqual(["A", "B", "C"]);
    expect(relatorio.conversao.etapas[0]?.funil).toBe("Vendas");
    expect(relatorio.conversao.etapas[0]?.proxima?.id).toBe("B");
    expect(temNaN(relatorio)).toBe(false);
  });
});

describe("dias até fechar (#1750)", () => {
  it("a mediana ignora abertos e perdidos e diz que é mediana", () => {
    const leads = [
      lead({ id: "g1", status: "won", created_at: "2026-09-01T00:00:00.000Z", closed_at: "2026-09-03T00:00:00.000Z" }),
      lead({ id: "g2", status: "won", created_at: "2026-09-01T00:00:00.000Z", closed_at: "2026-09-05T00:00:00.000Z" }),
      // Perdido e aberto, ambos absurdos: nenhum dos dois pode puxar a mediana.
      lead({ id: "p1", status: "lost", created_at: "2026-06-01T00:00:00.000Z", closed_at: "2026-09-10T00:00:00.000Z" }),
      lead({ id: "a1", status: "open", created_at: "2026-06-01T00:00:00.000Z", closed_at: null }),
    ];
    const dias = calcularDiasAteFechar(leads, JANELA, FUNIS);

    expect(dias.medida).toBe("mediana");
    expect(dias.amostra).toBe(2);
    expect(dias.mediana).toBe(3);
    expect(dias.p25).toBe(2.5);
    expect(dias.p75).toBe(3.5);
    expect(dias.por_funil).toEqual([
      { pipeline_id: "f1", funil: "Vendas", mediana: 3, p25: 2.5, p75: 3.5, amostra: 2 },
    ]);
    expect(dias.exclui).toContain("abertos e perdidos");
    expect(temNaN(dias)).toBe(false);
  });

  it("ganhos fora da janela e datas corrompidas não entram (e são contados)", () => {
    const leads = [
      lead({ id: "g1", status: "won", created_at: "2026-09-01T00:00:00.000Z", closed_at: "2026-11-09T00:00:00.000Z" }),
      lead({ id: "g2", status: "won", created_at: "2026-09-10T00:00:00.000Z", closed_at: "2026-09-09T00:00:00.000Z" }),
    ];
    const dias = calcularDiasAteFechar(leads, JANELA, FUNIS);
    expect(dias.amostra).toBe(0);
    expect(dias.ignorados).toBe(1); // o de fora da janela nem conta como ignorado
    expect(dias.mediana).toBeNull();
    expect(temNaN(dias)).toBe(false);
  });

  it("ganho único devolve a própria duração como mediana", () => {
    const dias = calcularDiasAteFechar(
      [
        lead({
          id: "g1",
          status: "won",
          created_at: "2026-09-01T00:00:00.000Z",
          closed_at: "2026-09-08T00:00:00.000Z",
        }),
      ],
      JANELA,
      FUNIS,
    );
    expect(dias.mediana).toBe(7);
    expect(dias.p25).toBe(7);
    expect(dias.p75).toBe(7);
    expect(dias.amostra).toBe(1);
  });
});

describe("ganho × perda por origem (#1750)", () => {
  it("soma valor POR MOEDA e nunca publica total geral", () => {
    const relatorio = montarRelatorioDeFunil({
      janela: JANELA,
      etapas: ETAPAS,
      funis: FUNIS,
      leads: [
        lead({ id: "g1", status: "won", source: "instagram", value_cents: 120_00, currency: "BRL", closed_at: "2026-09-12T00:00:00.000Z" }),
        lead({ id: "g2", status: "won", source: "instagram", value_cents: 90_00, currency: "USD", closed_at: "2026-09-13T00:00:00.000Z" }),
        lead({ id: "g3", status: "won", source: "instagram", value_cents: 40_00, currency: null, closed_at: "2026-09-14T00:00:00.000Z" }),
        lead({ id: "p1", status: "lost", source: "instagram", value_cents: 10_00, currency: "BRL", closed_at: "2026-09-15T00:00:00.000Z" }),
        lead({ id: "p2", status: "lost", source: "indicação", value_cents: 5_00, currency: "BRL", closed_at: "2026-09-16T00:00:00.000Z" }),
      ],
      atividades: [],
    });

    const instagram = relatorio.origem.linhas.filter((l) => l.origem === "instagram");
    expect(instagram.map((l) => l.status)).toEqual(["won", "lost"]);
    expect(instagram[0]?.quantidade).toBe(3);
    expect(instagram[0]?.por_moeda).toEqual([
      { moeda: "BRL", quantidade: 1, valor_cents: 120_00 },
      { moeda: "USD", quantidade: 1, valor_cents: 90_00 },
      { moeda: "sem moeda", quantidade: 1, valor_cents: 40_00 },
    ]);
    // Régua 3: não existe total de valor cruzando moedas.
    expect(Object.keys(relatorio.origem)).not.toContain("valor_total");
    expect(Object.keys(relatorio)).not.toContain("valor_total");
    expect(relatorio.origem.valor_por_moeda).toBe(true);
    expect(temNaN(relatorio)).toBe(false);
  });

  it("a base é criados OU encerrados na janela — fechado antes dela fica de fora", () => {
    const linhas = calcularOrigem(
      [
        lead({ id: "g1", status: "won", source: "site", closed_at: "2026-09-12T00:00:00.000Z" }),
        lead({ id: "g2", status: "won", source: "site", closed_at: "2026-07-12T00:00:00.000Z", created_at: "2026-07-01T00:00:00.000Z" }),
        lead({ id: "a1", status: "open", source: "site", created_at: "2026-09-20T00:00:00.000Z" }),
        lead({ id: "a2", status: "open", source: "site", created_at: "2026-05-01T00:00:00.000Z" }),
      ],
      JANELA,
    );
    expect(
      linhas.map((l) => ({ origem: l.origem, status: l.status, quantidade: l.quantidade })),
    ).toEqual([
      { origem: "site", status: "won", quantidade: 1 },
      { origem: "site", status: "open", quantidade: 1 },
    ]);
  });

  it("origem vazia vira rótulo honesto, não linha some", () => {
    const linhas = calcularOrigem(
      [lead({ id: "g1", status: "won", source: "   ", closed_at: "2026-09-12T00:00:00.000Z" })],
      JANELA,
    );
    expect(linhas.map((l) => l.origem)).toEqual(["sem origem"]);
  });
});

describe("reconstrução das passagens (#1750)", () => {
  it("a etapa de nascimento vem do `de` da primeira passagem, não da etapa atual", () => {
    const conversao = calcularConversao(
      [
        passagem("l1", "A", "B", "2026-09-12T10:00:00.000Z"),
        passagem("l1", "B", "C", "2026-09-20T10:00:00.000Z"),
      ],
      [lead({ id: "l1", stage_id: "C" })],
      ETAPAS,
      JANELA,
    );
    const a = conversao.etapas.find((l) => l.etapa.id === "A");
    const b = conversao.etapas.find((l) => l.etapa.id === "B");
    expect(a?.entraram).toBe(1);
    expect(a?.passaram).toBe(1);
    expect(a?.taxa).toBe(1);
    expect(b?.entraram).toBe(1);
    expect(b?.passaram).toBe(1);
    // Amostra = soma dos denominadores: A, B e C cada uma com 1 entrada.
    expect(conversao.amostra).toBe(3);
  });

  it("ordem das atividades no banco não muda a sequência", () => {
    const conversao = calcularConversao(
      [
        passagem("l1", "B", "C", "2026-09-20T10:00:00.000Z"),
        passagem("l1", "A", "B", "2026-09-12T10:00:00.000Z"),
      ],
      [lead({ id: "l1", stage_id: "C" })],
      ETAPAS,
      JANELA,
    );
    const a = conversao.etapas.find((l) => l.etapa.id === "A");
    expect(a?.passaram).toBe(1);
    const b = conversao.etapas.find((l) => l.etapa.id === "B");
    // B→C só conta se o lead chegou a B DEPOIS de sair de A.
    expect(b?.entraram).toBe(1);
    expect(b?.passaram).toBe(1);
  });
});
