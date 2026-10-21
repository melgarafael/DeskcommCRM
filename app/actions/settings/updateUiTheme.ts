"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { installedUiThemes } from "@/lib/ui-themes/installed";
import { validateUiThemeOptions } from "@/lib/ui-themes/contracts";
import { uiThemeCatalogHash } from "@/lib/ui-themes/server";
import { uiThemeApplyInputSchema } from "@/lib/ui-themes/apply-input";

export type UpdateUiThemeResult =
  | { ok: true; revision: number; appliedNow: boolean }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden"
        | "mfa_required"
        | "catalog_changed"
        | "revision_conflict"
        | "db_error";
    };
export async function updateUiTheme(input: unknown): Promise<UpdateUiThemeResult> {
  const parsed = uiThemeApplyInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const org = await resolveActiveOrg(user);
  if (!org || !podeAdministrarEmpresa(user, org)) return { ok: false, error: "forbidden" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };
  const data = parsed.data;
  const entry = installedUiThemes.find((item) => item.package.id === data.themeId && item.enabled);
  if (
    !entry ||
    entry.installationId !== data.installationId ||
    data.catalogHash !== uiThemeCatalogHash()
  )
    return { ok: false, error: "catalog_changed" };
  const options = validateUiThemeOptions(entry.package, data.options);
  if (!options.valid) return { ok: false, error: "validation_failed" };
  const result = await createAdminClient().rpc("fn_ui_theme_apply", {
    p_org: org.orgId,
    p_actor: user.id,
    p_theme: entry.package.id,
    p_installation: entry.installationId,
    p_catalog_hash: data.catalogHash,
    p_options_version: entry.package.optionsVersion,
    p_values: options.values,
    p_expected_revision: data.revision,
    p_request: data.requestId,
  });
  if (result.error)
    return {
      ok: false,
      error:
        result.error.code === "42501"
          ? "forbidden"
          : result.error.code === "PT409"
            ? "revision_conflict"
            : result.error.code === "22023"
              ? "validation_failed"
              : "db_error",
    };
  const applied = z
    .object({ revision: z.number().int().positive(), applied_now: z.boolean() })
    .safeParse(result.data);
  if (!applied.success) return { ok: false, error: "db_error" };
  revalidatePath("/app", "layout");
  return { ok: true, revision: applied.data.revision, appliedNow: applied.data.applied_now };
}
