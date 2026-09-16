import { describe, expect, it } from "vitest";

import { detectarModoComercialAdvomax, validarModoComercialAdvomax } from "@/lib/env";

const comercial = {
  ADVOMAX_DEPLOYMENT_MODE: true,
  NEXT_PUBLIC_APP_URL: "https://crm.advomax.com.br",
  ADVOMAX_API_URL: "https://api.advomax.com.br",
  ADVOMAX_CRM_INTEGRATION_KEY: "test-key",
} as const;

describe("modo comercial Advomax", () => {
  it("detecta o domínio canônico mesmo sem depender da flag manual", () => {
    expect(detectarModoComercialAdvomax(false, "https://crm.advomax.com.br")).toBe(true);
    expect(detectarModoComercialAdvomax(false, "https://crm.exemplo.com")).toBe(false);
    expect(detectarModoComercialAdvomax(true, "https://crm.exemplo.com")).toBe(true);
  });
  it("aceita somente o domínio e as credenciais comerciais completas", () => {
    expect(() => validarModoComercialAdvomax(comercial)).not.toThrow();
    expect(() =>
      validarModoComercialAdvomax({ ...comercial, ADVOMAX_CRM_INTEGRATION_KEY: "" }),
    ).toThrow(/INTEGRATION_KEY/);
    expect(() =>
      validarModoComercialAdvomax({ ...comercial, NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com" }),
    ).toThrow(/crm\.advomax\.com\.br/);
  });

  it("mantém instalações standalone fora da exigência comercial", () => {
    expect(() =>
      validarModoComercialAdvomax({
        ...comercial,
        ADVOMAX_DEPLOYMENT_MODE: false,
        ADVOMAX_API_URL: "",
        ADVOMAX_CRM_INTEGRATION_KEY: "",
      }),
    ).not.toThrow();
  });
});
