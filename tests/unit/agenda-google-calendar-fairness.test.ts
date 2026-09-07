import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/cron/agenda-google-sync/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncCalendar } from "@/lib/agenda/google/calendar-executor";
import { audit } from "@/lib/audit";
vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "cron" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agenda/google/calendar-executor", () => ({
  refreshCatalog: vi.fn(),
  syncCalendar: vi.fn(),
}));
vi.mock("@/lib/agenda/google/membros", () => ({
  apenasDeMembrosAtivos: vi.fn(async (_db, rows) => rows),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const connection = {
  id: "conn",
  organization_id: "org",
  user_id: "owner",
  calendar_selection_revision: "1",
};
let healthyLinked = false;
let calendars: Array<{
  id: string;
  external_calendar_id: string;
  counts_for_conflicts: boolean;
  is_destination: boolean;
  sync_next_attempt_at: string;
}>;
beforeEach(() => {
  vi.clearAllMocks();
  healthyLinked = false;
  calendars = Array.from({ length: 26 }, (_, i) => ({
    id: `calendar-${i}`,
    external_calendar_id: `calendar-${i}`,
    counts_for_conflicts: i === 25,
    is_destination: false,
    sync_next_attempt_at: "2000-01-01T00:00:00Z",
  }));
  vi.mocked(syncCalendar).mockResolvedValue("complete");
  const db = {
    from: (table: string) => {
      let projection = "",
        patch: Record<string, unknown> | null = null;
      const filters: Record<string, string> = {};
      const execute = () => {
        if (patch && table === "calendar_connection_calendars") {
          const c = calendars.find((c) => c.id === filters.id);
          if (c) c.sync_next_attempt_at = String(patch.sync_next_attempt_at);
          return { data: null, error: null };
        }
        // A tabela bruta ainda contém identidades redigidas; só a view canônica
        // pode afirmar que existe consumidor reconciliável.
        if (table === "calendar_appointments") return { data: [{ id: "redacted" }], error: null };
        if (table === "calendar_google_reconcilable_appointments")
          return {
            data:
              healthyLinked && filters.google_calendar_id === "calendar-25"
                ? [{ id: "healthy" }]
                : [],
            error: null,
          };
        if (table === "calendar_connections")
          return { data: patch ? null : [connection], error: null };
        if (projection === "catalog_checked_at")
          return { data: [{ catalog_checked_at: new Date().toISOString() }], error: null };
        return {
          data: calendars
            .filter((c) => Date.parse(c.sync_next_attempt_at) <= Date.now())
            .slice(0, 25),
          error: null,
        };
      };
      const q = {
        select: (s: string) => {
          projection = s;
          return q;
        },
        eq: (key: string, v: string) => {
          filters[key] = v;
          return q;
        },
        lte: () => q,
        order: () => q,
        update: (p: Record<string, unknown>) => {
          patch = p;
          return q;
        },
        limit: async () => execute(),
        then: (resolve: (value: unknown) => void) => resolve(execute()),
      };
      return q;
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(db as never);
});
it("calendários sem fonte/destino/vínculo não escondem para sempre o26º elegível", async () => {
  const req = () =>
    new NextRequest("http://local/cron", { headers: { authorization: "Bearer cron" } });
  expect((await GET(req())).status).toBe(200);
  expect(syncCalendar).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
  expect(calendars.slice(0, 25).every((c) => Date.parse(c.sync_next_attempt_at) > Date.now())).toBe(
    true,
  );
  expect((await GET(req())).status).toBe(200);
  expect(syncCalendar).toHaveBeenCalledWith(expect.anything(), "org", "calendar-25");
  expect(audit).toHaveBeenCalledTimes(1);
});

it("calendários só com identidades redigidas não escondem vínculo saudável sem fonte", async () => {
  healthyLinked = true;
  calendars[25]!.counts_for_conflicts = false;
  const req = () =>
    new NextRequest("http://local/cron", { headers: { authorization: "Bearer cron" } });
  await GET(req());
  expect(syncCalendar).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
  await GET(req());
  expect(syncCalendar).toHaveBeenCalledTimes(1);
  expect(syncCalendar).toHaveBeenCalledWith(expect.anything(), "org", "calendar-25");
  expect(audit).toHaveBeenCalledTimes(1);
});
