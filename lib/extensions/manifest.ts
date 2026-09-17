import { z } from "zod";

import { ExtensionError } from "./errors";
import { parseStrictJson } from "./strict-json";

export const EXTENSION_LIMITS = {
  packageBytes: 64 * 1_024,
  catalogBytes: 512 * 1_024,
  jsonDepth: 12,
  jsonNodes: 20_000,
  objectProperties: 32,
  catalogEntries: 128,
  catalogRevision: 999_999_999,
  versionCharacters: 64,
  cards: 4,
  blocksPerCard: 8,
  titleCharacters: 100,
  descriptionCharacters: 400,
  bodyCharacters: 2_000,
} as const;

export type LocalizedText = { "pt-BR": string; es?: string };

export type ExtensionConfiguration = {
  density: "comfortable" | "compact";
  show_description: boolean;
};

export type ExtensionManifest = {
  format_version: 1;
  profile: "declarative";
  publisher: string;
  name: string;
  version: string;
  license: "MIT";
  host_api: { min: number; max: number };
  permissions: ["navigation.tasks"];
  dependencies: [];
  data: { mode: "none" };
  display: {
    title: LocalizedText;
    summary: LocalizedText;
    category: "productivity" | "sales" | "service";
    icon: "ListChecks" | "BookOpen" | "Lightbulb";
  };
  configuration: ExtensionConfiguration;
  contributions: {
    crm_cards: Array<{
      id: string;
      title: LocalizedText;
      description: LocalizedText;
      icon: "ListChecks" | "BookOpen" | "Lightbulb";
      blocks: Array<{ heading: LocalizedText; body: LocalizedText }>;
      action: { label: LocalizedText; capability: "tasks.open" };
    }>;
  };
};

export type CatalogEntry = Pick<
  ExtensionManifest,
  "publisher" | "name" | "version" | "license" | "host_api" | "display" | "permissions"
> & { sha256: string; byte_length: number };

export type ExtensionCatalog = {
  format_version: 1;
  origin: string;
  revision: number;
  entries: CatalogEntry[];
};

export type CompatibilityReason =
  | "format_version_unsupported"
  | "profile_unsupported"
  | "host_api_unsupported"
  | "permission_unsupported"
  | "dependency_unsupported"
  | "capability_unsupported";

export interface CompatibilityResult {
  compatible: boolean;
  reason: CompatibilityReason | null;
}

type CompatibilitySubject = Pick<ExtensionManifest, "host_api" | "permissions"> &
  Partial<Pick<ExtensionManifest, "format_version" | "profile" | "dependencies" | "contributions">>;

const HOST_API_VERSION = 1;
const FORBIDDEN_SNAPSHOT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(2)
  .max(64);
const semverSchema = z
  .string()
  .max(EXTENSION_LIMITS.versionCharacters)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const iconSchema = z.enum(["ListChecks", "BookOpen", "Lightbulb"]);

function textSchema(maxCharacters: number) {
  return z.string().refine((text) => text.trim().length > 0 && [...text].length <= maxCharacters);
}

function localizedTextSchema(maxCharacters: number) {
  const text = textSchema(maxCharacters);
  return z.object({ "pt-BR": text, es: text.optional() }).strict();
}

