import type { RuntimeConfirmation } from "@/lib/system/runtime-identity";

export function confirmedRuntime(
  version = "1.89.0",
  collectedAt = new Date().toISOString(),
  customized = false,
): RuntimeConfirmation {
  return {
    schema: 1,
    collected_at: collectedAt,
    project: "example-crm",
    issues: [],
    services: (["app", "worker", "scheduler"] as const).map((role, index) => ({
      role,
      container_id: String(index + 1).repeat(64),
      image_id: `sha256:${String(index + 4).repeat(64)}`,
      revision: "a".repeat(40),
      base_revision: (customized ? "b" : "a").repeat(40),
      base_version: version,
      source_verified: true,
      running: true,
      healthy: true,
    })),
  };
}
