import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  insert: vi.fn(async () => ({ error: null })),
  filters: vi.fn(),
  agency: true,
}));
vi.mock("@/lib/env", () => ({ env: { SUPABASE_SERVICE_ROLE_KEY: "test-key" } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("callback não tem cookie");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (key: string, value: string) => {
          fake.filters(table, key, value);
          return chain;
        },
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({
          data:
            table === "agencia_sessoes" && fake.agency
              ? { id: "delegacao", agencia_id: "agencia", auth_session_id: "sessao" }
              : null,
          error: null,
        }),
        insert: fake.insert,
      };
      return chain;
    },
  }),
}));
import { audit } from "./index";
beforeEach(() => {
  vi.clearAllMocks();
  fake.agency = true;
});
it("callback atribui efeito à pessoa real e à agência sem marcar administrador global", async () => {
  await audit({
    action: "org.updated",
    actorUserId: "pessoa",
    actorAuthSessionId: "sessao",
    organizationId: "cliente",
  });
  expect(fake.insert).toHaveBeenCalledWith(
    expect.objectContaining({
      actor_user_id: "pessoa",
      organization_id: "cliente",
      acting_as_platform_admin: false,
      metadata: expect.objectContaining({
        agency_id: "agencia",
        support_session_id: "delegacao",
        support_auth_session_id: "sessao",
      }),
    }),
  );
  for (const [key, value] of [
    ["actor_user_id", "pessoa"],
    ["auth_session_id", "sessao"],
    ["organization_id", "cliente"],
  ])
    expect(fake.filters).toHaveBeenCalledWith("agencia_sessoes", key, value);
});
it("callback de vínculo direto não inventa uma delegação", async () => {
  fake.agency = false;
  await audit({
    action: "org.updated",
    actorUserId: "pessoa",
    actorAuthSessionId: "sessao",
    organizationId: "cliente",
  });
  expect(fake.insert).toHaveBeenCalledWith(
    expect.objectContaining({ acting_as_platform_admin: false, metadata: {} }),
  );
});
