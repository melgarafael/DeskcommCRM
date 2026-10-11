import { beforeEach, describe, expect, it, vi } from "vitest";

const valores = vi.hoisted(
  () => new Map<string, { valor: string | null; fonte: "banco" | "ambiente" | "ausente" }>(),
);
vi.mock("@/lib/instalacao/config", () => ({
  valorDaInstalacao: async (chave: string) => valores.get(chave) ?? { valor: null, fonte: "ausente" },
}));

import { chaveDoProvedor, provedorDaInstalacao, segredoDoWebhook, toleranciaDias } from "./configuracao";

const doBanco = (valor: string) => ({ valor, fonte: "banco" as const });
const doEnv = (valor: string) => ({ valor, fonte: "ambiente" as const });

beforeEach(() => valores.clear());

describe("tolerância da régua (D-5: padrão 7, de 5 a 30)", () => {
  it.each([
    [undefined, 7],
    [doBanco("10"), 10],
    [doBanco("0"), 5],
    [doBanco("3"), 5],
    [doBanco("45"), 30],
    [doBanco("7.5"), 7],
    [doBanco("sete"), 7],
    [doEnv("12"), 7],
  ] as const)("%j → %i dias", async (linha, dias) => {
    if (linha) valores.set("COBRANCA_TOLERANCIA_DIAS", linha);
    expect(await toleranciaDias()).toBe(dias);
  });
});

describe("provedor e credenciais valem só quando vieram da tela (banco), nunca do .env", () => {
  it("provedor gravado pela Conexão", async () => {
    valores.set("COBRANCA_PROVEDOR", doBanco("stripe"));
    expect(await provedorDaInstalacao()).toBe("stripe");
  });

  it("provedor fora do vocabulário, ou vindo do .env, não vale", async () => {
    valores.set("COBRANCA_PROVEDOR", doBanco("mercadopago"));
    expect(await provedorDaInstalacao()).toBeNull();
    valores.set("COBRANCA_PROVEDOR", doEnv("stripe"));
    expect(await provedorDaInstalacao()).toBeNull();
  });

  it("⭐ uma STRIPE_SECRET_KEY esquecida no .env não vira a chave de cobrança", async () => {
    valores.set("STRIPE_SECRET_KEY", doEnv("rk_test_do_env"));
    valores.set("STRIPE_WEBHOOK_SECRET", doEnv("whsec_do_env"));
    expect(await chaveDoProvedor("stripe")).toBeNull();
    expect(await segredoDoWebhook("stripe")).toBeNull();
  });

  it("controle: as gravadas pela tela valem", async () => {
    valores.set("STRIPE_SECRET_KEY", doBanco("rk_test_da_tela"));
    valores.set("STRIPE_WEBHOOK_SECRET", doBanco("whsec_da_tela"));
    expect(await chaveDoProvedor("stripe")).toBe("rk_test_da_tela");
    expect(await segredoDoWebhook("stripe")).toBe("whsec_da_tela");
  });

  it("⭐ Asaas: a chave e o token gravados pela tela valem; os do .env, não", async () => {
    const chave = "$" + ["aact", "hmlg", "000daTela"].join("_");
    valores.set("ASAAS_API_KEY", doEnv(chave));
    valores.set("ASAAS_WEBHOOK_TOKEN", doEnv("token-do-env"));
    expect(await chaveDoProvedor("asaas")).toBeNull();
    expect(await segredoDoWebhook("asaas")).toBeNull();
    valores.set("ASAAS_API_KEY", doBanco(chave));
    valores.set("ASAAS_WEBHOOK_TOKEN", doBanco("token-da-tela"));
    expect(await chaveDoProvedor("asaas")).toBe(chave);
    expect(await segredoDoWebhook("asaas")).toBe("token-da-tela");
  });
});
