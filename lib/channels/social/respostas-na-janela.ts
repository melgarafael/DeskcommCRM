/**
 * Quantas mensagens a EMPRESA já mandou nesta conversa desde a última do cliente.
 *
 * É a leitura que o envio da equipe (`sendMessageHandler`) faz para aplicar o limite
 * da rede (`limites-da-rede.ts`). A cadeia da IA lê o mesmo número pelo `pg`, sob o
 * lock do número (`agent/limite-da-rede.ts`); aqui o cliente é o do Supabase, porque
 * é por ele que a porta de saída de todos os chamadores conversa.
 *
 * Mesma régua nos dois lados: saída (`outbound`), sem as que falharam (não chegaram
 * ao cliente e não gastam o limite), e `coalesce(sent_at, created_at) >= last_inbound_at`.
 *
 * Fail-open com registro de quem chama: `null` = a leitura falhou, e o envio segue —
 * o pior que acontece é a rede recusar com o erro dela, a recusa que sempre existiu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function contarRespostasNaJanela(
  supabase: SupabaseClient,
  input: { organizationId: string; conversationId: string; desde: Date },
): Promise<number | null> {
  const desde = input.desde.toISOString();
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", input.organizationId)
    .eq("conversation_id", input.conversationId)
    .eq("direction", "outbound")
    .neq("status", "failed")
    // `coalesce(sent_at, created_at) >= desde`: o que está na fila (`sent_at` nulo)
    // também vai sair e gasta o limite.
    .or(`sent_at.gte.${desde},and(sent_at.is.null,created_at.gte.${desde})`);
  if (error || count === null) return null;
  return count;
}
