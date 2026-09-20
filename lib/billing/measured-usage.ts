import type { TokenUsage } from "@/lib/agent-engine/edge/llm/pricing";

interface MeasuredTextUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?:
    | {
        cacheReadTokens?: number | undefined;
        cacheWriteTokens?: number | undefined;
      }
    | undefined;
}

/** Missing measurements are unknown; an explicitly measured zero is valid. */
export function measuredTextUsage(usage: MeasuredTextUsage | undefined): TokenUsage | null {
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return null;
  const measured = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
  if (Object.values(measured).some((value) => !Number.isFinite(value) || value < 0)) return null;
  if (measured.cacheReadTokens + measured.cacheWriteTokens > measured.inputTokens) return null;
  return measured;
}

/** SDK totals can omit an unmeasured step. Validate every step before charging. */
export function measuredGenerationUsage(result: {
  usage?: MeasuredTextUsage | undefined;
  steps?: readonly { usage?: MeasuredTextUsage | undefined }[] | undefined;
}): TokenUsage | null {
  if (!result.steps) return measuredTextUsage(result.usage);
  if (result.steps.length === 0) return null;
  const total: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const step of result.steps) {
    const usage = measuredTextUsage(step.usage);
    if (!usage) return null;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
  }
  return Object.values(total).every(Number.isFinite) ? total : null;
}
