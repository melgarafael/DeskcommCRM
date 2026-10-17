import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/**
 * A REAÇÃO NO CANAL OFICIAL (#2797, fatia 1).
 *
 * A Cloud API entrega a reação DENTRO de `messages[]`, com `type: "reaction"` e
 * o par `reaction.{message_id,emoji}`. O normalizador a tratava como mensagem
 * qualquer: o payload virava `inbound_message` sem emoji e sem alvo, a
 * ingestão gravava uma linha cega em `messages`, e o carimbo da conversa
 * movia última mensagem e abria a janela de 24h por um gesto que não é fala.
 *
 * O que estas provas cobrem:
 *   - o normalizador lê `reaction.emoji` e `reaction.message_id` e produz um
 *     evento PRÓPRIO (`kind: "reaction"`), não uma mensagem;
 *   - o usuário que REMOVE a reação vem sem `emoji` — o evento continua
 *     nascendo (é a remoção que apaga a anterior);
 *   - reação sem `message_id` não vira evento algum (nunca linha cega);
 *   - a rota manda o evento para a ingestão de reação, e NUNCA para a de
 *     mensagem recebida (que é a que carimba a conversa).
 *
 * ⚠️ A ingestão real é provada em `meta-reacao-ingest.test.ts`; aqui ela está
 * mockada de propósito, para que o que se prova seja o roteamento.
 */

const SESSAO = { id: "sess-1", organizationId: "org-1", wabaId: "2434045433735175" };
const APP_SECRET = "app-secret-de-teste";

const disparos = vi.hoisted(() => ({
  reacoes: [] as unknown[],
  recebidas: [] as unknown[],
}));

vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: async () => SESSAO,
}));

vi.mock("@/lib/channels/meta/ingest", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    ingestMetaInbound: async (_admin: unknown, e: unknown) => {
      disparos.recebidas.push(e);
      return { status: "ingested" };
    },
    ingestMetaReaction: async (_admin: unknown, e: unknown) => {
      disparos.reacoes.push(e);
      return { status: "ingested", messageId: "reacao-1", conversationId: "conversa-1" };
    },
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({}) }) }) }),
      }),
    }),
  }),
}));

import { parseMetaWebhook } from "@/lib/channels/meta/webhook";
import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";

const CHAT = "5511999999999";
const ALVO = "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=";

/** Payload no formato documentado em webhooks/reference/messages/reaction. */
function envelopeDeReacao(reaction: Record<string, unknown> | undefined) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: SESSAO.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-1" },
              contacts: [{ wa_id: CHAT, profile: { name: "Cliente" } }],
              messages: [
                {
                  id: "wamid.REACAO",
                  from: CHAT,
                  timestamp: "1760000000",
                  type: "reaction",
                  ...(reaction === undefined ? {} : { reaction }),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function pedido(corpo: unknown) {
  const cru = JSON.stringify(corpo);
  return {
    text: async () => cru,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(cru, "utf8").digest("hex")}`,
    }),
  } as never;
}

const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;

describe("o normalizador lê reaction.emoji e reaction.message_id (#2797)", () => {
  it("vira evento PRÓPRIO de reação, com o alvo e o emoji", () => {
    const eventos = parseMetaWebhook(envelopeDeReacao({ message_id: ALVO, emoji: "👍" }));

    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      kind: "reaction",
      wabaId: SESSAO.wabaId,
      phoneNumberId: "phone-1",
      externalId: "wamid.REACAO",
      from: CHAT,
      emoji: "👍",
      targetExternalId: ALVO,
    });
    expect(eventos[0]).not.toHaveProperty("text");
  });

  it("reação REMOVIDA vem sem `emoji`: o evento continua nascendo, com emoji nulo", () => {
    // A Meta omite a propriedade quando o usuário desfaz o gesto — é o caso em
    // que a ingestão apaga a reação anterior do mesmo autor sobre o mesmo alvo.
    const eventos = parseMetaWebhook(envelopeDeReacao({ message_id: ALVO }));

    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ kind: "reaction", emoji: null, targetExternalId: ALVO });
  });

  it("reação sem `message_id` não vira evento algum — nunca linha cega", () => {
    expect(parseMetaWebhook(envelopeDeReacao({ emoji: "👍" }))).toEqual([]);
    expect(parseMetaWebhook(envelopeDeReacao(undefined))).toEqual([]);
  });

  it("mensagem normal continua virando inbound_message — nada do lado de antes mudou", () => {
    const eventos = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: SESSAO.wabaId,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                contacts: [{ wa_id: CHAT, profile: { name: "Cliente" } }],
                messages: [
                  {
                    id: "wamid.NORMAL",
                    from: CHAT,
                    timestamp: "1760000000",
                    type: "text",
                    text: { body: "quanto custa?" },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never);

    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ kind: "inbound_message", type: "text", text: "quanto custa?" });
  });
});

describe("a rota entrega a reação à ingestão CERTA (#2797)", () => {
  it("payload assinado com reação: passa por ingestMetaReaction e NUNCA por ingestMetaInbound", async () => {
    vi.stubEnv("META_APP_SECRET", APP_SECRET);
    disparos.reacoes.length = 0;
    disparos.recebidas.length = 0;

    const res = await POST(pedido(envelopeDeReacao({ message_id: ALVO, emoji: "👍" })), ctx);

    expect(res.status).toBe(200);
    expect(disparos.recebidas, "a reação entrou pelo caminho que carimba a conversa").toEqual([]);
    expect(disparos.reacoes).toHaveLength(1);
    expect(disparos.reacoes[0]).toMatchObject({ kind: "reaction", emoji: "👍", targetExternalId: ALVO });
    vi.unstubAllEnvs();
  });
});
