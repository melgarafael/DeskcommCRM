import { afterEach, describe, expect, it, vi } from "vitest";
import {
  campaignConfigSchema,
  normalizeProspect,
  prospectingInputSchema,
  safePublicLink,
  searchSchema,
} from "@/lib/prospecting/schema";
import { startSearch } from "@/lib/prospecting/provider";
import { contactMayBeProspected, assertProspectingDelivery } from "@/lib/prospecting/guard";
const valid = {
  source: "prospecting",
  is_anonymized: false,
  consent: { legitimate_interest: { ref: "LIA-example" } },
};
afterEach(() => vi.unstubAllGlobals());
describe("native prospecting", () => {
  it("normalizes Maps data without inventing international phones", () => {
    expect(
      normalizeProspect({ title: "Example", placeId: "p1", phone: "(11) 99999-0000" })?.phone,
    ).toBe("+5511999990000");
    expect(
      normalizeProspect({ title: "Example", placeId: "p1", phone: "+1 212 555 1234" })?.phone,
    ).toBeNull();
    expect(
      normalizeProspect({ title: "Example", placeId: "p1", permanentlyClosed: true }),
    ).toBeNull();
    expect(normalizeProspect({ title: "No identity" })).toBeNull();
    expect(safePublicLink("javascript:alert(1)")).toBeUndefined();
  });
  it("requires limits and tenant comes from authenticated session", () => {
    expect(
      searchSchema.safeParse({ name: "test", niche: "test", location: "SP", limit: 101 }).success,
    ).toBe(false);
    expect(
      searchSchema.safeParse({ name: "test", niche: "test", location: "SP", budget_usd: 11 })
        .success,
    ).toBe(false);
    expect(
      prospectingInputSchema.safeParse({
        action: "configure",
        api_key: "example-key",
        organization_id: "other",
      }).success,
    ).toBe(false);
    expect(campaignConfigSchema.safeParse({ daily_limit: 1000, interval_minutes: 0 }).success).toBe(
      false,
    );
  });
  it("sends the cost ceiling to the provider, with credentials only in the header", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { id: "run", status: "RUNNING" } })));
    vi.stubGlobal("fetch", fetch);
    await startSearch(
      "test-secret",
      searchSchema.parse({
        name: "test",
        niche: "clínicas",
        location: "SP",
        limit: 20,
        budget_usd: 1,
        enrich: true,
      }),
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toContain("maxItems=20&maxTotalChargeUsd=1&timeout=300");
    expect(url).not.toContain("test-secret");
    expect(init.headers.Authorization).toBe("Bearer test-secret");
    expect(JSON.parse(init.body)).toMatchObject({
      scrapeContacts: true,
      maximumLeadsEnrichmentRecords: 0,
    });
  });
  it("never repeats an uncertain paid request or exposes provider diagnostics", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("test-secret"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      startSearch(
        "test-secret",
        searchSchema.parse({ name: "test", niche: "test", location: "SP" }),
      ),
    ).rejects.toThrow("não confirmou");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { is_blocked: true },
    { force_human: true },
    { is_anonymized: true },
    { consent: {} },
    { consent: { ...valid.consent, marketing: { declined_at: "2026-09-15" } } },
  ])("blocks ineligible contact %j", (change) => {
    expect(contactMayBeProspected({ ...valid, ...change })).toBe(false);
  });
  it("accepts documented basis without manufacturing marketing consent", () =>
    expect(contactMayBeProspected(valid)).toBe(true));
  it.each(["paused", "reply", "human", "database-error", "other-conversation"])(
    "rechecks %s before delivery",
    async (condition) => {
      const rows: Record<string, unknown> = {
        prospecting_candidates: {
          campaign_id: "campaign",
          contact_id: "contact",
          status: "sending",
          conversation_id: condition === "other-conversation" ? "other" : "conversation",
        },
        prospecting_campaigns: { status: condition === "paused" ? "paused" : "running" },
        contacts: valid,
        conversations: {
          status: "open",
          last_inbound_at: condition === "reply" ? "now" : null,
          assigned_to_user_id: condition === "human" ? "user" : null,
        },
      };
      const filters: unknown[][] = [];
      const db = {
        from(table: string) {
          return {
            select() {
              return this;
            },
            eq(...args: unknown[]) {
              filters.push(args);
              return this;
            },
            maybeSingle() {
              return Promise.resolve({
                data: rows[table],
                error: condition === "database-error" ? { message: "failed" } : null,
              });
            },
          };
        },
      };
      await expect(
        assertProspectingDelivery(db as never, {
          organizationId: "org",
          candidateId: "candidate",
          conversationId: "conversation",
        }),
      ).rejects.toThrow();
      expect(filters).toContainEqual(["organization_id", "org"]);
    },
  );
});
