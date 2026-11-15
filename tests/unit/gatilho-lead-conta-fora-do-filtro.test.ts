import { describe, expect, it, vi } from "vitest";

/**
 * #4587: o gatilho "negócio criado" com filtro de funil/etiqueta conta quem o
 * filtro barrou (`summary.fora_do_filtro`, em `gatilho-lead.ts`). A prova de
 * tela do #4609 mediu o detalhe do dreno SEM esse número: o negócio barrado
 * sumia calado no `event_log.last_error`. Aqui, só a ligação do handler.
 */
const fora = vi.hoisted(() => ({ n: 0 as number | undefined }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/followup/agent-followup-gate", () => ({ createSupabaseFollowupGateDb: () => ({}) }));
vi.mock("@/lib/followup/gatilho-lead", () => ({
  EVENTO_DE_LEAD_CRIADO: "lead.created",
  aplicaGatilhoDeLead: async () => ({
    matched: true,
    pointers_armados: 1,
    pointers_barrados_pelo_gate: 0,
    enrolled: 0,
    skipped_existing: 0,
    sem_contato: 0,
    vindos_de_planilha: 0,
    fora_do_filtro: fora.n,
  }),
  createSupabaseGatilhoLeadDb: () => ({}),
}));

import { followupGatilhoLeadHandler } from "@/lib/followup/gatilho-lead.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

const linha: EventRow = {
  id: "evt-1",
  organization_id: "11111111-1111-4111-8111-111111111111",
  event_type: "lead.created",
  entity_kind: "crm_lead",
  entity_id: "44444444-4444-4444-8444-444444444444",
  payload: {},
  metadata: {},
  consumed_by: [],
  attempts: 0,
};

describe("gatilho de negócio criado: quem o filtro barrou aparece no detalhe (#4587)", () => {
  it("fora_do_filtro entra no detail com a contagem", async () => {
    fora.n = 2;
    const r = await followupGatilhoLeadHandler.handle(linha);
    expect(r.detail).toContain("fora_do_filtro=2");
  });

  it("sem filtro barrando, aparece zero (e não some)", async () => {
    fora.n = undefined;
    const r = await followupGatilhoLeadHandler.handle(linha);
    expect(r.detail).toContain("fora_do_filtro=0");
  });
});
