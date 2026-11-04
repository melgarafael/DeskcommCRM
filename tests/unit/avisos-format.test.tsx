import { test, expect } from "vitest";
import { formatDerivedNotice } from "@/lib/realtime/derived-notice";
const notice = (kind: any, snapshot: Record<string, unknown>) => ({
  kind,
  snapshot,
  id: "00000000-0000-4000-8000-000000000001",
  revision: "a".repeat(64),
  organization_id: "00000000-0000-4000-8000-000000000002",
  created_at: "2026-11-01T00:00:00Z",
});
test("formats the four retained snapshots without relabelling business rules", () => {
  expect(
    formatDerivedNotice(notice("channel_unavailable", { status: "ban_suspected", status_reason: null }))
      .message,
  ).toBe("Conexão com suspeita de bloqueio");
  expect(
    formatDerivedNotice(notice("lgpd_at_risk", { due_at: "2026-11-03T00:00:00Z", overdue: false }))
      .message,
  ).toContain("03/11/2026");
  expect(formatDerivedNotice(notice("ai_budget", { percent: 80, mode: "avisar" })).message).toBe(
    "Budget IA 80% do teto (gasto acumulado)",
  );
  expect(formatDerivedNotice(notice("tenant_pending_overflow", { count: 51 })).message).toBe(
    "51 conversas pendentes sem atendimento",
  );
});
test("rejects canonical FAILED and values outside retained notice thresholds", () => {
  for (const x of [
    notice("channel_unavailable", { status: "FAILED", status_reason: null }),
    notice("ai_budget", { percent: 79, mode: "avisar" }),
    notice("tenant_pending_overflow", { count: 50 }),
  ])
    expect(() => formatDerivedNotice(x)).toThrow();
});
