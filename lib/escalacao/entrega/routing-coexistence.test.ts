import { describe, it, expect, vi, beforeEach } from "vitest";
import { processEvent } from "@/lib/routing/worker";
import { createAdminClient } from "@/lib/supabase/admin";
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
const org = "aaaaaaaa-0000-4000-8000-000000000001",
  conv = "aaaaaaaa-0000-4000-8000-000000000002";
beforeEach(() => vi.clearAllMocks());
describe("roteador legado respeita passagem opt-in por tenant", () => {
  for (const [enabled, outcome] of [
    [true, "skipped_handoff_delivery"],
    [false, "skipped_manual"],
    ["true", "skipped_manual"],
    [undefined, "skipped_manual"],
  ] as const) {
    it(`flag ${String(enabled)}: ${outcome}`, async () => {
      const calls: string[] = [];
      const updates: unknown[] = [];
      const admin = {
        from: (table: string) => {
          calls.push(table);
          const chain = {
            select: () => chain,
            order: () => chain,
            is: () => chain,
            in: () => chain,
            limit: () => chain,
            eq: () => chain,
            update: (v: unknown) => {
              updates.push(v);
              return chain;
            },
            maybeSingle: async () => ({
              data:
                table === "conversations"
                  ? {
                      id: conv,
                      organization_id: org,
                      status: "pending",
                      assigned_to_user_id: null,
                      bot_silenced_until: "infinity",
                      service_revision: 1,
                    }
                  : table === "organizations"
                    ? { settings: { routing: { mode: "manual" }, handoff_delivery: { enabled } } }
                    : null,
              error: null,
            }),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({
                data:
                  table === "handoff_delivery_episodes" && enabled === true ? [{ id: conv }] : null,
                error: null,
              }).then(resolve),
          };
          return chain;
        },
        rpc: vi.fn(),
      };
      vi.mocked(createAdminClient).mockReturnValue(
        admin as unknown as ReturnType<typeof createAdminClient>,
      );
      const result = await processEvent(
        {
          id: conv,
          organization_id: org,
          payload: { organization_id: org, conversation_id: conv },
          metadata: null,
          consumed_by: [],
          attempts: 0,
          claimed_at: new Date().toISOString(),
        },
        new Date(),
      );
      expect(result).toBe(outcome);
      expect(admin.rpc).not.toHaveBeenCalled();
      expect(updates).toEqual([
        expect.objectContaining({ metadata: expect.objectContaining({ outcome }) }),
      ]);
      expect(calls).toContain("organizations");
    });
  }
});
