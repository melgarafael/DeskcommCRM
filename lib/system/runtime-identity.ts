import { z } from "zod";

/** Three missed five-minute heartbeats invalidate an observation. */
export const RUNTIME_MAX_AGE_MS = 15 * 60_000;
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const release = z.string().regex(/^v?\d+\.\d+\.\d+$/);

export const runtimeConfirmationSchema = z.object({
  schema: z.literal(1),
  collected_at: z.string().datetime(),
  project: z.string().min(1).max(128),
  supports_forced_update: z.boolean().optional(),
  published_release: release.nullable().optional(),
  services: z
    .array(
      z.object({
        role: z.enum(["app", "worker", "scheduler", "voice-agent"]),
        container_id: sha.nullable(),
        image_id: imageId.nullable(),
        revision: sha.nullable(),
        base_version: release.nullable(),
        base_revision: sha.nullable(),
        source_verified: z.boolean(),
        running: z.boolean(),
        healthy: z.boolean(),
      }),
    )
    .min(3)
    .max(4),
  issues: z
    .array(z.enum(["collection_failed", "changed_during_collection", "release_refs_unavailable"]))
    .max(3),
});

export type RuntimeConfirmation = z.infer<typeof runtimeConfirmationSchema>;
export type RuntimeIdentity = {
  status: "legacy" | "unknown" | "partial" | "divergent" | "stale" | "confirmed";
  base_version: string | null;
  revision: string | null;
  customized: boolean | null;
  confirmed_at: string | null;
};

/** The authenticated host reports observations; the server derives the verdict. */
export function runtimeIdentity(
  raw: unknown,
  receivedAt: string | null | undefined,
  now = new Date(),
): RuntimeIdentity {
  const empty: RuntimeIdentity = {
    status: raw == null ? "legacy" : "unknown",
    base_version: null,
    revision: null,
    customized: null,
    confirmed_at: null,
  };
  if (raw == null) return empty;
  const parsed = runtimeConfirmationSchema.safeParse(raw);
  if (!parsed.success) return empty;
  const snapshot = parsed.data;
  const roles = snapshot.services.map((s) => s.role);
  if (
    new Set(snapshot.services.map((s) => s.container_id).filter(Boolean)).size !==
    snapshot.services.filter((s) => s.container_id).length
  )
    return empty;
  if (
    new Set(roles).size !== roles.length ||
    !["app", "worker", "scheduler"].every((r) => roles.includes(r as (typeof roles)[number]))
  )
    return empty;
  const complete =
    snapshot.issues.length === 0 &&
    snapshot.services.every(
      (s) =>
        s.source_verified &&
        s.container_id &&
        s.image_id &&
        s.revision &&
        s.base_version &&
        s.base_revision &&
        s.running &&
        s.healthy,
    );
  if (!complete) return { ...empty, status: "partial" };
  const first = snapshot.services[0];
  if (!first) return empty;
  if (
    snapshot.services.some(
      (s) =>
        s.revision !== first.revision ||
        s.base_revision !== first.base_revision ||
        s.base_version?.replace(/^v/, "") !== first.base_version?.replace(/^v/, ""),
    )
  )
    return { ...empty, status: "divergent" };
  const observed = Date.parse(snapshot.collected_at);
  const received = Date.parse(receivedAt ?? "");
  const fresh =
    Number.isFinite(received) &&
    observed <= received + 60_000 &&
    received - observed <= RUNTIME_MAX_AGE_MS &&
    now.getTime() >= observed - 60_000 &&
    now.getTime() - observed <= RUNTIME_MAX_AGE_MS &&
    now.getTime() - received <= RUNTIME_MAX_AGE_MS;
  return {
    status: fresh ? "confirmed" : "stale",
    base_version: first.base_version!.replace(/^v/, ""),
    revision: first.revision,
    customized: first.revision !== first.base_revision,
    confirmed_at: snapshot.collected_at,
  };
}

/** A completed run names an intention. Only a later, complete observation can supersede a failure. */
export function failureSupersededByRuntime(
  identity: RuntimeIdentity,
  run:
    | {
        status?: string | null;
        finished_at?: string | null;
        from_version?: string | null;
        to_version?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (
    !run ||
    !["failed", "failed_rolled_back"].includes(run.status ?? "") ||
    identity.status !== "confirmed"
  )
    return false;
  if (!run.to_version) return false;
  const finished = Date.parse(run.finished_at ?? "");
  if (!Number.isFinite(finished) || Date.parse(identity.confirmed_at ?? "") <= finished)
    return false;
  // A healthy reinstallation of the failed target is legitimate. A confirmed
  // rollback to from_version remains a rollback and keeps its explanation.
  return (
    identity.base_version === (run.to_version ?? "").replace(/^v/, "") ||
    Boolean(run.from_version && identity.base_version !== run.from_version.replace(/^v/, ""))
  );
}

/** Published release comparison, independent of the checkout used by cron. */
export function newerOfficialRelease(installed: string, latest: string): boolean | null {
  if (!release.safeParse(installed).success || !release.safeParse(latest).success) return null;
  const a = installed.replace(/^v/, "").split(".").map(BigInt);
  const b = latest.replace(/^v/, "").split(".").map(BigInt);
  for (const [index, value] of a.entries()) {
    const other = b[index];
    if (other === undefined) return null;
    if (value !== other) return other > value;
  }
  return false;
}

/** A capacidade vem do agente em execução e só vale com identidade oficial recente. */
export function supportsForcedUpdate(
  raw: unknown,
  receivedAt: string | null | undefined,
  now = new Date(),
): boolean {
  const snapshot = runtimeConfirmationSchema.safeParse(raw);
  const identity = runtimeIdentity(raw, receivedAt, now);
  return (
    snapshot.success &&
    snapshot.data.supports_forced_update === true &&
    identity.status === "confirmed" &&
    identity.customized === false
  );
}
