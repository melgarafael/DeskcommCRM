/**
 * GET /api/v1/contact-tags — tags em uso nos contatos da org ativa. Sugestões
 * para o editor de tags do contato no Inbox (#852, item 1).
 *
 * Irmã de `GET /api/v1/conversation-tags`: server route porque o cookie de
 * sessão é HttpOnly. A organização vem de `requireRole`, nunca do pedido, e o
 * client é o da SESSÃO — a RLS de `contacts` isola sozinha.
 *
 * Sem função no banco de propósito: o vocabulário de tags (com uso por contato,
 * lead e conversa) é a S4 da #852. Quando ele entrar, esta rota passa a ler de
 * lá e o editor não muda.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// ponytail: lê só os 1000 contatos com tag mais recentes (o PostgREST não faz
// `distinct unnest`); tag rara de contato antigo pode faltar na sugestão. Some
// quando a leitura do vocabulário da S4 (#852) substituir esta consulta.
const CONTATOS_LIDOS = 1000;
const TETO_DE_TAGS = 200;

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("tags")
    .eq("organization_id", authz.org.orgId)
    .neq("tags", "{}")
    .order("updated_at", { ascending: false })
    .limit(CONTATOS_LIDOS);
  // A falha SOBE: lista vazia diria "não há tags" em cima de um erro.
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const tags = [...new Set((data ?? []).flatMap((c: { tags: string[] | null }) => c.tags ?? []))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .slice(0, TETO_DE_TAGS);
  return ok(tags, { requestId });
}
