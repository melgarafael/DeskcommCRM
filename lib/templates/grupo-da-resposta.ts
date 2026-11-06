/**
 * O grupo que a resposta rápida vai receber é DA ORGANIZAÇÃO ATIVA? (#3245)
 *
 * ─── Por que a rota confere, se o banco também confere ──────────────────────
 *
 * A FK composta `(organization_id, grupo_id)` (migration 0808) recusa o par que
 * não existe, mas o erro dela chega como 23503 — "violação de chave
 * estrangeira" —, que a tela não consegue transformar numa frase útil. Pior: o
 * corpo forjado com o id de um grupo de OUTRA organização seria recusado pela
 * FK só DEPOIS de o INSERT já ter sido tentado, e a mensagem não diria qual
 * campo está errado.
 *
 * Esta conferência lê a lista VISÍVEL (RLS `message_template_groups_select` +
 * `.eq("organization_id", org.orgId)`), a mesma que a tela mostra: é a régua de
 * posse de `[id]/midias` e de `[id]/ordem`. `null` é sempre válido — é
 * "sem grupo", o estado de toda resposta anterior à 0808.
 *
 * ─── E o vínculo antigo que a lista não mostra mais? ───────────────────────
 *
 * O PATCH só confere o que VEM no corpo. Um `grupo_id` que já está na linha e
 * não vem no pedido não é tocado — a resposta continua vinculada até alguém
 * desvincular ou até o grupo ser apagado (`on delete set null` no banco).
 */
import type { createClient } from "@/lib/supabase/server";

/** `true` quando o grupo existe na organização ativa (ou quando não há grupo). */
export async function grupoDaOrganizacao(
  db: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  grupoId: string | null | undefined,
): Promise<boolean> {
  if (grupoId === null || grupoId === undefined) return true;
  const { data, error } = await db
    .from("message_template_groups")
    .select("id")
    .eq("id", grupoId)
    .eq("organization_id", orgId)
    .maybeSingle();
  // Falha de leitura não vira "inválido": quem decide é quem chamou, e um 422
  // por erro de infraestrutura mandaria a pessoa "consertar" um dado correto.
  if (error) throw new Error("Erro ao conferir o grupo da resposta rápida.");
  return data !== null;
}
