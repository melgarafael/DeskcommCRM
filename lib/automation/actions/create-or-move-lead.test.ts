import { describe, expect, it, vi } from "vitest";

const originRpc = vi.hoisted(() => vi.fn(async (_fn: string, _args: unknown) => ({ data: null, error: null })));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: originRpc }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// `tests/helpers/stages-db-double.ts` importa `createClient`/`requireRole` de
// verdade para poder `vi.mocked(...).mockResolvedValue(...)` — sem mockar os
// módulos aqui, a importação real de `lib/auth/server` (via `require-role`)
// valida env no boot e explode antes do teste rodar (mesmo padrão de
// `app/api/v1/pipelines/[id]/stages/route.test.ts`). Este teste nem chama
// `requireRole` — a ação recebe `HandlerCtx` já pronto — mas o mock precisa
// existir porque o double importa o módulo de qualquer forma.
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { getAction } from "@/lib/automation/actions";
// Import isolado da ação — registra `create_or_move_lead` no registry do
// módulo (mesmo padrão que `register-all.ts` faz para o motor de verdade).
import "@/lib/automation/actions/create-or-move-lead";
import type { ActionCtx } from "@/lib/automation/types";
import { ORG_ID, PIPE, etapa, funilRow, makeDb, negocio } from "@/tests/helpers/stages-db-double";

/**
 * Regressão pedida pelo dono do produto (2026-08-27, rascunho de
 * `automation_rule` do fluxo Respondi): a classificação inicial
 * (`lib/leads/classificacao-inicial.ts` — score A/B/C/D, "nao_avaliado",
 * "revisao_humana") NÃO PODE bloquear o ENCAMINHAMENTO do lead pela
 * automação — nem quando ele já existe (move de etapa via
 * `create_or_move_lead`), nem quando ele nasce por ela (create).
 *
 * `guarda-do-contato.test.ts` já prova o lado do ENVIO (send_whatsapp_message
 * / send_ai_message não leem classificação). Este arquivo prova o lado do
 * ROTEAMENTO: `create_or_move_lead` não lê `custom_fields.classificacao_*`
 * em NENHUM dos dois caminhos (create/move) — só `pipeline_id`/`stage_id` da
 * config da regra e `ctx.context.lead`/`ctx.context.contact`.
 *
 * Sabotagem verificada manualmente ao escrever este teste: adicionei em
 * `create-or-move-lead.ts` um `if (lead?.custom_fields?.classificacao_inicial_classe
 * === "D") return { type: "create_or_move_lead", status: "skipped", detail: {
 * reason: "classe_d" } }` antes do `moveLeadHandler` — o caso "classe D" abaixo
 * reprovou sozinho, os demais continuaram verdes. Sabotagem revertida antes
 * deste commit.
 */

const ETAPA_ORIGEM = etapa({ id: "novo", name: "Novo lead — Formulário", position: 1000 });
const ETAPA_DESTINO = etapa({ id: "triagem", name: "Triagem e classificação", position: 2000 });

function ctxComLead(customFields: Record<string, unknown>, admin: ActionCtx["admin"]): ActionCtx {
  return {
    admin,
    organizationId: ORG_ID,
    ruleId: "rule-1",
    ruleName: "SDR IA — Respondi Imobiliário — 1º contato",
    event: {} as ActionCtx["event"],
    requestId: "req-1",
    context: {
      lead: {
        id: "lead-1",
        pipeline_id: PIPE,
        custom_fields: customFields,
      },
    },
  };
}

function ctxComContato(customFields: Record<string, unknown> | undefined): ActionCtx["context"] {
  return {
    contact: { id: "contato-1", name: "Fulano", custom_fields: customFields },
  };
}

