import { describe, expect, it, vi } from "vitest";

const originRpc = vi.hoisted(() => vi.fn(async (_fn: string, _args: unknown) => ({ data: null, error: null })));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: originRpc }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Os mesmos mocks de `create-or-move-lead.test.ts`: o dublê de banco importa
// `createClient`/`requireRole` de verdade para poder ser `vi.mocked(...)`.
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/create-or-move-lead";
import { resultadoParaRecibo } from "@/lib/automation/resultado-para-recibo";
import type { ActionCtx } from "@/lib/automation/types";
import { ORG_ID, PIPE, etapa, funilRow, makeDb, negocio } from "@/tests/helpers/stages-db-double";

/**
 * #4297 — A AÇÃO MOVE PARA A ETAPA DE PERDA, COM MOTIVO, E O RECIBO DIZ A VERDADE.
 *
 * ─── O defeito medido em campo (v1.104.0) ───────────────────────────────────
 *
 * A config da ação era só `pipeline_id` + `stage_id`, então não havia onde
 * informar o motivo. O `moveLeadHandler` aplica a regra do #917
 * (`decideMotivoDaPerda`): etapa de perda sem motivo → 422
 * `lost_reason_required`. Resultado: 165 execuções `failed` numa passada de
 * `lead.stage_stale`, e — porque o `catch` da ação devolvia a FRASE do erro no
 * lugar do código — a aba Atividade mostrava `internal_error` no lugar da causa.
 *
 * ─── O que cada caso prova ──────────────────────────────────────────────────
 *
 *   (a) com motivo: o card vai para a etapa de perda e o `lost_reason` gravado
 *       é o ESCOLHIDO — pelos DOIS caminhos (negócio no evento e gatilho de
 *       contato), que são as duas chamadas do handler;
 *   (b) regra ANTIGA (sem motivo): o card NÃO se move e o recibo mostra
 *       `lost_reason_required`, não `internal_error`;
 *   (c) etapa que NÃO é de perda: nada de motivo é exigido, move como antes.
 *
 * Sabotagens medidas ao escrever este arquivo (as duas rc=1):
 *   (i)  tirar o repasse de `lost_reason` dos dois `moveLeadHandler` derruba (a);
 *   (ii) trocar `codigoDaRecusa` por `mensagemDeErro` derruba (b).
 */

const ETAPA_ORIGEM = etapa({ id: "novo", name: "Novo lead", position: 1000 });
const ETAPA_PERDA = etapa({ id: "perdido", name: "Perdido", position: 3000, is_lost: true });
const ETAPA_MEIO = etapa({ id: "triagem", name: "Triagem", position: 2000 });

function ctxComLead(admin: ActionCtx["admin"]): ActionCtx {
  return {
    admin,
    organizationId: ORG_ID,
    ruleId: "rule-1",
    ruleName: "Automacao de etapa parada",
    event: {} as ActionCtx["event"],
    requestId: "req-1",
    context: { lead: { id: "lead-1", pipeline_id: PIPE, status: "open" } },
  };
}

function ctxComContato(admin: ActionCtx["admin"]): ActionCtx {
  return {
    admin,
    organizationId: ORG_ID,
    ruleId: "rule-1",
    ruleName: "Automacao de etiqueta no contato",
    event: {} as ActionCtx["event"],
    requestId: "req-1",
    context: { contact: { id: "contato-1", name: "Fulano", phone_number: "5511999999999" } },
  };
}

function dbComNegocioAberto() {
  return makeDb({
    contacts: [{ id: "contato-1", organization_id: ORG_ID }],
    pipelines: [funilRow({ id: PIPE, name: "Funil comercial" })],
    stages: [ETAPA_ORIGEM, ETAPA_MEIO, ETAPA_PERDA],
    leads: [
      negocio("lead-1", "novo", { status: "open", contact_id: "contato-1", updated_at: "2026-11-09T10:00:00.000Z" }),
    ],
  });
}

