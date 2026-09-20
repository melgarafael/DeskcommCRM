import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { meteredUsageCostCents } from "@/lib/agent-engine/edge/llm/catalog-pricing";
import type { MeasuredGeneration } from "./measured-usage";
import type { TokenUsage } from "@/lib/agent-engine/edge/llm/pricing";
import { logger } from "@/lib/logger";
import { reserveSubscriptionAi, settleSubscriptionAi } from "./ai-allowance";

export { measuredTextUsage, measuredGenerationUsage, measuredGeneration } from "./measured-usage";

/** Direct SDK callers use the same reservations as the shared model-call engine. */
export async function runMeteredOperation<T>(
  identity: { organizationId: string; provider: string; model: string },
  operation: () => Promise<T>,
  measuredUsage: (result: T) => TokenUsage | MeasuredGeneration | null,
): Promise<T> {
  const db = getRequestPool();
  const reservation = await reserveSubscriptionAi(db, identity.organizationId);
  if (!reservation) return operation();
  const settle = async (cost: number | null) => {
    try {
      await settleSubscriptionAi(db, identity.organizationId, reservation, cost);
    } catch {
      // The held credit survives. Do not discard an answer or hide the original provider failure.
      logger.error("ai-allowance: reconciliation pending", {
        organization_id: identity.organizationId,
        reservation_id: reservation,
      });
    }
  };
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await settle(null);
    throw error;
  }
  let cost: number | null = null;
  try {
    const usage = measuredUsage(result);
    if (usage) cost = await meteredUsageCostCents(db, identity.provider, identity.model, usage);
  } catch {
    logger.error("ai-allowance: usage could not be measured", {
      organization_id: identity.organizationId,
      reservation_id: reservation,
    });
  }
  await settle(cost);
  return result;
}
