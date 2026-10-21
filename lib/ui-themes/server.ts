import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { installedUiThemes } from "./installed";
import { registeredUiAreas } from "./areas";
import type { UiThemeSavedState, UiThemeSelection } from "./resolve";

const values = z.record(z.string(), z.union([z.string(), z.boolean(), z.number().finite()]));
const selectionSchema = z.object({
  theme_id: z.string(),
  installation_id: z.string(),
  revision: z.number().int().nonnegative(),
  configurations: z.record(z.string(), z.object({ version: z.number().int().positive(), values })),
});
const savedSchema = selectionSchema.extend({ organization_id: z.string().uuid() });
export function uiThemeCatalogHash(): string {
  return createHash("sha256")
    .update(JSON.stringify({ themes: installedUiThemes, areas: registeredUiAreas }))
    .digest("hex");
}

/** Installation-only loader. The caller must guard the platform administration page. */
export async function readInitialUiThemeState(db: SupabaseClient): Promise<{
  state: UiThemeSelection | null;
  error: "configuration_unavailable" | "configuration_invalid" | null;
}> {
  try {
    const { data, error } = await db
      .from("platform_ui_theme_defaults")
      .select("theme_id,installation_id,revision,configurations")
      .eq("id", 1)
      .maybeSingle();
    if (error) return { state: null, error: "configuration_unavailable" };
    if (!data) return { state: null, error: null };
    const parsed = selectionSchema.safeParse(data);
    return parsed.success
      ? { state: parsed.data, error: null }
      : { state: null, error: "configuration_invalid" };
  } catch {
    return { state: null, error: "configuration_unavailable" };
  }
}
/** Caller supplies the org from the authenticated session. Even service-role reads are scoped. */
export async function readUiThemeState(
  db: SupabaseClient,
  organizationId: string,
): Promise<{
  state: UiThemeSavedState | null;
  error: "configuration_unavailable" | "configuration_invalid" | null;
}> {
  try {
    const { data, error } = await db
      .from("organization_ui_themes")
      .select("organization_id,theme_id,installation_id,revision,configurations")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) return { state: null, error: "configuration_unavailable" };
    if (!data) return { state: null, error: null };
    const parsed = savedSchema.safeParse(data);
    return parsed.success
      ? { state: parsed.data, error: null }
      : { state: null, error: "configuration_invalid" };
  } catch {
    return { state: null, error: "configuration_unavailable" };
  }
}
