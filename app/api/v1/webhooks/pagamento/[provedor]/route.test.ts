import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

import { novoTokenDoAviso } from "@/lib/pagamentos/assinatura";
import type { Recebimento } from "@/lib/pagamentos/registrar";

const h = vi.hoisted(() => ({
  ligado: true,
  permitido: true,
  baldes: [] as string[],
  aviso: vi.fn(),
  erro: vi.fn(),
  banco: undefined as unknown as BancoFalso,
  auditorias: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    h.auditorias.push(entrada);
  },
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => h.ligado }));
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
const LEAD = "cccccccc-0000-4000-8000-000000000004";
const REC = "cccccccc-0000-4000-8000-000000000005";
const ETAPA_GANHO = "cccccccc-0000-4000-8000-000000000007";
const ETAPA_ATUAL = "cccccccc-0000-4000-8000-000000000008";
const PIPELINE = "cccccccc-0000-4000-8000-000000000009";

/** O segredo DESTE recebimento, como o registro o entregou. */
const { token: TOKEN, hash: HASH } = novoTokenDoAviso();

type Linha = Recebimento & { aviso_token_hash: string };

/** Um recebimento recém-registrado: SEM id do provedor — é o aviso que o traz. */
const pendente = (over: Partial<Linha> = {}): Linha => ({
  id: REC,
  organization_id: ORG,
  conversation_id: CONV,
  lead_id: LEAD,
  provedor: "infinitepay",
  external_id: null,
  valor_cents: 100,
  moeda: "BRL",
  status: "pendente",
  pago_em: null,
  aviso_token_hash: HASH,
  ...over,
});

interface Mundo {
  linha: Linha | null;
  cas: Resposta;
  moveu: Resposta;
  lead: { id: string; stage_id: string | null; pipeline_id: string | null; status: string; contact_id: string | null } | null;
}

let m: Mundo;

function responder(c: Cadeia): Resposta {
  const op = operacao(c);
  if (c.tabela === "pagamento_recebimentos") return op === "update" ? m.cas : { data: m.linha };
  if (c.tabela === "crm_stages") return { data: { id: ETAPA_GANHO, name: "Pago" } };
  if (c.tabela === "crm_leads") return op === "update" ? m.moveu : { data: m.lead };
  if (c.tabela === "crm_lead_activities") return { data: null };
  return {};
}

// ─── O aviso REAL da InfinitePay (31/10 e 03/11/2026) ──────────────────────
//
// Forma verbatim (R$ 1,00 por Pix): sem assinatura, `order_nsu` gerado POR ELES
// (o que mandamos não volta), `invoice_slug` estável entre os avisos, e o `paid`
// do link do PAINEL sem `event_type`. Os parâmetros que pusemos na URL voltam
// em ordem que muda — por isso a ordem trocada é o padrão aqui.
const ITENS_REAIS = [{ price: 100, quantity: 1, image_url: null, description: "Teste", product_reference: null }];
const avisoDaApi = (evento: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    items: ITENS_REAIS,
    amount: 100,
    order_nsu: "uuid-gerado-pelo-provedor",
    event_type: evento,
    invoice_slug: "slug-da-cobranca",
    invoice_type: "external_checkout",
    ...extra,
  });
const avisoDoPainel = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    items: ITENS_REAIS,
    amount: 100,
    order_nsu: "uuid-gerado-pelo-provedor",
    paid_amount: 100,
    receipt_url: "https://recibo.exemplo/uuid",
    installments: 1,
    invoice_slug: "slug-da-cobranca",
    capture_method: "pix",
    transaction_nsu: "nsu-do-recibo",
    ...extra,
  });

/** A URL que o registro entregou, com os parâmetros na ordem INVERSA da que pusemos. */
const URL_DO_AVISO = `?t=${TOKEN}&r=${REC}`;

const entregar = (opcoes: { provedor?: string; corpo?: string; headers?: Record<string, string>; query?: string } = {}) => {
  const provedor = opcoes.provedor ?? "infinitepay";
  return POST(
    new NextRequest(`http://localhost/api/v1/webhooks/pagamento/${provedor}${opcoes.query ?? URL_DO_AVISO}`, {
      method: "POST",
      body: opcoes.corpo ?? avisoDoPainel(),
      headers: { "x-forwarded-for": "10.0.0.1", ...(opcoes.headers ?? {}) },
    }),
    { params: Promise.resolve({ provedor }) },
  );
};

/** Toda escrita observada no banco falso — a medida de "NADA mudou". */
const escritas = () => h.banco.cadeias.filter((c) => operacao(c) !== "select");

beforeEach(() => {
  vi.clearAllMocks();
  h.ligado = true;
  h.permitido = true;
  h.baldes = [];
  h.auditorias = [];
  m = {
    linha: pendente(),
    cas: { data: [{ id: REC }] },
    moveu: { data: [{ id: LEAD }] },
    lead: { id: LEAD, stage_id: ETAPA_ATUAL, pipeline_id: PIPELINE, status: "open", contact_id: null },
  };
  h.banco = bancoFalso(responder);
});

