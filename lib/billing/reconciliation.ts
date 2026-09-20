import { z } from "zod";
import type { UsageEvidence } from "./usage-evidence";
export const reconciliationSchema = z
  .object({
    reservation_id: z.string().uuid(),
    cost_usd_cents: z.number().finite().nonnegative(),
    reference: z.string().trim().min(10).max(1000),
    verified: z.literal(true),
  })
  .strict();
export interface PendingAiUsage {
  id: string;
  organization_id: string;
  company: string;
  provider: string | null;
  model: string | null;
  created_at: string;
  reserved_brl_cents: string;
  usd_to_brl_rate: string;
  period_start: string;
  period_end: string;
  usage_evidence: UsageEvidence | null;
}
export interface ReconciliationList {
  items: PendingAiUsage[];
  next_cursor: string | null;
  can_resolve: boolean;
}
