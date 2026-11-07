import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const g = vi.hoisted(() => ({ db: vi.fn(), sync: vi.fn(), select: vi.fn() }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: g.db }));
vi.mock("@/lib/amigo/sync", () => ({ syncAmigo: g.sync }));
import { POST } from "./route";
beforeEach(() => {
  vi.clearAllMocks();
  g.db.mockReturnValue({
    from: () => {
      let selection = "";
      const q = {
        select: (value: string) => {
          selection = value;
          g.select(value);
          return q;
        },
        eq: () => q,
        or: () => q,
        order: () => q,
        limit: async () =>
          selection.includes("!amigo_connections_organization_id_fkey!inner")
            ? { data: [], error: null }
            : { data: null, error: { code: "PGRST201" } },
      };
      return q;
    },
  });
});
it("usa a chave estrangeira explícita para evitar os relacionamentos ambíguos do PostgREST", async () => {
  const response = await POST(
    new NextRequest("http://localhost/api/v1/cron/amigo-sync", { method: "POST" }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { examined: 0, failed: 0 } });
  expect(g.sync).not.toHaveBeenCalled();
});
