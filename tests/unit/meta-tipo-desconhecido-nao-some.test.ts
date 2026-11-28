import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

/**
 * #4580 (ponto extra): no canal oficial, mensagem de tipo fora do vocabulário
 * do banco SUMIA sem aviso.
 *
 * O parser passava o `type` cru da Meta adiante, e o CHECK
 * `messages_type_check` recusava o INSERT de qualquer valor fora da lista
 * (`unsupported`, `order`, o `"unknown"` que o parser põe quando o payload vem
 * sem `type`). A rota responde 2xx do mesmo jeito — a Meta não re-entrega — e a
 * falha ficava só no `console.error` do contêiner: nem mensagem, nem aviso.
 *
 * O conserto segue o precedente do canal por QR (`mapWahaMessageType`): tipo
 * desconhecido entra como `text`, e o tipo cru fica em `metadata.raw_type`. Sem
 * marcador no corpo, de propósito: o corpo é o que o cliente escreveu, e um
 * marcador chegaria ao agente como fala do cliente.
 *
 * Os payloads de `unsupported` e `order` seguem a referência da Meta
 * (webhooks/reference/messages) — não foram capturados de uma WABA real.
 */

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async () => undefined,
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({
  pausarIaPorAtendimentoManual: async () => true,
}));

import { ingestMetaEcho, ingestMetaInbound } from "@/lib/channels/meta/ingest";
import {
  parseMetaWebhook,
  type InboundMessageEvent,
  type OutboundEchoEvent,
} from "@/lib/channels/meta/webhook";

type Linha = Record<string, unknown>;

/**
 * O vocabulário que o banco aceita, lido do CHECK — nunca uma cópia escrita
 * aqui. `lastIndexOf`: o baseline é dump + apêndices, e a definição que vale é
 * a ÚLTIMA.
 */
function vocabularioDoBanco(): Set<string> {
  const baseline = readFileSync("supabase/baseline.sql", "utf8");
  const inicio = baseline.lastIndexOf("add constraint messages_type_check");
  expect(inicio, "não achei o CHECK de messages.type no baseline").toBeGreaterThan(-1);
  const trecho = baseline.slice(inicio, baseline.indexOf("]))", inicio));
  const valores = new Set([...trecho.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
  expect(valores.size, "o CHECK lido veio vazio — o instrumento perdeu o alvo").toBeGreaterThan(5);
  return valores;
}

const UNSUPPORTED = {
  type: "unsupported",
  errors: [
    {
      code: 131051,
      title: "Message type unknown",
      message: "Message type unknown",
      error_data: { details: "Message type is currently not supported." },
    },
  ],
};

const ORDER = {
  type: "order",
  order: {
    catalog_id: "catalogo-1",
    text: "quero estes",
    product_items: [{ product_retailer_id: "SKU-1", quantity: 1, item_price: 10, currency: "BRL" }],
  },
};

/** Sem `type` no payload: o parser usa `"unknown"`, que o CHECK também recusa. */
const SEM_TIPO = {};

const DESCONHECIDOS: Array<[string, Record<string, unknown>, string]> = [
  ["unsupported", UNSUPPORTED, "unsupported"],
  ["order", ORDER, "order"],
  ["sem type", SEM_TIPO, "unknown"],
];

function envelope(campo: "messages" | "smb_message_echoes", mensagem: Record<string, unknown>) {
  const base = { id: "wamid.T1", timestamp: "1785342028", ...mensagem };
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: campo,
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511300000000", phone_number_id: "phone-1" },
              ...(campo === "messages"
                ? {
                    contacts: [{ wa_id: "5531900000001", profile: { name: "Ana" } }],
                    messages: [{ from: "5531900000001", ...base }],
                  }
                : { message_echoes: [{ from: "5511300000000", to: "5531900000001", ...base }] }),
            },
          },
        ],
      },
    ],
  } as unknown as Parameters<typeof parseMetaWebhook>[0];
}

function recebida(mensagem: Record<string, unknown>): InboundMessageEvent {
  const eventos = parseMetaWebhook(envelope("messages", mensagem)).filter(
    (e): e is InboundMessageEvent => e.kind === "inbound_message",
  );
  expect(eventos, "o parser não devolveu a mensagem recebida").toHaveLength(1);
  return eventos[0]!;
}

function eco(mensagem: Record<string, unknown>): OutboundEchoEvent {
  const eventos = parseMetaWebhook(envelope("smb_message_echoes", mensagem)).filter(
    (e): e is OutboundEchoEvent => e.kind === "outbound_echo",
  );
  expect(eventos, "o parser não devolveu o eco").toHaveLength(1);
  return eventos[0]!;
}

/** Banco falso: captura o INSERT em `messages`; o resto engole qualquer cadeia. */
function adminFalso(): { admin: unknown; inseridas: Linha[] } {
  const inseridas: Linha[] = [];
  const cadeia = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "update", "upsert", "delete", "eq", "neq", "in", "is", "gte", "lte", "or", "order", "limit"]) {
      q[m] = () => q;
    }
    q.maybeSingle = async () => ({ data: null, error: null });
    q.single = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(ok, ko);
    return q;
  };
  const from = (tabela: string) =>
    tabela !== "messages"
      ? cadeia()
      : {
          ...cadeia(),
          insert: (linha: Linha) => {
            inseridas.push(linha);
            return {
              select: () => ({
                maybeSingle: async () => ({ data: { id: `msg-${inseridas.length}` }, error: null }),
              }),
            };
          },
        };
  const rpc = async (fn: string) => {
    if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
    if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
    return { data: null, error: null };
  };
  return { admin: { from, rpc }, inseridas };
}

