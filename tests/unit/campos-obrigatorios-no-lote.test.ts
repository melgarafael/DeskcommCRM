/**
 * O CAMINHO 2 (LOTE) dos campos obrigatórios (issue #1536) — o irmão direto de
 * `etapa-de-perda-no-lote.test.ts`, com a MESMA promessa para a régua nova.
 *
 * Contra o Route Handler REAL de `POST /api/v1/leads/bulk` (auth e Supabase
 * mockados): um card sem o campo que a etapa de destino exige derruba a
 * recusa ANTES de `fn_mover_leads_em_lote` — a função do banco é uma
 * transação só ("move todos ou não move nenhum"), então quem não passa tem de
 * ser NOMEADO, não movido em silêncio nem enterrado num 500.
 *
 * E o controle negativo: card preenchido passa e a função é chamada — sem ele,
 * o teste anterior provaria só que qualquer coisa recusa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

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
  stageChangeReason: vi.fn(() => "razão"),
}));

import { POST } from "@/app/api/v1/leads/bulk/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const PROPOSTA_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CARD_A = "44444444-4444-4444-8444-444444444444";
const CARD_B = "66666666-6666-4666-8666-666666666666";

const CAMPOS_DO_FUNIL = {
  fields: [
    {
      key: "concorrente",
      label: "Concorrente",
      type: "text",
      obrigatorio_em: { etapas: [PROPOSTA_ID] },
    },
  ],
};

interface Estado {
  /** `custom_fields` de cada card do lote. */
  campos: Record<string, Record<string, unknown>>;
  rpcChamado: boolean;
}

function clienteStub(estado: Estado) {
  const leads = [CARD_A, CARD_B].map((id) => ({
    id,
    organization_id: ORG_ID,
    tags: [],
    stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pipeline_id: PIPELINE_ID,
    contact_id: "66666666-6666-4666-8666-666666666666",
    lost_reason: null,
    won_reason: null,
    custom_fields: estado.campos[id] ?? {},
  }));

  return {
    from: (tabela: string) => {
      const b = {
        _op: "select" as "select" | "update",
        select: () => b,
        update: () => ((b._op = "update"), b),
        eq: () => b,
        in: () => b,
        is: () => b,
        maybeSingle: () =>
          // A etapa de destino E o settings do funil respondem por aqui.
          Promise.resolve({
            data:
              tabela === "crm_pipelines"
                ? { settings: CAMPOS_DO_FUNIL }
                : { id: PROPOSTA_ID, name: "Proposta enviada", is_lost: false, is_won: false },
            error: null,
          }),
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
          void tabela;
          return Promise.resolve({ data: leads, error: null }).then(onF, onR);
        },
      };
      return b;
    },
    rpc(nome: string) {
      if (nome !== "fn_mover_leads_em_lote") {
        return Promise.resolve({ data: null, error: null });
      }
      estado.rpcChamado = true;
      return Promise.resolve({
        data: [CARD_A, CARD_B].map((id) => ({
          lead_id: id,
          from_stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
  vi.mocked(requireRole).mockImplementation(async (min: Role) => {
    void min;
    return { ok: true, user, org: { orgId: ORG_ID, name: "Org", role: "manager" as Role } };
  });
  vi.mocked(createClient).mockResolvedValue(clienteStub(estado) as never);
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
}

function pedido() {
  return new NextRequest("http://local/api/v1/leads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "move",
      lead_ids: [CARD_A, CARD_B],
      params: { stage_id: PROPOSTA_ID },
    }),
  });
}

describe("mover o lote para uma etapa que exige campo (#1536)", () => {
  let estado: Estado;
  beforeEach(() => {
    estado = { campos: {}, rpcChamado: false };
    vi.clearAllMocks();
  });

  it("card sem o campo: 422 nomeando os cards e o que falta, e a função do banco NÃO roda", async () => {
    sessao(estado);
    const res = await POST(pedido());

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as {
      error?: {
        code?: string;
        details?: { lead_ids?: string[]; faltando?: Record<string, { chave: string }[]> };
      };
    };
    expect(corpo.error?.code).toBe("required_fields_missing");
    // Os DOIS cards estão sem o campo — a recusa nomeia todos, como o irmão
    // da perda (#917) já fazia.
    expect(corpo.error?.details?.lead_ids).toEqual([CARD_A, CARD_B]);
    expect(corpo.error?.details?.faltando?.[CARD_A]).toEqual([
      { chave: "concorrente", rotulo: "Concorrente", tipo: "text" },
    ]);
    expect(estado.rpcChamado).toBe(false);
  });

  it("preenchendo só UM card, a recusa continua — o lote é transação única", async () => {
    estado.campos[CARD_A] = { concorrente: "ACME" };
    sessao(estado);
    const res = await POST(pedido());

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as {
      error?: { details?: { lead_ids?: string[] } };
    };
    // Quem não passa é listado; quem passa não é movido sozinho (transação).
    expect(corpo.error?.details?.lead_ids).toEqual([CARD_B]);
    expect(estado.rpcChamado).toBe(false);
  });

  it("todos preenchidos: o lote move (controle positivo — a régua não recusa tudo)", async () => {
    estado.campos[CARD_A] = { concorrente: "ACME" };
    estado.campos[CARD_B] = { concorrente: "BetaCorp" };
    sessao(estado);
    const res = await POST(pedido());

    expect(res.status).toBe(200);
    expect(estado.rpcChamado).toBe(true);
  });

  it("funil sem obrigatorio_em segue como hoje (controle do critério 3)", async () => {
    // Sobrescreve o settings do funil: campo com required antigo, sem exigência.
    const stub = clienteStub(estado);
    const original = stub.from;
    stub.from = ((tabela: string) => {
      if (tabela === "crm_pipelines") {
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: {
              settings: {
                fields: [
                  { key: "concorrente", label: "Concorrente", type: "text", required: true },
                ],
              },
            },
            error: null,
          }),
        };
        return b;
      }
      return original(tabela);
    }) as typeof stub.from;
    vi.mocked(createClient).mockResolvedValue(stub as never);

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

    const res = await POST(pedido());
    expect(res.status).toBe(200);
    expect(estado.rpcChamado).toBe(true);
  });
});
