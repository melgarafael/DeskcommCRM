/**
 * A taxa histórica de ganho por etapa (issue #1753) — a CONTA que a tela mostra
 * ao gestor, provada sem rota, sem banco e sem tela.
 *
 * O que estes casos prendem:
 *
 * 1. O DENOMINADOR FICA VISÍVEL: o número publicado é `total` (quantos dos
 *    encerrados passaram pela etapa), e `ganhos` vem junto — uma percentagem
 *    sem amostra é chute com cara de medida (doutrina `sistema-vivo`, §medida).
 * 2. SEM DADOS NÃO É 0%: etapa que ninguém atravessou devolve `total: 0` e
 *    `percentual: null`, nunca `0` — 0% afirmaria "já passaram 20 e nenhum
 *    fechou", que é o oposto do silêncio.
 * 3. SUGESTÃO EXIGE AMOSTRA (`MINIMO_DE_CASOS`): 7 casos não viram sugestão.
 * 4. SÓ ENCERRADOS CONTEM: o negócio cuja ÚLTIMA mudança da janela aterrissa
 *    numa etapa comum está aberto e fica de fora.
 * 5. DUAS FORMAS DE TER PASSADO: entrou na etapa (`to_stage_id`) OU nasceu
 *    nela e saiu (`de`), que é o que `nascimento-do-lead` faz — sem a segunda
 *    perna, o negócio criado já em «Proposta» nunca contaria.
 *
 * Os payloads vêm em DUAS grafias, porque os quatro escritores do repositório
 * não concordam entre si: rotas de movimento e `stage-operations` gravam
 * `from_stage_id`/`to_stage_id`, enquanto `agent-stage-sync`,
 * `handoff-stage-move` e `appointment-stage-move` gravam `de`/`para`. Ler só a
 * primeira grafia subcontaria toda mão que não é humana.
 */
import { describe, expect, it } from "vitest";

import {
  MINIMO_DE_CASOS,
  calcularTaxas,
  type AtividadeDaEtapa,
  type EtapaDaTaxa,
} from "@/lib/metrics/taxa-da-etapa";

const AGORA = Date.parse("2026-10-03T12:00:00.000Z");
const DIA = 86400000;
const JANELA = {
  inicio: new Date(AGORA - 365 * DIA).toISOString(),
  fim: new Date(AGORA).toISOString(),
};

/** O funil de teste: duas etapas comuns, uma de ganho e uma de perda. */
const ETAPAS: EtapaDaTaxa[] = [
  { id: "e1", is_won: false, is_lost: false },
  { id: "e2", is_won: false, is_lost: false },
  { id: "e3", is_won: true, is_lost: false },
  { id: "e4", is_won: false, is_lost: true },
];

function atividade(
  leadId: string,
  de: string,
  para: string,
  quando: number,
  payload: Record<string, string> | null = null,
): AtividadeDaEtapa {
  return {
    lead_id: leadId,
    performed_at: new Date(quando).toISOString(),
    payload: (payload ?? { from_stage_id: de, to_stage_id: para }) as AtividadeDaEtapa["payload"],
  };
}

/** Um negócio que passou por `etapa` e terminou em `desfecho`. */
function trajetoria(
  leadId: string,
  etapa: string,
  desfecho: string,
  quando: number,
  payload: Record<string, string> | null = null,
): AtividadeDaEtapa[] {
  return [
    atividade(leadId, "e1", etapa, quando - DIA),
    atividade(leadId, etapa, desfecho, quando, payload),
  ];
}

const nao = (taxas: ReturnType<typeof calcularTaxas>, id: string) =>
  taxas.find((t) => t.etapa_id === id)!;

