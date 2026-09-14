import { describe, expect, it } from "vitest";

import { sinceDoBucket } from "@/lib/leads/risk-since";

/**
 * `since` responde "há quanto tempo está NESTE ESTADO", não "há quanto tempo
 * está em silêncio". A diferença decide se a coluna serve para triar.
 */
const T0 = new Date("2026-07-01T00:00:00Z");
const JANELA = { coldHours: 24, criticalHours: 72 };
const horasApos = (d: Date): number => (d.getTime() - T0.getTime()) / 3_600_000;
// O relógio da passada, bem DEPOIS de todos os cruzamentos deste arquivo.
// `sinceDoBucket` ganhou um teto — nunca devolve instante futuro —, e estes
// casos medem o instante do CRUZAMENTO, que é o caminho em que o teto não
// deve tocar. Um `now` próximo os faria medir o teto em vez da regra.
const DEPOIS = new Date("2027-07-01T00:00:00Z");

describe("sinceDoBucket", () => {
  it("em_risco: conta do CRUZAMENTO do limiar, não do último contato", () => {
    // O caso que motivou o refino: 100h de silêncio numa janela de 24h significa
    // "em risco há 76h", não "há 100h". Quem tria quer a segunda grandeza.
    expect(horasApos(sinceDoBucket("em_risco", T0, JANELA, DEPOIS))).toBe(24);
  });

  it("critico: conta do limiar CRÍTICO, não do frio", () => {
    // Senão um negócio recém-crítico apareceria como crítico há dias, e a fila
    // de triagem ordenaria errado exatamente onde a ordem importa mais.
    expect(horasApos(sinceDoBucket("critico", T0, JANELA, DEPOIS))).toBe(72);
  });

  it("em_voo cruzou o limiar de frio como qualquer outro", () => {
    // `em_voo` não é um estágio anterior a `em_risco`: é o MESMO frio com
    // follow-up agendado. O que muda é haver promessa, não o instante.
    expect(sinceDoBucket("em_voo", T0, JANELA, DEPOIS)).toEqual(sinceDoBucket("em_risco", T0, JANELA, DEPOIS));
  });

  it("em_dia não cruzou nada: o estado começou na última interação", () => {
    expect(sinceDoBucket("em_dia", T0, JANELA, DEPOIS)).toEqual(T0);
  });

  it("janela do estágio manda — o mesmo silêncio dá `since` diferente", () => {
    // "Sem resposta há 2 dias" é normal numa negociação de contrato e é abandono
    // num agendamento de consulta. Se `since` ignorasse a janela, os dois
    // negócios apareceriam com a mesma idade de estado.
    const clinica = sinceDoBucket("em_risco", T0, { coldHours: 4, criticalHours: 12 }, DEPOIS);
    const contrato = sinceDoBucket("em_risco", T0, { coldHours: 168, criticalHours: 504 }, DEPOIS);
    expect(horasApos(clinica)).toBe(4);
    expect(horasApos(contrato)).toBe(168);
  });

  it("nunca no futuro em relação ao próprio cruzamento: o CHECK do banco cobra isso", () => {
    // `crm_lead_risk_states_since_no_passado` exige `since <= detected_at`. Um
    // negócio detectado no instante exato do cruzamento é o caso de borda.
    const cruzou = sinceDoBucket("em_risco", T0, JANELA, DEPOIS);
    const detectadoNoMesmoInstante = new Date(T0.getTime() + 24 * 3_600_000);
    expect(cruzou.getTime()).toBeLessThanOrEqual(detectadoNoMesmoInstante.getTime());
  });
});
