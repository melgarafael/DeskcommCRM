/**
 * O LOTE TAMBÉM FECHA O NEGÓCIO PARA O FINANCEIRO (#3602, fatia 5).
 *
 * `POST /api/v1/leads/bulk` move N cards numa função do banco
 * (`fn_mover_leads_em_lote`), que escreve `stage_id` direto e deixa o gatilho
 * fechar quem entra numa etapa `is_won`/`is_lost`. Era a terceira porta que
 * fechava negócio sem que o molde recorrente nascesse (ou fosse desativado).
 *
 * Medido contra o Route Handler REAL, com auth e Supabase mockados — o mesmo
 * desenho de `perdido-em-lote-nao-sobrescreve-o-motivo.test.ts`. O que se
 * observa são as duas funções do molde, chamadas pelo cerco
 * (`lib/financeiro/recorrencia-do-fecho`); a regra do molde em si é medida em
 * `lib/financeiro/recorrencia-do-negocio.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: vi.fn(async () => null) }));
const molde = vi.hoisted(() => ({
  recorrenciaDoNegocio: vi.fn(async () => ({ estado: "criado" })),
  desativaRecorrenciaDoNegocio: vi.fn(async () => ({ estado: "desativado" })),
}));
vi.mock("@/lib/financeiro/recorrencia-do-negocio", () => molde);

import { POST } from "@/app/api/v1/leads/bulk/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const NEGOCIANDO = "99999999-9999-4999-8999-999999999999";
const GANHO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERDIDO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CRIADO_EM = "2026-03-05T23:30:00.000Z";

/** Negócio com recorrência declarada, em etapa aberta. */
const CARD_COM_MENSALIDADE = "44444444-4444-4444-8444-444444444444";
/** Negócio sem recorrência: ganhar não cria molde nenhum. */
const CARD_SEM_MENSALIDADE = "66666666-6666-4666-8666-666666666666";

interface Estado {
  destino: { id: string; name: string; is_won: boolean; is_lost: boolean };
  /** `from_stage_id` que a função do banco devolve por card. */
  origens: Record<string, string>;
}

function clienteStub(estado: Estado) {
  const leads = [
    {
      id: CARD_COM_MENSALIDADE,
      organization_id: ORG_ID,
      tags: [],
      stage_id: NEGOCIANDO,
      pipeline_id: PIPELINE_ID,
      contact_id: null,
      lost_reason: null,
      status: "open",
      recurring_value_cents: 50_000,
      created_at: CRIADO_EM,
    },
    {
      id: CARD_SEM_MENSALIDADE,
      organization_id: ORG_ID,
      tags: [],
      stage_id: NEGOCIANDO,
      pipeline_id: PIPELINE_ID,
      contact_id: null,
      lost_reason: null,
      status: "open",
      recurring_value_cents: null,
      created_at: CRIADO_EM,
    },
  ];

  return {
    from: (tabela: string) => {
      if (tabela === "crm_leads") {
        const b = {
          select: () => b,
          eq: () => b,
          in: () => b,
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve({ data: leads, error: null }).then(onF, onR),
        };
        return b;
      }
      if (tabela === "crm_stages") {
        const b = {
          select: () => b,
          eq: () => b,
          in: () => b,
          is: () => b,
          order: () => b,
          limit: () => b,
          maybeSingle: () => Promise.resolve({ data: estado.destino, error: null }),
          then: (onF: (v: unknown) => unknown) =>
            Promise.resolve({
              data: [
                { id: NEGOCIANDO, name: "Negociando" },
                { id: GANHO, name: "Ganho" },
                { id: PERDIDO, name: "Perdido" },
              ],
              error: null,
            }).then(onF),
        };
        return b;
      }
      // `crm_pipelines` (settings vazio: nenhuma régua recusa) e as demais
      // tabelas de leitura.
      const d = {
        select: () => d,
        eq: () => d,
        in: () => d,
        is: () => d,
        order: () => d,
        limit: () => d,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (onF: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(onF),
      };
      return d;
    },
    rpc(nome: string) {
      if (nome !== "fn_mover_leads_em_lote") {
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({
        data: Object.entries(estado.origens).map(([lead_id, from_stage_id]) => ({
          lead_id,
          from_stage_id,
          pipeline_id: PIPELINE_ID,
        })),
        error: null,
      });
    },
  };
}

function adminStub() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (onF: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onF),
  };
  return { from: () => chain, rpc: () => Promise.resolve({ data: null, error: null }) };
}

