/**
 * GET /api/v1/conversation-tags — vocabulário canônico de tags de conversa da
 * org ativa (spec 13 §3.3, G3-05). Sugestões para o inbox.
 *
 * Server route (não query browser-supabase direta): o cookie de sessão é
 * HttpOnly, então o client do browser não lê a sessão — leitura autenticada
 * passa pelo servidor, mesmo padrão do board de pipelines.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { canonicalConversationTagsSchema } from "@/lib/schemas/settings";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const raw = (data?.settings as Record<string, unknown> | null)?.[
    "canonical_conversation_tags"
  ];
  const canonicas = canonicalConversationTagsSchema.parse(raw ?? []);

  // ─── E AS QUE ESTÃO EM USO ───────────────────────────────────────────────
  //
  // Só o vocabulário canônico é uma lista curada à mão. Medido numa instalação
  // real: o seletor oferecia 8 etiquetas de semente, NENHUMA conversa tinha
  // etiqueta, filtrar por qualquer uma devolvia zero — e a etiqueta que a lista
  // de conversas EXIBIA não estava entre as 8. O operador vê a etiqueta na tela
  // e não consegue filtrar por ela.
  //
  // A organização vem de `requireRole`, NUNCA do body. E `supabase` aqui é o
  // client da SESSÃO: a função é `security invoker`, então a RLS de
  // `conversations` isola sozinha — pedir a de outra organização devolve zero.
  const { data: emUso, error: erroEmUso } = await supabase.rpc(
    "fn_tags_de_conversa_em_uso",
    { p_org: activeOrg.orgId },
  );
  // A falha SOBE. Engolir devolveria o vocabulário curado como se fosse a lista
  // completa — que é exatamente a mentira que esta rota veio desfazer.
  if (erroEmUso) return fail("internal_error", erroEmUso.message, 500, { requestId });

  const usadas = (emUso ?? []).map((l: { tag: string }) => l.tag);
  const tags = [...new Set([...canonicas, ...usadas])].sort((a, b) =>
    a.localeCompare(b, "pt-BR"),
  );
  return ok(tags, { requestId });
}
