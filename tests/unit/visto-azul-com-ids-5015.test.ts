/**
 * O VISTO AZUL NO NOWEB SEM "GUARDAR HISTÓRICO" — issue #5015.
 *
 * ─── O defeito, visto de fora do CRM ───────────────────────────────────────
 *
 * O #2981 ligou o visto azul ao responder, mas o pedido saía SEM `messageIds`.
 * No WAHA, `POST /api/sendSeen` sem ids vira `readChatMessages(chatId, {days: 7})`
 * (`src/api/chatting.controller.ts`), e no NOWEB esse caminho lê o store local.
 * Com o store desligado — o padrão do produto desde o #999 — a resposta é 400
 * ("Enable NOWEB store ..."). O helper falha macio, nada fica vermelho, e o
 * cliente fica nos dois tiques cinza. Medido no #5015: 506 recusas e 45 aceites
 * em 24 h, todos os aceites da única sessão com store.
 *
 * Com `messageIds`, o WAHA vai por `session.sendSeen` → `ExtractMessageKeysForRead`
 * → `sock.readMessages(keys)`, que não usa o store. O id serializado
 * (`false_<chat>_<id>`) carrega o próprio `remoteJid`, então a mensagem que
 * chegou por `@lid` é lida no `@lid` dela, sem depender do endereço do envio.
 *
 * ─── O que cada bloco prende ───────────────────────────────────────────────
 *
 * 1. O cliente põe os ids no corpo quando os recebe — e só então.
 * 2. O adapter repassa os ids do envelope; lista vazia = nada a marcar, sem pedido.
 * 3. O handler de envio (por onde passam a resposta do agente, a do atendente,
 *    lembretes e propostas) acha as mensagens do cliente que ESTA resposta lê:
 *    as que chegaram depois do último envio que saiu de verdade.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { getAdapter } from "@/lib/channels";
import type { OutboundEnvelope } from "@/lib/channels/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import { WahaClient } from "@/lib/waha/client";
import { limparMemoCheckExists } from "@/lib/waha/resolve-contact-whatsapp-id";
import { criarDubleDoHandler, type LinhaDoDuble } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111115015";
const CONV = "22222222-2222-4222-8222-222222225015";
const CONTACT = "33333333-3333-4333-8333-333333335015";
const SESSION = "44444444-4444-4444-8444-444444445015";
const USER = "55555555-5555-4555-8555-555555555015";
const WAHA_BASE = "http://localhost:3030";

/** Ids de ENTRADA como o webhook do NOWEB os grava (`externalIdDeEntrada`). */
const IN1 = "false_5531999998888@c.us_3EB0AAAA0001";
const IN2 = "false_5531999998888@c.us_3EB0AAAA0002";
const IN_LID = "false_127904277102624@lid_3EB0AAAA0003";

interface Pedido {
  url: string;
  body: Record<string, unknown> | null;
}

function stubWaha() {
  vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
  vi.stubEnv("WAHA_API_KEY", "hash123");
  const pedidos: Pedido[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: unknown, init?: RequestInit) => {
      const href = String(url);
      const cru = typeof init?.body === "string" ? init.body : null;
      pedidos.push({ url: href, body: cru ? (JSON.parse(cru) as Record<string, unknown>) : null });
      if (href.includes("/api/sendSeen")) return Promise.resolve(new Response("{}", { status: 200 }));
      if (href.includes("/api/contacts/check-exists")) {
        const phone = new URL(href).searchParams.get("phone") ?? "";
        return Promise.resolve(Response.json({ numberExists: true, chatId: `${phone}@c.us` }));
      }
      return Promise.resolve(Response.json({ id: { _serialized: "3EB0RESPOSTA" } }));
    }),
  );
  return pedidos;
}

const doVisto = (pedidos: Pedido[]) => pedidos.filter((p) => p.url.includes("/api/sendSeen"));

