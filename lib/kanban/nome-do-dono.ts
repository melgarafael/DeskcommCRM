/**
 * O NOME do responsável humano no card do funil — por QUADRO, nunca por card.
 *
 * O nome mora em `auth.users.raw_user_meta_data->>'full_name'`, fora do alcance
 * do client do request. `fn_nomes_dos_membros` (migration 9314) já o entrega
 * numa consulta só, para uma lista de ids, e só para quem tem ou teve vínculo
 * com a organização pedida — é a mesma porta de `lib/users/nome-do-atendente.ts`,
 * reaproveitada aqui em vez de uma segunda regra sobre o nome de uma pessoa.
 *
 * Custo por carga do quadro: DUAS leituras fixas (os nomes e os vínculos), seja
 * qual for o número de cards ou de donos. Os vínculos dizem quem SAIU da equipe:
 * o nome continua (é o histórico de quem respondia pelo negócio), mas o card
 * avisa, em vez de apresentar como responsável alguém que não está mais lá.
 *
 * Por que não a cópia `conversations.assigned_to_user_name` (a primeira versão
 * deste arquivo): ela traz uma linha por CONVERSA atribuída — sem teto, cortada
 * pelo `max_rows` do PostgREST em silêncio — e guarda o nome do momento da
 * atribuição, não o atual.
 *
 * O admin client entra SÓ para o nome, com `organizationId` vindo do funil que
 * a RLS do chamador já deixou ler; os dados do quadro seguem no client do
 * request. Sem service role, nenhum nome é resolvido e o card cai no rótulo
 * anterior — declarado, com log, como em `/team/assignable`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isServiceRoleConfigured } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Lead } from "@/lib/types/leads";
import { nomesDosAtendentesCom } from "@/lib/users/nome-do-atendente";

/**
 * O nome como o card pode desenhá-lo — ou `null`.
 *
 *  1. **vazio/espaço** não é nome: produziria um disco "?" com rótulo em branco;
 *  2. **e-mail cru** não é nome: `full_name` é campo livre e recebe o e-mail
 *     digitado no cadastro — publicá-lo no card vazaria PII para a tela toda.
 *
 * Espaço interno é colapsado: o nome vem de um `<input>` sem máscara.
 */
export function nomeLegivel(bruto: string | null | undefined): string | null {
  if (typeof bruto !== "string") return null;
  const nome = bruto.trim().replace(/\s+/g, " ");
  if (nome.length === 0) return null;
  if (nome.includes("@")) return null;
  return nome;
}

/** `user_id` → ainda está na equipe? `null` quando os vínculos não puderam ser lidos. */
async function quemEstaNaEquipe(
  admin: SupabaseClient,
  organizationId: string,
  ids: string[],
): Promise<Map<string, boolean> | null> {
  // `organization_id` filtrado À MÃO: o admin bypassa a RLS.
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id, revoked_at")
    .eq("organization_id", organizationId)
    .in("user_id", ids);
  if (error) {
    logger.warn("[nome-do-dono] vínculos não lidos: o card não marca quem saiu", {
      organizationId,
      erro: error.message,
    });
    return null;
  }
  const ativos = new Map<string, boolean>(ids.map((id) => [id, false]));
  for (const v of (data ?? []) as Array<{ user_id: string; revoked_at: string | null }>) {
    if (v.revoked_at === null) ativos.set(String(v.user_id), true);
  }
  return ativos;
}

/**
 * Anexa `owner_user_name` (e `owner_user_removed`, quando a pessoa saiu da
 * equipe) aos negócios com dono HUMANO. Sem dono humano no quadro, não consulta
 * nada. Nunca lança: o nome é cortesia, `owner_user_id` é a verdade.
 */
export async function withOwnerUserNames(organizationId: string, leads: Lead[]): Promise<Lead[]> {
  const donos = [
    ...new Set(
      leads
        .map((l) => l.owner_user_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (donos.length === 0) return leads;

  if (!isServiceRoleConfigured()) {
    logger.info("[nome-do-dono] sem service role: o card não recebe o nome do responsável", {
      donos: donos.length,
    });
    return leads;
  }

  try {
    const admin = createAdminClient();
    const [nomes, naEquipe] = await Promise.all([
      nomesDosAtendentesCom(admin, organizationId, donos),
      quemEstaNaEquipe(admin, organizationId, donos),
    ]);
    return leads.map((lead) => {
      if (!lead.owner_user_id) return lead;
      const comNome: Lead = {
        ...lead,
        // `null` EXPLÍCITO: "olhei e esta pessoa não tem nome utilizável".
        owner_user_name: nomeLegivel(nomes.get(lead.owner_user_id)),
      };
      if (naEquipe?.get(lead.owner_user_id) === false) comNome.owner_user_removed = true;
      return comNome;
    });
  } catch (err) {
    logger.warn("[nome-do-dono] nomes não lidos: o card cai no rótulo anterior", {
      organizationId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return leads;
  }
}
