import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { socialPayloadBelongsToSession } from "./ingest";
vi.mock("../zernio/ingest", () => ({ ingestZernioInbound: vi.fn() }));
it("scopes by organization, channel and provider before accepting an account payload", async () => {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { zernio_account_id: "account-a", metadata: { social_platform: "instagram" } },
      error: null,
    }),
  };
  const db = { from: () => query } as unknown as SupabaseClient;
  const good = JSON.stringify({ account: { id: "account-a", platform: "instagram" } });
  expect(await socialPayloadBelongsToSession(db, "org-a", "session-a", good)).toBe(true);
  expect(query.eq.mock.calls).toEqual([
    ["organization_id", "org-a"],
    ["id", "session-a"],
    ["provider", "zernio_social"],
  ]);
  expect(
    await socialPayloadBelongsToSession(
      db,
      "org-a",
      "session-a",
      JSON.stringify({ account: { id: "account-b", platform: "instagram" } }),
    ),
  ).toBe(false);
  expect(
    await socialPayloadBelongsToSession(
      db,
      "org-a",
      "session-a",
      JSON.stringify({ account: { id: "account-a", platform: "facebook" } }),
    ),
  ).toBe(false);
});
describe("social account scope failures", () => {
  it("never accepts a missing session", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    expect(
      await socialPayloadBelongsToSession(
        { from: () => query } as unknown as SupabaseClient,
        "other",
        "session",
        "{}",
      ),
    ).toBe(false);
  });
});
