/**
 * O SEGUNDO ponto de uso da fronteira de funil (P-01) — o `moveLeadHandler`.
 *
 * O PR que criou `POST /api/v1/leads/[id]/clone` mudou DOIS lugares: a rota
 * `/move` (que o quadro usa) e o `moveLeadHandler` de `app/api/v1/leads/_handler.ts`
 * — o caminho da IA (`lib/ai/runtime/tools.ts`), do lote (`app/api/v1/leads/bulk`)
 * e das automações (`lib/automation/actions/create-or-move-lead.ts`). Só o
 * primeiro ganhou teste; medido, `git grep pipeline_immutable` em `*.test.ts`
 * devolvia UMA ocorrência, e ela era da rota.
 *
 * O que ficava sem guarda é justamente o que o consumidor lê para saber o que
 * fazer: o `details.use` que aponta o endpoint do clone. Sem ele o agente e a
 * automação recebem "não é permitido" e nenhum caminho — que é o defeito que a
 * issue #922 descreve, com outro nome.
 *
 * Sabotagem de controle, medida: devolver `undefined` no lugar do
 * `{ use: "/api/v1/leads/{id}/clone" }` da linha 646 deixava ZERO caso vermelho.
 */
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => ({ source: "user", reason: "move" }),
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const FUNIL_DA_ORIGEM = "44444444-4444-4444-8444-444444444444";
const OUTRO_FUNIL = "55555555-5555-4555-8555-555555555555";
const ETAPA_DO_OUTRO_FUNIL = "66666666-6666-4666-8666-666666666666";

/** O mínimo que o handler lê antes de recusar: o negócio e a etapa de destino. */
function clienteStub() {
  return {
    from: (tabela: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            tabela === "crm_leads"
              ? {
                  data: {
                    id: LEAD,
                    organization_id: ORG,
                    pipeline_id: FUNIL_DA_ORIGEM,
                    stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    status: "open",
                    updated_at: "2026-09-15T10:00:00.000Z",
                  },
                  error: null,
                }
              : {
                  data: {
                    id: ETAPA_DO_OUTRO_FUNIL,
                    organization_id: ORG,
                    pipeline_id: OUTRO_FUNIL,
                    name: "Triagem",
                    is_lost: false,
                  },
                  error: null,
                },
        }),
      }),
    }),
  };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
  requestId: "req-1",
  idioma: "pt-BR",
};

async function moverParaOutroFunil(): Promise<ApiError> {
  try {
    await moveLeadHandler(clienteStub() as never, ctx, LEAD, {
      to_stage_id: ETAPA_DO_OUTRO_FUNIL,
    });
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("esperava a recusa de fronteira de funil, e o handler não recusou");
}

describe("mover um negócio para etapa de OUTRO funil, pelo handler", () => {
  it("recusa com 422 `pipeline_immutable_use_clone`", async () => {
    const err = await moverParaOutroFunil();
    expect(err.status).toBe(422);
    expect(err.code).toBe("pipeline_immutable_use_clone");
  });

  it("e APONTA o caminho: o endpoint do clone vai no `details`", async () => {
    // Sem isto a recusa é um beco: o agente e a automação leem "não é
    // permitido" e não têm para onde ir — que é o defeito que a rota do clone
    // veio consertar do outro lado.
    const err = await moverParaOutroFunil();
    expect(err.details).toMatchObject({ use: "/api/v1/leads/{id}/clone" });
  });

  it("a mensagem nomeia o endpoint, e não só a proibição", async () => {
    const err = await moverParaOutroFunil();
    expect(err.message).toContain("/api/v1/leads/[id]/clone");
  });
});
