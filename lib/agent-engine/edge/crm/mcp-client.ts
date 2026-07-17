/**
 * Config da borda CRM pós-fusão. O transporte MCP HTTP do Vendaval MORREU: o CRM
 * é o mesmo processo/banco agora. O que resta desta borda:
 *   - o client admin do Supabase (service role) que os handlers do app exigem
 *     (ex.: sendMessageHandler) — ele BYPASSA RLS, então todo uso filtra
 *     organization_id manualmente, de fonte confiável (regra dura nº 1);
 *   - CrmTransportError: o erro que o runtime trata como TRANSIENTE (Supabase/
 *     WAHA indisponível) — o job re-tenta pela fila, nunca vira mensagem ao lead.
 *
 * O arquivo mantém o nome mcp-client.ts porque é o seam que todos os módulos do
 * engine já importam (CrmEdgeConfig) — o conteúdo é a versão fundida.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface CrmEdgeConfig {
  /** admin client (service role) — usado só pelas bordas que chamam handlers do app. */
  supabase: SupabaseClient;
}

/** Falha de transporte da borda (Supabase/WAHA fora) — transiente, o job re-tenta. */
export class CrmTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrmTransportError';
  }
}

export function crmEdgeConfigFromEnv(env: {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}): CrmEdgeConfig {
  return {
    supabase: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
}
