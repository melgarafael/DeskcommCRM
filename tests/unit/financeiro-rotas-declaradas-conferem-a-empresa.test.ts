/**
 * AS DUAS ROTAS QUE RECEBEM ID DE FORA E O RESOLVEM NA EMPRESA ATIVA (#4845).
 *
 *  1. `POST /api/v1/financeiro/comandas` — `appointment_id` e `contact_id` vêm
 *     do CORPO e iam direto ao insert. A comanda nascia na empresa A apontando
 *     para o atendimento (e o cliente) da B. A recusa é a do faturamento em lote:
 *     422 com `financeiro_agendamento_fora_da_empresa` /
 *     `financeiro_contato_fora_da_empresa` — um código só para toda a família,
 *     que é o que o cliente já trata.
 *  2. `GET /api/v1/honorarios/contratos/[id]/parcelas` — lia
 *     `honorarios_parcelas` só por `contrato_id`, então o id de um contrato da B
 *     abria o calendário de pagamento dela. Aqui a recusa é 404 `not_found`, o
 *     mesmo de um contrato inexistente.
 *
 * ─── Por que o dublê APLICA os filtros ──────────────────────────────────────
 *
 * O defeito é o filtro que falta. Um dublê que devolve a linha escrita à mão
 * passaria verde com e sem `.eq("organization_id", …)`. O
 * `bancoDeDuasEmpresas` aplica `eq`/`in`/`neq` como o PostgREST: a empresa A não
 * recebe a linha da B porque o filtro existe — e a contagem de `sales` antes e
 * depois da recusa prova que nada foi criado.
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

/** Contatos, atendimentos e contratos — um de cada empresa, com ids distintos. */
const CONTATO_A = "c0000000-0000-4000-8000-00000000000a";
const CONTATO_B = "c0000000-0000-4000-8000-00000000000b";
const ATENDIMENTO_A = "a0000000-0000-4000-8000-00000000000a";
const ATENDIMENTO_B = "a0000000-0000-4000-8000-00000000000b";
const CONTRATO_A = "d0000000-0000-4000-8000-00000000000a";
const CONTRATO_B = "d0000000-0000-4000-8000-00000000000b";
const CONTRATO_QUE_NAO_EXISTE = "d0000000-0000-4000-8000-0000000000ff";

let empresaAtiva = A;
let mundo: ReturnType<typeof banco>;

/**
 * O banco de duas empresas + as duas RPCs que a abertura de comanda chama.
 * `fn_proximo_numero_de_comanda` devolve um número fixo; `organizations` tem a
 * moeda de cada empresa, que é de onde `moedaDaOrganizacao` lê.
 */
function banco(inicial: Record<string, Linha[]> = {}) {
  const base = bancoDeDuasEmpresas({
    organizations: [
      { id: A, currency: "BRL" },
      { id: B, currency: "USD" },
    ],
    contacts: [
      { id: CONTATO_A, organization_id: A },
      { id: CONTATO_B, organization_id: B },
    ],
    calendar_appointments: [
      { id: ATENDIMENTO_A, organization_id: A, contact_id: CONTATO_A, status: "completed" },
      { id: ATENDIMENTO_B, organization_id: B, contact_id: CONTATO_B, status: "completed" },
    ],
    honorarios_contratos: [
      { id: CONTRATO_A, organization_id: A, modelo: "fixo" },
      { id: CONTRATO_B, organization_id: B, modelo: "fixo" },
    ],
    honorarios_parcelas: [
      { id: "parcela-a-1", organization_id: A, contrato_id: CONTRATO_A, numero: 1 },
      { id: "parcela-b-1", organization_id: B, contrato_id: CONTRATO_B, numero: 1 },
    ],
    ...inicial,
  });

  return {
    ...base,
    cliente: {
      ...base.cliente,
      rpc: async (nome: string, args: Record<string, unknown> = {}) =>
        nome === "fn_proximo_numero_de_comanda"
          ? { data: 7, error: null }
          : base.cliente.rpc(nome, args),
    },
  };
}

function comoEmpresa(orgId: string): void {
  empresaAtiva = orgId;
}

function pedidoPost(url: string, corpo: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

function pedidoGet(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

const COMANDAS = "http://localhost/api/v1/financeiro/comandas";

const paramsDoContrato = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  empresaAtiva = A;
  mundo = banco();
  vi.mocked(requireRole).mockImplementation(
    async () =>
      ({
        ok: true,
        user: { id: USER, idioma: "pt-BR" },
        org: { orgId: empresaAtiva, name: "Org", role: "agent" },
      }) as never,
  );
  vi.mocked(createClient).mockResolvedValue(mundo.cliente as never);
});