afterEach(() => {
  limparMemoCheckExists();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WahaClient.sendSeen com os ids das mensagens lidas (#5015)", () => {
  it("os ids vão em `messageIds`, no formato serializado que veio do webhook", async () => {
    const pedidos = stubWaha();
    await new WahaClient(WAHA_BASE, "chave").sendSeen("s1", "5531999998888@c.us", [IN1, IN2]);
    expect(pedidos[0]!.body).toEqual({
      session: "s1",
      chatId: "5531999998888@c.us",
      messageIds: [IN1, IN2],
    });
  });

  it("sem ids (ou lista vazia), o corpo é o de antes — a conversa inteira", async () => {
    const pedidos = stubWaha();
    const cliente = new WahaClient(WAHA_BASE, "chave");
    await cliente.sendSeen("s1", "5531999998888@c.us");
    await cliente.sendSeen("s1", "5531999998888@c.us", []);
    expect(pedidos.map((p) => p.body)).toEqual([
      { session: "s1", chatId: "5531999998888@c.us" },
      { session: "s1", chatId: "5531999998888@c.us" },
    ]);
  });
});

describe("o adapter do canal por QR repassa os ids do envelope (#5015)", () => {
  const envio = (extra: Partial<OutboundEnvelope>) =>
    getAdapter("waha").send({
      organizationId: ORG,
      sessionRef: "default",
      to: "5531999998888@c.us",
      kind: "text",
      body: "oi",
      ...extra,
    });

  it("`readExternalIds` chega ao `/api/sendSeen` — o caminho que não depende do store", async () => {
    const pedidos = stubWaha();
    await envio({ readExternalIds: [IN1, IN_LID] });
    await vi.waitFor(() => expect(doVisto(pedidos)).toHaveLength(1));
    expect(doVisto(pedidos)[0]!.body).toEqual({
      session: "default",
      chatId: "5531999998888@c.us",
      messageIds: [IN1, IN_LID],
    });
  });

  it("lista vazia = quem montou o envelope procurou e não há o que ler: nenhum pedido", async () => {
    const pedidos = stubWaha();
    await envio({ readExternalIds: [] });
    // Dá ao `void` do visto a chance de sair, se fosse sair.
    await new Promise((r) => setTimeout(r, 20));
    expect(pedidos.some((p) => p.url.includes("/api/sendText"))).toBe(true);
    expect(doVisto(pedidos)).toHaveLength(0);
  });
});

describe("o envio pelo handler marca como lidas as mensagens que a resposta lê (#5015)", () => {
  const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-5015" };

  const entrada = (externalId: string, sentAt: string, extra: LinhaDoDuble = {}): LinhaDoDuble => ({
    id: `in-${externalId.slice(-4)}`,
    organization_id: ORG,
    conversation_id: CONV,
    direction: "inbound",
    type: "text",
    status: "received",
    external_id: externalId,
    sent_at: sentAt,
    created_at: sentAt,
    ...extra,
  });
  const saida = (id: string, sentAt: string, status: string): LinhaDoDuble => ({
    id,
    organization_id: ORG,
    conversation_id: CONV,
    direction: "outbound",
    type: "text",
    status,
    external_id: status === "failed" ? null : `3EB0${id}`,
    sent_at: sentAt,
    created_at: sentAt,
  });

  async function responder(mensagensIniciais: LinhaDoDuble[]) {
    const pedidos = stubWaha();
    const { supabase } = criarDubleDoHandler({
      conversation: {
        id: CONV,
        organization_id: ORG,
        contact_id: CONTACT,
        channel_session_id: SESSION,
        is_group: false,
        group_chat_id: null,
        contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false },
        channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null },
      },
      mensagensIniciais,
    });
    await sendMessageHandler(supabase, ctx, {
      conversation_id: CONV,
      type: "text",
      body: "oi, tudo certo",
    } as SendMessageInput);
    // O visto sai em `void` depois do envio: espera assentar.
    await new Promise((r) => setTimeout(r, 20));
    return doVisto(pedidos);
  }

  it("a mensagem do cliente que está sendo respondida vai em `messageIds`", async () => {
    const visto = await responder([entrada(IN1, "2026-11-20T10:00:00.000Z")]);
    expect(visto, "o visto não saiu").toHaveLength(1);
    expect(visto[0]!.body?.messageIds, "sem ids o NOWEB sem store recusa com 400").toEqual([IN1]);
  });

  it("só as que chegaram DEPOIS do último envio que saiu, da mais antiga para a mais nova", async () => {
    const visto = await responder([
      entrada(IN1, "2026-11-20T10:00:00.000Z"),
      saida("out-1", "2026-11-20T10:01:00.000Z", "delivered"),
      entrada(IN2, "2026-11-20T10:02:00.000Z"),
      entrada(IN_LID, "2026-11-20T10:03:00.000Z"),
    ]);
    expect(visto[0]!.body?.messageIds).toEqual([IN2, IN_LID]);
  });

  it("um envio que FALHOU não conta como resposta: a mensagem de antes dele continua por ler", async () => {
    const visto = await responder([
      entrada(IN1, "2026-11-20T10:00:00.000Z"),
      saida("out-falhou", "2026-11-20T10:01:00.000Z", "failed"),
    ]);
    expect(visto[0]!.body?.messageIds).toEqual([IN1]);
  });

  it("reação e mensagem de sistema não entram: não são mensagens que alguém responde", async () => {
    const visto = await responder([
      entrada(IN1, "2026-11-20T10:00:00.000Z"),
      entrada("false_5531999998888@c.us_3EB0REACAO", "2026-11-20T10:01:00.000Z", { type: "reaction" }),
      entrada("false_5531999998888@c.us_3EB0SISTEMA", "2026-11-20T10:02:00.000Z", { type: "system" }),
    ]);
    expect(visto[0]!.body?.messageIds).toEqual([IN1]);
  });

  it("nada chegou desde a última resposta: nenhum pedido de visto (a 2ª bolha não repete)", async () => {
    const visto = await responder([
      entrada(IN1, "2026-11-20T10:00:00.000Z"),
      saida("out-1", "2026-11-20T10:01:00.000Z", "sent"),
    ]);
    expect(visto).toHaveLength(0);
  });
});
