/**
 * GET /api/v1/ai/knowledge/sources/[id]/trechos
 *
 * O que o agente REALMENTE aprendeu deste material.
 *
 * A tela mostrava só uma contagem ("4 trechos"), e contagem não responde a
 * pergunta que a pessoa faz quando o agente erra: *"o que exatamente ele leu?"*.
 * Sem isso, a única forma de auditar o acervo era consultar o banco — e o
 * produto é vendido para quem não programa.
 *
 * Devolve os trechos da versão ATIVA do material, na ordem em que foram
 * indexados. Sem o vetor: 1536 floats por trecho não têm leitor humano e só
 * engordariam a resposta.
 *
 * Auth: sessão por cookie, papel >= manager (mesmo gate do resto do acervo).
 */

import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/** Teto de leitura: uma tela não folheia mil trechos, e o corpo não precisa carregá-los. */
const TETO = 200;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: sourceId } = await params;

  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const supabase = await createClient();

  const { data: fonte, error: fonteErr } = await supabase
    .from("ai_knowledge_sources")
    .select("id, name, active_kb_version_id, chunks_count")
    .eq("id", sourceId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fonteErr) {
    console.error("[conhecimento-trechos] leitura da fonte falhou:", fonteErr.message);
    return fail("internal_error", "Erro ao ler o material.", 500, { requestId });
  }
  if (!fonte) {
    return fail("not_found", t("Material não encontrado."), 404, { requestId });
  }

  const versaoAtiva = (fonte as { active_kb_version_id: string | null }).active_kb_version_id;
  if (!versaoAtiva) {
    // Não é erro: é o estado de quem ainda não foi preparado. Devolver 404 aqui
    // faria a tela dizer "não encontrado" para um material que existe.
    return ok({ nome: (fonte as { name: string }).name, trechos: [], total: 0 }, { requestId });
  }

  const { data: trechos, error: trechosErr } = await supabase
    .from("ai_chunks")
    .select("id, position, content, token_count, metadata")
    .eq("organization_id", activeOrg.orgId)
    .eq("knowledge_source_id", sourceId)
    .eq("kb_version_id", versaoAtiva)
    .order("position", { ascending: true })
    .limit(TETO);

  if (trechosErr) {
    console.error("[conhecimento-trechos] leitura dos trechos falhou:", trechosErr.message);
    return fail("internal_error", "Erro ao ler os trechos.", 500, { requestId });
  }

  return ok(
    {
      nome: (fonte as { name: string }).name,
      trechos: trechos ?? [],
      total: (fonte as { chunks_count: number }).chunks_count ?? (trechos ?? []).length,
      truncado: (trechos ?? []).length >= TETO,
    },
    { requestId },
  );
}
