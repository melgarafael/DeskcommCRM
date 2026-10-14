import { describe, expect, it } from "vitest";
import { contemAssuntoComercialRestrito, comercialExigeHumano } from "./assunto-comercial";
import { atendimentoConfigPatchSchema, mesclarSettingsDeAtendimento } from "@/lib/schemas/routing";

describe("valores e negociação somente humanos", () => {
  it.each(["Quanto custa?", "Qual o preço dos óculos?", "Tem desconto?", "Pode parcelar?",
    "Passa o Pix", "Quero um orçamento", "Está grátis?", "A promoção vale?", "R$ 199,90",
    "São 10x", "Consigo 15%?", "Tenho boleto", "Quero pagar", "Preciso de reembolso",
    "Está caro", "Aceptan pago con tarjeta?", "Qual o valor?", "Condição de crédito", "Fica 299", "A partir de 199", "299,90"])
    ("não entrega condição comercial: %s", s => expect(contemAssuntoComercialRestrito(s)).toBe(true));
  it.each(["Rua das Flores, 2054", "Avenida dos Exemplos, 1317", "Sala 01",
    "(11) 4000-0000", "Abre às 8:30?", "Quero o Maps", "Falar com a unidade A", "Bom dia",
    "Tem armações?", "Segunda a sexta", "Gostei do atendimento"])
    ("não confunde rotina/endereço com preço: %s", s => expect(contemAssuntoComercialRestrito(s)).toBe(false));
  it("falha de leitura não vira permissão", async () => {
    await expect(comercialExigeHumano({ query: async () => { throw Error("offline"); } }, "org"))
      .rejects.toThrow("offline");
  });
  it.each([true, false, "true", undefined])("só booleano true liga: %s", async enabled => {
    expect(await comercialExigeHumano({ query: async () => ({ rows: [{ enabled }] }) }, "org"))
      .toBe(enabled === true);
  });
  it("edição por cliente antigo mantém a barreira e a carteira", () => {
    const atual = { routing: { commercial_requires_human: true },
      visibility_mode: "own_and_unassigned", ai: { provider: "existing" } };
    const r = mesclarSettingsDeAtendimento(atual, atendimentoConfigPatchSchema.parse({ mode: "manual" }));
    expect(r.routing.commercial_requires_human).toBe(true);
    expect(r.settings.visibility_mode).toBe("own_and_unassigned");
    expect(r.settings.ai).toEqual(atual.ai);
  });
  it("gestor pode desligar explicitamente, sem apagar as demais configurações", () => {
    const r = mesclarSettingsDeAtendimento({ routing: { commercial_requires_human: true } },
      atendimentoConfigPatchSchema.parse({ commercial_requires_human: false }));
    expect(r.routing.commercial_requires_human).toBe(false);
  });
});
