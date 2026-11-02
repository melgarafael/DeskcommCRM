import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  argumentos,
  bancoFalso,
  operacao,
  valorDoFiltro,
  type BancoFalso,
  type Cadeia,
  type Resposta,
} from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ erro: vi.fn(), aviso: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.aviso, error: h.erro, info: vi.fn() } }));

import { registrarLinkDoPagamento, type Recebimento } from "./registrar";

const ORG = "cccccccc-0000-4000-8000-000000000001";
const CONV = "cccccccc-0000-4000-8000-000000000002";
const MSG = "cccccccc-0000-4000-8000-000000000003";
const LEAD = "cccccccc-0000-4000-8000-000000000004";
const REC = "cccccccc-0000-4000-8000-000000000005";
const CONTATO = "cccccccc-0000-4000-8000-000000000006";
const LINK = "https://pay.infinitepay.io/abc123";

interface MensagemFalsa {
  id: string;
  conversation_id: string;
  contact_id: string | null;
  direction: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
}

const recebimento = (over: Partial<Recebimento> = {}): Recebimento => ({
  id: REC,
  organization_id: ORG,
  conversation_id: CONV,
  message_id: MSG,
  lead_id: LEAD,
  provedor: "infinitepay",
  external_id: "pay_123",
  valor_cents: 15000,
  moeda: "BRL",
  status: "pendente",
  pago_em: null,
  ...over,
});

interface Mundo {
  mensagem: MensagemFalsa | null;
  leads: Array<{ id: string }>;
  insert: Resposta;
  existente: Recebimento | null;
  patch: Resposta;
}

let m: Mundo;
let banco: BancoFalso;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "messages") {
    const op = operacao(c);
    if (op === "update") return m.patch;
    return { data: m.mensagem };
  }
  if (c.tabela === "crm_leads") return { data: m.leads };
  if (c.tabela === "pagamento_recebimentos") {
    const op = operacao(c);
    if (op === "insert") return m.insert;
    // A releitura tanto por message_id (idempotência do botão) quanto por
    // (provedor, id externo) (o 23505 do índice único) cai aqui.
    return { data: m.existente };
  }
  return {};
}

const pedido = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  conversationId: CONV,
  messageId: MSG,
  provedor: "infinitepay" as const,
  externalId: "pay_123",
  valorCents: 15000,
  link: LINK,
  ...over,
});

const cadeia = (tabela: string, op: string) =>
  banco.cadeias.filter((c) => c.tabela === tabela && operacao(c) === op);

beforeEach(() => {
  vi.clearAllMocks();
  m = {
    mensagem: {
      id: MSG,
      conversation_id: CONV,
      contact_id: CONTATO,
      direction: "outbound",
      body: `segue o link: ${LINK}`,
      metadata: { queued_reason: "canal fora" },
    },
    leads: [{ id: LEAD }],
    insert: { data: recebimento() },
    existente: null,
    patch: { data: null },
  };
  banco = bancoFalso(responder);
});