function sessao(estado: Estado) {
  const user: AuthUser = {
    id: USER_ID,
    email: "m@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" as Role }],
  };
  vi.mocked(requireRole).mockImplementation(async () => ({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" as Role },
  }));
  vi.mocked(createClient).mockResolvedValue(clienteStub(estado) as never);
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
}

function pedido(destinoId: string, extra: Record<string, unknown> = {}) {
  return new NextRequest("http://local/api/v1/leads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "move",
      lead_ids: [CARD_COM_MENSALIDADE, CARD_SEM_MENSALIDADE],
      params: { stage_id: destinoId, ...extra },
    }),
  });
}

function estadoPara(destino: Estado["destino"], origens: Record<string, string>): Estado {
  return { destino, origens };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("lote para a coluna Ganho (#3602, fatia 5)", () => {
  it("cria o molde de cada card que fechou COM recorrência — e só desses", async () => {
    sessao(
      estadoPara(
        { id: GANHO, name: "Ganho", is_won: true, is_lost: false },
        { [CARD_COM_MENSALIDADE]: NEGOCIANDO, [CARD_SEM_MENSALIDADE]: NEGOCIANDO },
      ),
    );

    const res = await POST(pedido(GANHO));
    expect(res.status).toBe(200);

    expect(molde.recorrenciaDoNegocio).toHaveBeenCalledTimes(1);
    expect(molde.recorrenciaDoNegocio).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG_ID,
        leadId: CARD_COM_MENSALIDADE,
        pipelineId: PIPELINE_ID,
        valorCents: 50_000,
        criadoEm: CRIADO_EM,
        userId: USER_ID,
      }),
    );
    expect(molde.desativaRecorrenciaDoNegocio).not.toHaveBeenCalled();
  });

  it("card que JÁ estava na coluna Ganho não cria molde de novo (reordenar em lote)", async () => {
    sessao(
      estadoPara(
        { id: GANHO, name: "Ganho", is_won: true, is_lost: false },
        {
          [CARD_COM_MENSALIDADE]: GANHO,
          [CARD_SEM_MENSALIDADE]: GANHO,
        },
      ),
    );

    const res = await POST(pedido(GANHO));
    expect(res.status).toBe(200);

    expect(molde.recorrenciaDoNegocio).not.toHaveBeenCalled();
    expect(molde.desativaRecorrenciaDoNegocio).not.toHaveBeenCalled();
  });

  it("financeiro fora do ar não derruba o lote: a resposta continua 200", async () => {
    molde.recorrenciaDoNegocio.mockRejectedValueOnce(new Error("banco fora"));
    sessao(
      estadoPara(
        { id: GANHO, name: "Ganho", is_won: true, is_lost: false },
        { [CARD_COM_MENSALIDADE]: NEGOCIANDO },
      ),
    );

    const res = await POST(pedido(GANHO));
    expect(res.status).toBe(200);
  });
});

describe("lote para a coluna Perdido (#3602, fatia 5)", () => {
  it("desativa o molde de cada card que fechou como perda", async () => {
    sessao(
      estadoPara(
        { id: PERDIDO, name: "Perdido", is_won: false, is_lost: true },
        { [CARD_COM_MENSALIDADE]: NEGOCIANDO, [CARD_SEM_MENSALIDADE]: NEGOCIANDO },
      ),
    );

    const res = await POST(pedido(PERDIDO, { lost_reason: "no_response" }));
    expect(res.status).toBe(200);

    expect(molde.desativaRecorrenciaDoNegocio).toHaveBeenCalledTimes(2);
    expect(molde.desativaRecorrenciaDoNegocio).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG_ID,
      leadId: CARD_COM_MENSALIDADE,
    });
    expect(molde.recorrenciaDoNegocio).not.toHaveBeenCalled();
  });
});

describe("lote para etapa comum (#3602, fatia 5)", () => {
  it("não toca no financeiro: só ganho e perda movem a recorrência", async () => {
    const ETAPA_COMUM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    sessao(
      estadoPara(
        { id: ETAPA_COMUM, name: "Negociando", is_won: false, is_lost: false },
        { [CARD_COM_MENSALIDADE]: NEGOCIANDO },
      ),
    );

    const res = await POST(pedido(ETAPA_COMUM));
    expect(res.status).toBe(200);

    expect(molde.recorrenciaDoNegocio).not.toHaveBeenCalled();
    expect(molde.desativaRecorrenciaDoNegocio).not.toHaveBeenCalled();
  });
});
