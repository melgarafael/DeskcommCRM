/**
 * O CAMINHO 1 (ARRASTO) — mover o card para uma etapa de PERDA sem motivo (#917).
 *
 * Prova, contra o Route Handler REAL de `POST /api/v1/leads/[id]/move` (auth e
 * Supabase mockados), que a recusa do banco chega ao board como RECUSA DE
 * NEGÓCIO (422 `lost_reason_required`), com o card INTACTO — e nunca como o 500
 * (`internal_error`) que o operador recebia depois de arrastar o card e decidir
 * que o negócio se perdeu.
 *
 * O duplo de banco emula o TRIGGER de verdade: `trg_crm_lead_close_on_stage`
 * fecha o negócio quando a etapa de destino é de perda e a CHECK
 * `crm_leads_lost_reason_required` recusa a linha (23514). É esse erro do banco
 * que o handler recebe quando NÃO decide antes.
 *
 * Vermelho sem o fix: sem a decisão de `lib/leads/motivo-da-perda.ts`, o UPDATE
 * acontece, o duplo devolve 23514 e o status é 500 (e a linha do banco fora da
 * faixa de motivo foi tocada, que é o que o terceiro caso prende).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { fail } from "@/lib/api/wrappers";
import { readFileSync } from "node:fs";
import { MOTIVO_DA_PERDA_OBRIGATORIO } from "@/lib/leads/motivo-da-perda";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: vi.fn(() => "razão"),
}));

import { POST } from "@/app/api/v1/leads/[id]/move/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "44444444-4444-4444-8444-444444444444";
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const PERDIDO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UPDATED_AT = "2026-09-15T12:00:00.000Z";

/** A recusa da CHECK do Postgres, como ela chega pelo supabase-js. */
const RECUSA_DO_BANCO = {
  code: "23514",
  message:
    'new row for relation "crm_leads" violates check constraint "crm_leads_lost_reason_required"',
};

interface Estado {
  updates: Array<Record<string, unknown>>;
}

function stub(estado: Estado) {
  const select = (tabela: string) => ({
    eq: () => ({
      maybeSingle: async () => {
        if (tabela === "crm_leads") {
          return {
            data: {
              id: LEAD_ID,
              organization_id: ORG_ID,
              pipeline_id: PIPELINE_ID,
              stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              status: "open",
              lost_reason: null,
              updated_at: UPDATED_AT,
              contact_id: "66666666-6666-4666-8666-666666666666",
            },
            error: null,
          };
        }
        // A etapa de destino: PERDA declarada pelo tenant (`is_lost`).
        return {
          data: { id: PERDIDO_ID, pipeline_id: PIPELINE_ID, name: "Perdido", is_lost: true },
          error: null,
        };
      },
    }),
  });

  return {
    from: (tabela: string) => ({
      select: () => select(tabela),
      update: (payload: Record<string, unknown>) => {
        estado.updates.push(payload);
        // O BANCO DE VERDADE: a CHECK recusa a etapa de perda SEM motivo, e
        // aceita a escrita que leva o motivo junto.
        //
        // ⚠️ O duplo devolvia a recusa SEMPRE, e isso apagava a prova do caso
        // com motivo: `recusaDeMotivoDaPerdaPeloBanco` (a rede de segurança)
        // devolve o MESMO 422 que a decisão, então os dois caminhos chegavam à
        // mesma saída e o caso ficava verde com a decisão sabotada. Ramo
        // redundante não distingue conserto de defeito.
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () =>
                  payload.lost_reason
                    ? {
                        data: { id: LEAD_ID, stage_id: PERDIDO_ID, updated_at: UPDATED_AT },
                        error: null,
                      }
                    : { data: null, error: RECUSA_DO_BANCO },
              }),
            }),
          }),
        };
      },
    }),
    // A rota emite o evento de domínio depois do movimento (`.then` sobre o
    // resultado do RPC) — sem isto o caminho FELIZ estouraria antes de responder.
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

function sessao(estado: Estado, papel: Role = "agent") {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockImplementation(async (min: Role) => {
    if (ROLE_RANK[papel] >= ROLE_RANK[min]) {
      return { ok: true, user, org: { orgId: ORG_ID, name: "Org", role: papel } };
    }
    return { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) };
  });
  vi.mocked(createClient).mockResolvedValue(stub(estado) as never);
}

function pedido(corpo: Record<string, unknown>) {
  return new NextRequest(`http://local/api/v1/leads/${LEAD_ID}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

describe("arrastar o card para a etapa de perda sem motivo (#917)", () => {
  let estado: Estado;
  beforeEach(() => {
    estado = { updates: [] };
  });

  it("sem motivo: 422 `lost_reason_required` (recusa de negócio), nunca 500", async () => {
    sessao(estado);
    const res = await POST(pedido({ stage_id: PERDIDO_ID, position_in_stage: 1000, expected_updated_at: UPDATED_AT }), {
      params: Promise.resolve({ id: LEAD_ID }),
    });

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(corpo.error?.code).toBe("lost_reason_required");
    // A mensagem diz o QUE FAZER — era o que faltava no 500 que o board mostrava.
    // "motivo" sozinho passava com a recusa sem saída nenhuma (medido no QA do
    // lote 12: a tela dizia só "Informe o motivo da perda."). A saída é o item de
    // menu que abre a janela do motivo, e é ele que a frase tem de nomear.
    expect(corpo.error?.message ?? "").toContain("“Marcar como perdido”");
  });

  it("a recusa acontece ANTES da escrita: o card não é tocado", async () => {
    sessao(estado);
    await POST(pedido({ stage_id: PERDIDO_ID, position_in_stage: 1000, expected_updated_at: UPDATED_AT }), {
      params: Promise.resolve({ id: LEAD_ID }),
    });

    expect(estado.updates).toHaveLength(0);
  });

  it("com motivo: o UPDATE leva a etapa E o motivo na MESMA escrita", async () => {
    sessao(estado);
    const res = await POST(
      pedido({
        stage_id: PERDIDO_ID,
        position_in_stage: 1000,
        expected_updated_at: UPDATED_AT,
        lost_reason: "Cliente desistiu",
      }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    // O motivo sai NA MESMA escrita da etapa, nunca numa segunda — e a escrita
    // PASSA: este é o caminho feliz, que faltava. Sem ele os três casos mediam
    // só recusa, e nada provava que mover para a perda COM motivo funciona.
    expect(estado.updates).toHaveLength(1);
    expect(estado.updates[0]).toMatchObject({ stage_id: PERDIDO_ID, lost_reason: "Cliente desistiu" });
    expect(res.status).toBe(200);
  });

  it("a saída que a recusa nomeia existe de verdade no menu do card", () => {
    // A frase aponta para um item de menu. Se o item for renomeado, a recusa passa a
    // mandar a pessoa procurar algo que a tela não tem — e nada reprovaria.
    const nomeado = /“([^”]+)”/.exec(MOTIVO_DA_PERDA_OBRIGATORIO)?.[1];
    expect(nomeado, "a recusa precisa nomear o item de menu entre aspas").toBeDefined();
    const menu = readFileSync("components/kanban/KanbanCardActions.tsx", "utf8");
    expect(menu).toContain(`t("${nomeado}")`);
  });
});
