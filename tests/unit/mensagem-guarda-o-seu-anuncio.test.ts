/**
 * A mensagem nascida de um clique em anúncio guarda o SEU anúncio.
 *
 * ─── Por quê ─────────────────────────────────────────────────────────────────
 *
 * A atribuição do contato é PRIMEIRO TOQUE — gravada uma vez, nunca reescrita.
 * Numa loja com dois produtos, cada um com o seu anúncio "Clique para o
 * WhatsApp" e o mesmo texto pré-preenchido genérico, a pessoa que chegou pelo
 * anúncio A e dias depois clicou no B não deixava rastro do B em lugar nenhum:
 * a mensagem não guardava de qual anúncio nasceu. É esse rastro que a inbox
 * mostra na bolha e no painel ao lado (ver `anuncio-visivel-na-inbox.test.tsx`).
 *
 * ─── O que se prova aqui ─────────────────────────────────────────────────────
 *
 * A INGESTÃO grava o anúncio na própria mensagem (`metadata.anuncio`), nos três
 * transportes que sabem ler o clique — sem mexer no primeiro toque do contato,
 * e sem copiar o clique (`ctwa_clid`) nem o payload cru para cada mensagem.
 * A única exceção é a âncora reservada `meta_ctwa_message_v1` (#3128): só a
 * mensagem que TROUXE o clique a leva, só a ingestão (service role) escreve,
 * e o gatilho do banco recusa quem mais tentar. É ela que liga o LeadSubmitted
 * à mensagem que o provou.
 *
 * O que NÃO se prova aqui: o INSERT contra um Postgres real — o banco aqui é
 * de mentira.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
// Os efeitos pós-entrada (opt-out, lead, despacho do agente) não são o assunto
// e cada um tem teste próprio; aqui só importa o que a MENSAGEM grava.
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn() }));

import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import type { InboundMessageEvent } from "@/lib/channels/meta/webhook";
import { ingestZernioInbound } from "@/lib/channels/zernio/ingest";
import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

// ─── O anúncio do segundo produto da loja ───────────────────────────────────

const ANUNCIO_B = {
  source_id: "120200000000000002",
  source_type: "ad",
  source_url: "https://fb.me/protetor-solar",
  headline: "Protetor solar para carro",
  body: "Proteja o painel do sol. Frete grátis.",
  thumbnail_url: "https://scontent.example.fbcdn.net/protetor-solar.jpg",
  media_type: "image",
  ctwa_clid: "ARAk_clique_B",
};

const TEXTO_GENERICO = "Qual é o preço e vocês entregam?";

// ─── A ingestão grava o anúncio na mensagem ────────────────────────────────

/**
 * Admin de mentira TOLERANTE: toda cadeia do PostgREST resolve vazia, as duas
 * RPCs de resolução devolvem id, e o INSERT de `messages` é registrado — é a
 * única escrita que este bloco mede.
 */
