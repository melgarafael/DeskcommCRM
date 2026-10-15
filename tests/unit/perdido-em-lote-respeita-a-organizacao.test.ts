/**
 * F2 (#2484) — a UNIDADE POR ITEM do "perdido em lote", provada contra a rota
 * REAL de `POST /api/v1/leads/bulk` (auth e Supabase mockados).
 *
 * A barra nova (`BulkActionBar`) manda `action: "move"` com a etapa de perda do
 * funil e UM `lost_reason` para os selecionados. Duas coisas NÃO podem depender
 * de sorte nem de RLS para estarem certas:
 *
 *  1. o escopo por ORGANIZAÇÃO vem da SESSÃO (`authz.org.orgId`), nunca do
 *     corpo — a tela não manda `organization_id`, e mesmo que um corpo hostil o
 *     mande, a rota o ignora. Um ator em 2+ orgs sem esse filtro explícito
 *     toca leads que não são dele;
 *  2. o lote só mexe nos ids VISÍVEIS: um id de outra organização que entre no
 *     `lead_ids` é filtrado antes da escrita, e a função do banco recebe apenas
 *     os visíveis — a permissão/responsabilidade de CADA item é respeitada.
 *
 * ⚠️ É o caminho que a #917 já decidiu: mover para `is_lost` exige o motivo, e
 * ele entra na MESMA escrita (`p_lost_reason`). Aqui o motivo é o único de um
 * lote inteiro (é o contrato da barra), por isso a asserção leva o motivo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { type AuthUser, type Role } from "@/lib/auth/types";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

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
const ORG_SESSAO = "22222222-2222-4222-8222-222222222222";
const ORG_OUTRA = "33333333-3333-4333-8333-333333333333";
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const PERDIDO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEAD_DA_ORG = "44444444-4444-4444-8444-444444444444";
const LEAD_DE_OUTRA_ORG = "66666666-6666-4666-8666-666666666666";

interface Estado {
  /** O que a rota passou para `.eq("organization_id", …)` na leitura de leads. */
  orgFiltroDaLeitura: string | null;
  /** O que a função do banco recebeu em `p_lead_ids`. */
  rpcLeadIds: string[] | null;
  rpcArgs: Record<string, unknown> | null;
}

function clienteStub(estado: Estado) {
  return {
    from: (tabela: string) => {
      if (tabela === "crm_leads") {
        const b = {
          select() {
            return b;
          },
          eq(coluna: string, valor: unknown) {
            // A rota escopa a leitura pela org da SESSÃO. O valor é registrado
            // aqui — é ele que prova "não confie na RLS".
            if (coluna === "organization_id") estado.orgFiltroDaLeitura = String(valor);
            return b;
          },
          in() {
            return b;
          },
          // A leitura só devolve o lead da org que a rota pediu — é o que a
          // RLS/escopo explícito faz no banco de verdade.
          then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
            const linhas =
              estado.orgFiltroDaLeitura === ORG_SESSAO
                ? [
                    {
                      id: LEAD_DA_ORG,
                      organization_id: ORG_SESSAO,
                      tags: [],
                      stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                      pipeline_id: PIPELINE_ID,
                      contact_id: "77777777-7777-4777-8777-777777777777",
                      lost_reason: null,
                    },
                  ]
                : [];
            return Promise.resolve({ data: linhas, error: null }).then(onF, onR);
          },
        };
        return b;
      }
      // Demais tabelas (`crm_stages`, `crm_pipelines`): a etapa de destino do
      // lote e um settings sem conteúdo — a régua de reabertura/campos não
      // recusa, então o teste isola o escopo por organização.
      const c = {
        select() {
          return c;
        },
        eq() {
          return c;
        },
        in() {
          return c;
        },
        is() {
          return c;
        },
        maybeSingle: () =>
          Promise.resolve({ data: { id: PERDIDO_ID, name: "Perdido", is_lost: true }, error: null }),
        then(onF: (v: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(onF);
        },
      };
      return c;
    },
    rpc(nome: string, args: Record<string, unknown>) {
      if (nome !== "fn_mover_leads_em_lote") {
        return Promise.resolve({ data: null, error: null });
      }
      estado.rpcLeadIds = (args.p_lead_ids as string[]) ?? [];
      estado.rpcArgs = { nome, ...args };
      return Promise.resolve({
        data: (estado.rpcLeadIds ?? []).map((id) => ({
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
    organizations: [
      { organization_id: ORG_SESSAO, organization_name: "Org", role: "manager" as Role },
      { organization_id: ORG_OUTRA, organization_name: "Outra", role: "manager" as Role },
    ],
  };
  vi.mocked(requireRole).mockImplementation(async () => ({
    ok: true,
    user,
    org: { orgId: ORG_SESSAO, name: "Org", role: "manager" as Role },
  }));
  vi.mocked(createClient).mockResolvedValue(clienteStub(estado) as never);
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
}

function pedido(corpo: Record<string, unknown>) {
  return new NextRequest("http://local/api/v1/leads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

describe("perdido em lote (#2484 F2) respeita a organização da sessão, por item", () => {
  let estado: Estado;

  beforeEach(() => {
    estado = { orgFiltroDaLeitura: null, rpcLeadIds: null, rpcArgs: null };
    vi.clearAllMocks();
    sessao(estado);
  });

  it("escopa pela org da SESSÃO mesmo com organization_id no corpo, e só move o lead visível", async () => {
    // Corpo HOSTIL: pede o lead de outra org e tenta apontar a organização pelo
    // corpo. A org de fonte confiável é a da sessão — o corpo é ignorado.
    const res = await POST(
      pedido({
        action: "move",
        organization_id: ORG_OUTRA,
        lead_ids: [LEAD_DA_ORG, LEAD_DE_OUTRA_ORG],
        params: { stage_id: PERDIDO_ID, lost_reason: "preço alto", organization_id: ORG_OUTRA },
      }),
    );

    expect(res.status).toBe(200);
    // 1) A leitura foi escopada pela org da sessão — nunca pela do corpo.
    expect(estado.orgFiltroDaLeitura).toBe(ORG_SESSAO);
    // 2) A função do banco recebeu a org da sessão e SÓ o id visível.
    expect(estado.rpcArgs?.p_organization_id).toBe(ORG_SESSAO);
    expect(estado.rpcLeadIds).toEqual([LEAD_DA_ORG]);
    // 3) O motivo único do lote entrou na MESMA escrita (contrato da barra).
    expect(estado.rpcArgs?.p_lost_reason).toBe("preço alto");

    const corpo = (await res.json()) as { data?: { updated_count?: number } };
    // O lead de outra org NÃO é contado — não foi tocado.
    expect(corpo.data?.updated_count).toBe(1);
    // 4) A timeline do lead perdido em lote diz o MOTIVO, na mesma frase da
    //    perda pelo card (`/lose`) — não só "Movido de X para Perdido" (#2868).
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitLeadActivity).mock.calls[0]?.[1]).toMatchObject({
      leadId: LEAD_DA_ORG,
      type: "stage_changed",
      reason: "Perdido — preço alto",
    });
  });
});