describe("POST /api/v1/financeiro/comandas — o atendimento é resolvido na empresa ativa", () => {
  it("atendimento da OUTRA empresa: 422 do faturamento em lote e nenhuma linha em sales", async () => {
    const antes = mundo.contar("sales");

    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");
    const res = await POST(pedidoPost(COMANDAS, { appointment_id: ATENDIMENTO_B }));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("financeiro_agendamento_fora_da_empresa");
    expect(mundo.contar("sales")).toBe(antes);
    expect(mundo.escritas()).toHaveLength(0);
  });

  it("contato da OUTRA empresa: 422 do faturamento em lote e nenhuma linha em sales", async () => {
    const antes = mundo.contar("sales");

    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");
    const res = await POST(pedidoPost(COMANDAS, { contact_id: CONTATO_B }));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("financeiro_contato_fora_da_empresa");
    expect(mundo.contar("sales")).toBe(antes);
    expect(mundo.escritas()).toHaveLength(0);
  });

  it("a recusa é a MESMA de um id inexistente — não confirma que o registro existe noutra empresa", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");

    const deOutraEmpresa = await POST(
      pedidoPost(COMANDAS, { appointment_id: ATENDIMENTO_B }),
    ).then((r) => r.json());
    const inexistente = await POST(
      pedidoPost(COMANDAS, { appointment_id: CONTRATO_QUE_NAO_EXISTE }),
    ).then((r) => r.json());

    expect(deOutraEmpresa.error).toEqual(inexistente.error);
    expect(deOutraEmpresa.error.message).not.toContain(ATENDIMENTO_B);
  });

  it("atendimento da PRÓPRIA empresa continua abrindo comanda nela", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");
    const res = await POST(pedidoPost(COMANDAS, { appointment_id: ATENDIMENTO_A }));

    expect(res.status).toBe(200);
    const gravadas = mundo.linhas("sales");
    expect(gravadas).toHaveLength(1);
    expect(gravadas[0]!.organization_id).toBe(A);
    expect(gravadas[0]!.appointment_id).toBe(ATENDIMENTO_A);
  });

  it("contato da PRÓPRIA empresa continua aceito (empresa única não muda)", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");
    const res = await POST(pedidoPost(COMANDAS, { contact_id: CONTATO_A }));

    expect(res.status).toBe(200);
    expect(mundo.linhas("sales")[0]!.contact_id).toBe(CONTATO_A);
  });

  it("com a empresa B ativa, o atendimento da B é o aceito e o da A é o recusado", async () => {
    comoEmpresa(B);
    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");

    const daB = await POST(pedidoPost(COMANDAS, { appointment_id: ATENDIMENTO_B }));
    const daA = await POST(pedidoPost(COMANDAS, { appointment_id: ATENDIMENTO_A }));

    expect(daB.status).toBe(200);
    expect(daA.status).toBe(422);
    expect((await daA.json()).error.code).toBe("financeiro_agendamento_fora_da_empresa");
    expect(mundo.linhas("sales").map((s) => s.organization_id)).toEqual([B]);
  });
});

describe("GET /api/v1/honorarios/contratos/[id]/parcelas — o contrato é resolvido na empresa ativa", () => {
  it("contrato da OUTRA empresa: 404 e nenhuma parcela no corpo", async () => {
    const { GET } = await import("@/app/api/v1/honorarios/contratos/[id]/parcelas/route");
    const res = await GET(
      pedidoGet(`http://localhost/api/v1/honorarios/contratos/${CONTRATO_B}/parcelas`),
      paramsDoContrato(CONTRATO_B),
    );

    expect(res.status).toBe(404);
    const corpo = await res.text();
    expect(corpo).not.toContain("parcela-b-1");
  });

  it("a recusa do contrato de outra empresa é igual à do contrato inexistente", async () => {
    const { GET } = await import("@/app/api/v1/honorarios/contratos/[id]/parcelas/route");

    const deOutra = await GET(
      pedidoGet(`http://localhost/api/v1/honorarios/contratos/${CONTRATO_B}/parcelas`),
      paramsDoContrato(CONTRATO_B),
    ).then((r) => r.json());
    const inexistente = await GET(
      pedidoGet(`http://localhost/api/v1/honorarios/contratos/${CONTRATO_QUE_NAO_EXISTE}/parcelas`),
      paramsDoContrato(CONTRATO_QUE_NAO_EXISTE),
    ).then((r) => r.json());

    expect(deOutra.error).toEqual(inexistente.error);
  });

  it("contrato da PRÓPRIA empresa devolve só as parcelas dela", async () => {
    const { GET } = await import("@/app/api/v1/honorarios/contratos/[id]/parcelas/route");
    const res = await GET(
      pedidoGet(`http://localhost/api/v1/honorarios/contratos/${CONTRATO_A}/parcelas`),
      paramsDoContrato(CONTRATO_A),
    );

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ id: string }> };
    expect(corpo.data.map((p) => p.id)).toEqual(["parcela-a-1"]);
  });

  it("com a empresa B ativa, o contrato da B é o aceito", async () => {
    comoEmpresa(B);
    const { GET } = await import("@/app/api/v1/honorarios/contratos/[id]/parcelas/route");

    const daB = await GET(
      pedidoGet(`http://localhost/api/v1/honorarios/contratos/${CONTRATO_B}/parcelas`),
      paramsDoContrato(CONTRATO_B),
    );
    const daA = await GET(
      pedidoGet(`http://localhost/api/v1/honorarios/contratos/${CONTRATO_A}/parcelas`),
      paramsDoContrato(CONTRATO_A),
    );

    expect(daB.status).toBe(200);
    expect(daA.status).toBe(404);
  });
});

describe("as quatro listas continuam recortadas pela empresa ativa (#4858/#4859, não-regressão)", () => {
  it("a empresa A não vê a comanda, nem o contrato, nem o lançamento da B", async () => {
    mundo.semear("sales", [
      { id: "comanda-a", organization_id: A, number: 1, status: "open", contact_id: CONTATO_A },
      { id: "comanda-b", organization_id: B, number: 1, status: "open", contact_id: CONTATO_B },
    ]);

    const comandas = await import("@/app/api/v1/financeiro/comandas/route");
    const res = await comandas.GET(pedidoGet(COMANDAS));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ id: string }> };
    expect(corpo.data.map((c) => c.id)).toEqual(["comanda-a"]);

    const contratos = await import("@/app/api/v1/honorarios/contratos/route");
    const resContratos = await contratos.GET(
      pedidoGet("http://localhost/api/v1/honorarios/contratos"),
    );
    const corpoContratos = (await resContratos.json()) as { data: Array<{ id: string }> };
    expect(corpoContratos.data.map((c) => c.id)).toEqual([CONTRATO_A]);
  });
});
