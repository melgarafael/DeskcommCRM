/**
 * "ESTA ORG TEM ATENDIMENTO AUTOMÁTICO DE PÉ?" — uma pergunta, um lugar.
 *
 * O fato é ORG-WIDE. Desde a #4012 o banco também o responde
 * (`fn_org_tem_automatico`, espelho SQL de `agenteAtende`, migration 9330), porque
 * as funções do banco que decidem pelo comando precisam dele. Aqui ele segue
 * servindo o servidor: a aba Fila escolhe o CONJUNTO de comandos que pede
 * (`comandosDaFila`) e a contagem da aba Automático. As duas réguas são casadas por
 * `tests/invariants/comando-da-conversa-com-agente-no-ar.test.ts`.
 *
 * Já havia dois consumidores no primeiro dia (`/api/v1/conversations/counts` e
 * `lib/routing/queue.ts`), e é por isso que isto nasce como função e não como
 * três linhas coladas em cada rota.
 *
 * **Devolve `undefined` quando não deu para saber**, nunca `false`: dizer "esta
 * org não tem automático" por causa de um erro de leitura faria a Fila incluir
 * tudo que o robô atende — a mentira original, ao contrário. `comandosDaFila`
 * trata `undefined` como "assume que há", a mesma convenção da regra.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { agenteAtende } from "@/lib/ai/agents/no-ar";

export async function orgTemAutomatico(
  supabase: Pick<SupabaseClient, "from">,
  organizationId: string,
): Promise<boolean | undefined> {
  // As mesmas quatro colunas de `/api/v1/ai/automatico-ativo` — a régua olha
  // linha a linha, e uma contagem no banco não sabe respondê-la sem duplicar
  // `agenteAtende` em SQL, que é como ela se desencontrou da primeira vez.
  const { data, error } = await supabase
    .from("ai_agents")
    .select("kind, is_active, paused_at, published_version_id, archived_at")
    .eq("organization_id", organizationId)
    .is("archived_at", null);

  if (error) return undefined;
  return (data ?? []).some(agenteAtende);
}
