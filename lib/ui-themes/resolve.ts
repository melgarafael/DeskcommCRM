import { padrao } from "@/ui-themes/padrao/definition";
import {
  compatibleArea,
  validateUiThemeOptions,
  type InstalledUiTheme,
  type UiAreaContract,
  type UiOptionValues,
  type UiThemePackage,
  type UiRegionStyle,
} from "./contracts";

export interface UiThemeSavedState {
  organization_id: string;
  theme_id: string;
  installation_id: string;
  revision: number;
  configurations: Record<string, { version: number; values: UiOptionValues }>;
}
export type UiThemeFallback =
  | "unavailable"
  | "disabled"
  | "reinstalled"
  | "options_incompatible"
  | "options_invalid"
  | "configuration_unavailable"
  | "configuration_invalid"
  | null;
export interface ResolvedUiTheme {
  package: UiThemePackage;
  values: UiOptionValues;
  fallback: UiThemeFallback;
  requestedId: string;
}
export function resolveUiTheme(
  catalog: readonly InstalledUiTheme[],
  state: UiThemeSavedState | null,
): ResolvedUiTheme {
  const standard = {
    package: padrao,
    values: {},
    fallback: null,
    requestedId: state?.theme_id ?? "padrao",
  };
  if (!state || state.theme_id === "padrao") return standard;
  const entry = catalog.find((item) => item.package.id === state.theme_id);
  if (!entry) return { ...standard, fallback: "unavailable" };
  if (!entry.enabled) return { ...standard, fallback: "disabled" };
  if (entry.installationId !== state.installation_id)
    return { ...standard, fallback: "reinstalled" };
  const saved = state.configurations[state.theme_id];
  if (saved && saved.version !== entry.package.optionsVersion)
    return { ...standard, fallback: "options_incompatible" };
  const validated = validateUiThemeOptions(entry.package, saved?.values ?? {});
  return {
    package: entry.package,
    values: validated.values,
    fallback: validated.valid ? null : "options_invalid",
    requestedId: state.theme_id,
  };
}
export function resolveUiArea(theme: ResolvedUiTheme, contract: UiAreaContract) {
  const area = theme.package.areas[contract.id];
  return area && compatibleArea(area, contract) ? area : null;
}
export function regionClassName(
  theme: ResolvedUiTheme,
  contract: UiAreaContract,
  region: string,
): string | undefined {
  const style = resolveUiArea(theme, contract)?.regions[region];
  return classesFor(style, theme.values);
}
export function globalClassName(theme: ResolvedUiTheme): string | undefined {
  return classesFor(theme.package.global, theme.values);
}
function classesFor(style: UiRegionStyle | undefined, values: UiOptionValues): string | undefined {
  if (!style) return undefined;
  return (
    [
      style.className,
      ...Object.entries(style.variants ?? {}).map(([key, choices]) =>
        Object.hasOwn(choices, String(values[key])) ? choices[String(values[key])] : undefined,
      ),
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}
