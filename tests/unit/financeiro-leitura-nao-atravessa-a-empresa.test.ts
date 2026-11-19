/**
 * AS LISTAS DO FINANCEIRO SÃO DA EMPRESA ATIVA — não da RLS (#4845).
 *
 * A RLS destas tabelas libera TODAS as empresas de que a pessoa é membro
 * (`organization_id IN fn_user_org_ids()`) e, em `calendar_appointments`, todas
 * para o admin da plataforma (`fn_can_view_appointment` → `fn_is_platform_admin()`).
 * Quem participa de duas empresas via, na empresa A, o dinheiro e as comandas da
 * B — e o botão ao lado do registro faturava de verdade.
 *
 * ─── Por que o dublê aplica os filtros ──────────────────────────────────────
 *
 * O defeito é o filtro que FALTA. Um dublê que devolve a linha escrita à mão no
 * `maybeSingle` passaria verde com e sem `.eq("organization_id", …)`. O
 * `bancoDeDuasEmpresas` guarda as linhas e aplica `eq`/`in`/`neq` como o
 * PostgREST: a lista da A não traz a linha da B porque o filtro existe, e o
 * teste da B (mesma rota, mesma massa) prova que o recorte não quebrou ninguém.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoDeDuasEmpresas } from "@/tests/helpers/postgrest-de-duas-empresas";
import type { Linha } from "@/tests/helpers/postgrest-de-duas-empresas";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const LEAD_DA_B = "33333333-3333-4333-8333-333333333333";
const LEAD_DA_A = "44444444-4444-4444-8444-444444444444";

/** Qual empresa está ATIVA nesta requisição. O teste troca para provar o outro lado. */
let empresaAtiva = A;
let mundo = bancoDeDuasEmpresas();

function comoEmpresa(orgId: string) {
  empresaAtiva = orgId;
}

const haUmaHora = () => new Date(Date.now() - 3_600_000).toISOString();

