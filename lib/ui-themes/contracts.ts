import { z } from "zod";
import { esquemaDaContribuicaoDeTema } from "@/lib/extensions/tema";

/** Build-time presentation packages. This does not extend the declarative extension ABI. */
export const UI_THEME_API = 1;
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const region = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const className = z
  .string()
  .max(512)
  .regex(/^[a-zA-Z0-9_ -]*$/);
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export type UiOptionValue = string | number | boolean;
export type UiOptionValues = Record<string, UiOptionValue>;
const optionBase = {
  key: z.string().regex(/^(global|[a-z][a-z0-9-]{1,63})\.[a-z][a-z0-9-]{0,47}$/),
  label: z.string().min(1).max(100),
  description: z.string().max(300).optional(),
};
const optionSchema = z.discriminatedUnion("type", [
  z.object({ ...optionBase, type: z.literal("boolean"), default: z.boolean() }).strict(),
  z
    .object({
      ...optionBase,
      type: z.literal("enum"),
      default: z.string(),
      choices: z
        .array(
          z
            .object({ value: z.string().min(1).max(48), label: z.string().min(1).max(100) })
            .strict(),
        )
        .min(1)
        .max(12),
    })
    .strict(),
  z
    .object({
      ...optionBase,
      type: z.literal("range"),
      default: z.number().finite(),
      min: z.number().finite(),
      max: z.number().finite(),
      step: z.number().positive().finite(),
    })
    .strict(),
]);
export type UiThemeOption = z.infer<typeof optionSchema>;

export type UiLayout =
  | { type: "slot"; name: string; className?: string }
  | { type: "row" | "stack" | "grid"; className?: string; children: UiLayout[] };
const layoutSchema: z.ZodType<UiLayout> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("slot"), name: region, className: className.optional() }).strict(),
    z
      .object({
        type: z.enum(["row", "stack", "grid"]),
        className: className.optional(),
        children: z.array(layoutSchema).min(1).max(24),
      })
      .strict(),
  ]),
);
const regionStyleSchema = z
  .object({
    className: className.optional(),
    /** Only declared options can choose a class from this finite build-time map. */
    variants: z.record(z.string(), z.record(z.string(), className)).optional(),
  })
  .strict();
export type UiRegionStyle = z.infer<typeof regionStyleSchema>;
const areaSchema = z
  .object({
    contractVersion: z.number().int().positive(),
    className: className.optional(),
    layout: layoutSchema.optional(),
    regions: z.record(region, regionStyleSchema).default({}),
    /** The area's adapter owns this schema; these are presentation inputs, never effects. */
    configuration: z
      .record(z.string(), z.union([z.string().max(128), z.number().finite(), z.boolean()]))
      .default({}),
  })
  .strict();
export type UiAreaPresentation = z.infer<typeof areaSchema>;

