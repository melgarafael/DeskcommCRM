import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import {
  parseMetaWebhook,
  type InboundMessageEvent,
  type MetaWebhookEnvelope,
} from "@/lib/channels/meta/webhook";

/**
 * Contato que chega pelo canal oficial DIRETO depois de clicar num anúncio
 * "Clique para o WhatsApp" ficava `source = 'whatsapp'` (issue #903): o parser
 * descartava `messages[].referral` e a ingestão nunca estampava a atribuição.
 * O Zernio e o WAHA já estampavam; só este transporte ficava de fora.
 *
 * O `referral` abaixo segue a forma DOCUMENTADA da Cloud API — não há payload
 * de clique real capturado. A leitura campo a campo é de `extrairAtribuicaoMeta`
 * e tem teste próprio (`atribuicao-de-anuncio.test.ts`); aqui se prova só que o
 * dado atravessa o transporte e chega ao contato antes do lead nascer.
 */

const REFERRAL_DE_ANUNCIO = {
  source_url: "https://fb.me/anuncio123",
  source_id: "120210000000000",
  source_type: "ad",
  headline: "Agende sua consulta",
  body: "Clique e fale com a gente",
  ctwa_clid: "ARAkLkA8rmlFeiCktEJQ",
};

function envelope(mensagem: Record<string, unknown>): MetaWebhookEnvelope {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: "phone-1" },
              contacts: [{ profile: { name: "Cliente" }, wa_id: "5519999999999" }],
              messages: [
                {
                  from: "5519999999999",
                  id: "wamid.ANUNCIO",
                  timestamp: "1785342028",
                  type: "text",
                  text: { body: "Olá! Quero saber mais." },
                  ...mensagem,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

const inbound = (env: MetaWebhookEnvelope) =>
  parseMetaWebhook(env).filter((e): e is InboundMessageEvent => e.kind === "inbound_message");

describe("parser do webhook oficial — o referral atravessa", () => {
  it("mensagem de clique em anúncio carrega o referral cru", () => {
    const [e] = inbound(envelope({ referral: REFERRAL_DE_ANUNCIO }));
    expect(e!.referral).toEqual(REFERRAL_DE_ANUNCIO);
  });

  it("mensagem comum sai com referral nulo", () => {
    const [e] = inbound(envelope({}));
    expect(e!.referral).toBeNull();
  });
});

const estado = vi.hoisted(() => ({
  ordem: [] as string[],
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));

vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async () => {
    estado.ordem.push("pos_entrada");
  },
}));

function adminFalso(): SupabaseClient {
  const from = (table: string) => {
    if (table === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({
          data: { id: "session-1", organization_id: "org-1" },
          error: null,
        }),
      };
      return chain;
    }
    if (table === "messages") {
      const terminal = {
        maybeSingle: async () => ({ data: { id: "message-1" }, error: null }),
      };
      return { insert: () => ({ select: () => terminal }) };
    }
    throw new Error(`tabela inesperada: ${table}`);
  };

  const rpc = async (name: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ name, args });
    estado.ordem.push(name);
    if (name === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
    if (name === "fn_upsert_wa_conversation") return { data: "conversation-1", error: null };
    return { data: null, error: null };
  };

  return { from, rpc } as unknown as SupabaseClient;
}

function evento(referral: unknown): InboundMessageEvent {
  return {
    kind: "inbound_message",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    externalId: "wamid.ANUNCIO",
    from: "5519999999999",
    profileName: "Cliente",
    sentAt: new Date("2026-09-15T12:00:00.000Z"),
    type: "text",
    text: "Olá! Quero saber mais.",
    media: null,
    referral,
  };
}

const estampas = () => estado.rpcs.filter((r) => r.name === "fn_estampar_atribuicao_de_anuncio");

beforeEach(() => {
  estado.ordem = [];
  estado.rpcs = [];
});

describe("ingestão oficial — atribuição de anúncio no contato", () => {
  it("clique em anúncio estampa o contato como meta_ads, com o clique", async () => {
    const r = await ingestMetaInbound(adminFalso(), evento(REFERRAL_DE_ANUNCIO), {
      organizationId: "org-1",
    });

    expect(r.status).toBe("ingested");
    expect(estampas()).toHaveLength(1);
    expect(estampas()[0]!.args).toMatchObject({
      p_contact: "contact-1",
      p_platform: "meta_ads",
      p_metadata: {
        ad_platform: "meta_ads",
        ad_source_id: "ARAkLkA8rmlFeiCktEJQ",
        ad_title: "Agende sua consulta",
        ad_source_url: "https://fb.me/anuncio123",
      },
    });
  });

  it("a atribuição chega ao contato ANTES do lead nascer", async () => {
    await ingestMetaInbound(adminFalso(), evento(REFERRAL_DE_ANUNCIO), {
      organizationId: "org-1",
    });

    const estampa = estado.ordem.indexOf("fn_estampar_atribuicao_de_anuncio");
    expect(estampa).toBeGreaterThan(estado.ordem.indexOf("fn_upsert_wa_contact"));
    expect(estampa).toBeLessThan(estado.ordem.indexOf("pos_entrada"));
  });

  it("mensagem sem referral não estampa nada", async () => {
    await ingestMetaInbound(adminFalso(), evento(null), { organizationId: "org-1" });
    expect(estampas()).toHaveLength(0);
  });

  it("post orgânico compartilhado não é anúncio", async () => {
    await ingestMetaInbound(
      adminFalso(),
      evento({ ...REFERRAL_DE_ANUNCIO, source_type: "post" }),
      { organizationId: "org-1" },
    );
    expect(estampas()).toHaveLength(0);
  });
});
