import type { UiThemePackage } from "@/lib/ui-themes/contracts";

/** The host's existing composition is the reference, with no additional package required. */
export const padrao: UiThemePackage = {
  apiVersion: 1,
  id: "padrao",
  title: "Padrão",
  version: "1.0.0",
  description: "A interface padrão do CRM, com a marca da sua organização.",
  optionsVersion: 1,
  options: [],
  // Inherit the host's complete original composition, rather than copying it and letting it drift.
  // Copy this package under a new id to declare layouts, region classes or options through the same API.
  areas: {
    inbox: { contractVersion: 1, configuration: {}, regions: {} },
    pipeline: { contractVersion: 1, configuration: {}, regions: {} },
    calendar: { contractVersion: 1, configuration: {}, regions: {} },
  },
};
