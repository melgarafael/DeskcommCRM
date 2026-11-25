/**
 * Quantas mensagens a EMPRESA já mandou nesta conversa desde a última do cliente.
 *
 * É a leitura que o envio da equipe (`sendMessageHandler`) faz para aplicar o limite
 * da rede (`limites-da-rede.ts`). A cadeia da IA lê o mesmo número pelo `pg`, sob o
 * lock do número (`agent/limite-da-rede.ts`); aqui o cliente é o do Supabase, porque
 * é por ele que a porta de saída de todos os chamadores conversa.
 *
 * Mesma régua nos dois lados, e agora por construção: os dois chamam a função SQL
 * `fn_respostas_na_janela` (saída, sem as `failed`, `coalesce(sent_at, created_at)`).
 *
 * Fail-open com registro de quem chama: `null` = a leitura falhou, e o envio segue —
 * o pior que acontece é a rede recusar com o erro dela, a recusa que sempre existiu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function contarRespostasNaJanela(
  supabase: SupabaseClient,
  input: { organizationId: string; conversationId: string; desde: Date },
): Promise<number | null> {
  const { data, error } = await supabase.rpc("fn_respostas_na_janela", {
    p_org: input.organizationId,
    p_conversation: input.conversationId,
    p_desde: input.desde.toISOString(),
  });
  if (error || typeof data !== "number") return null;
  return data;
}
