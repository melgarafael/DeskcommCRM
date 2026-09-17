/**
 * GET /api/v1/contact-tags — tags em uso nos contatos da org ativa. Sugestões
 * para o editor de tags do contato no Inbox (#852, item 1).
 *
 * Irmã de `GET /api/v1/conversation-tags`: server route porque o cookie de
 * sessão é HttpOnly. A organização vem de `requireRole`, nunca do pedido, e o
 * client é o da SESSÃO — a RLS de `contacts` isola sozinha.
 *
 * Sem função no banco de propósito — e a S4 da #852, que traz essa função,
 * ENTROU NA MESMA RELEASE que esta rota: `GET /api/v1/tags/vocabulario`, sobre
 * `fn_vocabulario_de_tags`. A frase que estava aqui ("quando ele entrar, esta
 * rota passa a ler de lá") venceu no dia em que foi escrita; fica no lugar dela
 * o que ainda é verdade, que é a instrução.
 *
 * A troca NÃO é apagar esta rota. A da S4 exige `requireRole("manager")` mais
 * `mfaEmDivida()`, porque ela também ESCREVE o vocabulário de toda a
 * organização — e o editor do Inbox é usado por `agent` e por `viewer`, que a
 * S4 responde com 403. Consolidar é trocar o corpo da consulta abaixo por
 * `supabase.rpc("fn_vocabulario_de_tags", { p_org: authz.org.orgId })`, lendo o
 * campo `tag` de cada linha, MANTENDO o `requireRole("viewer")` daqui e
 * apagando `CONTATOS_LIDOS`, `TETO_DE_TAGS` e o `ponytail:` logo abaixo — a
 * função no banco não tem teto de leitura, que é exatamente a dívida que essas
 * duas constantes registram. Fora do escopo deste conserto porque mexe no
 * contrato de uma rota que a tela de Etiquetas acabou de estrear.
 */
import { randomUUID } from "node:crypto";
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
  return ok(tags, { requestId });
}
