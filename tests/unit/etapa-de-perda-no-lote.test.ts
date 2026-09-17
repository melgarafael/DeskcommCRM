/**
 * O CAMINHO 2 (LOTE) — mover N cards para uma etapa de PERDA sem motivo (#917).
 *
 * Prova, contra o Route Handler REAL de `POST /api/v1/leads/bulk` (auth e Supabase
 * mockados), que o lote é recusado como RECUSA DE NEGÓCIO (422), nomeando os
 * cards, ANTES de a função do banco ser chamada.
 *
 * ⚠️ Por que ANTES importa: `fn_mover_leads_em_lote` é UMA transação — "move
 * todos ou não move nenhum". UM card que ficaria perdido sem motivo derrubava o
 * LOTE INTEIRO com 23514, e o operador recebia 500 sem saber qual card ofendeu.
 * O duplo de banco emula exatamente essa recusa (23514 pela CHECK
 * `crm_leads_lost_reason_required`), que é o que a rota recebia sem o fix.
 *
 * Vermelho sem o fix: o RPC é chamado (o duplo devolve 23514) e o status vira 500
 * `internal_error` em vez de 422 — e o operador volta a não saber o que fazer.
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
const PERDIDO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CARD_A = "44444444-4444-4444-8444-444444444444";
const CARD_B = "55555555-5555-4555-8555-555555555555";

const RECUSA_DO_BANCO = {
  code: "23514",
  message:
    'new row for relation "crm_leads" violates check constraint "crm_leads_lost_reason_required"',
};

interface Estado {
  /** `lost_reason` que os cards JÁ têm (troca entre etapas de perda). */
  motivoAtual: string | null;
  rpcChamado: boolean;
  rpcArgs: Record<string, unknown> | null;
  isLostDaEtapa: boolean;
}

function clienteStub(estado: Estado) {
  const leads = [CARD_A, CARD_B].map((id) => ({
    id,
    organization_id: ORG_ID,
    tags: [],
    stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pipeline_id: PIPELINE_ID,
    contact_id: "66666666-6666-4666-8666-666666666666",
    lost_reason: estado.motivoAtual,
  }));

  return {
    from: (tabela: string) => {
      const b = {
        _op: "select" as "select" | "update",
        select() {
          return b;
        },
        update() {
          b._op = "update";
          return b;
        },
        eq() {
          return b;
        },
        in() {
          return b;
        },
        is() {
          return b;
        },
        maybeSingle() {
          // A etapa de destino do lote.
          return Promise.resolve({
            data: { id: PERDIDO_ID, name: "Perdido", is_lost: estado.isLostDaEtapa },
            error: null,
          });
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          void tabela;
          return Promise.resolve({ data: leads, error: null }).then(onF, onR);
        },
      };
      return b;
    },
    rpc(nome: string, args: Record<string, unknown>) {
      // SÓ a função do lote entra no registro. A rota também chama `emit_event`
      // por card DEPOIS do movimento, e gravar todo RPC aqui fazia `rpcArgs`
      // terminar com os argumentos do último — quem perguntasse pelo
      // `p_lost_reason` recebia o do evento, que não tem nenhum.
      if (nome !== "fn_mover_leads_em_lote") {
        return Promise.resolve({ data: null, error: null });
      }
      estado.rpcChamado = true;
      estado.rpcArgs = { nome, ...args };
      // A função do banco roda numa transação só: sem motivo, a CHECK recusa o
      // lote inteiro (23514). Com motivo, ela gravou e devolveu as linhas.
      // A CHECK só olha o card que o trigger fechou: etapa de perda SEM motivo.
      const error =
        !estado.isLostDaEtapa || estado.motivoAtual || args?.p_lost_reason ? null : RECUSA_DO_BANCO;
      return Promise.resolve(
        error
          ? { data: null, error }
          : {
              data: [CARD_A, CARD_B].map((id) => ({
                lead_id: id,
                from_stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                pipeline_id: PIPELINE_ID,
              })),
              error: null,
            },
      );
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

function pedido(params: Record<string, unknown>) {
  return new NextRequest("http://local/api/v1/leads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "move", lead_ids: [CARD_A, CARD_B], params }),
  });
}

describe("mover o lote para uma etapa de perda (#917)", () => {
  let estado: Estado;
  beforeEach(() => {
    estado = { motivoAtual: null, rpcChamado: false, rpcArgs: null, isLostDaEtapa: true };
    void ROLE_RANK;
  });

  it("sem motivo: 422 nomeando os cards, e a função do banco NÃO é chamada", async () => {
    sessao(estado);
    const res = await POST(pedido({ stage_id: PERDIDO_ID }));

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    expect(corpo.error?.code).toBe("lost_reason_required");
    // A recusa NOMEIA os cards — é o que distingue "um card do lote não pode" de
    // "o lote inteiro caiu". Vive no `details` do envelope de erro (contrato de
    // fio), e é por ele que um cliente de API sabe quais reenviar.
    const detalhe = corpo.error?.details as { lead_ids?: string[] } | undefined;
    expect(detalhe?.lead_ids).toEqual([CARD_A, CARD_B]);
    // O ponto do fix: a transação única nunca começa, então nenhum card do lote
    // é movido "pela metade" nem o lote inteiro cai por causa de um.
    expect(estado.rpcChamado).toBe(false);
  });

  it("card que JÁ tem motivo passa (trocar de etapa de perda não é perda nova)", async () => {
    estado.motivoAtual = "price";
    sessao(estado);
    const res = await POST(pedido({ stage_id: PERDIDO_ID }));

    expect(estado.rpcChamado).toBe(true);
    expect(res.status).toBe(200);
    // E o lote NÃO reescreve o motivo que o card já tem: `p_lost_reason` nulo é
    // o que faz a migration 0263 deixar a coluna fora da lista do `update` — se
    // ela entrasse, o trigger revalidaria um motivo que saiu da configuração
    // depois de usado e o lote cairia com 22023 `lost_reason_invalid`, enquanto
    // o arrasto do MESMO card continuaria passando.
    expect(estado.rpcArgs?.p_lost_reason).toBeNull();
  });

  it("com motivo no lote: o motivo vai para a função do banco, na MESMA escrita", async () => {
    // A razão de existir da migration 0263. Sem esta asserção o `rpcArgs` era
    // estado morto: o duplo capturava os argumentos e ninguém os olhava, então
    // trocar o nome do parâmetro (ou deixar de passá-lo) não deixava nada
    // vermelho — e a única prova do parâmetro seria o baseline APLICAR a função,
    // que não é o mesmo que CHAMÁ-LA.
    sessao(estado);
    const res = await POST(pedido({ stage_id: PERDIDO_ID, lost_reason: "price" }));

    expect(res.status).toBe(200);
    expect(estado.rpcArgs).toMatchObject({
      nome: "fn_mover_leads_em_lote",
      p_stage_id: PERDIDO_ID,
      p_lost_reason: "price",
    });
  });

  it("a etapa comum (is_lost falso) não pede motivo nenhum", async () => {
    estado.isLostDaEtapa = false;
    sessao(estado);
    const res = await POST(pedido({ stage_id: PERDIDO_ID }));

    expect(estado.rpcChamado).toBe(true);
    expect(res.status).toBe(200);
  });
});
