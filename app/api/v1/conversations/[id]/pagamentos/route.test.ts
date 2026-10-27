import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  autorizado: true,
  chamadas: [] as unknown[],
  resultado: {} as unknown,
  aviso: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    h.autorizado
      ? { ok: true, org: { orgId: "cccccccc-0000-4000-8000-000000000001", role: "agent" } }
      : { ok: false, response: new Response("{}", { status: 403 }) },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: h.aviso } }));
vi.mock("@/lib/pagamentos/registrar", () => ({
  registrarLinkDoPagamento: async (_admin: unknown, entrada: unknown) => {
    h.chamadas.push(entrada);
    return h.resultado;
  },
}));

import { POST } from "./route";

const CONV = "cccccccc-0000-4000-8000-000000000002";
const MSG = "cccccccc-0000-4000-8000-000000000003";
const LINK = "https://pay.infinitepay.io/abc123";

const corpo = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    mensagem_id: MSG,
    provedor: "infinitepay",
    id_externo: "pay_123",
    valor_cents: 15000,
    link: LINK,
    ...over,
  });

const pedir = (over: Record<string, unknown> = {}, conversa = CONV) =>
  POST(new NextRequest(`http://localhost/api/v1/conversations/${conversa}/pagamentos`, { method: "POST", body: corpo(over) }), {
    params: Promise.resolve({ id: conversa }),
  });

const sucesso = {
  ok: true,
  reutilizado: false,
  recebimento: {
    id: "cccccccc-0000-4000-8000-000000000005",
    status: "pendente",
    valor_cents: 15000,
    moeda: "BRL",
    pago_em: null,
  },
  pagamento: {
    provedor: "infinitepay",
    id: "pay_123",
    valor: 15000,
    moeda: "BRL",
    status: "pendente",
    recebimento_id: "cccccccc-0000-4000-8000-000000000005",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.autorizado = true;
  h.chamadas = [];
  h.resultado = sucesso;
});

describe("POST /conversations/[id]/pagamentos", () => {
  it("⭐ registra o link e devolve 201 com valor e status pendente (o que a conversa mostra)", async () => {
    const r = await pedir();
    expect(r.status).toBe(201);
    const json = (await r.json()) as { data: { status: string; valor_cents: number; pagamento: { status: string } } };
    expect(json.data.status).toBe("pendente");
    expect(json.data.valor_cents).toBe(15000);
    expect(json.data.pagamento.status).toBe("pendente");
    // A organização vem da SESSÃO, nunca do corpo.
    expect(h.chamadas[0]).toMatchObject({
      organizationId: "cccccccc-0000-4000-8000-000000000001",
      conversationId: CONV,
      messageId: MSG,
      valorCents: 15000,
    });
  });

  it("provedor fora da lista: 400 antes de qualquer chamada", async () => {
    const r = await pedir({ provedor: "stripe" });
    expect(r.status).toBe(400);
    expect(h.chamadas).toEqual([]);
  });

  it("valor em centavos inteiro positivo: zero/negativo/fracionário são 400", async () => {
    for (const valor of [0, -100, 10.5]) {
      const r = await pedir({ valor_cents: valor });
      expect(r.status).toBe(400);
    }
    expect(h.chamadas).toEqual([]);
  });

  it("conversa que não é uuid: 400", async () => {
    const r = await pedir({}, "nao-e-uuid");
    expect(r.status).toBe(400);
  });

  it("sem papel suficiente: a resposta do gate passa intacta", async () => {
    h.autorizado = false;
    const r = await pedir();
    expect(r.status).toBe(403);
    expect(h.chamadas).toEqual([]);
  });

  it("repetir o clique devolve 200 (não é erro) e marca `reutilizado`", async () => {
    h.resultado = { ...sucesso, reutilizado: true };
    const r = await pedir();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: { reutilizado: boolean } }).data.reutilizado).toBe(true);
  });

  it("erro do serviço é traduzido para o status certo (409 e 422 não viram 500)", async () => {
    h.resultado = { ok: false, code: "state_conflict", status: 409, message: "já registrado em outra conversa" };
    expect((await pedir()).status).toBe(409);

    h.resultado = { ok: false, code: "validation_failed", status: 422, message: "link fora do corpo" };
    expect((await pedir()).status).toBe(422);
  });
});
