/**
 * GET /api/v1/leads/[id]/timeline
 *
 * A timeline do NEGÓCIO — irmã da timeline do CONTATO, e não a mesma coisa.
 *
 * POR QUE ESTA ROTA EXISTE: o dossiê usava a timeline do contato, que é
 * indexada por `contact_id`. Lead SEM contato não tinha porta de entrada
 * nenhuma, e o dossiê de um negócio com quatro atividades dizia na tela "Nada
 * aconteceu com este negócio ainda". Medido: 14 de 55 leads sem contato (25%) e
 * 126 de 198 atividades pertencendo a eles (64%) — não é caso de canto, é a
 * maioria do que está registrado.
 *
 * E o defeito não estava NA peça: a timeline do contato está correta sobre o
 * contato. Ela foi reusada como dossiê do negócio, que é outro substantivo.
 * Vazio por falta de EIXO se lê idêntico a vazio por falta de ACONTECIMENTO — e
 * a frase estava na frente do cliente afirmando o que não era verdade.
 *
 * A CLÁUSULA: âncora no lead, unida com `contact_id = <contato do lead> and
 * lead_id is null`.
 *
 *  - o segundo lado NÃO é redundante hoje só porque está vazio: ele preserva a
 *    atividade que nasce da conversa e não de um negócio específico, que é o que
 *    o eixo por contato protegia. Se um dia nascer, ela aparece;
 *  - o irmão fica de fora POR CONSTRUÇÃO: atividade do negócio B tem
 *    `lead_id = B`, e não casa com nenhum dos dois lados. A rota do contato,
 *    por puxar todos os leads dele, somava no dossiê de A o que era de B;
 *  - lead sem contato passa a ter porta com o primeiro lado sozinho.
 *
 * ⚠️ NÃO "SIMPLIFIQUE" O SEGUNDO LADO. Hoje ele casa zero linhas, e é
 * exatamente por isso que parece removível. A escolha NÃO foi feita pela
 * contagem de hoje: contagem responde sobre o que existe, não sobre o que o
 * código permite, e aqui o zero estava dos dois lados do argumento.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { extractBearer } from "@/lib/mcp/auth";
import {
  TIMELINE_COLS,
  comNomeDoAtor,
  decodeCursor,
  encodeCursor,
  filtroDaPagina,
  filtroDoCursor,
} from "@/lib/leads/timeline-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TimelineItem } from "@/lib/types/contacts";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authHeader = req.headers.get("authorization");
  if (extractBearer(authHeader)) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "crm_leads",
      role: "viewer",
      scope: "mcp:read",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "leads_timeline", requestId);
    if (teto) return teto;
    return responder(authz.supabase, authz.organizationId, authz.idioma ?? IDIOMA_PADRAO, leadId, req, requestId);
  }

  // Sessão do navegador
  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const authUser = await loadAuthUser();
  return responder(supabase, null, authUser?.idioma ?? "pt-BR", leadId, req, requestId);
}

async function responder(
  supabase: SupabaseClient,
  organizationId: string | null,
  idioma: Idioma,
  leadId: string,
  req: NextRequest,
  requestId: string,
): Promise<Response> {
  const t = (texto: string) => traduzir(texto, idioma);

  const url = new URL(req.url);
  const types = url.searchParams.getAll("type").filter(Boolean);
  const limitRaw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 50;
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
  }

  // O lead vem pela RLS do caller — é ele que prova a org, nunca o body.
  // No ramo do token, o client é admin: filtra explicitamente pela org do token.
  let leadQuery = supabase.from("crm_leads").select("id, contact_id, organization_id").eq("id", leadId);
  if (organizationId) leadQuery = leadQuery.eq("organization_id", organizationId);
  const { data: lead, error: leadErr } = await leadQuery.maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const contactId = (lead as { contact_id: string | null }).contact_id;
  // A organização vem do lead, que veio pela RLS do caller — nunca do body.
  const orgId = (lead as { organization_id: string }).organization_id;

  let q = supabase
    .from("crm_lead_activities")
    .select(TIMELINE_COLS)
    .order("performed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  // A cláusula mora em `timeline-query` — não aqui — porque é ela que os testes
  // prendem. Ela leva a ORGANIZAÇÃO dona junto do eixo do dossiê: todos os
  // índices de `crm_lead_activities` começam por `organization_id`, e uma
  // consulta que não diz a empresa não usa nenhum deles. Os dois lados do
  // dossiê continuam intactos; o irmão continua fora por construção.
  q = q.or(filtroDaPagina(orgId, leadId, contactId));

  if (types.length > 0) q = q.in("type", types);
  if (cursor) {
    // O cursor é o segundo `or(...)` da mesma consulta e carrega a mesma
    // organização — sem isso a segunda página volta a varrer a tabela.
    q = q.or(filtroDoCursor(orgId, cursor));
  }
  if (organizationId) q = q.eq("organization_id", organizationId);

  const { data, error } = await q;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const rows = (data ?? []) as unknown as TimelineItem[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const page = await comNomeDoAtor(supabase, (lead as { organization_id: string }).organization_id, pageRows);
  const last = pageRows[pageRows.length - 1];

  return ok(page, {
    requestId,
    meta: {
      has_more: hasMore,
      cursor: hasMore && last ? encodeCursor({ performed_at: last.performed_at, id: last.id }) : null,
    },
  });
}
