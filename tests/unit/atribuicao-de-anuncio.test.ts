import { describe, expect, it, vi } from "vitest";

import { extrairAtribuicaoMeta } from "@/lib/channels/atribuicao-de-anuncio-oficial";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { extrairAtribuicaoWaha } from "@/lib/waha/atribuicao-de-anuncio";
import { extrairAtribuicaoDoInbound, mapInboundPayload } from "@/lib/webhooks/inbound";

describe("extrairAtribuicaoMeta — referral do webhook oficial", () => {
  it("extrai um referral de anúncio na forma documentada (snake_case)", () => {
    const r = extrairAtribuicaoMeta({
      source_type: "ad",
      source_id: "120210000000000",
      source_url: "https://fb.me/anuncio123",
      headline: "Agende sua consulta",
      body: "Clique e fale com a gente",
      thumbnail_url: "https://scontent.example.fbcdn.net/anuncio.jpg",
      ctwa_clid: "AfE...clid",
    });
    expect(r).toEqual({
      plataforma: "meta_ads",
      sourceId: "AfE...clid",
      adId: "120210000000000",
      titulo: "Agende sua consulta",
      corpo: "Clique e fale com a gente",
      sourceUrl: "https://fb.me/anuncio123",
      miniatura: "https://scontent.example.fbcdn.net/anuncio.jpg",
      bruto: expect.objectContaining({ source_type: "ad" }),
    });
  });

  it("aceita camelCase (caso o agregador normalize)", () => {
    const r = extrairAtribuicaoMeta({
      sourceType: "ad",
      ctwaClid: "clid-123",
      sourceUrl: "https://fb.me/x",
    });
    expect(r?.sourceId).toBe("clid-123");
    expect(r?.sourceUrl).toBe("https://fb.me/x");
    // Sem `sourceId` no payload não há anúncio a guardar — e `null` aqui é
    // diferente de repetir o clique, que diria "o anúncio é este clique".
    expect(r?.adId).toBeNull();
  });

  it("deixa sourceId nulo quando não há ctwa_clid, preservando adId", () => {
    const r = extrairAtribuicaoMeta({ source_type: "ad", source_id: "abc" });
    expect(r?.sourceId).toBeNull();
    expect(r?.adId).toBe("abc");
  });

  it("o payload com clique E anúncio guarda OS DOIS", () => {
    // O caso comum, e o que se perdia: enquanto o id do anúncio era só o degrau
    // de baixo do `??` do clique, ele sobrevivia apenas dentro de `bruto` — e
    // ninguém consulta o payload cru para responder de qual anúncio o contato
    // veio.
    const r = extrairAtribuicaoMeta({
      source_type: "ad",
      source_id: "120210000000000",
      ctwa_clid: "AfE...clid",
    });
    expect(r?.sourceId).toBe("AfE...clid");
    expect(r?.adId).toBe("120210000000000");
  });

  it("rejeita source_type 'post' — orgânico, não anúncio pago", () => {
    expect(extrairAtribuicaoMeta({ source_type: "post", source_id: "abc" })).toBeNull();
  });

  it("nulo quando não há nenhum campo que identifique o anúncio", () => {
    expect(extrairAtribuicaoMeta({ body: "só um corpo, sem id nem título nem url" })).toBeNull();
  });

  it("nulo pra payload ausente/vazio/tipo errado", () => {
    expect(extrairAtribuicaoMeta(null)).toBeNull();
    expect(extrairAtribuicaoMeta(undefined)).toBeNull();
    expect(extrairAtribuicaoMeta("string crua")).toBeNull();
    expect(extrairAtribuicaoMeta([])).toBeNull();
  });
});

