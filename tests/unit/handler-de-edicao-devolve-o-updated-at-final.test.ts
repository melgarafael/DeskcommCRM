/**
 * O QUARTO IRMÃO do #916 — `updateLeadHandler`, o PATCH que o dossiê usa.
 *
 * O conserto do cliente (`useEditLead` gravando a resposta no cache do quadro)
 * só fecha o 409 de "editar e arrastar em seguida" se a RESPOSTA carregar o
 * `updated_at` final. E não carregava: o handler devolvia o retorno do UPDATE,
 * e só DEPOIS gravava a atividade `lead_edited` — que está na lista positiva de
 * `fn_update_last_activity_at` (supabase/baseline.sql). O gatilho faz
 * `update crm_leads`, que passa por `fn_set_updated_at`
 * (`new.updated_at := now()`, incondicional), numa transação POSTERIOR à do
 * UPDATE: o `updated_at` muda de novo depois de a resposta já ter sido montada.
 *
 * Resultado sem este conserto: o hook grava no cache um carimbo que a própria
 * edição invalidou, e o arrasto seguinte leva 409 do mesmo jeito — o conserto do
 * cliente vira decorativo. Os testes do quadro não enxergam isso porque o PATCH
 * é dublê lá; aqui o banco falso tem a cascata.
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
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(() => Promise.resolve({ error: null })),
  })),
}));

import { updateLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

const CARREGADO = "2026-09-15T12:00:00.000Z";
/** O `updated_at` logo depois do UPDATE da edição. */
const DEPOIS_DA_EDICAO = "2026-09-15T12:00:01.000Z";
/** O `updated_at` depois que o gatilho de `last_activity_at` escreve no lead de novo. */
const DEPOIS_DA_ATIVIDADE = "2026-09-15T12:00:01.500Z";

/** Banco falso com a cascata real: gravar a atividade troca o `updated_at`. */
function bancoFalso() {
  const banco = { updatedAt: CARREGADO, title: "Antes" };
  vi.mocked(emitLeadActivity).mockImplementation(async () => {
    banco.updatedAt = DEPOIS_DA_ATIVIDADE;
    return { ok: true } as never;
  });

  const lead = () => ({
    id: LEAD,
    organization_id: ORG,
    contact_id: null,
    title: banco.title,
    tags: [],
    custom_fields: {},
    updated_at: banco.updatedAt,
  });

  const from = (tabela: string) => {
    if (tabela !== "crm_leads") throw new Error(`tabela inesperada: ${tabela}`);
    return {
      select: () => {
        const leitura: Record<string, unknown> = {};
        leitura.eq = () => leitura;
        leitura.maybeSingle = async () => ({ data: lead(), error: null });
        return leitura;
      },
      update: (valores: { title?: string }) => {
        const escrita: Record<string, unknown> = {};
        escrita.eq = () => escrita;
        escrita.select = () => escrita;
        escrita.maybeSingle = async () => {
          if (valores.title !== undefined) banco.title = valores.title;
          banco.updatedAt = DEPOIS_DA_EDICAO;
          return { data: lead(), error: null };
        };
        return escrita;
      },
    };
  };

  return {
    from,
    rpc: () => ({ then: (fn: (r: { error: null }) => void) => Promise.resolve(fn({ error: null })) }),
  };
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

describe("updateLeadHandler", () => {
  it("devolve o updated_at FINAL, depois da atividade que a própria edição grava", async () => {
    const devolvido = (await updateLeadHandler(bancoFalso() as never, ctx, LEAD, {
      title: "Depois",
    })) as { title: string; updated_at: string };

    // Premissa do cenário: a edição mudou um campo, então a atividade foi gravada.
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledTimes(1);
    expect(devolvido.title).toBe("Depois");
    expect(devolvido.updated_at).toBe(DEPOIS_DA_ATIVIDADE);
  });
});
