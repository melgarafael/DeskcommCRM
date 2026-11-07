import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
const deps = vi.hoisted(() => ({ db: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.db }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
import { GET } from "@/app/api/v1/cron/agenda-expira-pendentes/route";
import { googlePushCandidates } from "@/lib/agenda/google/candidates";

beforeEach(() => vi.clearAllMocks());

it("Google candidates explicitly select only local authority in TS", async () => {
  const eq = vi.fn();
  const q: Record<string, unknown> = {};
  for (const method of ["select", "or", "lte", "not", "order", "limit"]) q[method] = () => q;
  q.eq = (...args: unknown[]) => {
    eq(...args);
    return q;
  };
  const db = { from: () => q } as unknown as SupabaseClient;
  googlePushCandidates(db);
  expect(eq).toHaveBeenCalledWith("authority", "local");
});

it("pending expiration excludes external rows on both read and write, including a race", async () => {
  const rows = [
    {
      id: "external",
      authority: "amigo",
      organization_id: "org",
      created_at: "2020-01-01",
      status: "pending",
    },
    {
      id: "local",
      authority: "local",
      organization_id: "org",
      created_at: "2020-01-01",
      status: "pending",
    },
    {
      id: "raced",
      authority: "local",
      organization_id: "org",
      created_at: "2020-01-01",
      status: "pending",
    },
  ];
  const updated: string[] = [];
  const guarded: boolean[] = [];
  deps.db.mockReturnValue({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let updating = false;
      let ids: string[] = [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit"]) q[m] = () => q;
      q.eq = (field: string, value: unknown) => {
        filters.push([field, value]);
        return q;
      };
      q.in = (_field: string, value: string[]) => {
        ids = value;
        return q;
      };
      q.update = () => {
        updating = true;
        rows[2]!.authority = "amigo";
        return q;
      };
      q.then = (resolve: (value: unknown) => unknown) => {
        if (table === "organizations")
          return resolve({ data: [{ id: "org", settings: {} }], error: null });
        guarded.push(filters.some(([k, v]) => k === "authority" && v === "local"));
        const matches = rows.filter(
          (r) =>
            filters.every(([k, v]) => r[k as keyof typeof r] === v) &&
            (!updating || ids.includes(r.id)),
        );
        if (updating) updated.push(...matches.map((r) => r.id));
        return resolve({ data: matches, error: null });
      };
      return q;
    },
  });
  const response = await GET(
    new NextRequest("https://example.test/api/v1/cron/agenda-expira-pendentes"),
  );
  expect(response.status).toBe(200);
  expect(updated).toEqual(["local"]);
  expect(guarded).toEqual([true, true]);
});
