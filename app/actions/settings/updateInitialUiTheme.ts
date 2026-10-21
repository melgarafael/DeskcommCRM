"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { installedUiThemes } from "@/lib/ui-themes/installed";
import { uiThemeApplyInputSchema } from "@/lib/ui-themes/apply-input";
import { validateUiThemeOptions } from "@/lib/ui-themes/contracts";
import { uiThemeCatalogHash } from "@/lib/ui-themes/server";
import type { UpdateUiThemeResult } from "./updateUiTheme";

/** Changes only the starting selection for future organizations, never an existing tenant. */
export async function updateInitialUiTheme(input: unknown): Promise<UpdateUiThemeResult> {
  const parsed = uiThemeApplyInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };
  // The same native write guard used by global branding: JWT, full platform scope and MFA.
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok)
    return { ok: false, error: escrita.error === "mfa_required" ? "mfa_required" : "forbidden" };
  const actor = await loadAuthUser();
  // A platform configuration is never edited from an organization support session.
  if (!actor || actor.id !== escrita.ctx.user.id || actor.support)
    return { ok: false, error: "forbidden" };
  const data = parsed.data;
  const entry = installedUiThemes.find((item) => item.package.id === data.themeId && item.enabled);
  if (!entry || entry.installationId !== data.installationId || data.catalogHash !== uiThemeCatalogHash())
    return { ok: false, error: "catalog_changed" };
  const options = validateUiThemeOptions(entry.package, data.options);
  if (!options.valid) return { ok: false, error: "validation_failed" };
  const result = await createAdminClient().rpc("fn_ui_theme_initial_default_apply", {
    p_actor: escrita.ctx.user.id,
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
      error: result.error.code === "42501" ? "forbidden"
        : result.error.code === "PT409" ? "revision_conflict"
        : result.error.code === "22023" ? "validation_failed" : "db_error",
    };
  const applied = z.object({ revision: z.number().int().positive(), applied_now: z.boolean() })
    .safeParse(result.data);
  if (!applied.success) return { ok: false, error: "db_error" };
  revalidatePath("/admin/marca");
  return { ok: true, revision: applied.data.revision, appliedNow: applied.data.applied_now };
}
