/**
 * A COMANDA SÓ ACEITA VÍNCULO DA PRÓPRIA EMPRESA, E AS PARCELAS SÓ RESPONDEM PELO
 * CONTRATO DA EMPRESA ATIVA.
 *
 * A RLS de `contacts`, `calendar_appointments` e `honorarios_contratos` libera
 * toda empresa de que a pessoa é membro. Por isso a rota confere a empresa
 * ATIVA (`authz.org.orgId`) explicitamente:
 *
 * - `POST /api/v1/financeiro/comandas`: `contact_id` e `appointment_id` do corpo
 *   são conferidos antes do insert; o de fora vira 422 com o código do
 *   faturamento em lote (#4845) e nada é gravado.
 * - `GET /api/v1/honorarios/contratos/[id]/parcelas`: contrato de outra empresa
 *   responde o mesmo 404 do inexistente, e as parcelas são lidas com o filtro.
 *
 * O dublê APLICA os filtros (`tests/helpers/postgrest-de-duas-empresas.ts`): um
 * que devolvesse a linha escrita à mão passaria com e sem a guarda.
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

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTATO_DA_A = "22222222-2222-4222-8222-222222222222";
const CONTATO_DA_B = "33333333-3333-4333-8333-333333333333";
const COMPROMISSO_DA_A = "44444444-4444-4444-8444-444444444444";
const COMPROMISSO_DA_B = "55555555-5555-4555-8555-555555555555";
const CONTRATO_DA_A = "66666666-6666-4666-8666-666666666666";
const CONTRATO_DA_B = "77777777-7777-4777-8777-777777777777";

let empresaAtiva = A;
let mundo = bancoDeDuasEmpresas();

beforeEach(() => {
  vi.clearAllMocks();
  empresaAtiva = A;
  mundo = bancoDeDuasEmpresas({
    organizations: [
      { id: A, currency: "BRL" },
      { id: B, currency: "BRL" },
    ],
    contacts: [
      { id: CONTATO_DA_A, organization_id: A },
      { id: CONTATO_DA_B, organization_id: B },
    ],
    calendar_appointments: [
      { id: COMPROMISSO_DA_A, organization_id: A, status: "confirmed" },
      { id: COMPROMISSO_DA_B, organization_id: B, status: "confirmed" },
    ],
    honorarios_contratos: [
      { id: CONTRATO_DA_A, organization_id: A },
      { id: CONTRATO_DA_B, organization_id: B },
    ],
    honorarios_parcelas: [
      { id: "parcela-a", organization_id: A, contrato_id: CONTRATO_DA_A, numero: 1, valor_cents: 1000 },
      { id: "parcela-b", organization_id: B, contrato_id: CONTRATO_DA_B, numero: 1, valor_cents: 9000 },
    ],
  });
  vi.mocked(requireRole).mockImplementation(
    async () =>
      ({
        ok: true,
        user: { id: USER, idioma: "pt-BR" },
        org: { orgId: empresaAtiva, name: "Empresa", role: "manager" },
      }) as never,
  );
  // O número da comanda vem de `fn_proximo_numero_de_comanda`, que o dublê
  // compartilhado não conhece; o resto do PostgREST é o dele.
  const cliente = {
    ...mundo.cliente,
    rpc: async (nome: string, args: Record<string, unknown> = {}) =>
      nome === "fn_proximo_numero_de_comanda" ? { data: 7, error: null } : mundo.cliente.rpc(nome, args),
  };
  vi.mocked(createClient).mockImplementation(async () => cliente as never);
});

describe("POST /api/v1/financeiro/comandas — o vínculo é da empresa ativa", () => {
  async function abrir(corpo: Record<string, unknown>): Promise<Response> {
    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");
    return POST(
      new NextRequest("http://localhost/api/v1/financeiro/comandas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      }),
    );
  }

  it("cliente de outra empresa → 422 financeiro_contato_fora_da_empresa, nada gravado", async () => {
    const res = await abrir({ contact_id: CONTATO_DA_B });

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("financeiro_contato_fora_da_empresa");
    expect(mundo.contar("sales")).toBe(0);
    expect(mundo.escritas()).toEqual([]);
  });

  it("atendimento de outra empresa → 422 financeiro_agendamento_fora_da_empresa, nada gravado", async () => {
    const res = await abrir({ contact_id: CONTATO_DA_A, appointment_id: COMPROMISSO_DA_B });

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("financeiro_agendamento_fora_da_empresa");
    expect(mundo.contar("sales")).toBe(0);
    expect(mundo.escritas()).toEqual([]);
  });

  it("controle: cliente e atendimento da própria empresa abrem a comanda", async () => {
    const res = await abrir({ contact_id: CONTATO_DA_A, appointment_id: COMPROMISSO_DA_A });

    expect(res.status).toBe(200);
    expect(mundo.linhas("sales")).toEqual([
      expect.objectContaining({
        organization_id: A,
        contact_id: CONTATO_DA_A,
        appointment_id: COMPROMISSO_DA_A,
      }),
    ]);
  });

  it("controle: a empresa B abre a comanda com o cliente dela — o recorte não quebrou ninguém", async () => {
    empresaAtiva = B;

    const res = await abrir({ contact_id: CONTATO_DA_B, appointment_id: COMPROMISSO_DA_B });

    expect(res.status).toBe(200);
    expect(mundo.linhas("sales")).toEqual([expect.objectContaining({ organization_id: B })]);
  });

  it("controle: comanda avulsa, sem cliente nem atendimento, continua abrindo", async () => {
    const res = await abrir({});

    expect(res.status).toBe(200);
    expect(mundo.contar("sales")).toBe(1);
  });
});

describe("GET /api/v1/honorarios/contratos/[id]/parcelas — o contrato é da empresa ativa", () => {
  async function listar(contratoId: string): Promise<Response> {
    const { GET } = await import("@/app/api/v1/honorarios/contratos/[id]/parcelas/route");
    return GET(
      new NextRequest(`http://localhost/api/v1/honorarios/contratos/${contratoId}/parcelas`),
      { params: Promise.resolve({ id: contratoId }) },
    );
  }

  it("contrato de outra empresa → 404, sem nenhuma parcela dele", async () => {
    const res = await listar(CONTRATO_DA_B);

    expect(res.status).toBe(404);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("not_found");
    expect(JSON.stringify(corpo)).not.toContain("parcela-b");
  });

  it("contrato inexistente → o MESMO 404", async () => {
    const res = await listar("88888888-8888-4888-8888-888888888888");

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("controle: o contrato da própria empresa lista as parcelas dele", async () => {
    const res = await listar(CONTRATO_DA_A);

    expect(res.status).toBe(200);
    expect((await res.json()).data.map((p: { id: string }) => p.id)).toEqual(["parcela-a"]);
  });

  it("a leitura das parcelas também filtra a empresa, não só a do contrato", async () => {
    await listar(CONTRATO_DA_A);

    const parcelas = mundo.chamadas.find((c) => c.tabela === "honorarios_parcelas");
    expect(parcelas?.filtros).toContainEqual(["organization_id", A]);
  });
});
