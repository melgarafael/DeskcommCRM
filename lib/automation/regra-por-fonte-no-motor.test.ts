// @vitest-environment node
/**
 * Regra de "novo negócio" limitada a UMA fonte de formulário (#2553).
 *
 * `trigger_config.webhook_source_id` recorta a regra: ela só roda quando o
 * negócio nasceu daquela fonte (`crm_leads.source_metadata.webhook_source_id`,
 * gravado pela captação). Regra sem fonte segue valendo para todo negócio novo,
 * que é o comportamento de antes.
 *
 * O banco é um dublê mínimo (o mesmo de `contato-pessoal-no-motor.test.ts`); a
 * ação é um executor registrado no lugar do `call_webhook` que anota qual regra
 * chegou até ela.
 *
 *     pnpm vitest run lib/automation/regra-por-fonte-no-motor.test.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { registerAction } from "@/lib/automation/actions";
import { runAutomationForEvent } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const FONTE_A = "33333333-3333-4333-8333-333333333333";
const FONTE_B = "44444444-4444-4444-8444-444444444444";
const REGRA_A = "77777777-7777-4777-8777-7777777777a1";
const REGRA_B = "77777777-7777-4777-8777-7777777777b1";
const REGRA_GERAL = "77777777-7777-4777-8777-7777777777c1";

const regrasQueRodaram: string[] = [];
registerAction({
  type: "call_webhook",
  async execute(ctx) {
    regrasQueRodaram.push(ctx.ruleId);
    return { type: "call_webhook", status: "success" };
  },
});

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  function consulta(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    const linhas = () =>
      (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
    const q = {
      select: () => q,
      insert: () => q,
      update: () => q,
      order: () => q,
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      maybeSingle: async () => ({ data: linhas()[0] ?? { id: "run-1" }, error: null }),
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(ok),
    };
    return q;
  }
  return { from: consulta } as unknown as SupabaseClient;
}

function regra(id: string, triggerConfig: Record<string, unknown>): Linha {
  return {
    id,
    organization_id: ORG,
    trigger_event: "lead.created",
    is_active: true,
    name: `Regra ${id.slice(-2)}`,
    conditions: [],
    actions: [{ type: "call_webhook", config: { url: "https://exemplo.test/hook" } }],
    trigger_config: triggerConfig,
  };
}

function mundo(sourceMetadata: Record<string, unknown>): SupabaseClient {
  return bancoFalso({
    crm_leads: [
      { id: LEAD, organization_id: ORG, contact_id: null, source_metadata: sourceMetadata },
    ],
    automation_rules: [
      regra(REGRA_A, { webhook_source_id: FONTE_A }),
      regra(REGRA_B, { webhook_source_id: FONTE_B }),
      regra(REGRA_GERAL, {}),
    ],
  });
}

function negocioNovo(): EventRow {
  return {
    id: "evt-1",
    organization_id: ORG,
    event_type: "lead.created",
    entity_kind: "crm_lead",
    entity_id: LEAD,
    payload: { lead_id: LEAD },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

describe("regra de novo negócio limitada a uma fonte de formulário", () => {
  it("negócio da fonte A roda a regra da fonte A e a regra geral, nunca a da fonte B", async () => {
    regrasQueRodaram.length = 0;
    const r = await runAutomationForEvent(mundo({ webhook_source_id: FONTE_A }), negocioNovo());
    expect(r.status).toBe("ok");
    expect([...regrasQueRodaram].sort()).toEqual([REGRA_A, REGRA_GERAL].sort());
  });

  it("negócio criado à mão (sem fonte) roda só a regra geral", async () => {
    regrasQueRodaram.length = 0;
    await runAutomationForEvent(mundo({}), negocioNovo());
    expect(regrasQueRodaram).toEqual([REGRA_GERAL]);
  });
});
