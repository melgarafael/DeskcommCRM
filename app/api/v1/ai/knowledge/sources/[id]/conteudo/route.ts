/**
 * GET /api/v1/ai/knowledge/sources/[id]/conteudo
 *
 * O CONTEÚDO LEGÍVEL DE UM MATERIAL DO ACERVO.
 *
 * A tela listava os materiais em grade e só oferecia "Ver o que ele aprendeu" —
 * os PEDAÇOS do índice. Não havia como abrir um material e ler o que está
 * guardado nele: a política que alguém colou, os pares de pergunta e resposta
 * que alguém cadastrou. Sem essa porta, a equipe mantinha um sistema externo só
 * para consultar o que já estava neste banco.
 *
 * O que esta rota NÃO faz: busca. Não há embedding, não há limiar, não há RPC —
 * ela devolve o que ESTÁ guardado (`lib/ai/knowledge/conteudo-do-material.ts`
 * documenta a ordem: FAQ → arquivo guardado → índice).
 *
 * Auth: sessão por cookie, papel >= manager (mesmo gate do resto do acervo).
 * `organization_id` vem da sessão — nunca do caminho.
 */

import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerConteudoDoMaterial } from "@/lib/ai/knowledge/conteudo-do-material";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: sourceId } = await params;

  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  const leitura = await lerConteudoDoMaterial(supabase, {
    orgId: authz.org.orgId,
    sourceId,
  });

  if (!leitura.ok) {
    // "não existe nesta organização" e "o banco falhou" são diagnósticos
    // opostos: dizer 404 para uma falha de leitura esconderia um defeito real, e
    // dizer 500 para um material de outra empresa confirmaria que ele existe.
    if (leitura.falha === "nao_encontrado") {
      return fail("not_found", t("Material não encontrado."), 404, { requestId });
    }
    return fail("internal_error", "Erro ao ler o material.", 500, { requestId });
  }

  return ok(leitura.material, { requestId });
}
