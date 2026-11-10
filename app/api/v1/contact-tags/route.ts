/** Sugestões do contato: sem busca mantém compatibilidade; com busca lê a página do
 * vocabulário curado e em uso, com a sessão e a RLS. Não depende de clientes fictícios
 * portando a etiqueta para que os atendentes possam escolher uma etiqueta importada. */
import { randomUUID } from "node:crypto";
import { tagsPageQuerySchema, tagsPageResultSchema } from "@/lib/schemas/tags";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { normalizarTag } from "@/lib/contacts/tag-normalizada";
import { logger } from "@/lib/logger";
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
  if (_req.nextUrl.searchParams.has("busca")) {
    const query = tagsPageQuerySchema.safeParse({ busca: _req.nextUrl.searchParams.get("busca") });
    if (!query.success) return fail("validation_failed", "Confira a busca e a página.", 422, { requestId });
    const { data: result, error: readError } = await supabase.rpc("fn_vocabulario_de_tags_pagina", {
      p_org: authz.org.orgId, p_busca: query.data.busca, p_offset: 0, p_limit: 200,
    });
    const parsed = tagsPageResultSchema.safeParse(result);
    if (readError || !parsed.success) return fail("internal_error", "Não foi possível carregar as tags.", 500, { requestId });
    const tags = [...new Set(parsed.data.items.map(row => row.tag.trim().toLowerCase().slice(0,40)))];
    return ok(tags, { requestId, meta: { total: parsed.data.total, has_more: parsed.data.total > tags.length } });
  }

  const { data, error } = await supabase
    .from("contacts")
    .select("tags")
    .eq("organization_id", authz.org.orgId)
    .neq("tags", "{}")
    .order("updated_at", { ascending: false })
    .limit(CONTATOS_LIDOS);
  // A falha SOBE: lista vazia diria "não há tags" em cima de um erro.
  //
  // Fechada na AÇÃO, aberta na INFORMAÇÃO: o cliente recebe uma frase do
  // produto — a mensagem crua do Postgres é para quem opera, não para o
  // navegador — e a causa vai inteira para o log, junto do `requestId` que a
  // resposta carrega. Trocar uma pela outra sem o log seria pior que o estado
  // anterior: o operador ficaria com um 500 mudo e nenhum lugar onde procurar.
  if (error) {
    logger.error("contact-tags: leitura das tags do contato falhou", {
      requestId,
      orgId: authz.org.orgId,
      cause: error.message,
    });
    return fail("internal_error", "Não foi possível carregar as tags.", 500, { requestId });
  }

  // NORMALIZADA, com a mesma função que o editor usa ao gravar: o rótulo do
  // chip tem de dizer exatamente o que o clique grava. Devolvendo a tag crua,
  // "VIP", "vip " e "vip" viravam TRÊS chips que gravam a mesma coisa, e dois
  // deles nunca sumiam da tela.
  //
  // ─── E A ORDEM PASSA A SER A DE USO (#3180) ───────────────────────────────
  //
  // O editor de etiquetas usa este caminho para SUGERIR, e com o campo vazio
  // ele oferece as primeiras da lista. Em ordem alfabética era sempre o mesmo
  // bloco do começo do alfabeto — com 73 etiquetas, as mesmas oito. As mais
  // usadas são o que serve de sugestão para quem ainda não digitou nada.
  //
  // A contagem sai da MESMA leitura que a rota já fazia (o PostgREST não agrega
  // `unnest`), e o desempate é alfabético para duas respostas iguais à mesma
  // pergunta não saírem em ordens diferentes.
  const contagem = new Map<string, number>();
  for (const contato of data ?? []) {
    for (const crua of contato.tags ?? []) {
      const tag = normalizarTag(crua);
      if (tag === "") continue;
      contagem.set(tag, (contagem.get(tag) ?? 0) + 1);
    }
  }
  const tags = [...contagem]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"))
    .map(([tag]) => tag)
    .slice(0, TETO_DE_TAGS);
  return ok(tags, { requestId });
}