describe("webhook do pagamento do cliente final", () => {
  it("provedor fora da lista: 404, sem tocar o banco", async () => {
    const r = await entregar({ provedor: "outro" });
    expect(r.status).toBe(404);
    expect(h.banco.cadeias).toEqual([]);
  });

  it("⭐ módulo `link_de_pagamento` desligado: 404, e nem o recebimento é lido", async () => {
    h.ligado = false;
    const r = await entregar();
    expect(r.status).toBe(404);
    expect(h.banco.cadeias).toEqual([]);
  });

  it("⭐ aviso do PAINEL (paid SEM event_type), parâmetros fora de ordem: confirma UMA vez e grava o `invoice_slug`", async () => {
    const r = await entregar();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toMatchObject({ recebido: true, status: "paga", negocio: "movido" });

    // A linha foi achada pelo id da URL, não por um id do provedor.
    const leitura = h.banco.cadeias.find((c) => c.tabela === "pagamento_recebimentos" && operacao(c) === "select")!;
    expect(leitura.passos.filter((p) => p.metodo === "eq").map((p) => p.args)).toContainEqual(["id", REC]);

    const cas = h.banco.cadeias.filter((c) => c.tabela === "pagamento_recebimentos" && operacao(c) === "update");
    expect(cas).toHaveLength(1);
    expect(argumentos(cas[0]!, "update")?.[0]).toMatchObject({ status: "paga", external_id: "slug-da-cobranca" });
    expect(h.auditorias.filter((a) => a.action === "pagamento.confirmado")).toHaveLength(1);
  });

  it("⭐ `settled` do link da API também confirma (a ordem settled/paid não é garantida)", async () => {
    const r = await entregar({ corpo: avisoDaApi("settled") });
    expect(r.status).toBe(200);
    expect(escritas().filter((c) => c.tabela === "pagamento_recebimentos")).toHaveLength(1);
  });

  it("⭐ reentrega depois de pago: 200 duplicado e NENHUMA escrita", async () => {
    m.linha = pendente({ status: "paga", pago_em: new Date().toISOString(), external_id: "slug-da-cobranca" });
    const r = await entregar();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toMatchObject({ duplicado: true });
    expect(escritas()).toEqual([]);
  });

  it("`created` (o link apareceu, ninguém pagou): 200 ignorado e nada muda", async () => {
    const r = await entregar({ corpo: avisoDaApi("created") });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toMatchObject({ ignorado: true, evento: "created" });
    expect(escritas()).toEqual([]);
  });

  it("⭐ valor do aviso diferente do registrado: 200 sem efeito (reentregar não muda o valor)", async () => {
    m.linha = pendente({ valor_cents: 15000 });
    const r = await entregar();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toMatchObject({ ignorado: "valor_divergente" });
    expect(escritas()).toEqual([]);
    expect(h.auditorias).toEqual([]);
  });

  describe("prova de origem", () => {
    it("⭐ sem segredo: 401 e nada muda", async () => {
      const r = await entregar({ query: `?r=${REC}` });
      expect(r.status).toBe(401);
      expect(escritas()).toEqual([]);
    });

    it("⭐ segredo de OUTRO recebimento: 401 e nada muda", async () => {
      const r = await entregar({ query: `?r=${REC}&t=${novoTokenDoAviso().token}` });
      expect(r.status).toBe(401);
      expect(escritas()).toEqual([]);
    });

    it("⭐ recebimento inexistente responde IGUAL a segredo errado (não confirma o que existe)", async () => {
      m.linha = null;
      const r = await entregar();
      expect(r.status).toBe(401);
      expect(escritas()).toEqual([]);
    });

    it("⭐ sem `r` ou `r` fora da forma: 401 sem consultar o banco", async () => {
      for (const query of [`?t=${TOKEN}`, `?t=${TOKEN}&r=nao-e-uuid`]) {
        const r = await entregar({ query });
        expect(r.status).toBe(401);
      }
      expect(h.banco.cadeias).toEqual([]);
    });

    it("⭐ FAIL CLOSED: cabeçalho errado NÃO cai para o segredo certo da URL", async () => {
      const r = await entregar({ headers: { "x-webhook-token": "errado" } });
      expect(r.status).toBe(401);
      expect(escritas()).toEqual([]);
    });

    it("segredo no cabeçalho que confere: aceita", async () => {
      const r = await entregar({ query: `?r=${REC}`, headers: { "x-webhook-token": TOKEN } });
      expect(r.status).toBe(200);
    });

    it("recusas em série estouram o balde do IP: 429 com Retry-After", async () => {
      h.permitido = false;
      const r = await entregar({ query: `?r=${REC}&t=errado` });
      expect(r.status).toBe(429);
      expect(r.headers.get("Retry-After")).toBe("60");
      expect(h.baldes).toEqual(["pagamento-webhook-recusado:10.0.0.1"]);
    });

    it("⭐ o log da recusa não leva o segredo nem a URL", async () => {
      await entregar({ query: `?r=${REC}&t=segredo-que-nao-pode-vazar` });
      expect(JSON.stringify(h.aviso.mock.calls)).not.toContain("segredo-que-nao-pode-vazar");
    });
  });

  it("banco fora do ar ao ler o recebimento: 500 (o provedor reentrega) e nada muda", async () => {
    h.banco = bancoFalso((c) => (c.tabela === "pagamento_recebimentos" ? { error: { code: "XX000", message: "queda" } } : {}));
    const r = await entregar();
    expect(r.status).toBe(500);
    expect(escritas()).toEqual([]);
  });

  it("corpo grande demais: 413 antes de tocar o banco", async () => {
    const r = await entregar({ headers: { "content-length": String(2_000_000) } });
    expect(r.status).toBe(413);
    expect(h.banco.cadeias).toEqual([]);
  });

  it("origem conferida e corpo que não é JSON: 400 sem escrita", async () => {
    const r = await entregar({ corpo: "nao-e-json" });
    expect(r.status).toBe(400);
    expect(escritas()).toEqual([]);
  });

  it("evento que paga sem id do pagamento: 400 sem escrita", async () => {
    const r = await entregar({ corpo: JSON.stringify({ event_type: "paid", amount: 100 }) });
    expect(r.status).toBe(400);
    expect(escritas()).toEqual([]);
  });
});
