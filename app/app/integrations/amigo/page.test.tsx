import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getConfig: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/amigo/store", () => ({ getAmigoConfig: mocks.getConfig }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("./_client", () => ({ AmigoClient: () => null }));
import AmigoPage from "./page";
beforeEach(() => vi.clearAllMocks());
it("recusa antes de carregar configuração quando o guard nega o acesso", async () => {
  mocks.requireRole.mockResolvedValue({ ok: false });
  await expect(AmigoPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    "redirect:/app/inbox",
  );
  expect(mocks.requireRole).toHaveBeenCalledWith("agent", { resource: "amigo_operation" });
  expect(mocks.getConfig).not.toHaveBeenCalled();
});
it("usa organização do guard e limita controles ao papel efetivo", async () => {
  mocks.requireRole.mockResolvedValue({ ok: true, org: { orgId: "trusted-org", role: "agent" } });
  mocks.getConfig.mockResolvedValue({ configured: false });
  const result = await AmigoPage({
    searchParams: Promise.resolve({
      aba: "pacientes",
      contact_id: "invalid",
      organization_id: "untrusted",
    }),
  });
  expect(mocks.getConfig).toHaveBeenCalledWith("trusted-org");
  expect(result.props).toMatchObject({
    canConfigure: false,
    canManage: false,
    initialTab: "pacientes",
    initialContactId: undefined,
  });
});
