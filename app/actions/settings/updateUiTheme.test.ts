import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  user: vi.fn<() => Promise<Record<string, unknown> | null>>(),
  org: vi.fn<() => Promise<Record<string, unknown> | null>>(),
  mfa: vi.fn<() => Promise<boolean>>(),
  rpc: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.user,
  resolveActiveOrg: mocks.org,
  mfaEmDivida: mocks.mfa,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/impersonate/support", () => ({
  supportWriteError: (support: { access_mode?: string } | null) =>
    support?.access_mode === "support_readonly" ? "readonly" : null,
}));
import { updateUiTheme } from "./updateUiTheme";
import { uiThemeCatalogHash } from "@/lib/ui-themes/server";
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  org = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const user = { id: actor, is_platform_admin: false, platform_admin_scope: null, support: null };
function input() {
  return {
    themeId: "padrao",
    installationId: "builtin-padrao-v1",
    catalogHash: uiThemeCatalogHash(),
    revision: 0,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    options: {},
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ ...user });
  mocks.org.mockResolvedValue({ orgId: org, role: "admin" });
  mocks.mfa.mockResolvedValue(false);
  mocks.rpc.mockResolvedValue({ data: { revision: 1, applied_now: true }, error: null });
});
describe("action de tema usa a autoridade da sessão", () => {
  it("grava a org/ator da sessão e revalida a casca após o recibo", async () => {
    expect(await updateUiTheme(input())).toEqual({ ok: true, revision: 1, appliedNow: true });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fn_ui_theme_apply",
      expect.objectContaining({
        p_org: org,
        p_actor: actor,
        p_theme: "padrao",
        p_expected_revision: 0,
      }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/app", "layout");
  });
  it("não aceita identidade de organização/ator no corpo", async () => {
    expect(await updateUiTheme({ ...input(), organizationId: "another" })).toEqual({
      ok: false,
      error: "validation_failed",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("manager e sessão sem usuário não escrevem", async () => {
    mocks.org.mockResolvedValue({ orgId: org, role: "manager" });
    expect(await updateUiTheme(input())).toEqual({ ok: false, error: "forbidden" });
    mocks.user.mockResolvedValue(null);
    expect(await updateUiTheme(input())).toEqual({ ok: false, error: "unauthenticated" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("suporte readonly e MFA pendente não alcançam a RPC", async () => {
    mocks.user.mockResolvedValue({
      ...user,
      is_platform_admin: true,
      platform_admin_scope: "full",
      support: { access_mode: "support_readonly" },
    });
    expect(await updateUiTheme(input())).toEqual({ ok: false, error: "forbidden" });
    mocks.user.mockResolvedValue({ ...user });
    mocks.mfa.mockResolvedValue(true);
    expect(await updateUiTheme(input())).toEqual({ ok: false, error: "mfa_required" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("catálogo/instalação antigos e opção fora do contrato não gravam", async () => {
    expect(await updateUiTheme({ ...input(), catalogHash: "0".repeat(64) })).toEqual({
      ok: false,
      error: "catalog_changed",
    });
    expect(await updateUiTheme({ ...input(), installationId: "old-installation" })).toEqual({
      ok: false,
      error: "catalog_changed",
    });
    expect(await updateUiTheme({ ...input(), options: { "global.unknown": true } })).toEqual({
      ok: false,
      error: "validation_failed",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("papel revalidado e revisão concorrente recusados pelo banco aparecem como erro", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect(await updateUiTheme(input())).toEqual({ ok: false, error: "forbidden" });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PT409" } });
    expect(await updateUiTheme(input())).toEqual({ ok: false, error: "revision_conflict" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
