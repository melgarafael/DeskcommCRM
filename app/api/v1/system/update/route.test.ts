import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ insertError: { code: "", message: "" }, audit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "owner", is_platform_admin: true }),
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        insert: () => query,
        maybeSingle: async () => ({
          data:
            table === "system_version"
              ? { current_version: "1.0.0", latest_version: "1.1.0" }
              : null,
          error: null,
        }),
        single: async () => ({ data: null, error: mocks.insertError }),
      };
      return query;
    },
  }),
}));

import { POST } from "./route";

beforeEach(() => vi.clearAllMocks());

it("explica a preparação de extensão que bloqueia a atualização sem despachar um run", async () => {
  mocks.insertError = { code: "P0001", message: "extension_preparation_in_progress" };
  const response = await POST(
    new NextRequest("http://localhost/api/v1/system/update", { method: "POST" }),
  );
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.error.code).toBe("state_conflict");
  expect(body.error.message).toContain("Abra Extensões");
  expect(mocks.audit).not.toHaveBeenCalled();
});

it("a recusa nomeia as duas saídas da preparação: quem pediu retoma, qualquer responsável cancela", async () => {
  // O mesmo par de saídas que a gestão de extensões oferece (`SQL_ERRORS`): uma recusa que só
  // dissesse "há uma extensão em preparação" deixaria quem opera a VPS sem o que fazer.
  mocks.insertError = { code: "P0001", message: "extension_preparation_in_progress" };
  const response = await POST(
    new NextRequest("http://localhost/api/v1/system/update", { method: "POST" }),
  );
  const { error } = await response.json();
  expect(error.message).toContain("Atividade recente");
  expect(error.message).toContain("quem pediu pode retomar o pedido");
  expect(error.message).toContain("qualquer responsável pela instalação pode cancelá-lo");
});

it("não disfarça falha de infraestrutura como conflito de extensão", async () => {
  mocks.insertError = { code: "08006", message: "connection failed" };
  const response = await POST(
    new NextRequest("http://localhost/api/v1/system/update", { method: "POST" }),
  );
  expect(response.status).toBe(500);
  expect((await response.json()).error.message).not.toContain("Abra Extensões");
});