describe("create_or_move_lead — pontuação/classificação nunca bloqueia o ENCAMINHAMENTO (move)", () => {
  const CLASSIFICACOES: Array<[string, Record<string, unknown>]> = [
    ["classe A", { classificacao_inicial_classe: "A", classificacao_inicial_percentual: 92 }],
    ["classe B", { classificacao_inicial_classe: "B", classificacao_inicial_percentual: 55 }],
    ["classe C", { classificacao_inicial_classe: "C", classificacao_inicial_percentual: 20 }],
    ["classe D (piso do score)", { classificacao_inicial_classe: "D", classificacao_inicial_percentual: 0 }],
    ["nao_avaliado (sem respondi_score)", { classificacao_inicial_classe: "nao_avaliado", classificacao_inicial_percentual: null }],
    [
      "revisao_humana / incoerencia_investimento",
      { classificacao_inicial_status: "revisao_humana", classificacao_inicial_motivo: "incoerencia_investimento" },
    ],
    [
      "revisao_humana / spam_suspeito",
      { classificacao_inicial_status: "revisao_humana", classificacao_inicial_motivo: "spam_suspeito" },
    ],
    ["sem classificação nenhuma (custom_fields vazio)", {}],
  ];

  it.each(CLASSIFICACOES)("%s → move normalmente, status success", async (_nome, customFields) => {
    const db = makeDb({
      pipelines: [funilRow({ id: PIPE, name: "funil comercial imobiliário" })],
      stages: [ETAPA_ORIGEM, ETAPA_DESTINO],
      leads: [negocio("lead-1", "novo")],
    });
    const action = getAction("create_or_move_lead");
    expect(action).toBeDefined();

    const resultado = await action!.execute(
      ctxComLead(customFields, db.client as unknown as ActionCtx["admin"]),
      { pipeline_id: PIPE, stage_id: "triagem" },
    );

    expect(resultado).toEqual({ type: "create_or_move_lead", status: "success", detail: { moved: "lead-1" } });
    expect(db.tabelas.crm_leads.find((l) => l.id === "lead-1")?.stage_id).toBe("triagem");
  });
});

describe("create_or_move_lead — pontuação/classificação nunca bloqueia a CRIAÇÃO", () => {
  it("contato com custom_fields de classe D no contexto: cria o lead normalmente", async () => {
    const db = makeDb({
      pipelines: [funilRow({ id: PIPE, name: "funil comercial imobiliário" })],
      stages: [ETAPA_ORIGEM, ETAPA_DESTINO],
      leads: [],
    });
    const action = getAction("create_or_move_lead");

    const ctx: ActionCtx = {
      admin: db.client as unknown as ActionCtx["admin"],
      organizationId: ORG_ID,
      ruleId: "rule-1",
      ruleName: "SDR IA — Respondi Imobiliário — 1º contato",
      event: {} as ActionCtx["event"],
      requestId: "req-1",
      context: ctxComContato({ classificacao_inicial_classe: "D" }),
    };

    const resultado = await action!.execute(ctx, { pipeline_id: PIPE, stage_id: "novo" });

    expect(resultado.status).toBe("success");
    expect(resultado.type).toBe("create_or_move_lead");
    expect(db.tabelas.crm_leads).toHaveLength(1);
    expect(db.tabelas.crm_leads[0]?.stage_id).toBe("novo");
  });
});

describe("create_or_move_lead — não lê nenhuma chave classificacao_inicial_* do código-fonte", () => {
  it("o arquivo da ação não menciona 'classificacao' em lugar nenhum", async () => {
    // Prova estrutural complementar à prova por comportamento acima: se algum
    // dia alguém adicionar uma leitura de classificação aqui, este teste
    // reprova ANTES de precisar de um cenário específico para pegar o ramo.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const fonte = readFileSync(
      resolve(process.cwd(), "lib/automation/actions/create-or-move-lead.ts"),
      "utf-8",
    );
    expect(fonte.toLowerCase()).not.toContain("classificacao");
    expect(fonte.toLowerCase()).not.toContain("respondi_score");
  });
});


it("CRM derivado propaga referência original sem observar ou abrir atendimento", async () => {
  originRpc.mockClear();
  const db = makeDb({ pipelines: [funilRow({ id: PIPE, name: "Funil" })], stages: [ETAPA_ORIGEM, ETAPA_DESTINO], leads: [negocio("lead-1", "novo")] });
  const ctx = ctxComLead({}, db.client as unknown as ActionCtx["admin"]);
  ctx.event = { id: "evento-original", event_type: "message.received" } as ActionCtx["event"];
  ctx.context.contact = { id: "contato-1" };
  expect((await getAction("create_or_move_lead")!.execute(ctx, { pipeline_id: PIPE, stage_id: "triagem" })).status).toBe("success");
  expect(originRpc).toHaveBeenCalledWith("emit_event", expect.objectContaining({ p_payload: expect.objectContaining({ service_origin: {kind:"event",event_id:"evento-original",organization_id:ORG_ID,contact_id:"contato-1"} }) }));
  expect(originRpc.mock.calls.every(call => call[0] === "emit_event")).toBe(true);
});