describe("(a) create_or_move_lead move para a etapa de perda COM o motivo escolhido (#4297)", () => {
  it("negócio veio no evento: grava o lost_reason da config", async () => {
    const db = dbComNegocioAberto();
    const action = getAction("create_or_move_lead");
    expect(action).toBeDefined();

    const resultado = await action!.execute(ctxComLead(db.client as unknown as ActionCtx["admin"]), {
      pipeline_id: PIPE,
      stage_id: "perdido",
      lost_reason: "price",
    });

    expect(resultado).toEqual({ type: "create_or_move_lead", status: "success", detail: { moved: "lead-1" } });
    const linha = db.tabelas.crm_leads.find((l) => l.id === "lead-1");
    expect(linha?.stage_id).toBe("perdido");
    expect(linha?.lost_reason).toBe("price");
  });

  it("gatilho de CONTATO (o outro caminho do handler): grava o mesmo motivo", async () => {
    const db = dbComNegocioAberto();
    const action = getAction("create_or_move_lead");

    const resultado = await action!.execute(ctxComContato(db.client as unknown as ActionCtx["admin"]), {
      pipeline_id: PIPE,
      stage_id: "perdido",
      lost_reason: "no_response",
    });

    expect(resultado).toEqual({ type: "create_or_move_lead", status: "success", detail: { moved: "lead-1" } });
    expect(db.tabelas.crm_leads.find((l) => l.id === "lead-1")?.lost_reason).toBe("no_response");
  });

  it("motivo CADASTRADO no funil (não canônico) também passa: a lista é a do funil", async () => {
    const db = makeDb({
      contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [
        funilRow({
          id: PIPE,
          name: "Funil comercial",
          settings: { lost_reasons: [{ label: "Sem orçamento aprovado" }] },
        }),
      ],
      stages: [ETAPA_ORIGEM, ETAPA_PERDA],
      leads: [negocio("lead-1", "novo", { status: "open", updated_at: "2026-11-09T10:00:00.000Z" })],
    });
    const action = getAction("create_or_move_lead");

    const resultado = await action!.execute(ctxComLead(db.client as unknown as ActionCtx["admin"]), {
      pipeline_id: PIPE,
      stage_id: "perdido",
      lost_reason: "Sem orçamento aprovado",
    });

    expect(resultado.status).toBe("success");
    expect(db.tabelas.crm_leads.find((l) => l.id === "lead-1")?.lost_reason).toBe("Sem orçamento aprovado");
  });
});

describe("(b) regra ANTIGA (sem motivo) não move e o recibo mostra o código real (#4297)", () => {
  it("falha com lost_reason_required e o card continua na etapa de origem", async () => {
    const db = dbComNegocioAberto();
    const action = getAction("create_or_move_lead");

    // A config exatamente como está gravada nas regras anteriores a este campo.
    const resultado = await action!.execute(ctxComLead(db.client as unknown as ActionCtx["admin"]), {
      pipeline_id: PIPE,
      stage_id: "perdido",
    });

    expect(resultado.status).toBe("failed");
    expect(resultado.error).toBe("lost_reason_required");
    // O recibo é o que a aba Atividade lê: o código SOBREVIVE (antes virava
    // `internal_error`, e o operador não sabia o que consertar).
    expect(resultadoParaRecibo(resultado).error).toBe("lost_reason_required");
    // E a prova de que o #917 continua valendo para a automação.
    const linha = db.tabelas.crm_leads.find((l) => l.id === "lead-1");
    expect(linha?.stage_id).toBe("novo");
    expect(linha?.lost_reason ?? null).toBeNull();
  });

  it("nenhum motivo é inventado: a escrita de etapa nem chega ao banco", async () => {
    const db = dbComNegocioAberto();
    const action = getAction("create_or_move_lead");

    await action!.execute(ctxComLead(db.client as unknown as ActionCtx["admin"]), {
      pipeline_id: PIPE,
      stage_id: "perdido",
    });

    const escritasNoLead = db.escritas.filter((e) => e.table === "crm_leads" && e.tipo === "update");
    expect(escritasNoLead).toEqual([]);
  });
});

describe("(e) etapa que NÃO é de perda continua sem pedir motivo (#4297)", () => {
  it("move para etapa comum sem lost_reason na config, e nada é gravado em lost_reason", async () => {
    const db = dbComNegocioAberto();
    const action = getAction("create_or_move_lead");

    const resultado = await action!.execute(ctxComLead(db.client as unknown as ActionCtx["admin"]), {
      pipeline_id: PIPE,
      stage_id: "triagem",
    });

    expect(resultado).toEqual({ type: "create_or_move_lead", status: "success", detail: { moved: "lead-1" } });
    const linha = db.tabelas.crm_leads.find((l) => l.id === "lead-1");
    expect(linha?.stage_id).toBe("triagem");
    expect(linha?.lost_reason ?? null).toBeNull();
  });
});
