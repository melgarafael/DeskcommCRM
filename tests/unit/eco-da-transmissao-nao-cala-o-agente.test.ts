import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O ECO DA TRANSMISSÃO (migration 0712) — a mensagem que o provedor mandou por
 * broadcast volta pelo webhook como uma saída que o CRM não mandou.
 *
 * Medido em produção em 16/10/2026, antes deste conserto, com 2 destinatários:
 *
 *  - a linha nascia com "[Template: recordatorio_pedido_web]" no corpo — o
 *    agente, quando a resposta chegasse, não saberia o que a pessoa recebeu;
 *  - no número que ainda não tinha conversa, a ingestão leu a saída como "uma
 *    pessoa respondeu pelo celular" e calou o agente pelo prazo do atendimento
 *    manual — justamente quando as respostas de uma lista chegam juntas.
 *
 * O controle está no último caso: uma saída comum, feita de fora do CRM, segue
 * calando o agente. Sem ele, o primeiro caso passaria também com a pausa
 * apagada de vez — e a pausa existe por um defeito real (a IA respondendo por
 * cima de quem atende pelo celular).
 */

const ops: { tabela: string; op: string; payload?: unknown }[] = [];
let conversaExistente: { id: string; contact_id: string } | null = null;

/** O builder do PostgREST, encadeável — só o bastante para a ingestão andar. */
function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          if (tabela === "conversations" && op === "select") return async () => ({ data: conversaExistente, error: null });
          if (tabela === "contacts" && op === "select") return async () => ({ data: null, error: null });
          return async () => ({ data: { id: "msg-1" }, error: null });
        }
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [{ id: "row-1" }], error: null });
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  ops.push({ tabela, op, payload });
  return proxy;
}

const admin = {
  rpc: async (nome: string) => ({
    data: nome === "fn_upsert_wa_contact" ? "contact-1" : nome === "fn_upsert_wa_conversation" ? "conv-1" : null,
    error: null,
  }),
  from: (tabela: string) => ({
    select: () => chain(tabela, "select"),
    insert: (payload: unknown) => chain(tabela, "insert", payload),
    update: (payload: unknown) => chain(tabela, "update", payload),
  }),
} as never;

vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/zernio/credentials")>()),
  resolveZernioCreds: vi.fn(),
}));
vi.mock("@/lib/escalacao/atendimento-manual", async (orig) => ({
  ...(await orig<typeof import("@/lib/escalacao/atendimento-manual")>()),
  pausarIaPorAtendimentoManual: vi.fn(async () => true),
}));
vi.mock("@/lib/campanhas/transmissao", async (orig) => ({
  ...(await orig<typeof import("@/lib/campanhas/transmissao")>()),
  ecoDaTransmissao: vi.fn(),
  ligarEcoAoDestinatario: vi.fn(async () => undefined),
}));

import { ecoDaTransmissao, ligarEcoAoDestinatario, type EcoDaTransmissao } from "@/lib/campanhas/transmissao";
import { ingestZernioInbound } from "@/lib/channels/zernio/ingest";
import { parseZernioInbound } from "@/lib/channels/zernio/webhook";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";

const ENTRADA = { organizationId: "org-1", channelSessionId: "sess-1" };

/** Forma do `message.sent` da especificação do provedor, com o que a prova real trouxe no corpo. */
const saida = (message: Record<string, unknown> = {}) => ({
  id: "evt_1",
  event: "message.sent",
  account: { id: "acc_1" },
  conversation: { participantId: "5511912345678" },
  message: {
    id: "m_1",
    conversationId: "6ad297966c6c507b49d606a1",
    platform: "whatsapp",
    platformMessageId: "wamid.HBgMNTk1OTgyNDYxMDE3",
    direction: "outgoing",
    text: "[Template: recordatorio_pedido_web]",
    attachments: [],
    sender: { id: "acc_1", name: "Loja Exemplo" },
    sentAt: "2026-10-16T21:31:04.508Z",
    sentVia: "broadcast",
    broadcastId: "6ad297966c6c507b49d6069a",
    ...message,
  },
});

const ECO: EcoDaTransmissao = {
  campanhaId: "camp-1",
  destinatarioId: "dest-1",
  corpo: "Olá! 👋 Aqui é da Loja Exemplo, sobre o seu pedido da Cafeteira Elétrica.",
  modelo: "recordatorio_pedido_web",
  idioma: "pt_BR",
  versaoDoConteudo: 3,
  transmissaoId: "6ad297966c6c507b49d6069a",
};

function insertDaMensagem(): Record<string, unknown> {
  return ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<string, unknown>;
}

beforeEach(() => {
  ops.length = 0;
  conversaExistente = null;
  vi.mocked(ecoDaTransmissao).mockReset();
  vi.mocked(ligarEcoAoDestinatario).mockClear();
  vi.mocked(pausarIaPorAtendimentoManual).mockClear();
});