describe("calcularTaxas — a conta que o gestor lê ao lado do campo", () => {
  it("20 encerrados passaram pela etapa, 8 ganhos → sugestão 40% com «20 negócios» à vista", () => {
    const atividades: AtividadeDaEtapa[] = [];
    for (let i = 0; i < 20; i++) {
      const desfecho = i < 8 ? "e3" : "e4";
      atividades.push(...trajetoria(`l${i}`, "e2", desfecho, AGORA - (10 + i) * DIA));
    }
    const taxa = nao(calcularTaxas(atividades, ETAPAS, JANELA), "e2");
    expect(taxa.total).toBe(20);
    expect(taxa.ganhos).toBe(8);
    expect(taxa.percentual).toBe(40);
    expect(taxa.sugestao).toBe(40);
  });

  it("7 casos não geram sugestão nenhuma — mas a contagem continua visível", () => {
    const atividades: AtividadeDaEtapa[] = [];
    for (let i = 0; i < 7; i++) {
      atividades.push(...trajetoria(`l${i}`, "e2", i < 3 ? "e3" : "e4", AGORA - (10 + i) * DIA));
    }
    const taxa = nao(calcularTaxas(atividades, ETAPAS, JANELA), "e2");
    expect(taxa.total).toBe(7);
    expect(taxa.ganhos).toBe(3);
    // A fração aparece; o CONVITE não. É aqui que «poucos casos» mora.
    expect(taxa.percentual).toBe(43);
    expect(taxa.sugestao).toBeNull();
    expect(MINIMO_DE_CASOS).toBe(10);
  });

  it("etapa sem histórico devolve «sem dados» (total 0, percentual null) — nunca 0%", () => {
    const atividades = trajetoria("l1", "e1", "e3", AGORA - DIA);
    const taxa = nao(calcularTaxas(atividades, ETAPAS, JANELA), "e2");
    expect(taxa.total).toBe(0);
    expect(taxa.ganhos).toBe(0);
    expect(taxa.percentual).toBeNull();
    expect(taxa.sugestao).toBeNull();
  });

  it("mover um negócio para ganho muda a contagem (o critério de aceite da issue)", () => {
    const base = [atividade("l1", "e1", "e2", AGORA - 20 * DIA)];
    const antes = nao(calcularTaxas(base, ETAPAS, JANELA), "e2");
    // Ainda aberto: a última mudança aterrissa numa etapa comum.
    expect(antes.total).toBe(0);

    const depois = nao(
      calcularTaxas([...base, atividade("l1", "e2", "e3", AGORA - DIA)], ETAPAS, JANELA),
      "e2",
    );
    expect(depois.total).toBe(1);
    expect(depois.ganhos).toBe(1);
    expect(depois.percentual).toBe(100);
  });

  it("o negócio aberto fica de fora da conta", () => {
    const atividades = [
      ...trajetoria("l1", "e2", "e3", AGORA - 5 * DIA),
      ...trajetoria("l2", "e2", "e4", AGORA - 5 * DIA),
      ...trajetoria("l3", "e2", "e1", AGORA - 5 * DIA), // voltou para o início
    ];
    const taxa = nao(calcularTaxas(atividades, ETAPAS, JANELA), "e2");
    expect(taxa.total).toBe(2);
    expect(taxa.ganhos).toBe(1);
  });

  it("reaberto depois de ganho não conta como encerrado", () => {
    const atividades = [
      ...trajetoria("l1", "e2", "e3", AGORA - 20 * DIA),
      atividade("l1", "e3", "e1", AGORA - 2 * DIA), // reabertura
    ];
    const taxa = nao(calcularTaxas(atividades, ETAPAS, JANELA), "e2");
    expect(taxa.total).toBe(0);
  });

  it("quem NASCEU na etapa e saiu dela também passou por ela (payload `de`/`para`)", () => {
    // Os escritores de handoff/agendamento/IA gravam `de`/`para`, sem as chaves
    // das rotas de movimento. Ler só `to_stage_id` perderia esta passagem.
    const atividades = [
      atividade("l1", "e2", "e3", AGORA - DIA, {
        motivo_do_handoff: "transferido",
        de: "e2",
        para: "e3",
      }),
    ];
    const taxa = nao(calcularTaxas(atividades, ETAPAS, JANELA), "e2");
    expect(taxa.total).toBe(1);
    expect(taxa.ganhos).toBe(1);
  });

  it("atividade fora da janela não conta — o número carrega o período dele", () => {
    const atividades = trajetoria("l1", "e2", "e3", AGORA - 400 * DIA);
    const taxa = nao(calcularTaxas(atividades, ETAPAS, JANELA), "e2");
    expect(taxa.total).toBe(0);
  });

  it("passagem por OUTRO funil não conta: as etapas de lá não estão na lista", () => {
    const atividades = [
      atividade("l1", "x1", "x2", AGORA - 10 * DIA),
      atividade("l1", "x2", "x3", AGORA - DIA),
    ];
    const taxas = calcularTaxas(atividades, ETAPAS, JANELA);
    expect(taxas.every((t) => t.total === 0)).toBe(true);
  });

  it("payload malformado (sem etapa nenhuma) não derruba a conta", () => {
    const atividades = [
      atividade("l1", "e1", "e2", AGORA - 10 * DIA),
      { lead_id: "l1", performed_at: new Date(AGORA - DIA).toISOString(), payload: null },
      { lead_id: "l2", performed_at: new Date(AGORA - DIA).toISOString(), payload: "lixo" as never },
    ];
    const taxas = calcularTaxas(atividades, ETAPAS, JANELA);
    expect(taxas).toHaveLength(4);
    expect(nao(taxas, "e2").total).toBe(0);
  });
});
