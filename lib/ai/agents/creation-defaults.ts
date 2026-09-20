import type pg from "pg";
import type { Provider } from "@/hooks/ai/useCredentials";
import { escolherModeloDoProvedor } from "./escolher-modelo";
import { AgentSetupError, resolveSetupModel } from "@/lib/prospecting/agent-setup";

/** Public configuration only. The platform key never crosses the server boundary. */
export interface AgentCreationDefaults {
  provider: Provider;
  model: string;
  credential_id: string | null;
}

/** New agents inherit managed AI; existing versions are never rewritten. */
export async function resolveAgentCreationDefaults(
  db: pg.PoolClient,
  orgId: string,
  platformProviders: readonly string[],
): Promise<AgentCreationDefaults | null> {
  for (const provider of platformProviders) {
    const models = await db.query(
      `select model_id,is_default_for_provider,supports_tools,
       input_price_per_million_cents,output_price_per_million_cents
       from ai_models where provider=$1 and deprecated_at is null`,
      [provider],
    );
    const choice = escolherModeloDoProvedor(models.rows);
    if (choice.escolhido)
      return { provider: provider as Provider, model: choice.modelId, credential_id: null };
  }
  try {
    const choice = await resolveSetupModel(db, orgId);
    return {
      provider: choice.provider as Provider,
      model: choice.model,
      credential_id: choice.credential_id,
    };
  } catch (error) {
    if (error instanceof AgentSetupError) return null;
    throw error;
  }
}
