import type { SupabaseClient } from "@supabase/supabase-js";

import type { Role } from "@/lib/auth/types";

/**
 * O contexto do assistente interno — QUEM pede, DE QUAL organização.
 *
 * Diferente do turno do WhatsApp (ator = agente com token efêmero), aqui o
 * ator é a PESSOA logada (cookie validado pela rota). O papel dela vale:
 * um viewer conversa e consulta, mas não propõe escrita — o gate é o mesmo
 * `requireRole` das rotas, aplicado na `/executar` e repetido nos executores.
 *
 * Os dois clients espelham as rotas: `supabase` (sessão do usuário, RLS vale)
 * para leitura e `admin` (service role) onde o serviço precisa — com
 * `organization_id` explícito em TODA query, sem exceção.
 */
export interface AssistenteCtx {
  organizationId: string;
  userId: string;
  role: Role;
  requestId: string;
  supabase: SupabaseClient;
  admin: SupabaseClient;
}

/** Moeda em centavos → "R$ 1.234,56". Uma regra só, ou cada tool formata de um jeito. */
export function reais(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
