/**
 * GET /api/v1/ai/providers/:provider/models
 *
 * Lê do catálogo curado `ai_models` (tabela GLOBAL, RLS read-all).
 * Retorna modelos não-deprecated ordenados por default-first depois preço.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { ehProvedorSuportado } from "@/lib/ai/pontos/provedores";

export const dynamic = "force-dynamic";

// A lista única (`lib/ai/pontos/provedores.ts`) — não uma quarta cópia. Esta
// rota alimenta o seletor de modelos; com a lista velha, pedir os modelos da
// OpenRouter devolvia "provedor desconhecido" para um provedor que a tela ao
// lado oferecia.

const MODEL_COLUMNS =
  "id, provider, model_id, display_name, description, context_window, input_price_per_million_cents, output_price_per_million_cents, supports_tools, is_default_for_provider, deprecated_at, released_at";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { provider } = await ctx.params;

  if (!ehProvedorSuportado(provider)) {
    return fail("not_found", "Provider desconhecido.", 404, { requestId });
  }

  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_models")
    .select(MODEL_COLUMNS)
    .eq("provider", provider)
    .is("deprecated_at", null)
    .order("is_default_for_provider", { ascending: false })
    .order("input_price_per_million_cents", { ascending: true });

  if (error) {
    return fail("internal_error", "Erro ao listar modelos.", 500, { requestId });
  }

  // UM MODELO DE BUSCA NÃO É UM ATENDENTE.
  //
  // O catálogo é o mesmo que alimenta os pontos de índice/busca do RAG, então
  // ele traz `text-embedding-3-small` — modelo que só converte texto em
  // vetor. Era oferecido no seletor "Modelo" do agente (IA › Agentes › Modelo),
  // e quem o escolhia ficava com um atendente mudo: embedding não conversa.
  //
  // `supports_tools` é a MESMA régua que `escolherModeloDoProvedor`
  // (`lib/ai/agents/escolher-modelo.ts`) já usa para escolher o modelo do
  // atendente e que `validarBinding` aplica no painel: sem ferramenta o modelo
  // devolve texto plausível e nada chega ao funil. Filtrar aqui é filtrar em
  // todos os seletôres — esta rota é a única fonte do `ModelPicker`.
  //
  // O filtro é em memória de propósito: são no máximo centenas de linhas, e
  // assim o teste da rota enxerga a regra (um `eq` no banco o esconderia do
  // dublê, que devolve a lista inteira).
  const models = (data ?? []).filter((m) => m.supports_tools === true);

  return ok({ models }, { requestId });
}
