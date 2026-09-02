/**
 * StepResult → tool_calls jsonb serializer for ai_agent_runs (S-13.08).
 *
 * Stores a slim trace renderable by the agent test UI. Args are redacted using
 * the same allowlist as `lib/mcp/audit.ts`; long strings are truncated.
 */

const REDACT_KEYS = new Set([
  "authorization",
  "api_key",
  "token",
  "password",
  "nuit",
]);

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[redacted]" : redactValue(v);
    }
    return out;
  }
  return value;
}

interface MinimalStep {
  stepNumber?: number;
  text?: string;
  finishReason?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  toolCalls?: Array<{ toolName?: string; input?: unknown }>;
  toolResults?: Array<{ toolName?: string; output?: unknown; result?: unknown }>;
}

export interface SerializedStep {
  step: number;
  text?: string;
  finish_reason?: string;
  tokens_in?: number;
  tokens_out?: number;
  tool_calls: Array<{
    tool_name: string;
    args: unknown;
    result?: unknown;
  }>;
}

export function serializeSteps(steps: ReadonlyArray<MinimalStep>): SerializedStep[] {
  return steps.map((step, idx) => {
    const calls = step.toolCalls ?? [];
    const results = step.toolResults ?? [];
    const toolEntries = calls.map((call, i) => {
      const match = results[i];
      const result = match?.output ?? match?.result;
      return {
        tool_name: String(call.toolName ?? "unknown"),
        args: redactValue(call.input ?? {}),
        result: result === undefined ? undefined : redactValue(result),
      };
    });
    return {
      step: step.stepNumber ?? idx,
      text: step.text && step.text.length > 0 ? step.text.slice(0, 4000) : undefined,
      finish_reason:
        typeof step.finishReason === "string" ? step.finishReason : undefined,
      tokens_in: step.usage?.inputTokens,
      tokens_out: step.usage?.outputTokens,
      tool_calls: toolEntries,
    };
  });
}
