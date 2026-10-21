import { uiThemePackageSchema, type InstalledUiTheme, type UiAreaContract } from "./contracts";
import { padrao } from "@/ui-themes/padrao/definition";

/** Entries come from reviewed source in the image, never from an HTTP body. */
export function createUiThemeCatalog(
  entries: readonly InstalledUiTheme[],
): readonly InstalledUiTheme[] {
  const ids = new Set<string>();
  const withStandard = entries.some((entry) => entry.package.id === "padrao")
    ? entries
    : [{ installationId: "builtin-padrao-v1", enabled: true, package: padrao }, ...entries];
  return withStandard.map((entry) => {
    const pack = uiThemePackageSchema.parse(entry.package);
    if (
      pack.id === "padrao" &&
      (!entry.enabled ||
        entry.installationId !== "builtin-padrao-v1" ||
        JSON.stringify(pack) !== JSON.stringify(uiThemePackageSchema.parse(padrao)))
    )
      throw new Error("standard_ui_theme_is_builtin");
    if (ids.has(pack.id) || !/^[a-zA-Z0-9_-]{4,100}$/.test(entry.installationId))
      throw new Error("invalid_ui_theme_registration");
    ids.add(pack.id);
    return { ...entry, package: pack };
  });
}

/** Host adapters register their contract, rather than adding branches to the resolver. */
export function createUiAreaCatalog(areas: readonly UiAreaContract[]): readonly UiAreaContract[] {
  const ids = new Set<string>();
  return areas.map((area) => {
    const slots = area.slots ?? area.required;
    if (
      ids.has(area.id) ||
      !/^[a-z][a-z0-9-]{1,63}$/.test(area.id) ||
      !Number.isInteger(area.version) ||
      area.version < 1 ||
      new Set(area.regions).size !== area.regions.length ||
      new Set(slots).size !== slots.length ||
      new Set(area.required).size !== area.required.length ||
      area.required.some((id) => !slots.includes(id)) ||
      slots.some((id) => !area.regions.includes(id))
    )
      throw new Error("invalid_ui_area_registration");
    ids.add(area.id);
    return area;
  });
}
