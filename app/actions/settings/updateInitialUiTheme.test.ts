import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), user: vi.fn(), rpc: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth/escritaDeAdminOuRecusa", () => ({ escritaDeAdminOuRecusa: mocks.guard }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: mocks.user }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
import { updateInitialUiTheme } from "./updateInitialUiTheme";
import { uiThemeCatalogHash } from "@/lib/ui-themes/server";
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function input() {
  return { themeId: "padrao", installationId: "builtin-padrao-v1", catalogHash: uiThemeCatalogHash(),
    revision: 0, requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", options: {} };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue({ ok: true, ctx: { user: { id: actor }, platformAdmin: { scope: "full" } } });
  mocks.user.mockResolvedValue({ id: actor, support: null });
  mocks.rpc.mockResolvedValue({ data: { revision: 1, applied_now: true }, error: null });
});
describe("tema inicial é autoridade de instalação, não uma escolha do tenant ativo", () => {
  it("usa guard de escrita global, ator confiável e RPC exclusiva sem org do browser", async () => {
    expect(await updateInitialUiTheme(input())).toEqual({ ok: true, revision: 1, appliedNow: true });
    expect(mocks.guard).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("fn_ui_theme_initial_default_apply", {
      p_actor: actor, p_theme: "padrao", p_installation: "builtin-padrao-v1", p_catalog_hash: uiThemeCatalogHash(),
      p_options_version: 1, p_values: {}, p_expected_revision: 0, p_request: input().requestId,
    });
    expect(mocks.revalidate.mock.calls).toEqual([["/admin/marca"]]);
  });
  it("recusa identidade/escopo injetado no body antes de alcançar a escrita", async () => {
    expect(await updateInitialUiTheme({ ...input(), organizationId: actor })).toMatchObject({ error: "validation_failed" });
    expect(await updateInitialUiTheme({ ...input(), actorId: actor })).toMatchObject({ error: "validation_failed" });
    expect(mocks.guard).not.toHaveBeenCalled();expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["forbidden_scope", "mfa_required"])("recusa nativa %s não chama banco", async (error) => {
    mocks.guard.mockResolvedValue({ ok: false, error });
    expect(await updateInitialUiTheme(input())).toMatchObject({ error: error === "mfa_required" ? error : "forbidden" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("redirect nativo de quem não é platform admin não é absorvido como sucesso", async () => {
    mocks.guard.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(updateInitialUiTheme(input())).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("acompanhamento de organização e identidade divergente não escrevem configuração global", async () => {
    mocks.user.mockResolvedValue({ id: actor, support: { access_mode: "support_write" } });
    expect(await updateInitialUiTheme(input())).toMatchObject({ error: "forbidden" });
    mocks.user.mockResolvedValue({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", support: null });
    expect(await updateInitialUiTheme(input())).toMatchObject({ error: "forbidden" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("catálogo e opções são os incorporados, com id/revisão revalidados", async () => {
    for (const value of [{ ...input(), catalogHash: "0".repeat(64) }, { ...input(), installationId: "old-installation" }])
      expect(await updateInitialUiTheme(value)).toMatchObject({ error: "catalog_changed" });
    expect(await updateInitialUiTheme({ ...input(), options: { "global.unknown": true } })).toMatchObject({ error: "validation_failed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("conflito, revogação e falha do banco permanecem visíveis sem refresh de sucesso", async () => {
    for (const [code, error] of [["PT409", "revision_conflict"], ["42501", "forbidden"], ["22023", "validation_failed"], ["08006", "db_error"]]) {
      mocks.rpc.mockResolvedValue({ data: null, error: { code } });
      expect(await updateInitialUiTheme(input())).toEqual({ ok: false, error });
    }
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
