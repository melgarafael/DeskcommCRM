import { describe, expect, it } from "vitest";

import { classifyRisk } from "@/lib/leads/risk-radar";
import { sinceDoBucket } from "@/lib/leads/risk-since";

/**
 * O observador de risco parava INTEIRO, para a organização toda.
 *
 *   [risk-watcher] org falhou — new row for relation "crm_lead_risk_states"
 *   violates check constraint "crm_lead_risk_states_since_no_passado"
 *
 * A regra do banco é `check (since <= detected_at)`, e `detected_at` é sempre
 * `now()` — carimbo do banco, gatilho da migration 0081, conferido presente e
 * ligado na produção. Então violar exige `since` no FUTURO.
 *
 * E ele nascia no futuro: `classifyRisk` tem dois atalhos da agenda que
 * atribuem balde SEM limiar cruzado (`agenda.adiar` → `em_voo`;
 * `presenca_vencida` → `critico`), enquanto `sinceDoBucket` devolve o instante
 * do CRUZAMENTO daquele balde. Num negócio tocado há pouco, esse instante ainda
 * não chegou.
 *
 * Provado rodando as duas funções, com janela de 72h/168h e um negócio tocado
 * uma hora antes: `em_voo` devolvia `since` três dias à frente; `critico`, sete.
 */
const JANELA = { coldHours: 72, criticalHours: 168 };
const AGORA = new Date("2026-09-12T22:00:00Z");
const TOCADO_HA_UMA_HORA = new Date("2026-09-12T21:00:00Z");

describe("since nunca nasce no futuro", () => {
  it("⛔ adiamento na agenda, negócio ATIVO", () => {
    const r = classifyRisk({
      lastActivityAt: TOCADO_HA_UMA_HORA,
      now: AGORA,
      inFlight: false,
      window: JANELA,
      agenda: { adiar: true },
    } as never);
    expect(r.bucket).toBe("em_voo");
    expect(
      sinceDoBucket(r.bucket, TOCADO_HA_UMA_HORA, JANELA, AGORA).getTime(),
    ).toBeLessThanOrEqual(AGORA.getTime());
  });

  it("⛔ presença vencida, negócio ATIVO", () => {
    const r = classifyRisk({
      lastActivityAt: TOCADO_HA_UMA_HORA,
      now: AGORA,
      inFlight: false,
      window: JANELA,
      agenda: { motivo: "presenca_vencida" },
    } as never);
    expect(r.bucket).toBe("critico");
    expect(
      sinceDoBucket(r.bucket, TOCADO_HA_UMA_HORA, JANELA, AGORA).getTime(),
    ).toBeLessThanOrEqual(AGORA.getTime());
  });

  it("⛔ CONTROLE: negócio realmente frio mantém o instante do CRUZAMENTO", () => {
    // O par que impede o conserto de virar um `since = now` geral, que apagaria
    // justamente a informação que a coluna existe para dar: há quanto tempo este
    // negócio está NESTE estado.
    const frio = new Date("2026-09-01T22:00:00Z");
    const since = sinceDoBucket("critico", frio, JANELA, AGORA);
    expect(since.toISOString()).toBe("2026-09-08T22:00:00.000Z");
    expect(since.getTime()).toBeLessThan(AGORA.getTime());
  });

  it("CONTROLE: `em_dia` continua sendo a última interação", () => {
    expect(sinceDoBucket("em_dia", TOCADO_HA_UMA_HORA, JANELA, AGORA)).toEqual(
      TOCADO_HA_UMA_HORA,
    );
  });
});
