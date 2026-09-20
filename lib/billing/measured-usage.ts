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

interface GenerationStep {
  usage?: MeasuredTextUsage | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
}

export interface MeasuredGeneration {
  steps: { usage: TokenUsage; serviceTier?: string | undefined }[];
}

/** Preserve request boundaries and returned pricing metadata after validation. */
export function measuredGeneration(
  result: GenerationStep & {
    steps?: readonly GenerationStep[] | undefined;
  },
): MeasuredGeneration | null {
  if (measuredGenerationUsage(result) === null) return null;
  const steps = result.steps ?? [result];
  return {
    steps: steps.map((step) => {
      const metadata = step.providerMetadata?.openai;
      const serviceTier =
        metadata &&
        typeof metadata === "object" &&
        "serviceTier" in metadata &&
        typeof metadata.serviceTier === "string"
          ? metadata.serviceTier
          : undefined;
      return { usage: measuredTextUsage(step.usage)!, serviceTier };
    }),
  };
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
