import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

import { assinarParaTeste } from "@/lib/pagamentos/assinatura";
import type { Recebimento } from "@/lib/pagamentos/registrar";

const h = vi.hoisted(() => ({
  segredo: "segredo-de-teste-com-32-caracteres" as string | null,
  permitido: true,
  baldes: [] as string[],
  aviso: vi.fn(),
  erro: vi.fn(),
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/pagamentos/configuracao", () => ({
  configuracaoDoRecebimento: async () => ({ segredo: h.segredo, chave: "INFINITEPAY_WEBHOOK_SECRET" }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (balde: string) => {
    h.baldes.push(balde);
    return { allowed: h.permitido };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.aviso, error: h.erro, info: vi.fn() } }));

import { POST } from "./route";

const ORG = "cccccccc-0000-4000-8000-000000000001";
const CONV = "cccccccc-0000-4000-8000-000000000002";
const MSG = "cccccccc-0000-4000-8000-000000000003";
const LEAD = "cccccccc-0000-4000-8000-000000000004";
const REC = "cccccccc-0000-4000-8000-000000000005";
const ETAPA_GANHO = "cccccccc-0000-4000-8000-000000000007";
const ETAPA_ATUAL = "cccccccc-0000-4000-8000-000000000008";
const PIPELINE = "cccccccc-0000-4000-8000-000000000009";

const CORPO = JSON.stringify({ id: "pay_123", event: "paid", data: { id: "pay_123" } });

const pendente = (over: Partial<Recebimento> = {}): Recebimento => ({
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
  linhas: Recebimento[];
  cas: Resposta;
  moveu: Resposta;
  lead: { id: string; stage_id: string | null; pipeline_id: string | null; status: string; contact_id: string | null } | null;
  mensagem: { id: string; metadata: Record<string, unknown> | null } | null;
}

let m: Mundo;

function responder(c: Cadeia): Resposta {
  const op = operacao(c);
  if (c.tabela === "pagamento_recebimentos") return op === "update" ? m.cas : { data: m.linhas };
  if (c.tabela === "messages") return op === "update" ? { data: null } : { data: m.mensagem };
  if (c.tabela === "crm_stages") return { data: { id: ETAPA_GANHO, name: "Pago" } };
  if (c.tabela === "crm_leads") return op === "update" ? m.moveu : { data: m.lead };
  if (c.tabela === "crm_lead_activities") return { data: null };
  return {};
}

const entregar = (opcoes: { provedor?: string; corpo?: string; headers?: Record<string, string> } = {}) => {
  const provedor = opcoes.provedor ?? "infinitepay";
  return POST(
    new NextRequest(`http://localhost/api/v1/webhooks/pagamento/${provedor}`, {
      method: "POST",
      body: opcoes.corpo ?? CORPO,
      headers: { "x-forwarded-for": "10.0.0.1", ...(opcoes.headers ?? {}) },
    }),
    { params: Promise.resolve({ provedor }) },
  );
};

/** Toda escrita observada no banco falso — a medida de "NADA mudou". */
const escritas = () => h.banco.cadeias.filter((c) => operacao(c) !== "select");

beforeEach(() => {
  vi.clearAllMocks();
  h.segredo = "segredo-de-teste-com-32-caracteres";
  h.permitido = true;
  h.baldes = [];
  m = {
    linhas: [pendente()],
    cas: { data: [{ id: REC }] },
    moveu: { data: [{ id: LEAD }] },
    lead: { id: LEAD, stage_id: ETAPA_ATUAL, pipeline_id: PIPELINE, status: "open", contact_id: null },
    mensagem: {
      id: MSG,
      metadata: {
        pagamento: { provedor: "infinitepay", id: "pay_123", valor: 15000, moeda: "BRL", status: "pendente", recebimento_id: REC },
      },
    },
  };
  h.banco = bancoFalso(responder);
});

describe("webhook do pagamento do cliente final", () => {
  it("provedor fora da lista: 404, sem ler corpo e sem tocar o banco", async () => {
    const r = await entregar({ provedor: "mercadopago" });
    expect(r.status).toBe(404);
    expect(h.banco.cadeias).toEqual([]);
  });

  it("⭐ SEM segredo configurado: 503 dizendo qual chave falta, e NADA muda no negócio", async () => {
    h.segredo = null;
    // Mesmo com assinatura "válida" contra o segredo vazio: não há conferência
    // possível, e aceitar seria o defeito.
    const r = await entregar({ headers: { "x-webhook-token": "qualquer" } });
    expect(r.status).toBe(503);
    const corpo = (await r.json()) as { error?: { details?: { falta?: string } }; details?: { falta?: string } };
    expect(JSON.stringify(corpo)).toContain("INFINITEPAY_WEBHOOK_SECRET");
    expect(escritas()).toEqual([]);
    expect(h.erro).toHaveBeenCalled();
  });

  it("⭐ ASSINATURA INVÁLIDA: 401 e NADA muda — sem update, sem etapa, sem timeline", async () => {
    const r = await entregar({ headers: { "x-webhook-token": "token-errado" } });
    expect(r.status).toBe(401);
    expect(escritas()).toEqual([]);
    // Nem sequer LEU o recebimento: a guarda vem antes de qualquer consulta.
    expect(h.banco.cadeias).toEqual([]);
    expect(h.aviso).toHaveBeenCalled();
  });

  it("⭐ HMAC de outro segredo também dá 401 (o caminho do provedor que assina)", async () => {
    const r = await entregar({
      headers: { "x-assinatura": assinarParaTeste(CORPO, "outro-segredo-qualquer", new Date()) },
    });
    expect(r.status).toBe(401);
    expect(escritas()).toEqual([]);
  });

  it("sem cabeçalho de assinatura nenhum: 401", async () => {
    const r = await entregar();
    expect(r.status).toBe(401);
    expect(escritas()).toEqual([]);
  });

  it("⭐ assinatura VÁLIDA: 200, marca paga UMA vez e move o negócio", async () => {
    const r = await entregar({ headers: { "x-webhook-token": "segredo-de-teste-com-32-caracteres" } });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { recebido?: boolean; status?: string; negocio?: string } };
    expect(corpo.data.recebido).toBe(true);
    expect(corpo.data.status).toBe("paga");
    expect(corpo.data.negocio).toBe("movido");

    const cas = argumentos(h.banco.cadeias.find((c) => c.tabela === "pagamento_recebimentos" && operacao(c) === "update")!, "update")?.[0];
    expect(cas).toMatchObject({ status: "paga" });
  });

  it("⭐ evento REPETIDO com assinatura válida: 200 `duplicado` e nenhuma escrita", async () => {
    m.linhas = [pendente({ status: "paga", pago_em: new Date().toISOString() })];
    const r = await entregar({ headers: { "x-webhook-token": "segredo-de-teste-com-32-caracteres" } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toMatchObject({ duplicado: true });
    expect(escritas()).toEqual([]);
  });

  it("evento fora do vocabulário: 200 `ignorado` e nada muda (estorno é fatia seguinte, não `paga`)", async () => {
    const r = await entregar({
      corpo: JSON.stringify({ id: "pay_123", event: "refunded" }),
      headers: { "x-webhook-token": "segredo-de-teste-com-32-caracteres" },
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toMatchObject({ ignorado: true, evento: "refunded" });
    expect(h.banco.cadeias).toEqual([]);
  });

  it("id desconhecido: 200 `desconhecido` (não é erro do provedor)", async () => {
    m.linhas = [];
    const r = await entregar({ headers: { "x-webhook-token": "segredo-de-teste-com-32-caracteres" } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ ignorado: "desconhecido" });
  });

  it("corpo grande demais: 413 antes de conferir assinatura", async () => {
    const r = await entregar({
      corpo: "x".repeat(1_048_577),
      headers: { "x-webhook-token": "segredo-de-teste-com-32-caracteres" },
    });
    expect(r.status).toBe(413);
    expect(h.banco.cadeias).toEqual([]);
  });

  it("recusas em série viram 429 (o balde de quem NÃO se autenticou)", async () => {
    h.permitido = false;
    const r = await entregar({ headers: { "x-webhook-token": "errado" } });
    expect(r.status).toBe(429);
    expect(h.baldes).toHaveLength(1);
    expect(h.baldes[0]).toContain("pagamento-webhook-recusado:");
  });

  it("assinado mas sem JSON: 400 e nada muda", async () => {
    const r = await entregar({
      corpo: "nao-e-json",
      headers: { "x-webhook-token": "segredo-de-teste-com-32-caracteres" },
    });
    expect(r.status).toBe(400);
    expect(escritas()).toEqual([]);
  });
});
