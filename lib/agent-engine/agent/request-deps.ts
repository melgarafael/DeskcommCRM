import { previewFixtureRegistry } from './preview-fixture';
import { loadEnv } from '../env';
import { crmEdgeConfigFromEnv } from '../edge/crm/mcp-client';
import { llmEdgeConfigFromEnv } from '../edge/llm/run-model-call';
import { createLogger } from '../obs/logger';
import { turnKnobsFromEnv } from './turn-knobs';
import type { InboundTurnDeps } from './inbound-turn';
export function requestTurnDeps(): InboundTurnDeps {
  const env = loadEnv();
  const fixture = process.env.INTERNAL_AGENT_RUN_STUB === 'true';
  const llmCfg = llmEdgeConfigFromEnv(env);
  if (fixture) llmCfg.anthropicApiKey = 'local-controlled-provider';
  return {
    ...(fixture
      ? {
          registry: previewFixtureRegistry(),
          embed: async () => ({
            embedding: Array(1536).fill(0.1),
            promptTokens: 0,
            model: 'text-embedding-3-small',
          }),
        }
      : {}),
    crmCfg: crmEdgeConfigFromEnv({
      SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    }),
    llmCfg,
    knobs: turnKnobsFromEnv(env),
    log: createLogger(),
  };
}