const hostApiSchema = z
  .object({
    min: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    max: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(({ min, max }) => min <= max);

const displaySchema = z
  .object({
    title: localizedTextSchema(EXTENSION_LIMITS.titleCharacters),
    summary: localizedTextSchema(EXTENSION_LIMITS.descriptionCharacters),
    category: z.enum(["productivity", "sales", "service"]),
    icon: iconSchema,
  })
  .strict();

export const configurationSchema = z
  .object({
    density: z.enum(["comfortable", "compact"]),
    show_description: z.boolean(),
  })
  .strict();

const permissionsSchema = z.tuple([z.literal("navigation.tasks")]);
const dependenciesSchema: z.ZodType<[]> = z.tuple([]);

const manifestSchema: z.ZodType<ExtensionManifest> = z
  .object({
    format_version: z.literal(1),
    profile: z.literal("declarative"),
    publisher: slugSchema,
    name: slugSchema,
    version: semverSchema,
    license: z.literal("MIT"),
    host_api: hostApiSchema,
    permissions: permissionsSchema,
    dependencies: dependenciesSchema,
    data: z.object({ mode: z.literal("none") }).strict(),
    display: displaySchema,
    configuration: configurationSchema,
    contributions: z
      .object({
        crm_cards: z
          .array(
            z
              .object({
                // O id vai para a URL do guia (`?card=`) e para o data-testid: mesma forma de
                // slug do publicador e do nome, e não texto livre.
                id: slugSchema,
                title: localizedTextSchema(EXTENSION_LIMITS.titleCharacters),
                description: localizedTextSchema(EXTENSION_LIMITS.descriptionCharacters),
                icon: iconSchema,
                blocks: z
                  .array(
                    z
                      .object({
                        heading: localizedTextSchema(EXTENSION_LIMITS.titleCharacters),
                        body: localizedTextSchema(EXTENSION_LIMITS.bodyCharacters),
                      })
                      .strict(),
                  )
                  .max(EXTENSION_LIMITS.blocksPerCard),
                action: z
                  .object({
                    label: localizedTextSchema(EXTENSION_LIMITS.titleCharacters),
                    capability: z.literal("tasks.open"),
                  })
                  .strict(),
              })
              .strict(),
          )
          .max(EXTENSION_LIMITS.cards)
          // Dois cards com o mesmo id dariam dois links idênticos e um destino ambíguo.
          .superRefine((cards, ctx) => {
            if (new Set(cards.map((card) => card.id)).size !== cards.length) {
              ctx.addIssue({ code: "custom", message: "id de card repetido" });
            }
          }),
      })
      .strict(),
  })
  .strict();

function isExactOrigin(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

const catalogEntrySchema: z.ZodType<CatalogEntry> = z
  .object({
    publisher: slugSchema,
    name: slugSchema,
    version: semverSchema,
    license: z.literal("MIT"),
    host_api: hostApiSchema,
    display: displaySchema,
    permissions: permissionsSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byte_length: z.number().int().positive().max(EXTENSION_LIMITS.packageBytes),
  })
  .strict();

const catalogSchema: z.ZodType<ExtensionCatalog> = z
  .object({
    format_version: z.literal(1),
    origin: z.string().refine(isExactOrigin),
    revision: z.number().int().positive().max(EXTENSION_LIMITS.catalogRevision),
    entries: z.array(catalogEntrySchema).max(EXTENSION_LIMITS.catalogEntries),
  })
  .strict()
  .superRefine(({ entries }, context) => {
    const identities = new Set<string>();
    for (const entry of entries) {
      const identity = `${entry.publisher}\0${entry.name}\0${entry.version}`;
      if (identities.has(identity)) {
        context.addIssue({ code: "custom", message: "duplicate_catalog_identity" });
        return;
      }
      identities.add(identity);
    }
  });

function parseWithSchema<T>(bytes: Uint8Array, maxBytes: number, schema: z.ZodType<T>): T {
  const raw = parseStrictJson(bytes, {
    maxBytes,
    maxDepth: EXTENSION_LIMITS.jsonDepth,
    maxNodes: EXTENSION_LIMITS.jsonNodes,
    maxPropertiesPerObject: EXTENSION_LIMITS.objectProperties,
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ExtensionError("extension_invalid_package");
  return parsed.data;
}

function isJsonbSafeString(value: string) {
  if (value.includes("\0")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * JSONB já perdeu os bytes e a notação numérica do documento admitido. Esta validação
 * conserva os limites estruturais do parser externo sem fabricar um novo teto de transporte
 * a partir de `JSON.stringify`.
 */
function validateSnapshotStructure(root: unknown) {
  const pending: Array<{ value: unknown; containerDepth: number }> = [
    { value: root, containerDepth: 0 },
  ];
  const visited = new WeakSet<object>();
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const value = current.value;
    nodes += 1;
    if (nodes > EXTENSION_LIMITS.jsonNodes) {
      throw new ExtensionError("extension_payload_too_large");
    }

    if (value === null || typeof value === "boolean" || typeof value === "number") continue;
    if (typeof value === "string") {
      if (!isJsonbSafeString(value)) throw new ExtensionError("extension_invalid_package");
      continue;
    }
    if (typeof value !== "object" || visited.has(value)) {
      throw new ExtensionError("extension_invalid_package");
    }
    visited.add(value);

    const depth = current.containerDepth + 1;
    if (depth > EXTENSION_LIMITS.jsonDepth) {
      throw new ExtensionError("extension_payload_too_large");
    }
    if (Array.isArray(value)) {
      if (value.length > EXTENSION_LIMITS.jsonNodes - nodes) {
        throw new ExtensionError("extension_payload_too_large");
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: value[index], containerDepth: depth });
      }
      continue;
    }

    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new ExtensionError("extension_invalid_package");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > EXTENSION_LIMITS.objectProperties ||
      keys.some((key) => typeof key !== "string" || FORBIDDEN_SNAPSHOT_KEYS.has(key))
    ) {
      throw new ExtensionError(
        keys.length > EXTENSION_LIMITS.objectProperties
          ? "extension_payload_too_large"
          : "extension_invalid_package",
      );
    }
    nodes += keys.length;
    if (nodes > EXTENSION_LIMITS.jsonNodes) {
      throw new ExtensionError("extension_payload_too_large");
    }
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new ExtensionError("extension_invalid_package");
      }
      pending.push({ value: descriptor.value, containerDepth: depth });
    }
  }
}

export function parseManifest(bytes: Uint8Array): ExtensionManifest {
  return parseWithSchema(bytes, EXTENSION_LIMITS.packageBytes, manifestSchema);
}

export function parseCatalog(bytes: Uint8Array): ExtensionCatalog {
  return parseWithSchema(bytes, EXTENSION_LIMITS.catalogBytes, catalogSchema);
}

export function validateCatalogSnapshot(value: unknown): ExtensionCatalog {
  try {
    validateSnapshotStructure(value);
    const parsed = catalogSchema.safeParse(value);
    if (!parsed.success) throw new ExtensionError("extension_invalid_package");
    return parsed.data;
  } catch (error) {
    if (error instanceof ExtensionError) throw error;
    throw new ExtensionError("extension_invalid_package", { cause: error });
  }
}

export function checkCompatibility(subject: CompatibilitySubject): CompatibilityResult {
  if (subject.format_version !== undefined && subject.format_version !== 1) {
    return incompatible("format_version_unsupported");
  }
  if (subject.profile !== undefined && subject.profile !== "declarative") {
    return incompatible("profile_unsupported");
  }
  if (subject.host_api.min > HOST_API_VERSION || subject.host_api.max < HOST_API_VERSION) {
    return incompatible("host_api_unsupported");
  }
  if (subject.permissions.length !== 1 || subject.permissions[0] !== "navigation.tasks") {
    return incompatible("permission_unsupported");
  }
  if (subject.dependencies !== undefined && subject.dependencies.length !== 0) {
    return incompatible("dependency_unsupported");
  }
  if (subject.contributions?.crm_cards.some((card) => card.action.capability !== "tasks.open")) {
    return incompatible("capability_unsupported");
  }
  return { compatible: true, reason: null };
}

function incompatible(reason: CompatibilityReason): CompatibilityResult {
  return { compatible: false, reason };
}

export function localize(text: LocalizedText, locale: string): { text: string; fallback: boolean } {
  if (locale.toLowerCase().split("-")[0] === "es" && text.es !== undefined) {
    return { text: text.es, fallback: false };
  }
  return { text: text["pt-BR"], fallback: locale.toLowerCase() !== "pt-br" };
}

async function sha256(bytes: Uint8Array) {
  const stableBytes = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", stableBytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mirrorsCatalog(manifest: ExtensionManifest, entry: CatalogEntry) {
  return (
    manifest.publisher === entry.publisher &&
    manifest.name === entry.name &&
    manifest.version === entry.version &&
    manifest.license === entry.license &&
    manifest.host_api.min === entry.host_api.min &&
    manifest.host_api.max === entry.host_api.max &&
    manifest.permissions.length === entry.permissions.length &&
    manifest.permissions.every((permission, index) => permission === entry.permissions[index]) &&
    manifest.display.title["pt-BR"] === entry.display.title["pt-BR"] &&
    manifest.display.title.es === entry.display.title.es &&
    manifest.display.summary["pt-BR"] === entry.display.summary["pt-BR"] &&
    manifest.display.summary.es === entry.display.summary.es &&
    manifest.display.category === entry.display.category &&
    manifest.display.icon === entry.display.icon
  );
}

export async function validateArtifact(
  bytes: Uint8Array,
  entry: CatalogEntry,
): Promise<ExtensionManifest> {
  if (bytes.byteLength !== entry.byte_length || bytes.byteLength > EXTENSION_LIMITS.packageBytes) {
    throw new ExtensionError("extension_invalid_package");
  }
  if ((await sha256(bytes)) !== entry.sha256) {
    throw new ExtensionError("extension_digest_mismatch");
  }

  const manifest = parseManifest(bytes);
  if (!mirrorsCatalog(manifest, entry)) throw new ExtensionError("extension_invalid_package");
  if (!checkCompatibility(manifest).compatible) {
    throw new ExtensionError("extension_incompatible");
  }
  return manifest;
}
