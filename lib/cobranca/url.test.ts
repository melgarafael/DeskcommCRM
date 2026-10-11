import { describe, expect, it } from "vitest";

import { destinoDaVolta, urlDoHub, urlDoPainelDaEmpresa, urlDoWebhookDaCobranca } from "./url";

describe("urlDoWebhookDaCobranca — o provedor só entrega aviso em https público", () => {
  it.each([
    ["https público", "https://crm.cliente.com.br", false, "https://crm.cliente.com.br/api/v1/webhooks/cobranca/stripe"],
    ["a barra final sai", "https://crm.cliente.com.br/", false, "https://crm.cliente.com.br/api/v1/webhooks/cobranca/stripe"],
    ["http público: recusado", "http://crm.cliente.com.br", false, null],
    ["placeholder do build: recusado", "https://placeholder.invalid", false, null],
    ["localhost sem o dublê de teste: recusado", "http://localhost:3001", false, null],
    ["⭐ localhost com o dublê de teste ligado: aceito", "http://localhost:3001", true, "http://localhost:3001/api/v1/webhooks/cobranca/stripe"],
    ["vazio", "", true, null],
  ] as const)("%s", (_caso, base, aceitaLoopback, esperado) => {
    expect(urlDoWebhookDaCobranca(base, "stripe", aceitaLoopback)).toBe(esperado);
  });
});

describe("a volta do provedor passa pela ponte (cookie de sessão Strict)", () => {
  it("checkout e portal voltam por /cobranca/volta, nunca direto na tela protegida", () => {
    expect(urlDoPainelDaEmpresa()).toMatch(/\/cobranca\/volta\?para=painel$/);
    expect(urlDoHub()).toMatch(/\/cobranca\/volta\?para=hub$/);
  });

  it.each([
    ["para=painel", "/app/settings/billing"],
    ["para=painel&voltou=1", "/app/settings/billing?voltou=1"],
    ["para=hub", "/account-suspended"],
    ["para=hub&voltou=1", "/account-suspended?voltou=1"],
    ["", "/app/settings/billing"],
  ])("%s → %s", (query, destino) => {
    expect(destinoDaVolta(new URLSearchParams(query))).toBe(destino);
  });

  it("nada da query é refletido: destino fora da lista cai no painel", () => {
    for (const q of ["para=https://evil.example.com", "para=//evil.example.com", "para=/admin", "voltou=javascript:alert(1)&para=HUB"]) {
      expect(["/app/settings/billing", "/app/settings/billing?voltou=1"]).toContain(destinoDaVolta(new URLSearchParams(q)));
    }
  });
});
