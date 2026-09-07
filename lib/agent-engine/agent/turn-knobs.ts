import type { Env } from '../env';
import type { InboundTurnKnobs } from './inbound-turn';
/** Shared env projection for worker and in-process preview. */
export function turnKnobsFromEnv(env: Env): InboundTurnKnobs {
  return {
    historyLimit: env.LEAD_CONTEXT_HISTORY_LIMIT,
    maxContextTokens: env.LEAD_CONTEXT_MAX_TOKENS,
    notesIndexMaxTokens: env.LEAD_NOTES_INDEX_MAX_TOKENS,
    maxSteps: env.AGENT_MAX_STEPS,
    maxSendsPerTurn: env.MAX_SENDS_PER_TURN,
    queuedRetryDelayMs: env.SEND_QUEUED_RETRY_MS,
    breaker: {
      exactFailureWarn: env.TOOL_BREAKER_EXACT_WARN,
      exactFailureBlock: env.TOOL_BREAKER_EXACT_BLOCK,
      sameToolFailureWarn: env.TOOL_BREAKER_SAME_TOOL_WARN,
      sameToolFailureHalt: env.TOOL_BREAKER_SAME_TOOL_HALT,
      noProgressWarn: env.TOOL_BREAKER_NO_PROGRESS_WARN,
      noProgressBlock: env.TOOL_BREAKER_NO_PROGRESS_BLOCK,
    },
    followup: {
      minAheadMs: env.FOLLOWUP_MIN_AHEAD_MS,
      maxAheadMs: env.FOLLOWUP_MAX_AHEAD_MS,
      staggerWindowMs: env.CRON_STAGGER_WINDOW_MS,
    },
    compaction: {
      triggerMessages: env.COMPACTION_TRIGGER_MESSAGES,
      ...(env.COMPACTION_MODEL !== undefined ? { model: env.COMPACTION_MODEL } : {}),
      transcriptMaxTokens: env.COMPACTION_TRANSCRIPT_MAX_TOKENS,
    },
    prune: {
      windowTurns: env.PRUNE_TOOL_RESULTS_WINDOW_TURNS,
      minResultTokens: env.PRUNE_TOOL_RESULTS_MIN_RESULT_TOKENS,
    },
    goldenCandidatesDir: env.GOLDEN_CANDIDATES_DIR,
    stageClassifier: {
      ...(env.STAGE_CLASSIFIER_MODEL !== undefined ? { model: env.STAGE_CLASSIFIER_MODEL } : {}),
    },
    jailbreak: {
      ...(env.JAILBREAK_CLASSIFIER_MODEL !== undefined
        ? { model: env.JAILBREAK_CLASSIFIER_MODEL }
        : {}),
    },
    disclosureMode: env.DISCLOSURE_MODE,
    promiseSemantic: {
      enabled: env.PROMISE_SEMANTIC_ENABLED,
      ...(env.PROMISE_SEMANTIC_MODEL !== undefined ? { model: env.PROMISE_SEMANTIC_MODEL } : {}),
    },
    followupAi: {
      ...(env.FOLLOWUP_AI_MODEL !== undefined ? { model: env.FOLLOWUP_AI_MODEL } : {}),
    },
    allowlistTtlMs: env.AI_ALLOWLIST_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}