describe("extrairAtribuicaoWaha — externalAdReply do WAHA e forma legada", () => {
  it("extrai externalAdReply na forma recebida pelo WAHA NOWEB", () => {
    const r = extrairAtribuicaoWaha({
      extendedTextMessage: {
        text: "Quero saber mais",
        contextInfo: {
          ctwaPayload: "dados-do-clique",
          externalAdReply: {
            sourceType: "ad",
            sourceId: "ad-exemplo",
            ctwaClid: "clid-exemplo",
            title: "Serviço de exemplo",
            body: "Saiba mais",
            sourceUrl: "https://fb.me/anuncio",
            thumbnailUrl: "https://scontent.example.fbcdn.net/servico.jpg",
          },
        },
      },
      messageContextInfo: { deviceListMetadataVersion: 2 },
    });
    expect(r).toEqual({
      plataforma: "meta_ads",
      sourceId: "clid-exemplo",
      adId: "ad-exemplo",
      titulo: "Serviço de exemplo",
      corpo: "Saiba mais",
      sourceUrl: "https://fb.me/anuncio",
      miniatura: "https://scontent.example.fbcdn.net/servico.jpg",
      bruto: expect.objectContaining({ sourceType: "ad" }),
    });
  });

  it("extrai de extendedTextMessage.contextInfo.externalAdReplyInfo", () => {
    const r = extrairAtribuicaoWaha({
      extendedTextMessage: {
        text: "Olá, vim do anúncio",
        contextInfo: {
          externalAdReplyInfo: {
            title: "Agende sua consulta",
            body: "Clique e fale com a gente",
            sourceId: "ad-999",
            sourceUrl: "https://fb.me/anuncio123",
            ctwaClid: "clid-999",
          },
        },
      },
    });
    expect(r).toEqual({
      plataforma: "meta_ads",
      sourceId: "clid-999",
      adId: "ad-999",
      titulo: "Agende sua consulta",
      corpo: "Clique e fale com a gente",
      sourceUrl: "https://fb.me/anuncio123",
      miniatura: null,
      bruto: expect.objectContaining({ ctwaClid: "clid-999" }),
    });
  });

  it("também procura em imageMessage/videoMessage.contextInfo", () => {
    const r = extrairAtribuicaoWaha({
      imageMessage: {
        contextInfo: { externalAdReplyInfo: { sourceId: "ad-1", title: "X" } },
      },
    });
    expect(r?.sourceId).toBeNull();
    expect(r?.adId).toBe("ad-1");
  });

  it("nulo quando é uma mensagem comum, sem contextInfo de anúncio", () => {
    expect(extrairAtribuicaoWaha({ conversation: "oi, tudo bem?" })).toBeNull();
    expect(
      extrairAtribuicaoWaha({ extendedTextMessage: { text: "oi", contextInfo: {} } }),
    ).toBeNull();
  });

  it("post ORGÂNICO compartilhado não é anúncio — o mesmo filtro do irmão oficial", () => {
    // Sem este filtro, o primeiro compartilhamento de um post carimba
    // `meta_ads` no contato — e a guarda de primeiro toque torna isso
    // irreversível pelo caminho normal. O extrator da API oficial já filtrava
    // por `source_type`; este não, e a assimetria não tinha razão escrita.
    expect(
      extrairAtribuicaoWaha({
        extendedTextMessage: {
          text: "oi",
          contextInfo: {
            externalAdReplyInfo: { sourceType: "post", title: "Promo", ctwaClid: "x" },
          },
        },
      }),
    ).toBeNull();

    expect(
      extrairAtribuicaoWaha({
        extendedTextMessage: {
          contextInfo: {
            externalAdReply: { sourceType: "post", title: "Publicação", ctwaClid: "x" },
          },
        },
      }),
    ).toBeNull();

    expect(
      extrairAtribuicaoWaha({
        extendedTextMessage: {
          text: "oi",
          contextInfo: {
            externalAdReplyInfo: { sourceType: "ad", title: "Promo", ctwaClid: "x" },
          },
        },
      }),
    ).toMatchObject({ plataforma: "meta_ads", sourceId: "x", titulo: "Promo" });
  });

  it("nulo pra payload ausente/tipo errado", () => {
    expect(extrairAtribuicaoWaha(null)).toBeNull();
    expect(extrairAtribuicaoWaha(undefined)).toBeNull();
    expect(extrairAtribuicaoWaha("string crua")).toBeNull();
  });
});