export const uiThemePackageSchema = z
  .object({
    apiVersion: z.literal(UI_THEME_API),
    id: slug,
    title: z.string().min(1).max(80),
    version,
    description: z.string().max(400),
    optionsVersion: z.number().int().positive(),
    options: z.array(optionSchema).max(32).default([]),
    global: regionStyleSchema.extend({ tokens: esquemaDaContribuicaoDeTema.optional() }).optional(),
    areas: z.record(slug, areaSchema).default({}),
  })
  .strict()
  .superRefine((pack, ctx) => {
    const keys = new Set<string>();
    pack.options.forEach((option, i) => {
      if (keys.has(option.key))
        ctx.addIssue({ code: "custom", path: ["options", i], message: "duplicate option" });
      keys.add(option.key);
      const scope = option.key.split(".")[0]!;
      if (scope !== "global" && !Object.hasOwn(pack.areas, scope))
        ctx.addIssue({ code: "custom", path: ["options", i], message: "unknown option area" });
      if (
        option.type === "enum" &&
        (!option.choices.some((c) => c.value === option.default) ||
          new Set(option.choices.map((c) => c.value)).size !== option.choices.length)
      )
        ctx.addIssue({
          code: "custom",
          path: ["options", i],
          message: "invalid enum choices/default",
        });
      if (
        option.type === "range" &&
        (option.max < option.min ||
          option.default < option.min ||
          option.default > option.max ||
          !onStep(option.default, option))
      )
        ctx.addIssue({ code: "custom", path: ["options", i], message: "invalid range/default" });
    });
    for (const key of Object.keys(pack.global?.variants ?? {})) {
      if (!keys.has(key) || !key.startsWith("global."))
        ctx.addIssue({
          code: "custom",
          path: ["global", "variants"],
          message: "unknown or non-global option binding",
        });
    }
    for (const [area, contribution] of Object.entries(pack.areas)) {
      let nodes = 0;
      const visit = (node: UiLayout, depth: number) => {
        if (++nodes > 128 || depth > 8) {
          ctx.addIssue({
            code: "custom",
            path: ["areas", area, "layout"],
            message: "layout limit exceeded",
          });
          return;
        }
        if (node.type !== "slot") node.children.forEach((child) => visit(child, depth + 1));
      };
      if (contribution.layout) visit(contribution.layout, 0);
      for (const style of Object.values(contribution.regions))
        for (const key of Object.keys(style.variants ?? {}))
          if (!keys.has(key) || !(key.startsWith("global.") || key.startsWith(`${area}.`)))
            ctx.addIssue({
              code: "custom",
              path: ["areas", area, "regions"],
              message: "unknown or cross-area option binding",
            });
    }
  });
export type UiThemePackage = z.infer<typeof uiThemePackageSchema>;
export interface InstalledUiTheme {
  installationId: string;
  enabled: boolean;
  package: UiThemePackage;
}
export interface UiAreaContract {
  id: string;
  title?: string;
  version: number;
  regions: readonly string[];
  required: readonly string[];
  slots?: readonly string[];
  /** Pure host-owned guard, never supplied by a package or serialized as organization data. */
  validateConfiguration?: (configuration: UiAreaPresentation["configuration"]) => boolean;
}

function onStep(value: number, option: { min: number; step: number }): boolean {
  return (
    Math.abs((value - option.min) / option.step - Math.round((value - option.min) / option.step)) <
    1e-7
  );
}
export function validateUiThemeOptions(
  pack: UiThemePackage,
  input: unknown,
): { values: UiOptionValues; valid: boolean } {
  const object =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  let valid = input !== null && typeof input === "object" && !Array.isArray(input);
  const values: UiOptionValues = {};
  for (const option of pack.options) {
    const raw = object[option.key];
    const accepts =
      raw === undefined ||
      (option.type === "boolean"
        ? typeof raw === "boolean"
        : option.type === "enum"
          ? typeof raw === "string" && option.choices.some((c) => c.value === raw)
          : typeof raw === "number" &&
            Number.isFinite(raw) &&
            raw >= option.min &&
            raw <= option.max &&
            onStep(raw, option));
    if (!accepts) valid = false;
    values[option.key] = accepts && raw !== undefined ? (raw as UiOptionValue) : option.default;
  }
  if (Object.keys(object).some((key) => !pack.options.some((option) => option.key === key)))
    valid = false;
  return { values, valid };
}

export function compatibleArea(
  presentation: UiAreaPresentation,
  contract: UiAreaContract,
): boolean {
  try {
    if (
      contract.validateConfiguration &&
      !contract.validateConfiguration(presentation.configuration)
    )
      return false;
  } catch {
    return false;
  }
  if (
    presentation.contractVersion !== contract.version ||
    Object.keys(presentation.regions).some((name) => !contract.regions.includes(name))
  )
    return false;
  if (!presentation.layout) return true;
  const seen = new Set<string>();
  let valid = true;
  const visit = (node: UiLayout) => {
    if (node.type === "slot") {
      if (!(contract.slots ?? contract.required).includes(node.name) || seen.has(node.name))
        valid = false;
      seen.add(node.name);
    } else node.children.forEach(visit);
  };
  visit(presentation.layout);
  return valid && contract.required.every((name) => seen.has(name));
}
