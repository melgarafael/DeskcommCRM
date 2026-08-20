export type HealthCheckStatus = "ok" | "degraded" | "down";

export type HealthCheck = {
  status: HealthCheckStatus;
};

export type HealthOverallStatus = "healthy" | "degraded" | "unhealthy";

/**
 * Endereços usados como placeholders pelo setup/local dev não representam uma
 * falha de um serviço opcional. Eles devem aparecer como "degraded" para que
 * o endpoint de liveness público não devolva 503 antes de Redis/WAHA serem
 * contratados/configurados.
 */
export function isOptionalEndpointUnconfigured(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized || normalized.includes("placeholder")) return true;

  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/.test(normalized);
}

export function overallHealth(checks: readonly HealthCheck[]): {
  status: HealthOverallStatus;
  httpStatus: 200 | 503;
} {
  const anyDown = checks.some((check) => check.status === "down");
  const anyDegraded = checks.some((check) => check.status === "degraded");
  const status: HealthOverallStatus = anyDown
    ? "unhealthy"
    : anyDegraded
      ? "degraded"
      : "healthy";

  return { status, httpStatus: status === "unhealthy" ? 503 : 200 };
}