const DONO = { organizationId: "org-1", channelSessionId: "sessao-1" };

describe("recebida: tipo desconhecido entra como texto, com o tipo cru preservado", () => {
  it.each(DESCONHECIDOS)("%s", (_nome, mensagem, cru) => {
    const e = recebida(mensagem);
    expect(e).toMatchObject({ type: "text", rawType: cru, text: null, media: null });
  });
});

describe("eco da coexistência: tipo desconhecido entra como texto, com o tipo cru preservado", () => {
  it.each(DESCONHECIDOS)("%s", (_nome, mensagem, cru) => {
    const e = eco(mensagem);
    expect(e).toMatchObject({ type: "text", rawType: cru, text: null, media: null });
  });
});

describe("o tipo que sai do parser cabe no CHECK do banco — nos dois pontos", () => {
  const tiposDaMeta = [
    "text", "image", "video", "audio", "document", "sticker", "location",
    "contacts", "button", "interactive", "system", "unsupported", "order", "request_welcome",
  ];

  it.each(tiposDaMeta)("%s", (tipo) => {
    const banco = vocabularioDoBanco();
    expect(banco.has(recebida({ type: tipo }).type), "recebida").toBe(true);
    expect(banco.has(eco({ type: tipo }).type), "eco").toBe(true);
  });

  it("sem type", () => {
    const banco = vocabularioDoBanco();
    expect(banco.has(recebida(SEM_TIPO).type), "recebida").toBe(true);
    expect(banco.has(eco(SEM_TIPO).type), "eco").toBe(true);
  });
});

describe("o que já funcionava não muda", () => {
  // Todo valor do CHECK que a Meta pode mandar passa como veio, sem `rawType`.
  // `reaction` na recebida tem evento próprio (#2797) e fica fora daqui.
  const valido = ["text", "image", "video", "audio", "document", "sticker", "location", "contact", "system", "template"];

  it.each(valido)("recebida %s passa como veio, sem rawType", (tipo) => {
    const e = recebida({ type: tipo });
    expect(e.type).toBe(tipo);
    expect(e).not.toHaveProperty("rawType");
  });

  it.each([...valido, "reaction"])("eco %s passa como veio, sem rawType", (tipo) => {
    const e = eco({ type: tipo });
    expect(e.type).toBe(tipo);
    expect(e).not.toHaveProperty("rawType");
  });

  it("cartão (`contacts`) continua virando `contact`, nos dois pontos", () => {
    const cartao = { type: "contacts", contacts: [{ name: { formatted_name: "Bia" }, phones: [{ phone: "+5531988887777" }] }] };
    for (const e of [recebida(cartao), eco(cartao)]) {
      expect(e.type).toBe("contact");
      expect(e).not.toHaveProperty("rawType");
    }
  });

  it("clique de botão continua texto com o rótulo, sem rawType", () => {
    const botao = recebida({ type: "button", button: { payload: "SIM", text: "Sim" } });
    expect([botao.type, botao.text]).toEqual(["text", "Sim"]);
    expect(botao).not.toHaveProperty("rawType");
    const lista = recebida({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "l1", title: "Agenda" } } });
    expect([lista.type, lista.text]).toEqual(["text", "Agenda"]);
    expect(lista).not.toHaveProperty("rawType");
  });

  it("texto continua com o corpo", () => {
    const e = recebida({ type: "text", text: { body: "oi" } });
    expect([e.type, e.text]).toEqual(["text", "oi"]);
  });
});

describe("ingestão: a linha nasce, e o tipo cru vai para metadata.raw_type", () => {
  it("recebida `unsupported` vira linha de texto sem corpo", async () => {
    const { admin, inseridas } = adminFalso();
    const r = await ingestMetaInbound(admin as never, recebida(UNSUPPORTED), DONO);
    expect(r.status, JSON.stringify(r)).toBe("ingested");
    expect(inseridas).toHaveLength(1);
    expect(inseridas[0]).toMatchObject({ type: "text", body: null, direction: "inbound" });
    expect(inseridas[0]!.metadata).toMatchObject({ raw_type: "unsupported" });
  });

  it("eco `unsupported` vira saída de texto sem corpo, ainda marcada como do app", async () => {
    const { admin, inseridas } = adminFalso();
    const r = await ingestMetaEcho(admin as never, eco(UNSUPPORTED), DONO);
    expect(r.status, JSON.stringify(r)).toBe("ingested");
    expect(inseridas).toHaveLength(1);
    expect(inseridas[0]).toMatchObject({ type: "text", body: null, direction: "outbound" });
    expect(inseridas[0]!.metadata).toMatchObject({ raw_type: "unsupported", from_business_app: true });
  });

  it("tipo conhecido não ganha raw_type — o metadata de sempre", async () => {
    const { admin, inseridas } = adminFalso();
    await ingestMetaInbound(admin as never, recebida({ type: "text", text: { body: "oi" } }), DONO);
    const ecoAdmin = adminFalso();
    await ingestMetaEcho(ecoAdmin.admin as never, eco({ type: "text", text: { body: "já respondi" } }), DONO);
    expect(inseridas[0]!.metadata).not.toHaveProperty("raw_type");
    expect(ecoAdmin.inseridas[0]!.metadata).not.toHaveProperty("raw_type");
  });
});
