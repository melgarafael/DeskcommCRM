import { beforeEach, expect, it, vi } from "vitest";
const estado = vi.hoisted(() => ({ path: "/api/v1/contacts", status: "active", agency: true }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(estado.path ? { "x-pathname": estado.path } : {}),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: "ator",
    support: {
      organization_id: "cliente",
      agency_id: estado.agency ? "agencia" : undefined,
      status: estado.status,
      access_mode: "full",
    },
  }),
}));
import { requireSupportWrite } from "@/lib/impersonate/support";
beforeEach(() => {
  estado.path = "/api/v1/contacts";
  estado.status = "active";
  estado.agency = true;
});
it.each([
  "/api/v1/team/invite",
    "/api/v1/%74eam/invite",
    "/api/v1/settings%2Fapi-tokens",
    "/api/v1//admin/platform-admins",
  "/api/v1/team/pessoa/reactivate",
  "/api/v1/settings/api-tokens",
  "/api/v1/admin/platform-admins",
  "",
])("delegação recusa concessão permanente ou caminho sem origem confiável: %s", async (path) => {
  estado.path = path;
  expect((await requireSupportWrite())?.status).toBe(403);
});
it("permite operação normal do CRM com delegação válida", async () => {
  expect(await requireSupportWrite()).toBeNull();
});
it("nega operação normal depois da revogação", async () => {
  estado.status = "revoked";
  expect((await requireSupportWrite())?.status).toBe(403);
});
it("mantém a guarda original do suporte global", async () => {
  estado.agency = false;
  estado.path = "/api/v1/team/invite";
  expect(await requireSupportWrite()).toBeNull();
});
