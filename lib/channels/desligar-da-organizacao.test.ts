/**
 * `inventarioDaLapide` — a retomada de uma exclusão interrompida depois do
 * commit lê os canais da lápide (sem credencial) e precisa chegar ao MESMO
 * inventário que a tentativa original montou, menos o que só existia em
 * memória: o token do número oficial.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => null }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn() }));
vi.mock("@/lib/channels/meta/webhook-override", () => ({ desfazerWebhookDoNumero: vi.fn() }));

import { inventarioDaLapide } from "./desligar-da-organizacao";

const linha = (over: Record<string, unknown>) => ({
  id: "c",
  provider: "waha",
  waha_session_name: null,
  meta_phone_number_id: null,
  wacalls_session_id: null,
  archived_at: null,
  ...over,
});

describe("inventarioDaLapide", () => {
  it("sessão por QR mantém o nome da sessão — volta a ser desligável", () => {
    const inv = inventarioDaLapide([linha({ id: "qr", waha_session_name: "s-1" })]);
    expect(inv.canais).toEqual([{ id: "qr", provider: "waha", wahaSessionName: "s-1", meta: null }]);
  });

  it("número oficial: o phone_number_id fica, o token não — vai ao registro como credencial perdida", () => {
    const inv = inventarioDaLapide([linha({ id: "of", provider: "meta_cloud", meta_phone_number_id: "1555" })]);
    expect(inv.canais[0]!.meta).toEqual({
      phoneNumberId: "1555",
      token: null,
      motivo: "credencial_perdida_na_interrupcao",
    });
  });

  it("voz: a sessão da linha de voz não arquivada; a arquivada não conta", () => {
    expect(
      inventarioDaLapide([
        linha({ id: "v-velha", provider: "wacalls", wacalls_session_id: "voz-velha", archived_at: "2026-01-01" }),
        linha({ id: "v", provider: "wacalls", wacalls_session_id: "voz-atual" }),
      ]).sessaoDeVoz,
    ).toBe("voz-atual");
    expect(
      inventarioDaLapide([linha({ provider: "wacalls", wacalls_session_id: "x", archived_at: "2026-01-01" })])
        .sessaoDeVoz,
    ).toBeNull();
  });
});
