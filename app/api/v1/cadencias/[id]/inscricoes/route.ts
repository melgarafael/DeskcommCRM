/**
 * GET  /api/v1/cadencias/:id/inscricoes — quem está (ou passou) por esta
 *      cadência, para a aba "Atividade".
 * POST /api/v1/cadencias/:id/inscricoes — põe UM lead na cadência. Inscrever
 *      é `agent`+ (é o vendedor quem decide "este lead entra"), diferente de
 *      montar a cadência (`manager`+) — mesma separação que a doutrina do
 *      construtor descreve.
 *
 * Esta rota NÃO envia e-mail: só cria a linha em `email_cadence_enrollments`
 * com `proximo_em = now()`. Quem lê essa fila e dispara o primeiro passo é o
 * worker do cron, agendado no scheduler da instalação.
 */
import { randomUUID } from "node:crypto";
import { codificarPagina, lerPagina, paginaSchema } from "@/lib/cadencias/paginacao";
import { cadenciasLigadas } from "@/lib/cadencias/modulo";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { inscreverLeadSchema } from "@/lib/cadencias/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  if (!(await cadenciasLigadas(createAdminClient(), authz.org.orgId))) return fail("not_found", "Módulo indisponível.", 404, { requestId });
  const { id } = await ctx.params;

  const pagina = paginaSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!pagina.success) return fail("validation_failed", "Query inválida.", 422, { requestId });
  const { limit, cursor } = pagina.data;
  const depois = cursor ? lerPagina(cursor) : null;
  if (cursor && !depois) return fail("invalid_cursor", "Cursor inválido.", 400, { requestId });

  const supabase = await createClient();
  let query = supabase
    .from("email_cadence_enrollments")
    .select(
      "id, lead_id, contact_id, status, motivo_parada, origem, passo_atual_id, proximo_em, " +
        "emails_enviados, aberturas, concluida_em, parada_em, created_at, rastreio_consentido, ultimo_erro, crm_leads(title)",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("cadence_id", id)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(limit + 1);
  if (depois) query = query.or(`created_at.lt.${depois.instante},and(created_at.eq.${depois.instante},id.lt.${depois.id})`);
  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = data ?? [];
  const temMais = linhas.length > limit;
  const resultado = linhas.slice(0, limit);
  const ultima = resultado.at(-1) as unknown as { created_at: string; id: string } | undefined;
  return ok(resultado, { requestId, meta: { cursor: temMais && ultima ? codificarPagina(ultima.created_at, ultima.id) : null, has_more: temMais } });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  if (!(await cadenciasLigadas(createAdminClient(), authz.org.orgId))) return fail("not_found", "Módulo indisponível.", 404, { requestId });
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id: cadenceId } = await ctx.params;

  const parsed = inscreverLeadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }
  const { lead_id, rastreio_consentido } = parsed.data;

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("fn_cadencia_inscrever", {
    p_organization_id: org.orgId, p_cadence_id: cadenceId, p_lead_id: lead_id,
    p_actor: user.id, p_rastreio_consentido: rastreio_consentido,
  });
  if (error) {
    if (error.code === "23505") return fail("cadencia_inscricao_existente", t("Este lead já está nesta cadência."), 409, { requestId });
    const mensagens: Record<string, { texto: string; status: number }> = {
      cadencia_modulo_indisponivel: { texto: "Módulo indisponível.", status: 404 },
      cadencia_nao_encontrada: { texto: "Cadência não encontrada.", status: 404 },
      cadencia_estado_invalido: { texto: "Só uma cadência ativa aceita novas inscrições.", status: 409 },
      cadencia_lead_indisponivel: { texto: "Lead não encontrado nesta organização.", status: 409 },
      cadencia_sem_email: { texto: "Este lead não tem e-mail para receber a cadência.", status: 409 },
      cadencia_contato_restrito: { texto: "Este contato não pode receber cadências pelas preferências registradas.", status: 409 },
      cadencia_descadastrado: { texto: "Este contato já pediu para não receber e-mails desta organização.", status: 409 },
    };
    const recusa = mensagens[error.message];
    if (recusa) return fail(error.message, t(recusa.texto), recusa.status, { requestId });
    return fail("internal_error", t("Não foi possível inscrever o negócio."), 500, { requestId });
  }
  if (!data || typeof data !== "object" || typeof data.id !== "string") return fail("internal_error", t("Não foi possível inscrever o negócio."), 500, { requestId });
  const inscricao = data as { id: string };

  void audit({
    action: "cadencia.lead_inscrito",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "email_cadence_enrollment",
    resourceId: inscricao.id,
    requestId,
    metadata: { cadence_id: cadenceId, lead_id },
  });

  return ok(data, { requestId, status: 201 });
}
