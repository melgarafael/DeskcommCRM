import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import type { InboundMessageEvent } from "@/lib/channels/meta/webhook";
import { ingestZernioInbound } from "@/lib/channels/zernio/ingest";

/**
 * O CARIMBO QUE FALHA DEIXA RASTRO — nos TRÊS canais, não só no WAHA.
 *
 * `fn_mark_conversation_message` é quem move `last_message_at`,
 * `last_inbound_at`/`last_outbound_at`, a prévia, o contador de não lidas e
 * `contacts.last_activity_at`. Quando ela falha, a mensagem existe e a conversa
 * fica parada: some da ordenação da Inbox e a janela de 24h não abre.
 *
 * ═══ O defeito medido ═══════════════════════════════════════════════════════
 *
 * Os três canais chamavam a MESMA RPC e tratavam a falha de três jeitos:
 *
 *   • WAHA   — emitia `whatsapp.conversation_mark_failed`. Já tinha teste
 *              (`tests/unit/waha-carimbo-falho.test.ts`).
 *   • Zernio — `logger.warn`. Some no próximo restart do contêiner.
 *   • Meta   — **ignorava o retorno inteiro**, com um comentário acima da
 *              chamada afirmando o contrário: "o erro sobe como `failed` parcial
 *              no log do chamador em vez de sumir". Sumia.
 *
 * O canal oficial era o pior dos três justamente onde a falha dói mais, porque
 * é o único com janela de 24h.
 *
 * ⚠️ OS DOIS CASOS ENTRAM PELO CAMINHO DE PRODUÇÃO (`ingestMetaInbound` /
 * `ingestZernioInbound`), não chamando o helper compartilhado: um teste que
 * chamasse `marcarConversaComMensagem` direto provaria o helper e mentiria
 * sobre o caminho — que é exatamente o modo como a Meta passou a ter o helper
 * disponível e não o usar.
 */

const estado = vi.hoisted(() => ({
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));

vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async () => undefined,
}));

/**
 * Admin que deixa tudo passar e QUEBRA só no carimbo. As RPCs de resolução
 * precisam devolver id: sem elas a ingestão desiste antes de chegar ao carimbo
 * e o caso passaria por não ter exercitado nada.
 */
function adminQueFalhaNoCarimbo(): SupabaseClient {
  const linhaDeMensagem = {
    maybeSingle: async () => ({ data: { id: "message-1" }, error: null }),
  };

  const from = (table: string) => {
    if (table === "messages") {
      return {
        insert: () => ({ select: () => linhaDeMensagem }),
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      };
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: () => chain,
      update: () => chain,
      eq: () => chain,
      is: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({
        data: table === "channel_sessions" ? { id: "session-1", organization_id: "org-1" } : null,
        error: null,
      }),
    };
    return chain;
  };

  const rpc = async (name: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ name, args });
    if (name === "fn_mark_conversation_message") {
      return { data: null, error: { message: "boom: a RPC do carimbo caiu" } };
    }
    if (name === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
    if (name === "fn_upsert_wa_conversation") return { data: "conversation-1", error: null };
    return { data: null, error: null };
  };

  return { from, rpc } as unknown as SupabaseClient;
}

function avisosDeCarimbo() {
  return estado.rpcs.filter(
    (c) =>
      c.name === "emit_event" &&
      c.args.p_event_type === "whatsapp.conversation_mark_failed",
  );
}

const EVENTO_META: InboundMessageEvent = {
  kind: "inbound_message",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  externalId: "wamid.CARIMBO",
  from: "5519999999999",
  profileName: "Cliente",
  sentAt: new Date("2026-09-15T12:00:00.000Z"),
  type: "text",
  text: "oi, tudo bem?",
  media: null,
};

beforeEach(() => {
  estado.rpcs = [];
});

describe("canal oficial (Meta): carimbo que falha vira registro", () => {
  it("emite whatsapp.conversation_mark_failed com a conversa, o sentido e o erro", async () => {
    await ingestMetaInbound(adminQueFalhaNoCarimbo(), EVENTO_META, { organizationId: "org-1" });

    const [aviso] = avisosDeCarimbo();
    expect(aviso, "o carimbo falhou e a Meta não registrou nada").toBeDefined();
    expect(aviso!.args).toMatchObject({
      p_entity_kind: "conversation",
      p_entity_id: "conversation-1",
      p_organization_id: "org-1",
      p_payload: { direction: "inbound", canal: "meta", erro: "boom: a RPC do carimbo caiu" },
    });
  });

  it("a PRÉVIA não entra no payload do aviso", async () => {
    // Registro operacional não é cópia de conteúdo: o texto do cliente ficaria
    // gravado numa segunda tabela, fora do alcance da anonimização da LGPD, que
    // conhece `messages` e não `event_log`.
    await ingestMetaInbound(adminQueFalhaNoCarimbo(), EVENTO_META, { organizationId: "org-1" });

    const payload = JSON.stringify(avisosDeCarimbo()[0]!.args.p_payload);
    expect(payload).not.toContain("tudo bem");
  });

  it("carimbo que dá certo NÃO emite aviso (controle)", async () => {
    // Sem este controle, um `emit_event` incondicional deixaria os casos acima
    // verdes enquanto inundava o event_log de toda instalação saudável.
    const admin = adminQueFalhaNoCarimbo();
    const original = admin.rpc.bind(admin);
    (admin as unknown as { rpc: unknown }).rpc = async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      if (name === "fn_mark_conversation_message") {
        estado.rpcs.push({ name, args });
        return { data: null, error: null };
      }
      return original(name as never, args as never);
    };

    await ingestMetaInbound(admin, EVENTO_META, { organizationId: "org-1" });

    expect(avisosDeCarimbo()).toHaveLength(0);
  });
});

describe("canal intermediado (Zernio): carimbo que falha vira registro", () => {
  it("emite whatsapp.conversation_mark_failed em vez de só logar", async () => {
    await ingestZernioInbound(adminQueFalhaNoCarimbo(), {
      organizationId: "org-1",
      channelSessionId: "session-1",
      payload: {
        event: "message.received",
        message: {
          platform: "whatsapp",
          conversationId: "thread-1",
          platformMessageId: "zer-1",
          direction: "incoming",
          text: "oi",
          sentAt: "2026-09-15T12:00:00.000Z",
          attachments: [],
          sender: { phoneNumber: "+5519999999999", name: "Cliente" },
        },
      },
    });

    const [aviso] = avisosDeCarimbo();
    expect(aviso, "o carimbo falhou e o Zernio não registrou nada").toBeDefined();
    expect(aviso!.args).toMatchObject({
      p_organization_id: "org-1",
      p_payload: { canal: "zernio", erro: "boom: a RPC do carimbo caiu" },
    });
  });
});
