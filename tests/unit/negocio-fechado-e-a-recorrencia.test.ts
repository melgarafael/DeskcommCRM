/**
 * O FECHO DO NEGÓCIO CHEGA AO FINANCEIRO (#3602, fatias 3 e 4).
 *
 * `moveLeadHandler` é o escritor de etapa de tudo que NÃO é o arrasto (MCP
 * `crm_move_lead_stage`, automações, lote, IA). Este teste prende o FIO: ao
 * entrar numa etapa `is_won` com `recurring_value_cents` declarado, a função do
 * molde é chamada UMA vez com o negócio, o valor e o `created_at`; ao entrar
 * numa etapa `is_lost`, a desativação é chamada. Sem valor, sem chamada — e a
 * reordenação dentro da mesma etapa nunca chama nada.
 *
 * A regra do molde em si (valor, dia, idempotência, conta, módulo) é medida em
 * `lib/financeiro/recorrencia-do-negocio.test.ts`; aqui se mede que o handler
 * liga o fio e que uma falha do financeiro NÃO derruba o movimento.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: vi.fn(async () => null),
}));
const rpcDoAdmin = vi.hoisted(() => vi.fn(async () => ({ error: null })));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ rpc: rpcDoAdmin })),
}));
const molde = vi.hoisted(() => ({
  recorrenciaDoNegocio: vi.fn(async () => ({ estado: "criado" })),
  desativaRecorrenciaDoNegocio: vi.fn(async () => ({ estado: "desativado" })),
}));
vi.mock("@/lib/financeiro/recorrencia-do-negocio", () => molde);

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ETAPA_A = "55555555-5555-4555-8555-555555555555";
const ETAPA_B = "66666666-6666-4666-8666-666666666666";
const USER = "11111111-1111-4111-8111-111111111111";
const CRIADO_EM = "2026-03-05T23:30:00.000Z";

function bancoFalso(opcoes: {
  etapa: { is_won?: boolean; is_lost?: boolean };
  recurringValueCents?: number | null;
  /** O negócio JÁ está nesta etapa — mover para ela é reordenação. */
  jaNaEtapa?: string;
}) {
  let etapaAtual = opcoes.jaNaEtapa ?? ETAPA_A;
  const lead = () => ({
    id: LEAD,
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: etapaAtual,
    contact_id: null,
    status: "open",
    lost_reason: null,
    updated_at: "2026-09-15T12:00:00.000Z",
    custom_fields: {},
    won_reason: null,
    created_at: CRIADO_EM,
    recurring_value_cents: opcoes.recurringValueCents ?? null,
    recurring_months: 12,
  });

  const from = (tabela: string) => {
    if (tabela === "crm_pipelines") {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: { settings: null }, error: null });
      return chain;
    }
    if (tabela === "crm_stages") {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = async () => ({
        data: {
          id: ETAPA_B,
          organization_id: ORG,
          pipeline_id: FUNIL,
          name: "Etapa",
          is_won: opcoes.etapa.is_won ?? false,
          is_lost: opcoes.etapa.is_lost ?? false,
        },
        error: null,
      });
      return chain;
    }
    if (tabela === "crm_lead_activities") {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.limit = async () => ({ data: [], error: null });
      return chain;
    }
    if (tabela === "crm_leads") {
      return {
        select: () => {
          const leitura: Record<string, unknown> = {};
          leitura.eq = () => leitura;
          leitura.order = () => leitura;
          leitura.limit = () => leitura;
          leitura.maybeSingle = async () => ({ data: lead(), error: null });
          return leitura;
        },
        update: () => {
          const escrita: Record<string, unknown> = {};
          escrita.eq = () => escrita;
          escrita.select = () => escrita;
          escrita.maybeSingle = async () => {
            etapaAtual = ETAPA_B;
            return {
              data: {
                ...lead(),
                stage_id: ETAPA_B,
                status: opcoes.etapa.is_won ? "won" : opcoes.etapa.is_lost ? "lost" : "open",
              },
              error: null,
            };
          };
          return escrita;
        },
      };
    }
    throw new Error(`tabela inesperada: ${tabela}`);
  };

  return { from };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USER },
  requestId: "req-3602",
  idioma: "pt-BR",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("moveLeadHandler — o financeiro do fecho", () => {
  it("ganho com recorrência: chama o molde UMA vez, com negócio, valor e created_at", async () => {
    await moveLeadHandler(bancoFalso({ etapa: { is_won: true }, recurringValueCents: 50_000 }) as never, ctx, LEAD, {
      to_stage_id: ETAPA_B,
    });

    expect(molde.recorrenciaDoNegocio).toHaveBeenCalledTimes(1);
    expect(molde.recorrenciaDoNegocio).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        leadId: LEAD,
        pipelineId: FUNIL,
        valorCents: 50_000,
        criadoEm: CRIADO_EM,
        meses: 12,
        userId: USER,
      }),
    );
    expect(molde.desativaRecorrenciaDoNegocio).not.toHaveBeenCalled();
  });

  it("ganho SEM recorrência declarada não toca no financeiro", async () => {
    await moveLeadHandler(bancoFalso({ etapa: { is_won: true }, recurringValueCents: null }) as never, ctx, LEAD, {
      to_stage_id: ETAPA_B,
    });

    expect(molde.recorrenciaDoNegocio).not.toHaveBeenCalled();
    expect(molde.desativaRecorrenciaDoNegocio).not.toHaveBeenCalled();
  });

  it("perdido desativa a recorrência DAQUELE negócio", async () => {
    await moveLeadHandler(bancoFalso({ etapa: { is_lost: true } }) as never, ctx, LEAD, {
      to_stage_id: ETAPA_B,
      lost_reason: "sem resposta",
    });

    expect(molde.desativaRecorrenciaDoNegocio).toHaveBeenCalledTimes(1);
    expect(molde.desativaRecorrenciaDoNegocio).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      leadId: LEAD,
    });
    expect(molde.recorrenciaDoNegocio).not.toHaveBeenCalled();
  });

  it("reordenar dentro da etapa ganha NÃO cria molde de novo", async () => {
    await moveLeadHandler(
      bancoFalso({ etapa: { is_won: true }, recurringValueCents: 50_000, jaNaEtapa: ETAPA_B }) as never,
      ctx,
      LEAD,
      { to_stage_id: ETAPA_B, position_in_stage: 2000 },
    );

    expect(molde.recorrenciaDoNegocio).not.toHaveBeenCalled();
    expect(molde.desativaRecorrenciaDoNegocio).not.toHaveBeenCalled();
  });

  it("falha do financeiro NÃO derruba o movimento do negócio", async () => {
    molde.recorrenciaDoNegocio.mockRejectedValueOnce(new Error("banco fora"));

    const devolvido = (await moveLeadHandler(
      bancoFalso({ etapa: { is_won: true }, recurringValueCents: 50_000 }) as never,
      ctx,
      LEAD,
      { to_stage_id: ETAPA_B },
    )) as { stage_id: string };

    expect(devolvido.stage_id).toBe(ETAPA_B);
  });
});
