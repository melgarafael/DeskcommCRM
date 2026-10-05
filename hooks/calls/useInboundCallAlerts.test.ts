import { describe, expect, it } from "vitest";

import { deveAvisarChamadaEntrante } from "./useInboundCallAlerts";

/**
 * O alerta não toca para a recusada de bloqueado.
 *
 * SABOTAGEM (prova no CI, sem rodar nada local): tirar a guarda do
 * `end_reason` em `deveAvisarChamadaEntrante` = caso "recusada" vermelho
 * (1 caso cai); os demais seguem verdes.
 */
describe("deveAvisarChamadaEntrante", () => {
  it('recusada de bloqueado: ended + contact_blocked não dispara', () => {
    expect(
      deveAvisarChamadaEntrante({
        provider: "sip",
        direction: "inbound",
        status: "ended",
        end_reason: "contact_blocked",
      }),
    ).toBe(false);
  });

  it("linha ringing normal dispara", () => {
    expect(
      deveAvisarChamadaEntrante({
        provider: "sip",
        direction: "inbound",
        status: "ringing",
        end_reason: null,
      }),
    ).toBe(true);
  });

  it("linha encerrada por outro motivo continua avisando como hoje", () => {
    expect(
      deveAvisarChamadaEntrante({ provider: "sip", direction: "inbound", status: "ended", end_reason: "timeout" }),
    ).toBe(true);
    expect(
      deveAvisarChamadaEntrante({ provider: "sip", direction: "inbound", status: "ended", end_reason: null }),
    ).toBe(true);
  });

  it("WhatsApp (provider wacalls) não duplica o aviso aqui", () => {
    expect(
      deveAvisarChamadaEntrante({ provider: "wacalls", direction: "inbound", status: "ringing" }),
    ).toBe(false);
  });
});