function pedidoGet(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

function pedidoPost(url: string, corpo: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
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

describe("GET /api/v1/financeiro/comandas/pendentes — o atendimento sem comanda", () => {
  function semearAgendamentos(): void {
    mundo.semear("calendar_appointments", [
      {
        id: "agendamento-da-a",
        organization_id: A,
        title: "Corte — A",
        starts_at: haUmaHora(),
        contact_id: CONTATO,
        event_type_id: null,
        status: "confirmed",
      },
      {
        id: "agendamento-da-b",
        organization_id: B,
        title: "Corte — B",
        starts_at: haUmaHora(),
        contact_id: CONTATO,
        event_type_id: null,
        status: "confirmed",
      },
    ]);
  }

  async function listar(): Promise<Array<{ appointment_id: string; title: string }>> {
    const { GET } = await import("@/app/api/v1/financeiro/comandas/pendentes/route");
    const res = await GET(pedidoGet("http://localhost/api/v1/financeiro/comandas/pendentes"));
    expect(res.status).toBe(200);
    return (await res.json()).data;
  }

  it("a empresa A não vê o atendimento da B", async () => {
    semearAgendamentos();

    const pendentes = await listar();

    expect(pendentes.map((p) => p.appointment_id)).toEqual(["agendamento-da-a"]);
    expect(JSON.stringify(pendentes)).not.toContain("Corte — B");
  });

  it("a empresa B continua vendo o atendimento dela — o recorte não quebrou ninguém", async () => {
    semearAgendamentos();
    comoEmpresa(B);

    const pendentes = await listar();

    expect(pendentes.map((p) => p.appointment_id)).toEqual(["agendamento-da-b"]);
  });

  it("a checagem de 'já faturado' é desta empresa: comanda da B não esconde o atendimento da A", async () => {
    semearAgendamentos();
    // O caso medido na issue: a comanda de uma empresa apontando o agendamento de
    // outra (é o que `faturar-lote` grava). Se a checagem olhar todas as
    // empresas, o atendimento da A — que NÃO tem comanda na A — some da lista.
    mundo.semear("sales", [
      { id: "comanda-da-b", organization_id: B, number: 1, status: "finalized", appointment_id: "agendamento-da-a", discount_cents: 0 },
    ]);

    const pendentes = await listar();

    expect(pendentes.map((p) => p.appointment_id)).toEqual(["agendamento-da-a"]);
  });

  it("a comanda da própria empresa continua escondendo o atendimento já faturado", async () => {
    semearAgendamentos();
    mundo.semear("sales", [
      { id: "comanda-da-a", organization_id: A, number: 1, status: "finalized", appointment_id: "agendamento-da-a", discount_cents: 0 },
    ]);

    const pendentes = await listar();

    expect(pendentes).toEqual([]);
  });
});

describe("GET /api/v1/financeiro/comandas — a lista de comandas", () => {
  beforeEach(() => {
    mundo.semear("sales", [
      { id: "comanda-a-1", organization_id: A, number: 1, status: "open", discount_cents: 0, total_cents: 0, contact_id: CONTATO },
      { id: "comanda-b-1", organization_id: B, number: 1, status: "open", discount_cents: 0, total_cents: 0, contact_id: CONTATO },
      { id: "comanda-a-2", organization_id: A, number: 2, status: "open", discount_cents: 0, total_cents: 0, contact_id: CONTATO },
    ]);
    mundo.semear("sale_items", [
      { id: "item-a-1", organization_id: A, sale_id: "comanda-a-1", description: "Corte", quantity: 1, unit_price_cents: 5000, discount_cents: 0, total_cents: 5000, commission_percent: 10 },
      { id: "item-b-1", organization_id: B, sale_id: "comanda-b-1", description: "Corte da B", quantity: 1, unit_price_cents: 9000, discount_cents: 0, total_cents: 9000, commission_percent: 10 },
    ]);
  });

  async function listar(): Promise<Array<Record<string, unknown>>> {
    const { GET } = await import("@/app/api/v1/financeiro/comandas/route");
    const res = await GET(pedidoGet("http://localhost/api/v1/financeiro/comandas"));
    expect(res.status).toBe(200);
    return (await res.json()).data;
  }

  it("A vê só as comandas da A — número, contato, itens e valores", async () => {
    const comandas = await listar();

    expect(comandas.map((c) => c.id).sort()).toEqual(["comanda-a-1", "comanda-a-2"]);
    expect(JSON.stringify(comandas)).not.toContain("Corte da B");
    expect(JSON.stringify(comandas)).not.toContain("comanda-b-1");
  });

  it("B continua vendo a comanda dela", async () => {
    comoEmpresa(B);

    const comandas = await listar();

    expect(comandas.map((c) => c.id)).toEqual(["comanda-b-1"]);
  });
});

describe("GET /api/v1/financeiro/lancamentos — o caixa", () => {
  function semear(): void {
    mundo.semear("financial_entries", [
      { id: "entrada-a", organization_id: A, amount_cents: 1000, description: "Aluguel da A", entry_date: "2026-11-01", status: "pending", direction: "out" },
      { id: "entrada-b", organization_id: B, amount_cents: 2000, description: "Aluguel da B", entry_date: "2026-11-02", status: "pending", direction: "out" },
    ]);
  }

  async function listar(): Promise<Array<Record<string, unknown>>> {
    const { GET } = await import("@/app/api/v1/financeiro/lancamentos/route");
    const res = await GET(pedidoGet("http://localhost/api/v1/financeiro/lancamentos"));
    expect(res.status).toBe(200);
    return (await res.json()).data;
  }

  it("A não vê o lançamento da B", async () => {
    semear();

    const lancamentos = await listar();

    expect(lancamentos.map((l) => l.id)).toEqual(["entrada-a"]);
    expect(JSON.stringify(lancamentos)).not.toContain("Aluguel da B");
  });

  it("B continua vendo o lançamento dela", async () => {
    semear();
    comoEmpresa(B);

    expect((await listar()).map((l) => l.id)).toEqual(["entrada-b"]);
  });
});

describe("GET /api/v1/honorarios/contratos — o filtro `lead_id` não substitui a empresa", () => {
  function semear(): void {
    mundo.semear("honorarios_contratos", [
      { id: "contrato-a", organization_id: A, lead_id: LEAD_DA_A, modelo: "fixo", valor_fixo_cents: 100000 },
      { id: "contrato-b", organization_id: B, lead_id: LEAD_DA_B, modelo: "fixo", valor_fixo_cents: 900000 },
    ]);
  }

  async function listar(query = ""): Promise<Array<Record<string, unknown>>> {
    const { GET } = await import("@/app/api/v1/honorarios/contratos/route");
    const res = await GET(pedidoGet(`http://localhost/api/v1/honorarios/contratos${query}`));
    expect(res.status).toBe(200);
    return (await res.json()).data;
  }

  it("A vê só os contratos da A", async () => {
    semear();

    const contratos = await listar();

    expect(contratos.map((c) => c.id)).toEqual(["contrato-a"]);
  });

  it("o `lead_id` de outra empresa devolve lista vazia, não o contrato dela", async () => {
    semear();

    const contratos = await listar(`?lead_id=${LEAD_DA_B}`);

    expect(contratos).toEqual([]);
    // A recusa não revela nada: a resposta não cita o valor nem o id do contrato.
    expect(JSON.stringify(contratos)).not.toContain("900000");
  });

  it("o `lead_id` da própria empresa continua funcionando", async () => {
    semear();

    expect((await listar(`?lead_id=${LEAD_DA_A}`)).map((c) => c.id)).toEqual(["contrato-a"]);
  });

  it("B continua vendo o contrato dela", async () => {
    semear();
    comoEmpresa(B);

    expect((await listar()).map((c) => c.id)).toEqual(["contrato-b"]);
  });
});

describe("GET /api/v1/financeiro/fidelidade — saldo e extrato da MESMA empresa", () => {
  /**
   * O cenário do defeito: o contato é da A, e o extrato da B tem duas linhas com
   * esse `contact_id` — o que a gravação cruzada da `#4845` deixou para trás. O
   * saldo (por `p_org`) sempre foi da A; o extrato (por `contact_id`) somava as
   * duas empresas. Os dois números na mesma resposta contavam histórias
   * diferentes.
   */
  function semear(): void {
    mundo.semear("loyalty_ledger", [
      { id: "ponto-a", organization_id: A, contact_id: CONTATO, points: 100, reason: "Compra na A", created_at: "2026-11-01T10:00:00.000Z" },
      { id: "ponto-b", organization_id: B, contact_id: CONTATO, points: 40, reason: "Compra na B", created_at: "2026-11-02T10:00:00.000Z" },
    ]);
  }

  async function ler(): Promise<{
    saldo: number;
    extrato: Array<{ id: string; points: number }>;
  }> {
    const { GET } = await import("@/app/api/v1/financeiro/fidelidade/route");
    const res = await GET(
      pedidoGet(`http://localhost/api/v1/financeiro/fidelidade?contact_id=${CONTATO}`),
    );
    expect(res.status).toBe(200);
    return (await res.json()).data;
  }

  it("o extrato da A não traz os pontos da B, e o saldo continua sendo o da A", async () => {
    semear();

    const { saldo, extrato } = await ler();

    expect(saldo).toBe(100);
    expect(extrato.map((e) => e.id)).toEqual(["ponto-a"]);
    // A coerência é a soma: o extrato passa a explicar o saldo.
    expect(extrato.reduce((acc, e) => acc + e.points, 0)).toBe(saldo);
  });

  it("B continua com o saldo e o extrato dela", async () => {
    semear();
    comoEmpresa(B);

    const { saldo, extrato } = await ler();

    expect(saldo).toBe(40);
    expect(extrato.map((e) => e.id)).toEqual(["ponto-b"]);
  });
});

describe("POST /api/v1/financeiro/lancamentos — a conta e o plano são desta empresa", () => {
  const CONTA_A = "55555555-5555-4555-8555-555555555555";
  const CONTA_B = "66666666-6666-4666-8666-666666666666";
  const PLANO_A = "77777777-7777-4777-8777-777777777777";
  const PLANO_B = "88888888-8888-4888-8888-888888888888";
  const CONTA_QUE_NAO_EXISTE = "99999999-9999-4999-8999-999999999999";

  beforeEach(() => {
    mundo.semear("organizations", [
      { id: A, currency: "BRL" },
      { id: B, currency: "BRL" },
    ]);
    mundo.semear("financial_accounts", [
      { id: CONTA_A, organization_id: A, name: "Caixa da A", is_active: true },
      { id: CONTA_B, organization_id: B, name: "Caixa da B", is_active: true },
    ]);
    mundo.semear("account_plans", [
      { id: PLANO_A, organization_id: A, name: "Despesas da A", is_active: true },
      { id: PLANO_B, organization_id: B, name: "Despesas da B", is_active: true },
    ]);
  });

  async function lancar(corpo: Record<string, unknown>) {
    const { POST } = await import("@/app/api/v1/financeiro/lancamentos/route");
    return POST(pedidoPost("http://localhost/api/v1/financeiro/lancamentos", corpo));
  }

  const CORPO = {
    account_id: CONTA_A,
    direction: "out",
    amount_cents: 50000,
    description: "Aluguel",
    entry_date: "2026-11-05",
  };

  it("recusa a conta da outra empresa e NÃO grava nada", async () => {
    const antes = mundo.contar("financial_entries");

    const res = await lancar({ ...CORPO, account_id: CONTA_B });

    expect(res.status).toBe(422);
    expect(mundo.contar("financial_entries")).toBe(antes);
    expect(mundo.escritas()).toEqual([]);
  });

  it("recusa o plano de contas da outra empresa e NÃO grava nada", async () => {
    const antes = mundo.contar("financial_entries");

    const res = await lancar({ ...CORPO, account_plan_id: PLANO_B });

    expect(res.status).toBe(422);
    expect(mundo.contar("financial_entries")).toBe(antes);
    expect(mundo.escritas()).toEqual([]);
  });

  it("a recusa é a mesma da conta inexistente — não revela que a conta existe noutra empresa", async () => {
    const daOutraEmpresa = await (await lancar({ ...CORPO, account_id: CONTA_B })).json();
    const inexistente = await (
      await lancar({ ...CORPO, account_id: CONTA_QUE_NAO_EXISTE })
    ).json();

    expect(daOutraEmpresa.error.message).toBe(inexistente.error.message);
    expect(daOutraEmpresa.error.code).toBe(inexistente.error.code);
  });

  it("a conta e o plano da própria empresa continuam aceitos, e a linha nasce na empresa ativa", async () => {
    const res = await lancar({ ...CORPO, account_plan_id: PLANO_A });

    expect(res.status).toBe(200);
    const linha = mundo.linhas("financial_entries").at(-1)!;
    expect(linha.organization_id).toBe(A);
    expect(linha.account_id).toBe(CONTA_A);
    expect(linha.account_plan_id).toBe(PLANO_A);
  });

  it("B continua lançando na conta dela", async () => {
    comoEmpresa(B);

    const res = await lancar({ ...CORPO, account_id: CONTA_B });

    expect(res.status).toBe(200);
    expect(mundo.linhas("financial_entries").at(-1)!.organization_id).toBe(B);
  });

  it("a empresa ativa de um lançamento não pode ser trocada pelo corpo", async () => {
    const res = await lancar({ ...CORPO, organization_id: B, account_id: CONTA_A });

    expect(res.status).toBe(200);
    const linha: Linha = mundo.linhas("financial_entries").at(-1)!;
    expect(linha.organization_id).toBe(A);
  });
});
