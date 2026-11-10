import { describe, expect, it } from "vitest";

import { avisosDoBanco, carimboDaTransacao, type EventoDeNegocio } from "./aviso-de-negocio";

const ATUAL = "2026-10-25T15:00:01.123456Z";
const evento = (created_at: string): EventoDeNegocio => ({
  organization_id: "org-a", entity_id: "lead-a", event_type: "lead.assigned",
  to_user_id: "pessoa-a", created_at,
});
function avisar(created_at: string) {
  return avisosDoBanco({
    organizationId: "org-a", leadId: "lead-a", carimboDoUpdate: carimboDaTransacao(ATUAL)!,
    novo: { owner_user_id: "pessoa-a", status: "open" }, userId: "pessoa-a", eventos: [evento(created_at)],
  });
}

describe("o evento precisa ser da mesma transação, sem janela de aproximação", () => {
  it.each([
    "2026-10-25T15:00:00.123456Z", // 1 segundo antes: reprodução do parecer.
    "2026-10-25T15:00:01.122456Z", // 1 ms antes.
    "2026-10-25T15:00:01.124456Z", // 1 ms depois.
    "2026-10-25T14:59:59.623456Z", // exatos 1500 ms antes.
    "2026-10-25T15:00:02.623456Z", // exatos 1500 ms depois.
    "2026-10-25T15:00:01.123455Z", // 1 µs antes: Date.parse perde essa diferença.
    "2026-10-25T15:00:01.123457Z", // 1 µs depois.
  ])("não anuncia uma atribuição vizinha: %s", (instante) => {
    expect(avisar(instante)).toEqual([]);
  });

  it.each([ATUAL, "2026-10-25T12:00:01.123456-03:00", "2026-10-25T15:00:01.123456+00:00"])(
    "controle: o mesmo instante anuncia a atribuição: %s", (instante) => {
      expect(avisar(instante)).toEqual(["lead_assigned"]);
    },
  );

  it("zeros de precisão e offsets diferentes representam o mesmo instante", () => {
    expect(carimboDaTransacao("2026-10-25T15:00:01.123000Z"))
      .toBe(carimboDaTransacao("2026-10-25T12:00:01.123-03:00"));
    expect(carimboDaTransacao("2026-10-25T15:00:01Z"))
      .toBe(carimboDaTransacao("2026-10-25 15:00:01.000000+00"));
  });

  it.each([undefined, null, "ontem", "2026-10-25T15:00:01", "2026-10-25T15:00:01.1234567Z"])(
    "sem instante inequívoco o casamento é recusado: %s", (valor) => {
      expect(carimboDaTransacao(valor)).toBeNull();
    },
  );
});
