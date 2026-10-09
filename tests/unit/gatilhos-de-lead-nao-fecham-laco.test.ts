// @vitest-environment node
/**
 * Os gatilhos de ganho, perda, reabertura e troca de responsável (#1528) NÃO
 * aceitam as ações que regravam o lead.
 *
 * Esses eventos nascem do trigger `fn_emit_event_on_lead_change` com
 * `metadata '{}'`, e o anti-laço do motor (`engine.ts`) só reconhece
 * `caused_by_rule`. "Responsável mudou → atribuir a Ana" e "responsável mudou →
 * atribuir ao Beto" se realimentam sem fim; o mesmo vale para "ganhou → mover
 * para etapa aberta" com "reabriu → mover para etapa ganha".
 *
 * O veto mora em três portas, e cada uma tem caso aqui: o schema (criação e
 * PATCH completo), a rota de PATCH (o PATCH parcial, que só o banco completa) e
 * o motor (regra que chegou por fora do schema). A tela usa a mesma função para
 * não oferecer as ações.
 *
 * O que este arquivo NÃO prova: o laço em Postgres de verdade. Ele foi lido no
 * caminho (trigger → event_log → motor → UPDATE), não executado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  executar: vi.fn(async (_ctx: unknown, _config: unknown) => ({ type: "x", status: "success" as const })),
  gravada: { id: "", trigger_event: "", actions: [] as Array<{ type: string; config: unknown }> },
  atualizou: false,
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/automation/actions", () => ({
  getAction: (type: string) => ({ type, execute: (ctx: unknown, config: unknown) => deps.executar(ctx, config) }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const cadeia = {
        select: () => cadeia,
        eq: () => cadeia,
        update: () => {
          deps.atualizou = true;
          return cadeia;
        },
        maybeSingle: async () => ({ data: deps.gravada, error: null }),
        single: async () => ({ data: deps.gravada, error: null }),
      };
      return cadeia;
    },
  }),
}));

import { PATCH } from "@/app/api/v1/automation-rules/[id]/route";
import { runAutomationForEvent } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  createAutomationRuleSchema,
  GATILHOS_DO_TRIGGER_DE_LEAD,
  updateAutomationRuleSchema,
} from "@/lib/schemas/webhooks";

const ORG = "22222222-2222-4222-8222-222222222222";
const REGRA = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const UUID = "55555555-5555-4555-8555-555555555555";

const ATRIBUIR = { type: "assign_owner", config: { user_id: UUID } };
const MOVER = { type: "create_or_move_lead", config: { pipeline_id: UUID, stage_id: UUID } };
const AVISAR = { type: "call_webhook", config: { url: "https://erp.exemplo/ganho" } };

function regra(trigger_event: string, actions: unknown[]) {
  return { name: "r", trigger_event, conditions: [], actions };
}

describe("schema: os gatilhos do trigger recusam as ações que regravam o lead", () => {
  for (const gatilho of GATILHOS_DO_TRIGGER_DE_LEAD) {
    for (const acao of [ATRIBUIR, MOVER]) {
      it(`${gatilho} + ${acao.type} é recusado`, () => {
        const r = createAutomationRuleSchema.safeParse(regra(gatilho, [AVISAR, acao]));
        expect(r.success).toBe(false);
      });
    }
  }

  it("o PATCH que traz gatilho e ações juntos é recusado", () => {
    expect(updateAutomationRuleSchema.safeParse({ trigger_event: "lead.assigned", actions: [ATRIBUIR] }).success).toBe(false);
  });

  // Controle: o veto não é um bloqueio geral.
  it("lead.won + call_webhook passa", () => {
    expect(createAutomationRuleSchema.safeParse(regra("lead.won", [AVISAR])).success).toBe(true);
  });
  it("lead.stage_changed + assign_owner continua passando (o handler marca a causa)", () => {
    expect(createAutomationRuleSchema.safeParse(regra("lead.stage_changed", [ATRIBUIR])).success).toBe(true);
  });
});

describe("rota PATCH: o PATCH parcial é conferido contra a regra gravada", () => {
  function patch(corpo: unknown) {
    return PATCH(
      new NextRequest(`https://crm.exemplo/api/v1/automation-rules/${REGRA}`, {
        method: "PATCH",
        body: JSON.stringify(corpo),
      }),
      { params: Promise.resolve({ id: REGRA }) },
    );
  }

  beforeEach(() => {
    deps.atualizou = false;
  });

  it("trocar só o gatilho de uma regra que atribui para lead.assigned é recusado", async () => {
    deps.gravada = { id: REGRA, trigger_event: "lead.created", actions: [ATRIBUIR] };
    const res = await patch({ trigger_event: "lead.assigned" });
    expect(res.status).toBe(400);
    expect(deps.atualizou).toBe(false);
  });

  it("trocar só as ações de uma regra de lead.won para mover é recusado", async () => {
    deps.gravada = { id: REGRA, trigger_event: "lead.won", actions: [AVISAR] };
    const res = await patch({ actions: [MOVER] });
    expect(res.status).toBe(400);
    expect(deps.atualizou).toBe(false);
  });

  it("controle: renomear uma regra de lead.won que só avisa passa", async () => {
    deps.gravada = { id: REGRA, trigger_event: "lead.won", actions: [AVISAR] };
    const res = await patch({ name: "Avisa o ERP" });
    expect(res.status).toBe(200);
    expect(deps.atualizou).toBe(true);
  });
});

describe("motor: regra que chegou por fora do schema não regrava o lead", () => {
  function bancoComRegra(trigger_event: string, actions: unknown[]) {
    const runs: Array<Record<string, unknown>> = [];
    const admin = {
      from(tabela: string) {
        let inserida: Record<string, unknown> | null = null;
        const dados = () =>
          tabela === "automation_rules"
            ? [{ id: REGRA, name: "r", conditions: [], actions, trigger_event, run_count: 0 }]
            : tabela === "crm_leads"
              ? [{ id: LEAD, organization_id: ORG, contact_id: null }]
              : [];
        const cadeia = {
          select: () => cadeia,
          eq: () => cadeia,
          order: () => cadeia,
          update: () => cadeia,
          insert: (linha: Record<string, unknown>) => {
            inserida = { id: UUID, ...linha };
            if (tabela === "automation_rule_runs") runs.push(inserida);
            return cadeia;
          },
          maybeSingle: async () => ({ data: inserida ?? dados()[0] ?? null, error: null }),
          single: async () => ({ data: inserida ?? dados()[0] ?? null, error: null }),
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: dados(), error: null }).then(ok),
        };
        return cadeia;
      },
    };
    return { admin, runs };
  }

  function evento(event_type: string): EventRow {
    return {
      id: "66666666-6666-4666-8666-666666666666",
      organization_id: ORG,
      event_type,
      entity_kind: "lead",
      entity_id: LEAD,
      payload: { lead_id: LEAD },
      metadata: {},
      created_at: new Date().toISOString(),
    } as unknown as EventRow;
  }

  beforeEach(() => {
    deps.executar.mockClear();
  });

  it("lead.assigned → assign_owner é pulado, e a ação vizinha roda", async () => {
    const { admin, runs } = bancoComRegra("lead.assigned", [ATRIBUIR, AVISAR]);
    await runAutomationForEvent(admin as never, evento("lead.assigned"));
    expect(deps.executar).toHaveBeenCalledTimes(1);
    expect(deps.executar.mock.calls[0]?.[1]).toEqual(AVISAR.config);
    const resultado = runs[0]?.actions_result as Array<{ type: string; status: string; error?: string }>;
    expect(resultado[0]).toMatchObject({ type: "assign_owner", status: "skipped", error: "acao_fecharia_laco" });
  });

  it("lead.won → create_or_move_lead é pulado", async () => {
    const { admin } = bancoComRegra("lead.won", [MOVER]);
    await runAutomationForEvent(admin as never, evento("lead.won"));
    expect(deps.executar).not.toHaveBeenCalled();
  });
});
