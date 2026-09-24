import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyReplyStop,
  pickReplyStopReason,
  processCampaignInboundReply,
} from "@/lib/whatsapp-campaigns/reply";

vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: vi.fn(async () => ({ criado: false, motivo: "ja_existe" })),
}));

describe("pickReplyStopReason", () => {
  it("mapeia person e company", () => {
    expect(pickReplyStopReason("person")).toBe("person_already_replied");
    expect(pickReplyStopReason("company")).toBe("company_already_replied");
  });
});

describe("applyReplyStop", () => {
  it("none não atualiza", async () => {
    const update = vi.fn();
    const admin = { from: () => ({ update }) } as never;
    const n = await applyReplyStop(admin, {
      organizationId: "org",
      campaignId: "camp",
      excludeRecipientId: "r1",
      personId: "p1",
      companyId: "c1",
      mode: "none",
    });
    expect(n).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("person filtra person_id", async () => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["eq", "neq", "in"]) chain[m] = self;
    chain.select = async () => ({ data: [{ id: "a" }, { id: "b" }], error: null });
    const update = vi.fn(() => chain);
    const admin = { from: () => ({ update }) } as never;
    const n = await applyReplyStop(admin, {
      organizationId: "org",
      campaignId: "camp",
      excludeRecipientId: "r1",
      personId: "p1",
      companyId: null,
      mode: "person",
    });
    expect(n).toBe(2);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        skipped_reason: "person_already_replied",
      }),
    );
  });

  it("person sem person_id não cancela", async () => {
    const update = vi.fn();
    const admin = { from: () => ({ update }) } as never;
    const n = await applyReplyStop(admin, {
      organizationId: "org",
      campaignId: "camp",
      excludeRecipientId: "r1",
      personId: null,
      companyId: "c1",
      mode: "person",
    });
    expect(n).toBe(0);
  });
});

describe("processCampaignInboundReply idempotência", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sem contact → skipped", async () => {
    const admin = { from: vi.fn() } as never;
    const r = await processCampaignInboundReply(admin, "org", {});
    expect(r.matched).toBe(false);
    expect(r.detail).toBe("no_contact");
  });
});

describe("schemas fase 3", () => {
  it("exige ao menos uma sessão", async () => {
    const { campaignCreateSchema } = await import("@/lib/whatsapp-campaigns/schemas");
    expect(() =>
      campaignCreateSchema.parse({
        name: "X",
        message_text: "Oi",
      }),
    ).toThrow();
    const ok = campaignCreateSchema.parse({
      name: "X",
      message_text: "Oi",
      channel_session_ids: ["aaaaaaaa-0000-4000-8000-000000000001"],
      reply_stop_mode: "person",
    });
    expect(ok.reply_stop_mode).toBe("person");
    expect(ok.create_lead_on_reply).toBe(false);
  });

  it("resolveSessionIds", async () => {
    const { resolveSessionIds } = await import("@/lib/whatsapp-campaigns/schemas");
    expect(
      resolveSessionIds({
        channel_session_ids: ["a", "b", "a"],
        channel_session_id: "c",
      }),
    ).toEqual(["a", "b"]);
    expect(resolveSessionIds({ channel_session_id: "x" })).toEqual(["x"]);
  });
});

describe("migration 0243 contrato", () => {
  it("define reply_stop_mode, multi-session e claim RR", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sql = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260924220000_0243_whatsapp_campaigns_fase3.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("reply_stop_mode");
    expect(sql).toContain("create_lead_on_reply");
    expect(sql).toContain("whatsapp_campaign_sessions");
    expect(sql).toContain("session_rr_index");
    expect(sql).toContain("awaiting_whatsapp_session");
    expect(sql).toContain("fn_whatsapp_campaign_session_stats");
  });
});