describe("registrar o link na conversa", () => {
  it("⭐ caminho feliz: grava o recebimento pendente e o ponteiro na mensagem, preservando o metadata", async () => {
    const r = await registrarLinkDoPagamento(banco.cliente as never, pedido());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reutilizado).toBe(false);
    expect(r.recebimento.id).toBe(REC);

    const gravado = argumentos(cadeia("pagamento_recebimentos", "insert")[0]!, "insert")?.[0];
    expect(gravado).toEqual({
      organization_id: ORG,
      conversation_id: CONV,
      message_id: MSG,
      lead_id: LEAD,
      provedor: "infinitepay",
      external_id: "pay_123",
      valor_cents: 15000,
      moeda: "BRL",
      status: "pendente",
    });

    // O ponteiro: o metadata ANTERIOR sobrevive — o balão não perde o que sabia.
    const patch = argumentos(cadeia("messages", "update")[0]!, "update")?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(patch.metadata.queued_reason).toBe("canal fora");
    expect(patch.metadata.pagamento).toEqual({
      provedor: "infinitepay",
      id: "pay_123",
      valor: 15000,
      moeda: "BRL",
      status: "pendente",
      recebimento_id: REC,
    });
  });

  it("⭐ mensagem de outra conversa/organização: 404 e NADA é gravado", async () => {
    m.mensagem = null;
    const r = await registrarLinkDoPagamento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: false, code: "not_found", status: 404 });
    expect(banco.cadeias.filter((c) => c.tabela === "pagamento_recebimentos")).toEqual([]);
    expect(cadeia("messages", "update")).toEqual([]);
  });

  it("o filtro da mensagem carrega organização E conversa (não é busca por id solto)", async () => {
    await registrarLinkDoPagamento(banco.cliente as never, pedido());
    const select = banco.cadeias.find((c) => c.tabela === "messages")!;
    expect(valorDoFiltro(select, "eq", "organization_id")).toBe(ORG);
    expect(valorDoFiltro(select, "eq", "conversation_id")).toBe(CONV);
    expect(valorDoFiltro(select, "eq", "id")).toBe(MSG);
  });

  it("⭐ link que não está no corpo da mensagem: 422 e nada gravado", async () => {
    m.mensagem!.body = "outro link: https://pay.infinitepay.io/outro";
    const r = await registrarLinkDoPagamento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: false, code: "validation_failed", status: 422 });
    expect(banco.cadeias.filter((c) => c.tabela === "pagamento_recebimentos")).toEqual([]);
  });

  it("⭐ mensagem que o CLIENTE mandou: 422 (link recebido não é cobrança nossa)", async () => {
    m.mensagem!.direction = "inbound";
    const r = await registrarLinkDoPagamento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: false, status: 422 });
  });

  it("valor zero/negativo, link http e id com espaço são recusados ANTES de tocar o banco", async () => {
    for (const ruim of [
      pedido({ valorCents: 0 }),
      pedido({ valorCents: -100 }),
      pedido({ valorCents: 1.5 }),
      pedido({ link: "http://pay.infinitepay.io/abc123" }),
      pedido({ externalId: "com espaco" }),
    ]) {
      const r = await registrarLinkDoPagamento(banco.cliente as never, ruim);
      expect(r).toMatchObject({ ok: false, status: 422 });
    }
    expect(banco.cadeias).toEqual([]);
  });

  it("sem negócio aberto único, o recebimento nasce com lead_id nulo (o pagamento continua válido)", async () => {
    m.leads = [];
    await registrarLinkDoPagamento(banco.cliente as never, pedido());
    const gravado = argumentos(cadeia("pagamento_recebimentos", "insert")[0]!, "insert")?.[0] as {
      lead_id: string | null;
    };
    expect(gravado.lead_id).toBeNull();
  });

  it("DOIS negócios abertos do contato: não escolhe nenhum (lead_id nulo)", async () => {
    m.leads = [{ id: LEAD }, { id: "cccccccc-0000-4000-8000-0000000000ff" }];
    await registrarLinkDoPagamento(banco.cliente as never, pedido());
    const gravado = argumentos(cadeia("pagamento_recebimentos", "insert")[0]!, "insert")?.[0] as {
      lead_id: string | null;
    };
    expect(gravado.lead_id).toBeNull();
  });

  it("⭐ repetir o clique: mesmo pagamento na mesma mensagem é REUTILIZADO, sem gravar de novo", async () => {
    m.mensagem!.metadata = {
      pagamento: {
        provedor: "infinitepay",
        id: "pay_123",
        valor: 15000,
        moeda: "BRL",
        status: "pendente",
        recebimento_id: REC,
      },
    };
    m.existente = recebimento();
    const r = await registrarLinkDoPagamento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: true, reutilizado: true });
    expect(cadeia("pagamento_recebimentos", "insert")).toEqual([]);
  });

  it("⭐ 23505 com a MESMA mensagem: reutiliza (o retry da tela não vira erro)", async () => {
    m.insert = { error: { code: "23505", message: "duplicate key" } };
    m.existente = recebimento();
    const r = await registrarLinkDoPagamento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: true, reutilizado: true });
  });

  it("⭐ 23505 com OUTRA mensagem: 409 — o mesmo pagamento não vive em duas conversas", async () => {
    m.insert = { error: { code: "23505", message: "duplicate key" } };
    m.existente = recebimento({ message_id: "cccccccc-0000-4000-8000-0000000000aa" });
    const r = await registrarLinkDoPagamento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: false, code: "state_conflict", status: 409 });
  });

  it("falha de escrita do recebimento que não é 23505: 500 e o ponteiro NÃO é escrito", async () => {
    m.insert = { error: { code: "23503", message: "fk" } };
    const r = await registrarLinkDoPagamento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: false, code: "internal_error", status: 500 });
    expect(cadeia("messages", "update")).toEqual([]);
    expect(h.erro).toHaveBeenCalled();
  });

  it("metadata não gravado: 500 (a tela repete, e o retry cai no caminho reutilizado)", async () => {
    m.patch = { error: { code: "42501", message: "rls" } };
    const r = await registrarLinkDoPagamento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: false, code: "internal_error", status: 500 });
  });
});
