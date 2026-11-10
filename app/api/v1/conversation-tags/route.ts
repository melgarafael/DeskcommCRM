/**
 * GET /api/v1/conversation-tags — vocabulário canônico de tags de conversa da
 * org ativa (spec 13 §3.3, G3-05). Sugestões para o inbox.
 *
 * Server route (não query browser-supabase direta): o cookie de sessão é
 * HttpOnly, então o client do browser não lê a sessão — leitura autenticada
 * passa pelo servidor, mesmo padrão do board de pipelines.
 */
import { randomUUID } from "node:crypto";
import { tagsPageQuerySchema, tagsPageResultSchema } from "@/lib/schemas/tags";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { canonicalConversationTagsSchema } from "@/lib/schemas/settings";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Quantas conversas a ORDENAÇÃO por uso lê (#3180). A lista de etiquetas em si
// não tem teto aqui — quem a devolve é `fn_tags_de_conversa_em_uso`, com teto
// de 200 na própria função. Este número é só da amostra que conta o peso,
// espelhando o `CONTATOS_LIDOS` da rota irmã (`/api/v1/contact-tags`).
const CONVERSAS_LIDAS = 1000;

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  if (_req.nextUrl.searchParams.has("busca")) {
    const query = tagsPageQuerySchema.safeParse({ busca: _req.nextUrl.searchParams.get("busca") });
    if (!query.success) return fail("validation_failed", "Confira a busca e a página.", 422, { requestId });
    const { data: result, error: readError } = await supabase.rpc("fn_vocabulario_de_tags_pagina", {
      p_org: activeOrg.orgId, p_busca: query.data.busca, p_offset: 0, p_limit: 200,
    });
    const parsed = tagsPageResultSchema.safeParse(result);
    if (readError || !parsed.success) return fail("internal_error", "Não foi possível carregar as tags.", 500, { requestId });
    const tags = [...new Set(parsed.data.items.map(row => row.tag.trim().toLowerCase().slice(0,40)))];
    return ok(tags, { requestId, meta: { total: parsed.data.total, has_more: parsed.data.total > tags.length } });
  }

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

  // ─── A ORDEM PASSA A SER A DE USO (#3180) ──────────────────────────────────
  //
  // O editor de etiquetas da conversa sugere as PRIMEIRAS desta lista quando o
  // campo está vazio. Em ordem alfabética isso era sempre o mesmo bloco do
  // começo do alfabeto: com 73 etiquetas, as mesmas oito, para todo mundo. As
  // mais usadas são a sugestão útil de quem ainda não digitou nada.
  //
  // A contagem precisa de uma leitura a mais: a função acima responde QUAIS
  // etiquetas existem (todas as conversas, teto 200), não quanto pesam, e o
  // PostgREST não agrega `unnest`. A lista continua vindo da função — esta
  // leitura só ORDENA, então uma etiqueta fora da amostra aparece igual, mais
  // abaixo (mesma dívida declarada da rota irmã, `/api/v1/contact-tags`).
  const { data: conversas, error: erroDaContagem } = await supabase
    .from("conversations")
    .select("tags")
    .eq("organization_id", activeOrg.orgId)
    .neq("tags", "{}")
    .order("updated_at", { ascending: false })
    .limit(CONVERSAS_LIDAS);
  if (erroDaContagem) {
    // O contrato desta rota é a LISTA, e ela está inteira: quem respondeu foi a
    // função, com todas as conversas. Só a ORDEM se perde — volta a ser
    // alfabética, como era antes da #3180 —, e por isso a falha fica no log em
    // vez de virar um 500 sobre uma resposta que existe.
    logger.warn("conversation-tags: contagem de uso falhou; ordem alfabética", {
      requestId,
      orgId: activeOrg.orgId,
      cause: erroDaContagem.message,
    });
  }
  const contagem = new Map<string, number>();
  for (const conversa of conversas ?? []) {
    for (const tag of conversa.tags ?? []) {
      contagem.set(tag, (contagem.get(tag) ?? 0) + 1);
    }
  }
  // O desempate é alfabético: as SEMENTES da organização (uso zero) descem
  // juntas, em ordem estável, e duas respostas iguais saem na mesma ordem.
  const tags = [...new Set([...canonicas, ...usadas])].sort(
    (a, b) => (contagem.get(b) ?? 0) - (contagem.get(a) ?? 0) || a.localeCompare(b, "pt-BR"),
  );
  return ok(tags, { requestId });
}
