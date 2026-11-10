/**
 * GET /api/v1/contacts/[id]/compras — as "Últimas compras" do contato (#3179).
 *
 * POR QUE UMA ROTA (e não o `crm-summary`): o painel do Inbox e a FICHA do contato
 * mostram a mesma seção, e a ficha não tem o `crm-summary` no caminho. Uma leitura
 * só, num lugar só, serve aos dois — e a régua de "o que é compra" (negócio GANHO,
 * em todos os funis) fica escrita uma vez, em `lib/leads/compras-do-contato.ts`.
 *
 * UMA consulta por contato, como o caminho medido pede: `status='won'`, de TODOS
 * os funis (a lista não filtra por funil nem por arquivado — o histórico de compra
 * do cliente não desaparece porque o quadro saiu da vista), ordenada pela data do
 * ganho. Os campos escolhidos pela organização vêm da preferência que JÁ existe
 * (`organizations.interface_settings.compras_campos`) — nenhuma tabela nova.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
import { montarCompras, type LeadGanhoRow } from "@/lib/leads/compras-do-contato";
import { camposDeCompraDaInterface } from "@/lib/navigation/interface";

export const dynamic = "force-dynamic";

/** O embed do funil alimenta os RÓTULOS dos campos escolhidos (título da coluna). */
const COMPRA_COLS =
  "id, title, status, value_cents, recurring_value_cents, recurring_period, recurring_months, currency, closed_at, pipeline_id, custom_fields, crm_pipelines(settings)";

/** A janela da lista: o suficiente para o histórico do atendimento, sem paginar. */
const LIMITE = 20;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  // A RLS já limita o que este usuário enxerga; a organização vem da LINHA do
  // contato (nunca do corpo) e o filtro por ela é explícito, como no crm-summary.
  const { data: contactScope, error: scopeError } = await supabase
    .from("contacts")
    .select("organization_id")
    .eq("id", contactId)
    .maybeSingle();
  if (scopeError) return fail("internal_error", scopeError.message, 500, { requestId });
  if (!contactScope) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("interface_settings")
    .eq("id", contactScope.organization_id)
    .maybeSingle();
  if (orgError) return fail("internal_error", orgError.message, 500, { requestId });
  const chaves = camposDeCompraDaInterface(org?.interface_settings);

  const { data, error } = await supabase
    .from("crm_leads")
    .select(COMPRA_COLS)
    .eq("contact_id", contactId)
    .eq("organization_id", contactScope.organization_id)
    .eq("status", "won")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false })
    .limit(LIMITE);

  // A falha SOBE: engolir aqui devolveria lista vazia ao cliente — e "o cliente
  // não comprou nada" é uma afirmação sobre o negócio, não sobre a leitura.
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const compras = montarCompras((data ?? []) as unknown as LeadGanhoRow[], chaves);
  return ok({ compras }, { requestId });
}
