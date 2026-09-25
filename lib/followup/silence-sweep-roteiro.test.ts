/**
 * A varredura de silêncio e o roteiro de atendimento (revisão adversarial do
 * #1559). Com a 0394, o banco recusa (23514) enrollment de relógio num pointer
 * `atendimento`. Se um pointer desses chegasse à varredura, o insert lançaria e
 * — sem o try por pointer — o laço inteiro abortava: nenhum pointer de NENHUMA
 * empresa depois dele era varrido. Dois cortes: o carregador não devolve
 * roteiro, e um pointer que falha é logado e pulado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { createSupabaseGatilhoCasoDb } from "./gatilho-caso";
import { createSupabaseGatilhoEtapaDb } from "./gatilho-etapa";
import { createSupabaseGatilhoLeadDb } from "./gatilho-lead";
import { createSupabaseGatilhoRetornoDb } from "./gatilho-retorno";
import { createSupabaseSilenceSweepDb, runSilenceSweep, type SilenceSweepDb } from "./silence-sweep";

const SILENCIO = { kind: "silence", params: { threshold_minutes: 60 } };

describe("loadActiveSilencePointers", () => {
  it("não devolve roteiro de atendimento, mesmo com gatilho de silêncio", async () => {
    const linhas = [
      { id: "p-followup", organization_id: "o", active_version_id: "v1", trigger_config: SILENCIO, surface: "followup" },
      { id: "p-roteiro", organization_id: "o", active_version_id: "v2", trigger_config: SILENCIO, surface: "atendimento" },
    ];
    const cadeia = {
      select: () => cadeia,
      eq: () => cadeia,
      not: async () => ({ data: linhas, error: null }),
    };
    const admin = { from: () => cadeia } as unknown as SupabaseClient;
    const pointers = await createSupabaseSilenceSweepDb(admin).loadActiveSilencePointers();
    expect(pointers.map((p) => p.id)).toEqual(["p-followup"]);
  });
});

/** Cliente fake que devolve, para `followup_flow_pointers`, um follow-up e um roteiro com o MESMO gatilho. */
function adminCom(trigger: unknown): SupabaseClient {
  const linhas = [
    { id: "p-followup", organization_id: "o", active_version_id: "v1", trigger_config: trigger, surface: "followup" },
    { id: "p-roteiro", organization_id: "o", active_version_id: "v2", trigger_config: trigger, surface: "atendimento" },
  ];
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    not: async () => ({ data: linhas, error: null }),
  };
  return { from: () => cadeia } as unknown as SupabaseClient;
}

describe("os outros produtores do relógio também não carregam roteiro", () => {
  const ETAPA = "11111111-1111-4111-8111-111111111111";
  it.each([
    ["etapa", () => createSupabaseGatilhoEtapaDb(adminCom({ kind: "stage_change", params: { stage_id: ETAPA } })).carregaPointersDeEtapa("o")],
    ["caso", () => createSupabaseGatilhoCasoDb(adminCom({ kind: "case_opened" })).carregaPointersDeCaso("o")],
    ["lead", () => createSupabaseGatilhoLeadDb(adminCom({ kind: "lead_created" })).carregaPointersDeLead("o")],
    [
      "retorno",
      () =>
        createSupabaseGatilhoRetornoDb(
          adminCom({ kind: "inbound_after_silence", params: { threshold_minutes: 120 } }),
        ).carregaPointersDeRetorno("o"),
    ],
  ])("gatilho de %s", async (_nome, carregar) => {
    const pointers = (await carregar()) as Array<{ id: string }>;
    expect(pointers.map((p) => p.id)).toEqual(["p-followup"]);
  });
});

describe("runSilenceSweep", () => {
  it("um pointer que falha é pulado; os outros seguem sendo varridos", async () => {
    const insert = vi.fn(async (input: { pointer_id: string }) => {
      if (input.pointer_id === "p-ruim") throw new Error("23514 roteiro de atendimento só roda como coletando");
      return { inserted: true };
    });
    const db: SilenceSweepDb = {
      loadActiveSilencePointers: async () => [
        { id: "p-ruim", organization_id: "org-1", active_version_id: "v1", threshold_minutes: 60, segments: [] },
        { id: "p-bom", organization_id: "org-2", active_version_id: "v2", threshold_minutes: 60, segments: [] },
      ],
      loadSilentContactIds: async () => ["contato"],
      loadTriggerNode: async () => ({ id: "t", pedeAgente: false }),
      insertEnrollment: insert,
    };
    const resumo = await runSilenceSweep({
      db,
      gateDb: { loadEnabledPublishedFollowupAgents: async () => [] },
      clock: () => new Date("2026-09-23T12:00:00Z"),
    });
    expect(resumo.pointers_failed).toBe(1);
    expect(resumo.enrolled).toBe(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ pointer_id: "p-bom" }));
  });
});
