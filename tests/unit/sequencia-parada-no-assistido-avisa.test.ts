import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Doc 301 = B (#4319): o gatilho de follow-up (etapa ou negócio novo) que NÃO
 * inscreveu por causa da marca do assistido abre o aviso na Central — sem ele, a
 * sequência parada seria invisível. A decisão de não inscrever é testada em
 * `lib/followup/gatilho-{etapa,lead}.test.ts`; aqui, só a ligação do handler.
 */

const inserts = vi.hoisted(() => [] as Array<{ tabela: string; linha: Record<string, unknown> }>);
const parados = vi.hoisted(() => ({ n: 0 as number | undefined }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      // O aviso lê o idioma da organização antes de gravar.
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: tabela === "organizations" ? { locale: "pt-BR" } : null, error: null }),
        insert: async (linha: Record<string, unknown>) => {
          inserts.push({ tabela, linha });
          return { error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/followup/agent-followup-gate", () => ({ createSupabaseFollowupGateDb: () => ({}) }));
const resumo = () => ({
  matched: true,
  pointers_armados: 1,
  pointers_barrados_pelo_gate: 0,
  enrolled: 0,
  skipped_existing: 0,
  sem_contato: 0,
  vindos_de_planilha: 0,
  parados_no_assistido: parados.n,
});
vi.mock("@/lib/followup/gatilho-etapa", () => ({
  EVENTO_DE_ETAPA: "lead.stage_changed",
  aplicaGatilhoDeEtapa: async () => resumo(),
  createSupabaseGatilhoEtapaDb: () => ({}),
}));
vi.mock("@/lib/followup/gatilho-lead", () => ({
  EVENTO_DE_LEAD_CRIADO: "lead.created",
  aplicaGatilhoDeLead: async () => resumo(),
  createSupabaseGatilhoLeadDb: () => ({}),
}));

import { followupGatilhoEtapaHandler } from "@/lib/followup/gatilho-etapa.handler";
import { followupGatilhoLeadHandler } from "@/lib/followup/gatilho-lead.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

const LEAD = "44444444-4444-4444-8444-444444444444";
const linha = (event_type: string): EventRow => ({
  id: "evt-1",
  organization_id: "11111111-1111-4111-8111-111111111111",
  event_type,
  entity_kind: "crm_lead",
  entity_id: LEAD,
  payload: {},
  metadata: { actor_operation_mode: "assisted" },
  consumed_by: [],
  attempts: 0,
});

beforeEach(() => {
  inserts.length = 0;
});

describe.each([
  ["etapa", followupGatilhoEtapaHandler, "lead.stage_changed"],
  ["negócio novo", followupGatilhoLeadHandler, "lead.created"],
] as const)("gatilho de follow-up por %s", (_nome, handler, tipo) => {
  it("sequência parada no assistido abre o aviso na Central, apontando o negócio", async () => {
    parados.n = 1;
    const r = await handler.handle(linha(tipo));

    expect(r.status).toBe("skipped");
    expect(r.detail).toContain("parado_no_assistido=1");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      tabela: "agent_inbox_items",
      linha: { kind: "other", severity: "warn", ref_kind: "lead", ref_id: LEAD },
    });
  });

  it("CONTROLE: nada parado, nenhum aviso", async () => {
    parados.n = undefined;
    await handler.handle(linha(tipo));

    expect(inserts).toEqual([]);
  });
});
