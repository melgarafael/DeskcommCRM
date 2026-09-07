/** Identidade capturada na origem do trabalho; nunca recompor com o estado atual. */
export interface ServiceBoundary {
  organization_id: string;
  contact_id: string;
  conversation_id: string;
  service_revision: number;
  demanda_id: string | null;
  demanda_revision: number | null;
}
export interface CurrentServiceBoundary extends ServiceBoundary {
  status: string;
  demanda_fechada_em: string | null;
}
export class StaleServiceBoundaryError extends Error {
  constructor() {
    super("service_boundary_stale");
    this.name = "StaleServiceBoundaryError";
  }
}
export function assertCurrentServiceBoundary(
  expected: ServiceBoundary | null,
  current: CurrentServiceBoundary | null,
): void {
  if (
    !expected ||
    !current ||
    (expected.demanda_id !== null && !Number.isSafeInteger(expected.demanda_revision)) ||
    (current.demanda_id !== null && !Number.isSafeInteger(current.demanda_revision)) ||
    ["closed", "resolved", "archived"].includes(current.status) ||
    current.demanda_fechada_em ||
    expected.organization_id !== current.organization_id ||
    expected.contact_id !== current.contact_id ||
    expected.conversation_id !== current.conversation_id ||
    expected.service_revision !== current.service_revision ||
    expected.demanda_id !== current.demanda_id ||
    expected.demanda_revision !== current.demanda_revision
  ) {
    throw new StaleServiceBoundaryError();
  }
}
export function parseServiceBoundary(value: unknown): ServiceBoundary | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  if (
    typeof b.organization_id !== "string" ||
    typeof b.contact_id !== "string" ||
    typeof b.conversation_id !== "string" ||
    !Number.isSafeInteger(b.service_revision) ||
    Number(b.service_revision) < 1 ||
    !(b.demanda_id === null || typeof b.demanda_id === "string") ||
    !(b.demanda_revision === null || Number.isSafeInteger(b.demanda_revision))
  )
    return null;
  return b as unknown as ServiceBoundary;
}
