import { describe, expect, it, vi } from "vitest";

import { extrairAtribuicaoMeta } from "@/lib/channels/atribuicao-de-anuncio-oficial";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { extrairAtribuicaoWaha } from "@/lib/waha/atribuicao-de-anuncio";

describe("extrairAtribuicaoMeta — referral do webhook oficial", () => {
  it("extrai um referral de anúncio na forma documentada (snake_case)", () => {
    const r = extrairAtribuicaoMeta({
      source_type: "ad",
      source_id: "120210000000000",
      source_url: "https://fb.me/anuncio123",
      headline: "Agende sua consulta",
      body: "Clique e fale com a gente",
      ctwa_clid: "AfE...clid",
    });
    expect(r).toEqual({
      plataforma: "meta_ads",
      sourceId: "AfE...clid",
      adId: "120210000000000",
      titulo: "Agende sua consulta",
      corpo: "Clique e fale com a gente",
      sourceUrl: "https://fb.me/anuncio123",
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

  it("cai pra source_id quando não há ctwa_clid", () => {
    const r = extrairAtribuicaoMeta({ source_type: "ad", source_id: "abc" });
    expect(r?.sourceId).toBe("abc");
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

describe("extrairAtribuicaoWaha — externalAdReplyInfo do Baileys", () => {
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
      bruto: expect.objectContaining({ ctwaClid: "clid-999" }),
    });
  });

  it("também procura em imageMessage/videoMessage.contextInfo", () => {
    const r = extrairAtribuicaoWaha({
      imageMessage: {
        contextInfo: { externalAdReplyInfo: { sourceId: "ad-1", title: "X" } },
      },
    });
    expect(r?.sourceId).toBe("ad-1");
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