function adminTolerante() {
  const insertsDeMensagem: Array<Record<string, unknown>> = [];
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const cadeia = (op: string): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get(_alvo, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
        }
        if (prop === "maybeSingle" || prop === "single") {
          return async () => ({ data: op === "insert" ? { id: "mensagem-1" } : null, error: null });
        }
        return () => proxy;
      },
    });
    return proxy;
  };

  const admin = {
    from: (tabela: string) => ({
      select: () => cadeia("select"),
      insert: (linha: Record<string, unknown>) => {
        if (tabela === "messages") insertsDeMensagem.push(linha);
        return cadeia("insert");
      },
      update: () => cadeia("update"),
      upsert: () => cadeia("upsert"),
      delete: () => cadeia("delete"),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };
  return { admin, insertsDeMensagem, rpcs };
}

const metadataGravada = (inserts: Array<Record<string, unknown>>) =>
  (inserts[0]?.metadata ?? null) as Record<string, unknown> | null;

const ANUNCIO_B_NA_MENSAGEM = {
  titulo: "Protetor solar para carro",
  texto: "Proteja o painel do sol. Frete grátis.",
  ad_id: "120200000000000002",
  // O link e a imagem, para a inbox MOSTRAR o anúncio na conversa.
  url: "https://fb.me/protetor-solar",
  miniatura: "https://scontent.example.fbcdn.net/protetor-solar.jpg",
};

describe("ingestão — a mensagem nascida de um clique guarda o SEU anúncio", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("canal intermediado (o número oficial da loja)", () => {
    // A forma medida no provider real (24/09/2026): o `referral` mora em
    // `metadata` no nível do EVENTO, não na mensagem.
    const evento = (referral: unknown, extra: Record<string, unknown> = {}) => ({
      id: "evt_1",
      event: "message.received",
      account: { id: "acc_1" },
      ...(referral ? { metadata: { referral } } : {}),
      message: {
        id: "m_1",
        conversationId: "thread-1",
        platform: "whatsapp",
        platformMessageId: "wamid.CLIQUE_B",
        direction: "incoming",
        text: TEXTO_GENERICO,
        attachments: [],
        sender: { phoneNumber: "+5511999990000", name: "Cliente de Teste" },
        sentAt: "2026-09-29T15:00:00.000Z",
        ...extra,
      },
    });
    const ENTRADA = { organizationId: "org-1", channelSessionId: "sessao-1" };

    it("clique em anúncio: `metadata.anuncio` com título, texto e id — sem o clique nem o cru", async () => {
      const { admin, insertsDeMensagem } = adminTolerante();
      const r = await ingestZernioInbound(admin as never, { ...ENTRADA, payload: evento(ANUNCIO_B) });

      expect(r.status).toBe("ingested");
      const metadata = metadataGravada(insertsDeMensagem);
      expect(metadata?.anuncio).toEqual(ANUNCIO_B_NA_MENSAGEM);
      // Compacto de propósito: o clique identifica uma pessoa, e o cru já mora
      // no contato. Nada disso se repete em cada mensagem — o link e a imagem
      // entram (a inbox mostra o anúncio), o clique e o resto do payload não.
      // A âncora reservada da prova causal (#3128) é o ÚNICO lugar do clique.
      const { meta_ctwa_message_v1: ancora, ...resto } = metadata ?? {};
      expect(ancora).toEqual({ platform: "meta_ads", source_type: "ad", ctwa_clid: "ARAk_clique_B" });
      expect(JSON.stringify(resto)).not.toContain("ARAk_clique_B");
      expect(JSON.stringify(metadata)).not.toContain("media_type");
    });

    it("o primeiro toque do contato continua sendo estampado como antes", async () => {
      const { admin, rpcs } = adminTolerante();
      await ingestZernioInbound(admin as never, { ...ENTRADA, payload: evento(ANUNCIO_B) });

      const estampas = rpcs.filter((c) => c.fn === "fn_estampar_atribuicao_de_anuncio");
      expect(estampas).toHaveLength(1);
      expect(estampas[0]!.args).toMatchObject({ p_contact: "contato-1", p_platform: "meta_ads" });
    });

    it("mensagem sem anúncio: a chave nem aparece", async () => {
      const { admin, insertsDeMensagem } = adminTolerante();
      await ingestZernioInbound(admin as never, { ...ENTRADA, payload: evento(null) });
      expect("anuncio" in (metadataGravada(insertsDeMensagem) ?? {})).toBe(false);
    });

    it("post orgânico compartilhado não é anúncio — não vira `metadata.anuncio`", async () => {
      const { admin, insertsDeMensagem } = adminTolerante();
      await ingestZernioInbound(admin as never, {
        ...ENTRADA,
        payload: evento({ ...ANUNCIO_B, source_type: "post" }),
      });
      expect("anuncio" in (metadataGravada(insertsDeMensagem) ?? {})).toBe(false);
    });

    it("o anúncio convive com o anexo: `provider_attachments` segue gravado", async () => {
      const { admin, insertsDeMensagem } = adminTolerante();
      await ingestZernioInbound(admin as never, {
        ...ENTRADA,
        payload: evento(ANUNCIO_B, {
          attachments: [{ type: "image", url: "https://provider.example/anexo" }],
        }),
      });
      const metadata = metadataGravada(insertsDeMensagem);
      expect(metadata?.provider_attachments).toBeDefined();
      expect(metadata?.anuncio).toEqual(ANUNCIO_B_NA_MENSAGEM);
    });
  });

  describe("canal oficial direto", () => {
    const evento = (referral: unknown): InboundMessageEvent => ({
      kind: "inbound_message",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      externalId: "wamid.CLIQUE_B",
      from: "5511999990000",
      profileName: "Cliente de Teste",
      sentAt: new Date("2026-09-29T15:00:00.000Z"),
      type: "text",
      text: TEXTO_GENERICO,
      media: null,
      referral,
    });

    it("clique em anúncio: `metadata.anuncio` gravado no INSERT", async () => {
      const { admin, insertsDeMensagem } = adminTolerante();
      const r = await ingestMetaInbound(admin as never, evento(ANUNCIO_B), {
        organizationId: "org-1",
        channelSessionId: "sessao-1",
      });
      expect(r.status).toBe("ingested");
      expect(metadataGravada(insertsDeMensagem)?.anuncio).toEqual(ANUNCIO_B_NA_MENSAGEM);
    });

    it("sem anúncio: a chave nem aparece", async () => {
      const { admin, insertsDeMensagem } = adminTolerante();
      await ingestMetaInbound(admin as never, evento(null), {
        organizationId: "org-1",
        channelSessionId: "sessao-1",
      });
      expect("anuncio" in (metadataGravada(insertsDeMensagem) ?? {})).toBe(false);
    });
  });

  describe("canal por QR", () => {
    const envelope = (externalAdReply: Record<string, unknown> | null): WahaEnvelope => ({
      event: "message",
      session: "default",
      payload: {
        id: "false_5511999990000@c.us_CLIQUE_B",
        from: "5511999990000@c.us",
        fromMe: false,
        body: TEXTO_GENERICO,
        timestamp: 1_790_000_000,
        _data: {
          message: {
            extendedTextMessage: {
              text: TEXTO_GENERICO,
              contextInfo: externalAdReply ? { externalAdReply } : {},
            },
          },
        },
      },
    });
    const SESSION = { id: "sessao-1", organization_id: "org-1" };

    it("clique em anúncio: `metadata.anuncio` gravado junto do tipo cru", async () => {
      const { admin, insertsDeMensagem } = adminTolerante();
      await dispatchWahaEvent(
        admin as never,
        SESSION as never,
        envelope({
          title: "Protetor solar para carro",
          body: "Proteja o painel do sol. Frete grátis.",
          sourceId: "120200000000000002",
          sourceUrl: "https://fb.me/protetor-solar",
          thumbnailUrl: "https://scontent.example.fbcdn.net/protetor-solar.jpg",
          ctwaClid: "ARAk_clique_B",
          sourceType: "ad",
        }),
        "req-1",
      );
      const metadata = metadataGravada(insertsDeMensagem);
      expect(metadata?.anuncio).toEqual(ANUNCIO_B_NA_MENSAGEM);
      expect("raw_type" in (metadata ?? {})).toBe(true);
    });

    it("sem anúncio: a chave nem aparece", async () => {
      const { admin, insertsDeMensagem } = adminTolerante();
      await dispatchWahaEvent(admin as never, SESSION as never, envelope(null), "req-1");
      expect(insertsDeMensagem).toHaveLength(1);
      expect("anuncio" in (metadataGravada(insertsDeMensagem) ?? {})).toBe(false);
    });
  });
});