describe("estamparAtribuicaoDoContato", () => {
  it("chama a RPC com plataforma e metadata montados a partir da atribuição", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const admin = { rpc } as never;

    await estamparAtribuicaoDoContato(admin, "org-1", "contact-1", {
      plataforma: "meta_ads",
      sourceId: "clid-1",
      adId: "120210000000000",
      titulo: "Título",
      corpo: "Corpo",
      sourceUrl: "https://fb.me/x",
      bruto: { fonte: "teste" },
    });

    expect(rpc).toHaveBeenCalledWith(
      "fn_estampar_atribuicao_de_anuncio",
      expect.objectContaining({
        p_org: "org-1",
        p_contact: "contact-1",
        p_platform: "meta_ads",
        p_metadata: expect.objectContaining({
          ad_platform: "meta_ads",
          ad_source_id: "clid-1",
          ad_id: "120210000000000",
          ad_title: "Título",
          ad_body: "Corpo",
          ad_source_url: "https://fb.me/x",
          ad_raw: { fonte: "teste" },
        }),
      }),
    );
  });

  it("não lança quando a RPC falha — só registra o erro", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: "boom" } });
    const admin = { rpc } as never;

    await expect(
      estamparAtribuicaoDoContato(admin, "org-1", "contact-1", {
        plataforma: "meta_ads",
        sourceId: null,
        adId: null,
        titulo: null,
        corpo: null,
        sourceUrl: null,
        bruto: {},
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * Issue #2317 — quem anuncia para LANDING PAGE COM FORMULÁRIO não tinha a
 * origem do anúncio estampada no contato. O envio do formulário manda `fbclid`,
 * `fbc`, `fbp`, `gclid`, `ad_id`, `adset_id` e `campaign_id`, e até aqui tudo
 * isso caía em `custom_fields`: o card do lead mostrava esses valores como se a
 * pessoa os tivesse preenchido, e a atribuição — que o clique-pro-WhatsApp já
 * estampa — nem existia. `lib/conversoes`, que lê a atribuição do contato, não
 * sabia de que clique veio uma venda de formulário.
 *
 * Aqui se prova a corrente INTEIRA, com o payload cru de um formulário: as
 * chaves viram reservadas (não campo do card) → a atribuição é extraída → ela é
 * gravada pela MESMA função de primeiro toque (`fn_estampar_atribuicao_de_anuncio`)
 * que o referral do clique-pro-WhatsApp usa. É o arquivo que o brief pediu.
 */
describe("atribuição de anúncio do webhook de entrada (formulário)", () => {
  const FORMULARIO = {
    name: "Ana",
    phone: "11998765432",
    email: "ana@example.com",
    mensagem: "quero um orçamento",
    fbclid: "IwAR-fbclid-do-clique",
    fbc: "fb.1.1770000000000.IwAR-fbclid-do-clique",
    fbp: "fb.1.1770000000000.987654321",
    gclid: "Cj0KCQjw-gclid-do-clique",
    ad_id: "120210000000000",
    adset_id: "120210000000111",
    campaign_id: "120210000000222",
  };

  it("as chaves de anúncio são RESERVADAS: vão para source_metadata, não para o card", () => {
    const m = mapInboundPayload(FORMULARIO);
    // `mensagem` é resposta da pessoa e continua campo do card. As sete chaves de
    // anúncio NÃO estão aqui — é o defeito que a #2317 conserta.
    expect(m.custom_fields).toEqual({ mensagem: "quero um orçamento" });
    expect(m.source_metadata).toEqual({
      fbclid: "IwAR-fbclid-do-clique",
      fbc: "fb.1.1770000000000.IwAR-fbclid-do-clique",
      fbp: "fb.1.1770000000000.987654321",
      gclid: "Cj0KCQjw-gclid-do-clique",
      ad_id: "120210000000000",
      adset_id: "120210000000111",
      campaign_id: "120210000000222",
    });
  });

  it("o payload do formulário grava a atribuição no contato pela regra de primeiro toque", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const admin = { rpc } as never;

    const atribuicao = extrairAtribuicaoDoInbound(FORMULARIO);
    expect(atribuicao).not.toBeNull();
    // A MESMA função do clique-pro-WhatsApp: a regra de primeiro toque mora no
    // banco, não numa segunda cópia em JS.
    await estamparAtribuicaoDoContato(admin, "org-1", "contact-1", atribuicao!);

    expect(rpc).toHaveBeenCalledWith(
      "fn_estampar_atribuicao_de_anuncio",
      expect.objectContaining({
        p_org: "org-1",
        p_contact: "contact-1",
        p_platform: "meta_ads",
        p_metadata: expect.objectContaining({
          ad_platform: "meta_ads",
          // A marca de que a captura foi na PÁGINA: é ela que faz a leitura
          // entregar o lead pelo ramo SEM clique (e o transporte trocar a
          // identidade do evento). Sem ela, o `fbclid` sairia como `ctwa_clid`.
          ad_click_source: "site",
          // O clique da Meta (fbclid) tem precedência sobre o gclid quando o
          // formulário traz os dois — ordem declarada no extrator.
          ad_source_id: "IwAR-fbclid-do-clique",
          ad_id: "120210000000000",
          // As chaves todas sobrevivem no payload cru: o Google, os dois níveis
          // abaixo da campanha e o id do navegador. Perder qualquer uma aqui é
          // perder a prova de onde o dado saiu.
          ad_raw: expect.objectContaining({
            fbclid: "IwAR-fbclid-do-clique",
            fbc: "fb.1.1770000000000.IwAR-fbclid-do-clique",
            fbp: "fb.1.1770000000000.987654321",
            gclid: "Cj0KCQjw-gclid-do-clique",
            ad_id: "120210000000000",
            adset_id: "120210000000111",
            campaign_id: "120210000000222",
          }),
        }),
      }),
    );
  });

  it("o clique IDENTIFICA a plataforma: só gclid (Google) grava google_ads", () => {
    const r = extrairAtribuicaoDoInbound({
      gclid: "Cj0KCQjw-gclid",
      ad_id: "ads-google",
      campaign_id: "camp-google",
    });
    expect(r).toMatchObject({
      plataforma: "google_ads",
      sourceId: "Cj0KCQjw-gclid",
      adId: "ads-google",
      bruto: expect.objectContaining({ campaign_id: "camp-google" }),
    });
  });

  it("sem um clique não há atribuição — ad_id sozinho não diz de qual rede", () => {
    expect(extrairAtribuicaoDoInbound({ ad_id: "x", campaign_id: "y" })).toBeNull();
    expect(extrairAtribuicaoDoInbound({ mensagem: "oi" })).toBeNull();
    expect(extrairAtribuicaoDoInbound({ fbclid: "   " })).toBeNull();
  });
});