describe("o aviso de saída diz de onde ela veio", () => {
  it("lê `sentVia` e `broadcastId` da saída", () => {
    const m = parseZernioInbound(saida());
    expect(m?.direction).toBe("outbound");
    expect(m?.sentVia).toBe("broadcast");
    expect(m?.broadcastId).toBe("6ad297966c6c507b49d6069a");
  });

  it("na entrada os dois ficam de fora — nenhuma transmissão produz mensagem do cliente", () => {
    const m = parseZernioInbound({
      ...saida({ direction: "incoming", sender: { phoneNumber: "+5511912345678" } }),
      event: "message.received",
    });
    expect(m?.direction).toBe("inbound");
    expect(m?.sentVia).toBeUndefined();
    expect(m?.broadcastId).toBeUndefined();
  });
});

describe("o eco de uma transmissão de campanha", () => {
  it("⭐ nasce com o texto do modelo, como mensagem da campanha, e liga ao destinatário", async () => {
    vi.mocked(ecoDaTransmissao).mockResolvedValue(ECO);
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: saida() });

    expect(r.status).toBe("ingested");
    expect(vi.mocked(ecoDaTransmissao)).toHaveBeenCalledWith(admin, {
      organizationId: "org-1",
      transmissaoId: "6ad297966c6c507b49d6069a",
      contactId: "contact-1",
      // O outro lado da saída (`conversation.participantId`), para achar pela lista.
      telefone: "+5511912345678",
    });
    const ins = insertDaMensagem();
    expect(ins.body).toBe(ECO.corpo);
    expect(ins.type).toBe("template");
    expect(ins.template_name).toBe("recordatorio_pedido_web");
    expect(ins.sent_via).toBe("automation");
    expect(ins.metadata).toMatchObject({
      source: "campaign",
      campaign_id: "camp-1",
      campaign_recipient_id: "dest-1",
      provider_broadcast_id: "6ad297966c6c507b49d6069a",
    });
    expect(vi.mocked(ligarEcoAoDestinatario)).toHaveBeenCalledWith(admin, ECO, {
      id: "msg-1",
      conversationId: "conv-1",
      enviadaEm: "2026-10-16T21:31:04.508Z",
    });
  });

  it("⭐ não cala o agente — a transmissão não é uma pessoa respondendo pelo celular", async () => {
    vi.mocked(ecoDaTransmissao).mockResolvedValue(ECO);
    await ingestZernioInbound(admin, { ...ENTRADA, payload: saida() });
    expect(vi.mocked(pausarIaPorAtendimentoManual)).not.toHaveBeenCalled();
  });

  it("na conversa já associada à thread, o eco também liga ao destinatário", async () => {
    conversaExistente = { id: "conv-antiga", contact_id: "contact-antigo" };
    vi.mocked(ecoDaTransmissao).mockResolvedValue(ECO);
    await ingestZernioInbound(admin, { ...ENTRADA, payload: saida() });
    expect(vi.mocked(ecoDaTransmissao)).toHaveBeenCalledWith(admin, expect.objectContaining({ contactId: "contact-antigo" }));
    expect(vi.mocked(ligarEcoAoDestinatario)).toHaveBeenCalledWith(
      admin,
      ECO,
      expect.objectContaining({ conversationId: "conv-antiga" }),
    );
    expect(vi.mocked(pausarIaPorAtendimentoManual)).not.toHaveBeenCalled();
  });
});

describe("transmissão que não é de campanha nenhuma (criada no painel do provedor)", () => {
  it("mantém o texto que veio e também não cala o agente", async () => {
    vi.mocked(ecoDaTransmissao).mockResolvedValue(null);
    await ingestZernioInbound(admin, { ...ENTRADA, payload: saida() });
    const ins = insertDaMensagem();
    expect(ins.body).toBe("[Template: recordatorio_pedido_web]");
    expect(ins.sent_via).toBe("external_device");
    expect(vi.mocked(ligarEcoAoDestinatario)).not.toHaveBeenCalled();
    expect(vi.mocked(pausarIaPorAtendimentoManual)).not.toHaveBeenCalled();
  });
});

describe("controle: a saída comum feita de fora do CRM", () => {
  it("segue calando o agente — quem respondeu pelo celular está atendendo", async () => {
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: saida({ sentVia: null, broadcastId: null, text: "te paso el precio" }),
    });
    expect(vi.mocked(ecoDaTransmissao)).not.toHaveBeenCalled();
    expect(vi.mocked(pausarIaPorAtendimentoManual)).toHaveBeenCalledTimes(1);
    expect(insertDaMensagem().body).toBe("te paso el precio");
  });
});
