/** Accounting evidence deliberately excludes prompts, answers, headers and credentials. */
export interface UsageEvidence {
  version: 1;
  steps: Array<{
    responseId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    serviceTier: string | null;
  }>;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function identifier(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(value) ? value : null;
}
/** Incomplete measurements stay incomplete, but known step IDs remain available for review. */
export function usageEvidence(result: unknown): UsageEvidence {
  const root = record(result);
  const steps = Array.isArray(root?.steps) ? root.steps : root ? [root] : [];
  return {
    version: 1,
    steps: steps.map((value) => {
      const step = record(value);
      const usage = record(step?.usage);
      const details = record(usage?.inputTokenDetails);
      const response = record(step?.response);
      const openai = record(record(step?.providerMetadata)?.openai);
      return {
        responseId: identifier(response?.id),
        inputTokens: count(usage?.inputTokens),
        outputTokens: count(usage?.outputTokens),
        cacheReadTokens: count(details?.cacheReadTokens),
        cacheWriteTokens: count(details?.cacheWriteTokens),
        serviceTier: identifier(openai?.serviceTier),
      };
    }),
  };
}
