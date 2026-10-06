/**
 * As etiquetas em uso nos contatos de uma organização — as sugestões dos
 * editores de etiqueta.
 *
 * Uma leitura só para dois consumidores: a rota `GET /api/v1/contact-tags`
 * (editor do Inbox, no cliente) e as páginas do agente (no servidor, que mandam
 * a lista por prop para o filtro por etiqueta — o editor do agente é
 * renderizado sem `QueryClient` nos testes e não busca nada sozinho).
 *
 * `db` é o client da SESSÃO (a RLS de `contacts` isola) ou o admin com
 * `organizationId` de fonte confiável — o filtro por organização é explícito
 * nos dois casos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizarTag } from "@/lib/contacts/tag-normalizada";

// ponytail: lê só os 1000 contatos com tag mais recentes (o PostgREST não faz
// `distinct unnest`); tag rara de contato antigo pode faltar na sugestão. Some
// quando a leitura do vocabulário da S4 (#852) substituir esta consulta.
export const CONTATOS_LIDOS = 1000;
export const TETO_DE_TAGS = 200;

export type EtiquetasEmUso = { ok: true; tags: string[] } | { ok: false; causa: string };

export async function lerEtiquetasDeContatoEmUso(
  db: SupabaseClient,
  organizationId: string,
): Promise<EtiquetasEmUso> {
  const { data, error } = await db
    .from("contacts")
    .select("tags")
    .eq("organization_id", organizationId)
    .neq("tags", "{}")
    .order("updated_at", { ascending: false })
    .limit(CONTATOS_LIDOS);
  if (error) return { ok: false, causa: error.message };

  // NORMALIZADA, com a mesma função que o editor usa ao gravar: o rótulo do
  // chip tem de dizer exatamente o que o clique grava. Devolvendo a tag crua,
  // "VIP", "vip " e "vip" viravam TRÊS chips que gravam a mesma coisa.
  const tags = [
    ...new Set(
      (data ?? [])
        .flatMap((c: { tags: string[] | null }) => c.tags ?? [])
        .map(normalizarTag)
        .filter(Boolean),
    ),
  ]
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .slice(0, TETO_DE_TAGS);
  return { ok: true, tags };
}
