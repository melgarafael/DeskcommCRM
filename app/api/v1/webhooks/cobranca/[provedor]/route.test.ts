import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  ligada: true,
  segredo: "whsec_teste" as string | null,
  sinal: { eventoId: "evt_1", tipo: "invoice.paid", clienteRef: "cus_1" } as { eventoId: string; tipo: string; clienteRef: string | null } | null,
  permitido: true,
  baldes: [] as string[],
  aviso: vi.fn(),
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => h.ligada }));
vi.mock("@/lib/cobranca/configuracao", () => ({ segredoDoWebhook: async () => h.segredo }));
vi.mock("@/lib/cobranca/provedores", () => ({ adaptador: () => ({ verificarWebhook: () => h.sinal }) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (balde: string) => {
    h.baldes.push(balde);
    return { allowed: h.permitido };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.aviso, error: vi.fn(), info: vi.fn() } }));

import { POST } from "./route";

const ORG = "cccccccc-0000-4000-8000-000000000001";

interface Mundo { duplicado: boolean; statusExistente: string; dona: { organization_id: string } | null; emit: Resposta }
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "webhook_events_log") {
    const op = operacao(c);
    if (op === "insert") return m.duplicado ? { error: { code: "23505", message: "dup" } } : { data: { id: "linha-1", status: "received" } };
    if (op === "select") return { data: { id: "linha-1", status: m.statusExistente } };
    return { data: null };
  }
  if (c.tabela === "cobranca_assinaturas") return { data: m.dona };
  return {};
}

const pedido = (provedor = "stripe", corpo = '{"id":"evt_1"}', ip: string | null = "10.0.0.1") =>
  POST(
    new NextRequest(`http://localhost/api/v1/webhooks/cobranca/${provedor}`, {
      method: "POST",
      body: corpo,
      headers: { "stripe-signature": "t=1,v1=ab", ...(ip ? { "x-forwarded-for": ip } : {}) },
    }),
    { params: Promise.resolve({ provedor }) },
  );
const doLog = (op: string) => h.banco.cadeias.filter((c) => c.tabela === "webhook_events_log" && operacao(c) === op);
const emits = () => h.banco.rpcs.filter((r) => r.nome === "emit_event");

beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = true;
  h.segredo = "whsec_teste";
  h.sinal = { eventoId: "evt_1", tipo: "invoice.paid", clienteRef: "cus_1" };
  h.permitido = true;
  h.baldes = [];
  m = { duplicado: false, statusExistente: "received", dona: { organization_id: ORG }, emit: { data: "ev-1" } };
  h.banco = bancoFalso(responder, () => m.emit);
});

describe("webhook da cobrança", () => {
  it("provedor fora da lista, chave desligada ou sem segredo: 404 e nada gravado", async () => {
    expect((await pedido("mercadopago")).status).toBe(404);
    h.ligada = false;
    expect((await pedido()).status).toBe(404);
    h.ligada = true;
    h.segredo = null;
    expect((await pedido()).status).toBe(404);
    expect(h.banco.cadeias.filter((c) => c.tabela === "webhook_events_log")).toEqual([]);
  });

  it("⭐ assinatura inválida: 401 e deixa RASTRO que o dono vê (linha valid_signature=false, sem org, sem id, sem cabeçalhos)", async () => {
    h.sinal = null;
    expect((await pedido()).status).toBe(401);
    expect(doLog("insert").map((c) => argumentos(c, "insert")?.[0])).toEqual([
      {
        organization_id: null, provider: "stripe", raw_body: "{}", headers: null, signature_header: null,
        valid_signature: false, external_id: null, status: "error", error_message: "assinatura_invalida",
      },
    ]);
    expect(h.aviso).toHaveBeenCalledWith("cobranca.webhook_recusado", { provedor: "stripe", motivo: "assinatura_invalida" });
    expect(emits()).toEqual([]);
  });

  it("⭐ válido: ponteiro sem org, sem cabeçalhos e com corpo {id,type}; emite o sinal e fecha a linha", async () => {
    const res = await pedido();
    expect(res.status).toBe(200);
    expect(argumentos(doLog("insert")[0]!, "insert")?.[0]).toEqual({
      organization_id: null, provider: "stripe", raw_body: '{"id":"evt_1","type":"invoice.paid"}', headers: null,
      signature_header: "t=1,v1=ab", valid_signature: true, external_id: "evt_1", event_type: "invoice.paid", status: "received",
    });
    expect(emits()[0]?.args).toEqual({
      p_event_type: "cobranca.sinal", p_entity_kind: "organization", p_entity_id: ORG,
      p_payload: { provedor: "stripe", evento_id: "evt_1", tipo: "invoice.paid" }, p_metadata: { origem: "webhook_cobranca" }, p_organization_id: ORG,
    });
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "processed" });
  });

  it("⭐ duplicado já processado: 200 sem emitir", async () => {
    m.duplicado = true;
    m.statusExistente = "processed";
    expect((await pedido()).status).toBe(200);
    expect(emits()).toEqual([]);
  });

  it("⭐ duplicado ainda received (o emit anterior falhou): emite de novo e fecha a linha", async () => {
    m.duplicado = true;
    expect((await pedido()).status).toBe(200);
    expect(emits()).toHaveLength(1);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "processed" });
  });

  it("cliente desconhecido: linha error com o motivo, 200 e nenhum sinal (a reconciliação cura)", async () => {
    m.dona = null;
    expect((await pedido()).status).toBe(200);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "error", error_message: "cliente_desconhecido" });
    expect(emits()).toEqual([]);
  });

  it("emit que falha: 503 e a linha fica received (o provedor reentrega)", async () => {
    m.emit = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await pedido()).status).toBe(503);
    expect(doLog("update")).toEqual([]);
  });

  it("⭐ aviso VÁLIDO nunca recebe 429, mesmo com o balde de recusas cheio (a reativação de quem pagou não espera)", async () => {
    h.permitido = false;
    expect((await pedido()).status).toBe(200);
    expect(h.baldes).toEqual([]);
  });

  it("assinatura inválida acima de 120/min do mesmo IP: 429 e nenhuma linha", async () => {
    h.sinal = null;
    h.permitido = false;
    expect((await pedido()).status).toBe(429);
    expect(h.baldes).toEqual(["cobranca-webhook-recusado:10.0.0.1"]);
    expect(doLog("insert")).toEqual([]);
  });

  it("recusa sem proxy à frente conta num balde próprio de recusas (só recusas o dividem)", async () => {
    h.sinal = null;
    await pedido("stripe", '{"id":"evt_1"}', null);
    expect(h.baldes).toEqual(["cobranca-webhook-recusado:sem-proxy"]);
  });

  it("corpo acima de 1 MB: 413", async () => {
    expect((await pedido("stripe", "x".repeat(1_048_577))).status).toBe(413);
    expect(doLog("insert")).toEqual([]);
  });
});
