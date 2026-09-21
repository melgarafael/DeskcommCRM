import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { readSocialIntegration } from "./store";
import { listSocialAccounts, socialRequest, SocialError } from "./client";
const insightsSchema = z.object({
  success: z.literal(true),
  accountId: z.string(),
  dateRange: z.object({ since: z.string(), until: z.string() }),
  metrics: z.record(z.string(), z.object({ total: z.number().finite().nonnegative() })),
  unavailableMetrics: z.array(z.unknown()).optional(),
});
export async function instagramInsights(org: string, accountId?: string) {
  const config = await readSocialIntegration(createAdminClient(), org);
  if (!config) return { connected: false as const, accounts: [] };
  const accounts = (await listSocialAccounts(config.key, config.profileId))
    .filter((a) => a.platform === "instagram" && a.isActive)
    .map((a) => ({ id: a._id, name: a.username || a.displayName || "Instagram" }));
  if (!accounts.length) return { connected: false as const, accounts };
  if (!accountId) return { connected: true as const, accounts };
  if (!accounts.some((a) => a.id === accountId))
    throw new SocialError("Conta não encontrada nesta organização.", 404);
  const until = new Date();
  const since = new Date(until.getTime() - 30 * 86400_000);
  const query = new URLSearchParams({
    accountId,
    since: since.toISOString().slice(0, 10),
    until: until.toISOString().slice(0, 10),
    metricType: "total_value",
    metrics: "reach,views,accounts_engaged,total_interactions",
  });
  const result = insightsSchema.parse(
    await socialRequest(config.key, `analytics/instagram/account-insights?${query}`),
  );
  if (result.accountId !== accountId)
    throw new SocialError("A resposta de resultados não corresponde à conta selecionada.");
  return {
    connected: true as const,
    accounts,
    insights: result,
    checked_at: new Date().toISOString(),
  };
}
