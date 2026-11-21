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
 * 2. O adapter repassa os ids do envelope, recortados ao chat desta resposta;
 *    sem ids, o pedido de antes (a conversa inteira), que vale para quem tem store.
 * 3. O handler de envio (por onde passam a resposta do agente, a do atendente,
 *    lembretes e propostas) acha as mensagens do cliente que ESTA resposta lê:
 *    as que o CRM recebeu depois do último envio que saiu de verdade.
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
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "http://storage/assinada.pdf" }, error: null }),
      }),
    },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
// O nome do agente vem de `ai_agents`; aqui só importa que o envio da IA saia.
vi.mock("@/lib/messaging/nome-do-agente-de-ia", () => ({ nomeDoAgenteDeIA: vi.fn(async () => "Bia") }));

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

  it("lista vazia = sem ids conhecidos: o pedido de antes, a conversa inteira", async () => {
    const pedidos = stubWaha();
    await envio({ readExternalIds: [] });
    await vi.waitFor(() => expect(doVisto(pedidos)).toHaveLength(1));
    expect(doVisto(pedidos)[0]!.body).toEqual({ session: "default", chatId: "5531999998888@c.us" });
  });

  it("ficha com dois números: responder a um não marca como lidas as do outro", async () => {
    // A conversa juntou mensagens de dois chats; a resposta vai para o que
    // escreveu por último. O WAHA lê cada id no chat que ele traz, então o
    // recorte tem de acontecer antes do pedido.
    const pedidos = stubWaha();
    const DO_OUTRO = "false_5531977776666@c.us_3EB0OUTRO001";
    await envio({ readExternalIds: [DO_OUTRO, IN1, IN2] });
    await vi.waitFor(() => expect(doVisto(pedidos)).toHaveLength(1));
    expect(doVisto(pedidos)[0]!.body?.messageIds).toEqual([IN1, IN2]);
  });

  it("o @lid da mensagem mais nova fica, mesmo com o envio saindo pelo @c.us", async () => {
    const pedidos = stubWaha();
    await envio({ readExternalIds: [IN1, IN_LID] });
    await vi.waitFor(() => expect(doVisto(pedidos)).toHaveLength(1));
    expect(doVisto(pedidos)[0]!.body?.messageIds).toEqual([IN1, IN_LID]);
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

  async function responder(
    mensagensIniciais: LinhaDoDuble[],
    opcoes: { ctx?: HandlerCtx; envio?: Partial<SendMessageInput> } = {},
  ) {
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
    await sendMessageHandler(supabase, opcoes.ctx ?? ctx, {
      conversation_id: CONV,
      type: "text",
      body: "oi, tudo certo",
      ...opcoes.envio,
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

  it("nada chegou desde a última resposta (a 2ª bolha): o pedido de antes, sem ids", async () => {
    // Quem tem o store ligado continua tendo o que tinha; quem não tem recebe a
    // mesma recusa de antes, sem marcar nada errado.
    const visto = await responder([
      entrada(IN1, "2026-11-20T10:00:00.000Z"),
      saida("out-1", "2026-11-20T10:01:00.000Z", "sent"),
    ]);
    expect(visto).toHaveLength(1);
    expect(visto[0]!.body?.messageIds).toBeUndefined();
  });

  it("mensagem que chegou no MESMO segundo da resposta anterior não se perde", async () => {
    // O webhook do WAHA traz a hora em segundos: a mensagem das 10:00:00.800 é
    // gravada com `sent_at` 10:00:00, ANTES da resposta das 10:00:00.250. A ordem
    // que vale é a em que o CRM viu as duas (`created_at`).
    const visto = await responder([
      { ...saida("out-1", "2026-11-20T10:00:00.250Z", "sent"), created_at: "2026-11-20T10:00:00.250Z" },
      { ...entrada(IN2, "2026-11-20T10:00:00.000Z"), created_at: "2026-11-20T10:00:00.900Z" },
    ]);
    expect(visto[0]!.body?.messageIds).toEqual([IN2]);
  });

  it("microssegundos: o banco separa o que o milissegundo do JavaScript juntaria", async () => {
    // O Postgres devolve microssegundos; `Date.parse` cortaria os dois para
    // 10:00:00.250 e a mensagem pareceria da mesma hora da resposta.
    const visto = await responder([
      { ...saida("out-1", "2026-11-20T10:00:00Z", "sent"), created_at: "2026-11-20T10:00:00.2501+00:00" },
      { ...entrada(IN2, "2026-11-20T10:00:00Z"), created_at: "2026-11-20T10:00:00.2509+00:00" },
    ]);
    expect(visto[0]!.body?.messageIds).toEqual([IN2]);
  });

  it("resposta antiga trazida pela importação do histórico não fecha a régua", async () => {
    // A linha importada nasce com `created_at` da IMPORTAÇÃO: sem o recorte, ela
    // pareceria a resposta mais recente e esconderia a mensagem de antes dela.
    const visto = await responder([
      entrada(IN1, "2026-11-20T10:00:00.000Z"),
      {
        ...saida("out-importada", "2026-11-01T09:00:00.000Z", "sent"),
        created_at: "2026-11-20T10:01:00.000Z",
        metadata: { historico_importado: "true" },
      },
      entrada(IN2, "2026-11-20T10:02:00.000Z"),
    ]);
    expect(visto[0]!.body?.messageIds).toEqual([IN1, IN2]);
  });

  it("o 👍 do atendente antes do texto não é a resposta: a mensagem continua por ler", async () => {
    const visto = await responder([
      entrada(IN1, "2026-11-20T10:00:00.000Z"),
      { ...saida("out-reacao", "2026-11-20T10:01:00.000Z", "sent"), type: "reaction" },
    ]);
    expect(visto[0]!.body?.messageIds).toEqual([IN1]);
  });

  it("o envio de ARQUIVO também leva os ids", async () => {
    const visto = await responder([entrada(IN1, "2026-11-20T10:00:00.000Z")], {
      envio: {
        type: "document",
        media_storage_path: `${ORG}/${CONV}/contrato.pdf`,
        media_mime: "application/pdf",
      } as Partial<SendMessageInput>,
    });
    expect(visto, "o visto não saiu no envio de arquivo").toHaveLength(1);
    expect(visto[0]!.body?.messageIds).toEqual([IN1]);
  });

  it("a resposta do AGENTE DE IA também leva os ids", async () => {
    const visto = await responder([entrada(IN1, "2026-11-20T10:00:00.000Z")], {
      ctx: { organization_id: ORG, actor: { type: "ai_agent", id: "agente-5015", role: "manager" }, requestId: "req-ia" },
    });
    expect(visto, "o visto não saiu na resposta da IA").toHaveLength(1);
    expect(visto[0]!.body?.messageIds).toEqual([IN1]);
  });
});

describe("só o canal que marca por id paga a leitura do histórico (#5015)", () => {
  it("a matriz diz: só o canal por QR marca lidas por id", async () => {
    const { CHANNEL_CAPABILITIES, canalMarcaLidasPorMensagem } = await import("@/lib/channels/capabilities");
    const marcam = Object.entries(CHANNEL_CAPABILITIES)
      .filter(([, c]) => c.marcaLidasPorMensagem)
      .map(([p]) => p);
    expect(marcam).toEqual(["waha"]);
    expect(canalMarcaLidasPorMensagem("waha")).toBe(true);
    expect(canalMarcaLidasPorMensagem("telegram")).toBe(false);
    expect(canalMarcaLidasPorMensagem("provider-que-nao-existe")).toBe(false);
    expect(canalMarcaLidasPorMensagem(null)).toBe(false);
  });
});
