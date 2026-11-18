/**
 * ESCREVER POR ID EXIGE QUE O REGISTRO SEJA DA EMPRESA ATIVA (#4845).
 *
 * O id chega de uma lista que vazou: as rotas de leitura devolviam comandas e
 * lançamentos de todas as empresas de que a pessoa é membro. Estas rotas de
 * escrita liam por `id` e confiavam só na RLS — que também libera as empresas
 * todas das quais a pessoa participa. Resultado: desconto, cancelamento, item e
 * baixa de pagamento na comanda/entrada da OUTRA empresa.
 *
 * ─── O padrão medido no repositório ─────────────────────────────────────────
 *
 * `tasks/[id]` (PATCH e DELETE) filtra `.eq("organization_id", authz.org.orgId)`
 * na leitura E na escrita, e devolve **404 `not_found`** com a mesma mensagem do
 * registro inexistente — não 403: quem está na A não descobre, pela resposta,
 * que existe um registro com aquele id na B. É esse molde que as rotas do
 * financeiro passam a seguir.
 *
 * ─── O que cada caso fixa ───────────────────────────────────────────────────
 *
 *   1. A é RECUSADA (404) e a resposta não cita dado da B.
 *   2. A recusa acontece ANTES da escrita: a contagem e o conteúdo das linhas da
 *      B são os mesmos de antes, e nenhuma escrita foi emitida.
 *   3. A B continua fazendo a mesma operação — o recorte não virou bloqueio.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoDeDuasEmpresas } from "@/tests/helpers/postgrest-de-duas-empresas";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/financeiro/comissao-do-item", () => ({
  percentualDoItem: vi.fn(async () => ({ ok: true, percent: 10 })),
}));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";

let empresaAtiva = A;
let mundo = bancoDeDuasEmpresas();

const COMANDA_DA_A = "c0000000-0000-4000-8000-0000000000a1";
const COMANDA_DA_B = "c0000000-0000-4000-8000-0000000000b1";
const ITEM_DA_B = "i0000000-0000-4000-8000-0000000000b1";
const ENTRADA_DA_A = "e0000000-0000-4000-8000-0000000000a1";
const ENTRADA_DA_B = "e0000000-0000-4000-8000-0000000000b1";

function comoEmpresa(orgId: string) {
  empresaAtiva = orgId;
}

function pedido(metodo: "POST" | "PATCH" | "DELETE", corpo?: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/v1/financeiro", {
    method: metodo,
    ...(corpo
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) }
      : {}),
  });
}

function semearComandas(): void {
  mundo.semear("sales", [
    {
      id: COMANDA_DA_A,
      organization_id: A,
      number: 1,
      status: "open",
      contact_id: CONTATO,
      attendant_user_id: USER,
      appointment_id: null,
      discount_cents: 0,
      total_cents: 0,
      notes: null,
      currency: "BRL",
    },
    {
      id: COMANDA_DA_B,
      organization_id: B,
      number: 77,
      status: "open",
      contact_id: CONTATO,
      attendant_user_id: USER,
      appointment_id: null,
      discount_cents: 0,
      total_cents: 0,
      notes: "Observação da B",
      currency: "BRL",
    },
  ]);
  mundo.semear("sale_items", [
    { id: ITEM_DA_B, organization_id: B, sale_id: COMANDA_DA_B, description: "Serviço da B", quantity: 1, unit_price_cents: 9000, discount_cents: 0, total_cents: 9000, commission_percent: 10 },
  ]);
}

function semearLancamentos(): void {
  mundo.semear("financial_entries", [
    { id: ENTRADA_DA_A, organization_id: A, account_id: null, amount_cents: 1000, description: "Aluguel da A", entry_date: "2026-11-01", status: "pending", direction: "out", origin: "manual" },
    { id: ENTRADA_DA_B, organization_id: B, account_id: null, amount_cents: 2000, description: "Aluguel da B", entry_date: "2026-11-02", status: "pending", direction: "out", origin: "manual" },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  empresaAtiva = A;
  mundo = bancoDeDuasEmpresas();
  vi.mocked(requireRole).mockImplementation(
    async () =>
      ({
        ok: true,
        user: { id: USER, idioma: "pt-BR" },
        org: { orgId: empresaAtiva, name: "Empresa", role: "manager" },
      }) as never,
  );
  vi.mocked(createClient).mockImplementation(async () => mundo.cliente as never);
});

describe("GET /api/v1/financeiro/comandas/[id] — ler uma comanda", () => {
  it("A não lê a comanda da B: 404, e a resposta não cita o registro alheio", async () => {
    semearComandas();
    const { GET } = await import("@/app/api/v1/financeiro/comandas/[id]/route");

    const res = await GET(pedido("POST"), {
      params: Promise.resolve({ id: COMANDA_DA_B }),
    });

    expect(res.status).toBe(404);
    const corpo = await res.json();
    expect(corpo.error.message).toBe("Comanda não encontrada.");
    expect(JSON.stringify(corpo)).not.toContain("Observação da B");
    expect(JSON.stringify(corpo)).not.toContain("77");
  });

  it("B continua lendo a comanda dela", async () => {
    semearComandas();
    comoEmpresa(B);
    const { GET } = await import("@/app/api/v1/financeiro/comandas/[id]/route");

    const res = await GET(pedido("POST"), {
      params: Promise.resolve({ id: COMANDA_DA_B }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.number).toBe(77);
  });
});

describe("PATCH /api/v1/financeiro/comandas/[id] — desconto, observação e cancelar", () => {
  async function alterar(id: string, corpo: Record<string, unknown>) {
    const { PATCH } = await import("@/app/api/v1/financeiro/comandas/[id]/route");
    return PATCH(pedido("PATCH", corpo), { params: Promise.resolve({ id }) });
  }

  it("A não cancela a comanda da B — 404 e NADA é escrito", async () => {
    semearComandas();
    const antes = mundo.linhas("sales").map((s) => ({ ...s }));

    const res = await alterar(COMANDA_DA_B, { cancel: true });

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("Comanda não encontrada.");
    expect(mundo.linhas("sales")).toEqual(antes);
    expect(mundo.porId("sales", COMANDA_DA_B)!.status).toBe("open");
    expect(mundo.escritas()).toEqual([]);
  });

  it("A não dá desconto nem troca a observação da comanda da B", async () => {
    semearComandas();

    const res = await alterar(COMANDA_DA_B, { discount_cents: 5000, notes: "invadida" });

    expect(res.status).toBe(404);
    expect(mundo.porId("sales", COMANDA_DA_B)!.discount_cents).toBe(0);
    expect(mundo.porId("sales", COMANDA_DA_B)!.notes).toBe("Observação da B");
    expect(mundo.escritas()).toEqual([]);
  });

  it("B continua cancelando a comanda dela", async () => {
    semearComandas();
    comoEmpresa(B);

    const res = await alterar(COMANDA_DA_B, { cancel: true });

    expect(res.status).toBe(200);
    expect(mundo.porId("sales", COMANDA_DA_B)!.status).toBe("cancelled");
  });
});

describe("POST /api/v1/financeiro/comandas/[id]/itens — incluir item", () => {
  const CORPO = {
    description: "Serviço",
    quantity: 1,
    unit_price_cents: 5000,
    discount_cents: 0,
  };

  async function incluir(comandaId: string, corpo: Record<string, unknown> = CORPO) {
    const { POST } = await import("@/app/api/v1/financeiro/comandas/[id]/itens/route");
    return POST(pedido("POST", corpo), { params: Promise.resolve({ id: comandaId }) });
  }

  it("A não inclui item na comanda da B — 404, sem linha nova", async () => {
    semearComandas();
    const antes = mundo.contar("sale_items");

    const res = await incluir(COMANDA_DA_B);

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("Comanda não encontrada.");
    expect(mundo.contar("sale_items")).toBe(antes);
    expect(mundo.escritas()).toEqual([]);
  });

  it("B continua incluindo item na comanda dela, e a linha nasce na B", async () => {
    semearComandas();
    comoEmpresa(B);

    const res = await incluir(COMANDA_DA_B);

    expect(res.status).toBe(200);
    const linha = mundo.linhas("sale_items").at(-1)!;
    expect(linha.organization_id).toBe(B);
    expect(linha.sale_id).toBe(COMANDA_DA_B);
  });
});

describe("DELETE /api/v1/financeiro/comandas/[id]/itens/[itemId] — remover item", () => {
  async function remover(comandaId: string, itemId: string) {
    const { DELETE } = await import("@/app/api/v1/financeiro/comandas/[id]/itens/[itemId]/route");
    return DELETE(pedido("DELETE"), { params: Promise.resolve({ id: comandaId, itemId }) });
  }

  it("A não remove o item da comanda da B — 404, item continua lá", async () => {
    semearComandas();
    const antes = mundo.contar("sale_items");

    const res = await remover(COMANDA_DA_B, ITEM_DA_B);

    expect(res.status).toBe(404);
    expect(mundo.contar("sale_items")).toBe(antes);
    expect(mundo.porId("sale_items", ITEM_DA_B)).not.toBeNull();
    expect(mundo.escritas()).toEqual([]);
  });

  it("B continua removendo o item da comanda dela", async () => {
    semearComandas();
    comoEmpresa(B);

    const res = await remover(COMANDA_DA_B, ITEM_DA_B);

    expect(res.status).toBe(200);
    expect(mundo.porId("sale_items", ITEM_DA_B)).toBeNull();
  });
});

describe("PATCH /api/v1/financeiro/lancamentos/[id] — marcar como pago", () => {
  async function pagar(id: string) {
    const { PATCH } = await import("@/app/api/v1/financeiro/lancamentos/[id]/route");
    return PATCH(pedido("PATCH", { pay: true }), { params: Promise.resolve({ id }) });
  }

  it("A não marca como pago o lançamento da B — 404 e o status não muda", async () => {
    semearLancamentos();

    const res = await pagar(ENTRADA_DA_B);

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("Lançamento não encontrado.");
    expect(mundo.porId("financial_entries", ENTRADA_DA_B)!.status).toBe("pending");
    expect(mundo.escritas()).toEqual([]);
  });

  it("B continua marcando como pago o lançamento dela", async () => {
    semearLancamentos();
    comoEmpresa(B);

    const res = await pagar(ENTRADA_DA_B);

    expect(res.status).toBe(200);
    expect(mundo.porId("financial_entries", ENTRADA_DA_B)!.status).toBe("paid");
  });
});

describe("DELETE /api/v1/financeiro/lancamentos/[id] — apagar pendente", () => {
  async function apagar(id: string) {
    const { DELETE } = await import("@/app/api/v1/financeiro/lancamentos/[id]/route");
    return DELETE(pedido("DELETE"), { params: Promise.resolve({ id }) });
  }

  it("A não apaga o lançamento da B — 404, contagem e conteúdo intactos", async () => {
    semearLancamentos();
    const antes = mundo.contar("financial_entries");

    const res = await apagar(ENTRADA_DA_B);

    expect(res.status).toBe(404);
    const corpo = await res.json();
    expect(corpo.error.message).toBe("Lançamento não encontrado.");
    expect(JSON.stringify(corpo)).not.toContain("Aluguel da B");
    expect(mundo.contar("financial_entries")).toBe(antes);
    expect(mundo.escritas()).toEqual([]);
  });

  it("B continua apagando o lançamento dela", async () => {
    semearLancamentos();
    comoEmpresa(B);

    const res = await apagar(ENTRADA_DA_B);

    expect(res.status).toBe(200);
    expect(mundo.porId("financial_entries", ENTRADA_DA_B)).toBeNull();
  });
});
