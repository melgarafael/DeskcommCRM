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

interface Mundo {
  duplicado: boolean;
  statusExistente: string;
  dona: { organization_id: string } | null;
  erroDona: boolean;
  emit: Resposta;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "webhook_events_log") {
    const op = operacao(c);
    if (op === "insert") return m.duplicado ? { error: { code: "23505", message: "dup" } } : { data: { id: "linha-1", status: "received" } };
    if (op === "select") return { data: { id: "linha-1", status: m.statusExistente } };
    return { data: null };
  }
  if (c.tabela === "cobranca_assinaturas") return m.erroDona ? { error: { code: "08000", message: "sem banco" } } : { data: m.dona };
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
const selects = () => h.banco.cadeias.filter((c) => c.tabela === "webhook_events_log" && operacao(c) === "select");
const gravado = () => argumentos(doLog("insert")[0]!, "insert")?.[0] as Record<string, unknown> | undefined;
const emits = () => h.banco.rpcs.filter((r) => r.nome === "emit_event");
const TOKEN_ASAAS = ["token", "do", "aviso", "0123456789abcdef"].join("_");
const doAsaas = (headers: Record<string, string>) =>
  POST(
    new NextRequest("http://localhost/api/v1/webhooks/cobranca/asaas", { method: "POST", body: '{"id":"evt_1"}', headers }),
    { params: Promise.resolve({ provedor: "asaas" }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = true;
  h.segredo = "whsec_teste";
  h.sinal = { eventoId: "evt_1", tipo: "invoice.paid", clienteRef: "cus_1" };
  h.permitido = true;
  h.baldes = [];
  m = { duplicado: false, statusExistente: "received", dona: { organization_id: ORG }, erroDona: false, emit: { data: "ev-1" } };
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

  it("⭐ assinatura inválida: 401 e deixa RASTRO que o dono vê — com o corpo CRU, sem org, sem id, sem cabeçalhos (#3870)", async () => {
    h.sinal = null;
    expect((await pedido()).status).toBe(401);
    expect(gravado()).toEqual({
      organization_id: null, provider: "stripe", raw_body: '{"id":"evt_1"}', headers: null, signature_header: null,
      valid_signature: false, external_id: null, event_type: null, status: "error", error_message: "assinatura_invalida",
    });
    expect(h.aviso).toHaveBeenCalledWith("cobranca.webhook_recusado", { provedor: "stripe", motivo: "assinatura_invalida" });
    expect(emits()).toEqual([]);
  });

  it("⭐ válido: grava o aviso COMO CHEGOU (raw_body = bytes recebidos) e os cabeçalhos, sem org; emite o sinal e fecha a linha", async () => {
    const res = await pedido();
    expect(res.status).toBe(200);
    expect(gravado()).toEqual({
      organization_id: null, provider: "stripe", raw_body: '{"id":"evt_1"}',
      headers: { "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": "10.0.0.1" },
      signature_header: "t=1,v1=ab", valid_signature: true, external_id: "evt_1", event_type: "invoice.paid", status: "received", error_message: null,
    });
    expect(emits()[0]?.args).toEqual({
      p_event_type: "cobranca.sinal", p_entity_kind: "organization", p_entity_id: ORG,
      p_payload: { provedor: "stripe", evento_id: "evt_1", tipo: "invoice.paid" }, p_metadata: { origem: "webhook_cobranca" }, p_organization_id: ORG,
    });
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "processed" });
  });

  it("⭐ o corpo gravado é byte a byte o que chegou, formatação e acento inclusive", async () => {
    const corpo = '{\n  "id": "evt_1",\n  "cliente": { "nome": "João Conceição" }\n}\n';
    expect((await pedido("stripe", corpo)).status).toBe(200);
    expect(gravado()?.raw_body).toBe(corpo);
  });

  it("⭐ duplicado já processado: 200 sem emitir e UMA linha só (o 23505 do índice de cobrança)", async () => {
    m.duplicado = true;
    m.statusExistente = "processed";
    expect((await pedido()).status).toBe(200);
    expect(emits()).toEqual([]);
    // Uma tentativa de insert, nenhuma linha nova; a reentrega acha a existente pelo (provider, external_id).
    expect(doLog("insert")).toHaveLength(1);
    const filtros = selects()[0]?.passos.filter((p) => p.metodo === "eq").map((p) => p.args);
    expect(filtros).toEqual([["provider", "stripe"], ["external_id", "evt_1"]]);
    // E não regrava o corpo da linha já existente: ele já é o aviso cru, e a poda pode tê-la esvaziado.
    expect(doLog("update").some((c) => "raw_body" in ((argumentos(c, "update")?.[0] as object) ?? {}))).toBe(false);
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

  it("emit que falha: 503 e a linha fica received COM o corpo cru (o provedor reentrega)", async () => {
    m.emit = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await pedido()).status).toBe(503);
    expect(doLog("update")).toEqual([]);
    expect(gravado()?.raw_body).toBe('{"id":"evt_1"}');
  });

  it("⭐ processamento que LANÇA: o aviso cru já está gravado quando o emit explode", async () => {
    h.banco = bancoFalso(responder, () => {
      throw new Error("boom no emit");
    });
    await expect(pedido()).rejects.toThrow("boom no emit");
    expect(gravado()).toMatchObject({ raw_body: '{"id":"evt_1"}', external_id: "evt_1", status: "received" });
  });

  it("⭐ a leitura da empresa falha: 500 mas o corpo cru fica gravado (não some com o erro)", async () => {
    m.erroDona = true;
    expect((await pedido()).status).toBe(500);
    expect(gravado()).toMatchObject({ raw_body: '{"id":"evt_1"}', valid_signature: true, status: "error", error_message: "falha_ao_identificar_empresa" });
  });

  it("⭐ corpo VAZIO: a linha guarda vazio, nunca '{}'", async () => {
    h.sinal = null;
    expect((await pedido("stripe", "")).status).toBe(401);
    expect(gravado()).toMatchObject({ raw_body: "", error_message: "corpo_vazio" });
  });

  it("⭐ JSON malformado: 401 com erro NOMEADO e o corpo cru na linha — nunca 500 mudo", async () => {
    h.sinal = null;
    const res = await pedido("stripe", '{"id":');
    expect(res.status).toBe(401);
    expect(gravado()).toMatchObject({ raw_body: '{"id":', error_message: "corpo_malformado", status: "error" });
  });

  it("⭐ o corpo cru NUNCA vai para o log de aplicação (o banco é o arquivo, não o console)", async () => {
    h.sinal = null;
    await pedido("stripe", '{"cliente":{"email":"cliente@exemplo.com","cpf":"12345678901"}}');
    expect(gravado()?.raw_body).toBe('{"cliente":{"email":"cliente@exemplo.com","cpf":"12345678901"}}');
    expect(JSON.stringify(h.aviso.mock.calls)).not.toContain("cliente@exemplo.com");
    expect(JSON.stringify(h.aviso.mock.calls)).not.toContain("12345678901");
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

describe("webhook da cobrança pelo Asaas (PR 3b)", () => {
  it("⭐ Asaas: o token do cabeçalho nunca é gravado — nem como assinatura, que só a Stripe tem", async () => {
    const res = await doAsaas({ "asaas-access-token": TOKEN_ASAAS, "stripe-signature": "t=1,v1=forjada", "x-correlation-id": "corr-1" });
    expect(res.status).toBe(200);
    expect(gravado()).toMatchObject({ provider: "asaas", signature_header: null });
    // Os cabeçalhos úteis ficam (é o que se lê no dia do incidente); a credencial e a assinatura forjada, não.
    expect(gravado()?.headers).toEqual({ "content-type": "text/plain;charset=UTF-8", "x-correlation-id": "corr-1" });
    expect(JSON.stringify([h.banco.cadeias, h.banco.rpcs])).not.toContain(TOKEN_ASAAS);
  });

  it("Asaas com token errado: 401, a linha de recusa sem token e sem assinatura", async () => {
    h.sinal = null;
    expect((await doAsaas({ "asaas-access-token": TOKEN_ASAAS, "stripe-signature": "t=1,v1=forjada" })).status).toBe(401);
    expect(gravado()).toMatchObject({ provider: "asaas", signature_header: null, valid_signature: false, raw_body: '{"id":"evt_1"}' });
    expect(JSON.stringify(h.banco.cadeias)).not.toContain(TOKEN_ASAAS);
  });

  it("⭐ token vazado inundando com clientes que não existem: acima do balde, 200 SEM gravar linha (429 pararia a fila do Asaas)", async () => {
    m.dona = null;
    h.permitido = false;
    const res = await doAsaas({ "asaas-access-token": TOKEN_ASAAS, "x-forwarded-for": "10.0.0.9" });
    expect(res.status).toBe(200);
    // Trocar o x-forwarded-for não troca o balde: a chave é global por provedor.
    await doAsaas({ "asaas-access-token": TOKEN_ASAAS, "x-forwarded-for": "10.0.0.10" });
    expect(h.baldes).toEqual(["cobranca-webhook-desconhecido:asaas", "cobranca-webhook-desconhecido:asaas"]);
    expect(doLog("insert")).toEqual([]);
  });

  it("abaixo do balde, o aviso de cliente desconhecido do Asaas segue gravado como antes (a reconciliação cura)", async () => {
    m.dona = null;
    expect((await doAsaas({ "asaas-access-token": TOKEN_ASAAS })).status).toBe(200);
    expect(doLog("insert")).toHaveLength(1);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "error", error_message: "cliente_desconhecido" });
  });

  it("controle: aviso VÁLIDO de cliente conhecido do Asaas nunca passa por balde nenhum", async () => {
    h.permitido = false;
    expect((await doAsaas({ "asaas-access-token": TOKEN_ASAAS })).status).toBe(200);
    expect(h.baldes).toEqual([]);
  });
});
