/**
 * O IRMÃO do arrasto — `moveLeadHandler`, o escritor de etapa de todo mundo que
 * NÃO é o quadro: a IA (`lib/ai/runtime/tools.ts`), o lote
 * (`app/api/v1/leads/bulk`) e as automações
 * (`lib/automation/actions/create-or-move-lead.ts`).
 *
 * A issue #916 foi corrigida na rota `/move` movendo a releitura do lead para
 * DEPOIS de gravar a atividade. Aqui a mesma inversão seguia de pé, e a cascata
 * que a torna um defeito é a MESMA, medida no schema e não na prosa: o INSERT em
 * `crm_lead_activities` com `type = 'stage_changed'` passa pela lista positiva de
 * `fn_update_last_activity_at` (supabase/baseline.sql), que faz `update crm_leads`,
 * que dispara `fn_set_updated_at` (`new.updated_at := now()`, incondicional).
 *
 * Quem lê o retorno deste handler e o guarda como `expected_updated_at` da
 * próxima escrita leva 409 — e quem faz isso não é hipótese: é o quadro, pelo
 * cache de `["board", pipelineId]`, quando a IA ou uma automação move o card.
 *
 * ⚠️ Este teste NÃO vale para `lib/leads/encerramento.ts`, o terceiro irmão.
 * Medido: ele emite `type = 'demand_closed'`, que NÃO está na lista positiva —
 * lá não há segunda escrita, e a ordem, invertida, não produz defeito nenhum.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: vi.fn(async () => null),
}));
const rpcDoAdmin = vi.hoisted(() =>
  vi.fn((_funcao: string, _args: unknown) => Promise.resolve({ error: null })),
);
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ rpc: rpcDoAdmin })),
}));

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ETAPA_A = "55555555-5555-4555-8555-555555555555";
const ETAPA_B = "66666666-6666-4666-8666-666666666666";

const CARREGADO = "2026-09-15T12:00:00.000Z";
/** O `updated_at` logo depois do UPDATE que move a etapa. */
const DEPOIS_DO_MOVE = "2026-09-15T12:00:01.000Z";
/** O `updated_at` depois que o gatilho de `last_activity_at` escreve no lead de novo. */
const DEPOIS_DA_ATIVIDADE = "2026-09-15T12:00:01.500Z";

/** Banco falso com a cascata real: gravar a atividade troca o `updated_at`. */
function bancoFalso(statusDepoisDoUpdate = "open") {
  const banco = { updatedAt: CARREGADO, stageId: ETAPA_A, status: "open" };
  vi.mocked(emitLeadActivity).mockImplementation(async () => {
    banco.updatedAt = DEPOIS_DA_ATIVIDADE;
    return { ok: true } as never;
  });

  const lead = () => ({
    id: LEAD,
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: banco.stageId,
    contact_id: null,
    status: banco.status,
    lost_reason: null,
    updated_at: banco.updatedAt,
  });

  const from = (tabela: string) => {
    if (tabela === "crm_stages") {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (_col: string, id: string) => {
        chain.id = id;
        return chain;
      };
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = async () => ({
        data: {
          id: chain.id,
          organization_id: ORG,
          pipeline_id: FUNIL,
          name: "Etapa",
          is_lost: false,
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
        update: (valores: { stage_id: string }) => {
          const escrita: Record<string, unknown> = {};
          escrita.eq = () => escrita;
          escrita.select = () => escrita;
          escrita.maybeSingle = async () => {
            banco.stageId = valores.stage_id;
            banco.updatedAt = DEPOIS_DO_MOVE;
            // O que `trg_crm_lead_close_on_stage` (BEFORE) escreve na mesma linha.
            banco.status = statusDepoisDoUpdate;
            return { data: lead(), error: null };
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
  actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
  requestId: "req-1",
  idioma: "pt-BR",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("moveLeadHandler", () => {
  it("devolve o updated_at FINAL, depois da atividade que o próprio move grava", async () => {
    const devolvido = (await moveLeadHandler(bancoFalso() as never, ctx, LEAD, {
      to_stage_id: ETAPA_B,
      position_in_stage: 1500,
    })) as { stage_id: string; updated_at: string };

    expect(devolvido.stage_id).toBe(ETAPA_B);
    expect(devolvido.updated_at).toBe(DEPOIS_DA_ATIVIDADE);
  });

  it("o evento `lead.stage_changed` leva o status que o gatilho do UPDATE escreveu", async () => {
    // O `status` do emit_event lia a RELEITURA. Com ela no fim, ler dali seria
    // amarrar o evento à ordem da releitura — e o valor já está no retorno do
    // próprio UPDATE, porque `trg_crm_lead_close_on_stage` é BEFORE.
    //
    // O caso anterior deste arquivo afirmava sobre o lead DEVOLVIDO, não sobre o
    // evento que o título nomeia — e o `status` do lead lido ANTES do UPDATE
    // ("open") passava igual. Aqui o UPDATE devolve "won" (o gatilho fechou o
    // negócio), então só o valor do UPDATE satisfaz a asserção.
    await moveLeadHandler(bancoFalso("won") as never, ctx, LEAD, {
      to_stage_id: ETAPA_B,
    });

    expect(rpcDoAdmin).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({
        p_event_type: "lead.stage_changed",
        p_payload: expect.objectContaining({ status: "won" }),
      }),
    );
  });
});
