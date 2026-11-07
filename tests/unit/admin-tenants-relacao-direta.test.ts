import { describe, expect, it } from "vitest";
import { listarTenants } from "@/app/api/v1/admin/tenants/_lista";
import type { createAdminClient } from "@/lib/supabase/admin";

function fixture() {
  const calls: unknown[][] = [];
  let select = "";
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-01-01T00:00:00Z",
    user_count: [{ count: 3 }],
    conversations_count: [{ count: 9 }],
  };
  const state = { rows: [row], error: null as { message: string } | null };
  const chain = {
    select: (value: string) => {
      select = value;
      return chain;
    },
    order: (...args: unknown[]) => {
      calls.push(["order", ...args]);
      return chain;
    },
    limit: (value: number) => {
      calls.push(["limit", value]);
      return chain;
    },
    eq: (...args: unknown[]) => {
      calls.push(["eq", ...args]);
      return chain;
    },
    is: (...args: unknown[]) => {
      calls.push(["is", ...args]);
      return chain;
    },
    or: (...args: unknown[]) => {
      calls.push(["or", ...args]);
      return chain;
    },
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        resolve({
          data: state.rows,
          // Transport fixture for an installation with multiple relationships.
          error:
            state.error ??
            (select.includes(
              "conversations_count:conversations!conversations_organization_id_fkey(count)",
            )
              ? null
              : { message: "PGRST201: ambiguous conversations relationship" }),
        }),
      ),
  };
  const client = {
    from: (table: string) => {
      expect(table).toBe("organizations");
      return chain;
    },
  } as unknown as ReturnType<typeof createAdminClient>;
  return { client, state, calls, row };
}
describe("lista de empresas preserva a relação direta e as contagens", () => {
  it("lê a empresa e mantém os aliases de contagem sem PGRST201", async () => {
    const f = fixture();
    const result = await listarTenants(f.client, { limit: 30 });
    expect(result.error).toBeNull();
    expect(result.page).toEqual([f.row]);
    expect(result.has_more).toBe(false);
    expect(f.calls).toContainEqual(["limit", 31]);
  });
  it("preserva filtros de onboarding e busca", async () => {
    const f = fixture();
    await listarTenants(f.client, { limit: 30, status: "onboarding", q: "fixture" });
    expect(f.calls).toEqual(
      expect.arrayContaining([
        ["eq", "status", "active"],
        ["is", "onboarded_at", null],
        ["or", "display_name.ilike.%fixture%,slug::text.ilike.%fixture%,cnpj.ilike.%fixture%"],
      ]),
    );
  });
  it("preserva o status explícito", async () => {
    const f = fixture();
    await listarTenants(f.client, { limit: 30, status: "suspended" });
    expect(f.calls).toContainEqual(["eq", "status", "suspended"]);
  });
  it("preserva paginação e corte por cursor", async () => {
    const f = fixture();
    f.state.rows = [f.row, { ...f.row, id: "22222222-2222-4222-8222-222222222222" }];
    const result = await listarTenants(f.client, { limit: 1 });
    expect(result.page).toHaveLength(1);
    expect(result.has_more).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    await listarTenants(f.client, { limit: 1, cursor: result.nextCursor! });
    expect(f.calls).toContainEqual([
      "or",
      `created_at.lt.${f.row.created_at},and(created_at.eq.${f.row.created_at},id.lt.${f.row.id})`,
    ]);
  });
  it("não mascara erro real do banco", async () => {
    const f = fixture();
    f.state.error = { message: "fixture unavailable" };
    const result = await listarTenants(f.client, { limit: 30 });
    expect(result.error?.message).toBe("fixture unavailable");
    expect(result.page).toEqual([]);
  });
});
