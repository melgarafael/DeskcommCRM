import { describe, expect, it } from "vitest";
import { etiquetasGoogleAds, CAMPOS_DE_ETIQUETA_GOOGLE_ADS } from "./etiquetas-google-ads";
import { actionSchema } from "@/lib/schemas/webhooks";

const metadata = {
  ad_platform: "google_ads",
  utm_campaign: "Consultas", utm_adset: "Zona sul", utm_ad: "Avaliação",
  utm_term: "consulta perto", utm_content: "Não é anúncio",
  google_campaign_id: "123", google_adgroup_id: "456", google_ad_id: "789",
  google_customer_id: "9876543210", gclid: "clique-que-nao-e-etiqueta",
};
const contexto = (source_metadata: unknown = metadata, source = "google_ads") => ({ lead: { source, source_metadata } });

describe("etiquetas automáticas do Google Ads", () => {
  it("escolhe só dimensões marcadas e diferencia nomes de IDs e dimensões", () => {
    expect(etiquetasGoogleAds(contexto(), CAMPOS_DE_ETIQUETA_GOOGLE_ADS)).toEqual([
      "Google Ads · campanha: Consultas [123]",
      "Google Ads · grupo: Zona sul [456]",
      "Google Ads · anúncio: Avaliação [789]",
      "Google Ads · palavra-chave: consulta perto",
      "Google Ads · conta: 9876543210",
    ]);
    expect(etiquetasGoogleAds(contexto(), ["ad", "ad", "utm_content", "gclid"])).toEqual([
      "Google Ads · anúncio: Avaliação [789]",
    ]);
  });

  it("não faz nada sem opção ou sem origem Google Ads real, mesmo com UTM Google", () => {
    expect(etiquetasGoogleAds(contexto(), undefined)).toEqual([]);
    expect(etiquetasGoogleAds(contexto({ ...metadata, ad_platform: "meta_ads", utm_source: "google" }, "meta_ads"), ["campaign"])).toEqual([]);
    expect(etiquetasGoogleAds(contexto({ utm_source: "google", utm_campaign: "Campanha" }, "website"), ["campaign"])).toEqual([]);
    expect(etiquetasGoogleAds({ contact: { source: "google_ads", source_metadata: metadata } }, ["campaign"])).toEqual([]);
    expect(etiquetasGoogleAds(contexto(null), ["campaign"])).toEqual([]);
  });

  it("lê o carimbo de plataforma com source de formulário e usa ID sem nome", () => {
    expect(etiquetasGoogleAds(contexto({ ad_platform: "google_ads", google_campaign_id: "123" }, "webhook"), ["campaign"])).toEqual(["Google Ads · campanha: 123"]);
    expect(etiquetasGoogleAds(contexto({ google_campaign_id: "123" }), ["campaign"])).toEqual(["Google Ads · campanha: 123"]);
  });

  it("o anúncio usa utm_content como reserva, preservando o ID sem inferi-lo do rótulo", () => {
    expect(etiquetasGoogleAds(contexto({ ad_platform: "google_ads", utm_content: "Oferta local", google_ad_id: "789" }), ["ad"])).toEqual(["Google Ads · anúncio: Oferta local [789]"]);
    expect(etiquetasGoogleAds(contexto({ ad_platform: "google_ads", utm_content: "789" }), ["ad"])).toEqual(["Google Ads · anúncio: 789"]);
    expect(etiquetasGoogleAds(contexto({ ad_platform: "google_ads", utm_ad: "Principal", utm_content: "Reserva" }), ["ad"])).toEqual(["Google Ads · anúncio: Principal"]);
  });

  it("a conta usa o ID de cliente normalizado sem confundir clique com conta", () => {
    expect(etiquetasGoogleAds(contexto({ ad_platform: "google_ads", google_customer_id: "123-456-7890" }), ["account"])).toEqual(["Google Ads · conta: 1234567890"]);
    expect(etiquetasGoogleAds(contexto({ ad_platform: "google_ads", google_customer_id: "123", gclid: "1234567890" }), ["account"])).toEqual([]);
  });

  it("ID distingue campanhas homônimas e sobrevive a nome que não cabe", () => {
    const etiquetas = ["123", "124"].map((google_campaign_id) => etiquetasGoogleAds(contexto({ ...metadata, google_campaign_id }), ["campaign"])[0]);
    expect(new Set(etiquetas).size).toBe(2);
    expect(etiquetasGoogleAds(contexto({ ...metadata, utm_campaign: "c".repeat(100) }), ["campaign"])).toEqual(["Google Ads · campanha: 123"]);
    expect(etiquetasGoogleAds(contexto({ ad_platform: "google_ads", utm_term: "p".repeat(100) }), ["keyword"])).toEqual([]);
    expect(etiquetasGoogleAds(contexto(), CAMPOS_DE_ETIQUETA_GOOGLE_ADS).every((etiqueta) => etiqueta.length <= 60)).toBe(true);
  });

  it.each(["", "   ", null, [], {}, 123, "{campaignid}", "{{lead.title}}", "<b>nome</b>", "https://site.test/campanha", "ftp://site.test/campanha", "mailto:ads@site.test", "nome\nquebrado"])("ignora nome malformado %j sem fabricar etiqueta", (utm_campaign) => {
    expect(etiquetasGoogleAds(contexto({ ad_platform: "google_ads", utm_campaign }), ["campaign"])).toEqual([]);
  });

  it("não trata click IDs nem aliases genéricos como identificadores de campanha", () => {
    expect(etiquetasGoogleAds(contexto({ ad_platform: "google_ads", gclid: "123", campaign_id: "456", campaignid: "789", google_campaign_id: "1e3" }), ["campaign", "account"])).toEqual([]);
  });
});

describe("schema de add_tag com origem Google Ads", () => {
  it("preserva regras literais e a seleção com destino contato", () => {
    const antiga = { type: "add_tag", config: { tags: ["literal {{nao_interpola}}"] } };
    expect(actionSchema.parse(antiga)).toEqual(antiga);
    const automatica = { type: "add_tag", config: { tags: [], destino: "contato", google_ads_fields: ["campaign", "account"] } };
    expect(actionSchema.parse(automatica)).toEqual(automatica);
  });

  it("exige alguma etiqueta e limita escolhas fechadas dentro do teto de dez", () => {
    const valida = (config: unknown) => actionSchema.safeParse({ type: "add_tag", config }).success;
    expect(valida({ tags: [] })).toBe(false);
    expect(valida({ tags: [], google_ads_fields: [] })).toBe(false);
    expect(valida({ tags: [], google_ads_fields: ["lead.title"] })).toBe(false);
    expect(valida({ tags: [], google_ads_fields: ["campaign", "campaign"] })).toBe(false);
    expect(valida({ tags: Array(9).fill("tag"), google_ads_fields: ["campaign"] })).toBe(true);
    expect(valida({ tags: Array(10).fill("tag"), google_ads_fields: ["campaign"] })).toBe(false);
  });
});
