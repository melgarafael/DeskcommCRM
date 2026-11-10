import { describe, expect, it } from "vitest";

import { origemDoContato } from "@/lib/leads/origem-do-contato";

/**
 * A regra que este arquivo guarda é de PRECEDÊNCIA, não de leitura: os dois
 * caminhos de entrada gravam a mesma coisa com nomes diferentes no mesmo jsonb,
 * e uma tela que lesse só um dos dois mostraria metade dos contatos vazia.
 */
describe("os quatro níveis da origem", () => {
  it("lê o caminho do site, que grava UTM crua", () => {
    const r = origemDoContato(
      {
        origem: "site",
        ad_platform: "site",
        utm_source: "instagram",
        utm_campaign: "black-friday",
        utm_adset: "mulheres-25-34",
        utm_ad: "video-depoimento-v3",
        utm_placement: "instagram_stories",
      },
      "whatsapp",
    );
    expect(r.origem).toBe("instagram");
    expect(r.campanha).toBe("black-friday");
    expect(r.conjunto).toBe("mulheres-25-34");
    expect(r.anuncio).toBe("video-depoimento-v3");
    expect(r.posicionamento).toBe("instagram_stories");
    expect(r.semPosicionamentoDeAnuncio).toBe(false);
  });

  it("lê o caminho do anúncio, que grava o nome que a plataforma devolveu", () => {
    const r = origemDoContato(
      {
        ad_platform: "meta_ads",
        campaign_name: "Leads Setembro",
        adset_name: "Lookalike 1%",
        ad_name: "Criativo 07",
      },
      "whatsapp",
    );
    expect(r.origem).toBe("meta_ads");
    expect(r.campanha).toBe("Leads Setembro");
    expect(r.conjunto).toBe("Lookalike 1%");
    expect(r.anuncio).toBe("Criativo 07");
  });

  it("a UTM vence o nome da plataforma no MESMO nível", () => {
    // Quem escreveu o link escolheu o nome; o da plataforma é o que sobra
    // quando ninguém escreveu nada.
    const r = origemDoContato(
      { utm_campaign: "promo-junina", campaign_name: "Campanha 8127364" },
      "whatsapp",
    );
    expect(r.campanha).toBe("promo-junina");
  });

  it("`ad_title` cobre o anúncio enquanto a hierarquia não é resolvida", () => {
    const r = origemDoContato({ ad_platform: "meta_ads", ad_title: "Fale agora" }, "whatsapp");
    expect(r.anuncio).toBe("Fale agora");
  });

  it("valor em branco não conta como valor — a ficha esconderia a linha", () => {
    const r = origemDoContato({ utm_campaign: "promo", utm_adset: "   " }, "whatsapp");
    expect(r.campanha).toBe("promo");
    expect(r.conjunto).toBeNull();
  });

  it("sem metadata nenhum, a origem cai na coluna do contato", () => {
    expect(origemDoContato(null, "whatsapp").origem).toBe("whatsapp");
    expect(origemDoContato(undefined, "importacao").campanha).toBeNull();
    expect(origemDoContato({}, "webhook").origem).toBe("webhook");
  });

  it("valor que não é texto no jsonb é ignorado, não estampado", () => {
    const r = origemDoContato({ utm_campaign: 42, utm_adset: null, utm_ad: true }, "whatsapp");
    expect(r.campanha).toBeNull();
    expect(r.conjunto).toBeNull();
    expect(r.anuncio).toBeNull();
  });
});

describe("o posicionamento que não existe no clique-para-WhatsApp", () => {
  it("contato de anúncio sem posicionamento: a ficha precisa explicar", () => {
    const r = origemDoContato({ ad_platform: "meta_ads", ad_title: "Fale agora" }, "whatsapp");
    expect(r.semPosicionamentoDeAnuncio).toBe(true);
  });

  it("origem de SITE sem posicionamento não é o mesmo caso", () => {
    // Ali o dado existe na origem — quem montou o link é que não usou a macro.
    // Dizer "a plataforma não fornece" seria mentira, e mandaria o operador
    // parar de procurar onde ele deveria procurar.
    const r = origemDoContato({ ad_platform: "site", utm_campaign: "promo" }, "whatsapp");
    expect(r.semPosicionamentoDeAnuncio).toBe(false);
  });

  it("contato que não veio de anúncio nenhum não ganha explicação", () => {
    expect(origemDoContato({}, "whatsapp").semPosicionamentoDeAnuncio).toBe(false);
  });

  it("anúncio COM posicionamento pela URL não ganha explicação", () => {
    const r = origemDoContato(
      { ad_platform: "meta_ads", utm_placement: "facebook_feed" },
      "whatsapp",
    );
    expect(r.semPosicionamentoDeAnuncio).toBe(false);
  });
});

describe("a origem deduzida pelo horário do clique", () => {
  it("a marca da inferência chega à ficha", () => {
    const r = origemDoContato(
      { ad_platform: "site", utm_source: "site", origem_inferida_por: "horario" },
      "site",
    );
    expect(r.inferidaPorHorario).toBe(true);
  });

  it("a origem que veio no código não é dedução", () => {
    expect(origemDoContato({ ad_platform: "site", utm_source: "site" }, "site").inferidaPorHorario).toBe(false);
  });
});
