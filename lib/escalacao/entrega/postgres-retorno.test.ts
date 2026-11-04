import { describe, it, expect, vi } from "vitest";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { criarBancoDaEntrega } from "./postgres";
import type { PassagemParaEntrega } from "./passagem";

function fixture(
  options: {
    cardOwner?: string | null;
    conversationOwner?: string | null;
    episodeOwner?: string;
    eligible?: boolean;
    claim?: string;
    cas?: number;
    schedule?: unknown;
  } = {},
) {
  const p: PassagemParaEntrega = {
    organizationId: "org-A",
    episodeId: "episode",
    conversationId: "conversation",
    leadId: "",
    serviceRevision: 1,
    resumo: {},
  };
  const owner = options.cardOwner === undefined ? "seller-A" : options.cardOwner;
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.includes("select * from handoff_delivery_episodes"))
      return {
        rows: [{ contact_id: "contact", owner_user_id: options.episodeOwner }],
        rowCount: 1,
      };
    if (sql.includes("select * from conversations"))
      return {
        rows: [
          { channel_session_id: "channel", assigned_to_user_id: options.conversationOwner ?? null },
        ],
        rowCount: 1,
      };
    if (sql.includes("select l.* from crm_leads"))
      return { rows: [{ id: "card", owner_user_id: owner }], rowCount: 1 };
    if (sql.includes("join contacts ct")) return { rows: [{ id: "episode" }], rowCount: 1 };
    if (sql.includes("select a.schedule"))
      return {
        rows: options.eligible === false ? [] : [{ schedule: options.schedule ?? {} }],
        rowCount: options.eligible === false ? 0 : 1,
      };
    if (sql.includes("select a.user_id,a.schedule"))
      return { rows: [{ user_id: "seller-A", schedule: {} }], rowCount: 1 };
    if (sql.includes("fn_channel_routing_claim"))
      return { rows: [{ result: options.claim ?? "assigned" }], rowCount: 1 };
    if (sql.startsWith("update handoff_delivery_episodes e"))
      return { rows: options.cas === 0 ? [] : [{ id: "episode" }], rowCount: options.cas ?? 1 };
    if (sql.startsWith("update crm_leads")) return { rows: [{ id: "card" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })), query } as unknown as pg.Pool;
  const db = criarBancoDaEntrega(pool, {} as SupabaseClient);
  return { p, query, release, run: () => db.atribuirMesmoResponsavel(p, ["seller-A", "seller-B"]) };
}
describe("segunda passagem preserva dono comercial", () => {
  it("retoma o mesmo dono com claim nativo sem atualizar card nem escolher rodízio", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ status: "assigned", userId: "seller-A" });
    expect(f.p.leadId).toBe("card");
    const sql = f.query.mock.calls.map((c) => c[0]);
    expect(sql.some((s) => s.includes("select a.user_id,a.schedule"))).toBe(false);
    expect(sql.some((s) => s.startsWith("update crm_leads"))).toBe(false);
    expect(f.query.mock.calls.find((c) => c[0].includes("fn_channel_routing_claim"))?.[1]).toEqual([
      "org-A",
      "conversation",
      "channel",
      "seller-A",
      "{}",
      "handoff",
    ]);
    const eligibility = sql.find((s) => s.includes("select a.schedule"))!;
    expect(eligibility).toContain("u.revoked_at is null");
    expect(eligibility).toContain("a.organization_id=$1");
    expect(eligibility).toContain("a.is_available");
    expect(eligibility).toContain("< a.capacity");
    expect(sql.at(-1)).toBe("commit");
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("primeira passagem continua atribuindo Inbox e card pelo rodízio", async () => {
    const f = fixture({ cardOwner: null });
    expect(await f.run()).toEqual({ status: "assigned", userId: "seller-A" });
    expect(f.query.mock.calls.some((c) => c[0].startsWith("update crm_leads"))).toBe(true);
  });
  it("retry da mesma entrega não gira rodízio nem faz outro claim", async () => {
    const f = fixture({ episodeOwner: "seller-A", conversationOwner: "seller-A" });
    expect(await f.run()).toEqual({ status: "assigned", userId: "seller-A" });
    expect(f.query.mock.calls.some((c) => c[0].includes("fn_channel_routing_claim"))).toBe(false);
  });
  it("não toma conversa de outro proprietário", async () => {
    const f = fixture({ conversationOwner: "seller-B" });
    expect(await f.run()).toEqual({ status: "conflict" });
    expect(f.query.mock.calls.some((c) => c[0].includes("fn_channel_routing_claim"))).toBe(false);
  });
  it("não reaproveita dono fora do pool autorizado", async () => {
    const f = fixture({ cardOwner: "seller-other" });
    expect(await f.run()).toEqual({ status: "conflict" });
    expect(f.query.mock.calls.some((c) => c[0].includes("fn_channel_routing_claim"))).toBe(false);
  });
  it("dono revogado/indisponível/sem capacidade continua pendência recuperável", async () => {
    const f = fixture({ eligible: false });
    expect(await f.run()).toEqual({ status: "no_eligible" });
    expect(f.query.mock.calls.some((c) => c[0].includes("fn_channel_routing_claim"))).toBe(false);
  });
  it.each(["conversation_changed", "already_assigned"])(
    "claim concorrente %s não altera card ou episódio",
    async (claim) => {
      const f = fixture({ claim });
      expect(await f.run()).toEqual({ status: "conflict" });
      expect(
        f.query.mock.calls.some((c) => c[0].startsWith("update handoff_delivery_episodes")),
      ).toBe(false);
    },
  );
  it("recusa nativa de elegibilidade fica recuperável sem escolher outro vendedor", async () => {
    const f = fixture({ claim: "not_eligible" });
    expect(await f.run()).toEqual({ status: "no_eligible" });
    expect(f.query.mock.calls.some((c) => c[0].includes("select a.user_id,a.schedule"))).toBe(
      false,
    );
  });
  it("dono fora do horário permanece pendência sem novo claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T22:00:00Z"));
    try {
      const f = fixture({
        schedule: {
          timezone: "America/Sao_Paulo",
          windows: [{ dow: 1, start: "08:00", end: "18:00" }],
        },
      });
      expect(await f.run()).toEqual({ status: "no_eligible" });
      expect(f.query.mock.calls.some((c) => c[0].includes("fn_channel_routing_claim"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("CAS recusado desfaz claim na mesma transação", async () => {
    const f = fixture({ cas: 0 });
    await expect(f.run()).rejects.toThrow("handoff_return_conflict");
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(f.query.mock.calls.some((c) => c[0] === "commit")).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
  });
});
