import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/conversations/[id]/sector — a FILA de uma conversa (migration 9062).
 *
 * ─── Por que esta rota existe ────────────────────────────────────────────────
 *
 * A 0801 entregou setores de atendimento que AGRUPAM: filtram a aba Atendimento
 * da Equipe e não mudam quem recebe as conversas (é o que diz o texto do próprio
 * módulo). Sem uma coluna que ligue conversa → setor, "fila" continua sendo o
 * nome de um filtro. Esta rota grava esse vínculo pelo gesto HUMANO — o agente
 * de IA e as automações entram pela MESMA régua, em
 * `lib/atendimento/setor-da-conversa` (#3881).
 *
 * ─── Por que o destino mora na conversa ─────────────────────────────────────
 *
 * Quem escolhe a fila é o cliente (menu, triagem por IA) ou o operador — e a
 * escolha precisa sobreviver a refresh, realtime e troca de atendente. Guardar
 * a fila em `organizations.settings` (por número) expressaria a vontade do
 * GESTOR, não a escolha de quem está falando com a empresa neste momento. É a
 * diferença entre "este número é do comercial" e "esta pessoa quer o
 * comercial".
 *
 * ─── O que acontece depois de gravar ────────────────────────────────────────
 *
 * Conversa SEM dono volta para a fila de distribuição: o vínculo novo pede um
 * claim, e quem decide quem recebe é `lib/routing/eligibles.ts` com escopo de
 * fila (membro ∧ aberta agora ∧ disponível ∧ com folga). Conversa COM dono não
 * é redistribuída: mudar de fila não tira a conversa de quem já está nela —
 * isso é transferência, e tem caminho próprio (`/transfer`).
 *
 * Módulo `setores` desligado ⇒ 404, igual a toda rota de setor. A conferência
 * fica AQUI, antes de autorizar: módulo desligado não tem regra de papel para
 * responder (é o contrato que `tests/unit/setores-modulo-desligado` mede).
 *
 * ─── A escrita não é mais local (#3881) ─────────────────────────────────────
 *
 * A régua desceu para `definirSetorDaConversa` porque agora são três atores
 * (pessoa, agente de IA, automação). O que é DESTA rota continua aqui: a sessão
 * (é ela que faz a RLS de `conversations` valer para leitura E escrita), o papel
 * mínimo `agent` e a limpeza da fila (`sector_id: null`), que só gente faz.
 * Setor definido por pessoa fica marcado como `manual` em
 * `conversations.metadata.setor_origem` e não é sobrescrito pela IA sem opção
 * explícita.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { definirSetorDaConversa } from "@/lib/atendimento/setor-da-conversa";
import { requireRole } from "@/lib/auth/require-role";
import { conversationSectorSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PUT(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const moduloDesligado = await seSetoresDesligado(requestId);
  if (moduloDesligado) return moduloDesligado;

  const authHeader = req.headers.get("authorization");
  if (authHeader && /^Bearer\s+/i.test(authHeader.trim())) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "conversations",
      role: "agent",
      scope: "mcp:write",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "conversations", requestId);
    if (teto) return teto;
    const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
    const orgId = authz.organizationId;
    const supabase = authz.supabase;
    const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;
    return responderSetorPut(supabase, orgId, id, req, requestId, t, actorUserId, authz.apiTokenId ?? null);
  }

  // Caminho de sessão: byte a byte igual.
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const supabase = await createClient();
  return responderSetorPut(supabase, orgId, id, req, requestId, t, authz.user.id, null);
}

async function responderSetorPut(
  supabase: SupabaseClient,
  orgId: string,
  conversationId: string,
  req: NextRequest,
  requestId: string,
  t: (texto: string) => string,
  actorUserId: string | null,
  actorApiTokenId: string | null,
): Promise<Response> {
  let input;
  try {
    input = await validateRequest(conversationSectorSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // A escrita passa pelo cliente recebido: a SESSÃO na rota humana (a RLS de sempre, sem exceção para
  // esta rota) e o de serviço no ramo do token, onde a organização vem da LINHA do token e a conversa
  // é conferida com `organization_id` dentro do auxiliar. O de serviço entra só onde ele já entrava:
  // a lista de setores e o pedido de distribuição.
  const resultado = await definirSetorDaConversa({
    db: supabase,
    admin: createAdminClient(),
    organizationId: orgId,
    conversationId,
    sectorId: input.sector_id,
    origem: "manual",
    // Gente sempre pode corrigir a classificação — inclusive a que a IA fez.
    sobrescreverSetorManual: true,
    ator: actorApiTokenId
      ? { tipo: "api_token", userId: actorUserId, apiTokenId: actorApiTokenId }
      : { tipo: "user", userId: actorUserId },
    requestId,
    // Já conferido acima, antes de autorizar: não pagamos a segunda consulta.
    moduloJaConferido: true,
  });

  if (!resultado.ok) {
    switch (resultado.motivo) {
      case "conversa_nao_encontrada":
        return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
      case "setor_inexistente":
        return fail("unprocessable_entity", t("Setor inexistente nesta organização."), 422, {
          requestId,
        });
      case "conversa_encerrada":
        return fail("conflict", t("A conversa está encerrada e não aceita mais setor."), 409, {
          requestId,
        });
      case "falha_ao_gravar":
        return fail("internal_error", resultado.mensagem, 500, { requestId });
      default:
        // `setor_manual_preservado`, `limpeza_nao_permitida` e `setores_desligados`
        // não são alcançáveis daqui: origem `manual` e módulo já conferido.
        return fail("internal_error", resultado.mensagem, 500, { requestId });
    }
  }

  // Sem `emit_event` de propósito: nenhuma tela acompanha a fila ao vivo nesta
  // fatia, e evento sem consumidor é exatamente o que o #3697 tirou da
  // publicação em tempo real. Quando a fatia 2 (menu/IA e filtro no Inbox)
  // chegar, o evento nasce junto com quem o escuta.

  return ok({ id: conversationId, sector_id: resultado.para, redistribuiu: resultado.redistribuiu }, { requestId });
}

/** GET /api/v1/conversations/[id]/sector — a fila atual da conversa. */
export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const moduloDesligado = await seSetoresDesligado(requestId);
  if (moduloDesligado) return moduloDesligado;

  const authHeader = _req.headers.get("authorization");
  if (authHeader && /^Bearer\s+/i.test(authHeader.trim())) {
    const authz = await resolveAuthDual(_req, {
      requestId,
      resource: "conversations",
      role: "agent",
      scope: "mcp:read",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "conversations", requestId);
    if (teto) return teto;
    const orgId = authz.organizationId;
    const supabase = authz.supabase;
    return responderSetorGet(supabase, orgId, id, requestId);
  }

  // Caminho de sessão: byte a byte igual.
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const supabase = await createClient();
  return responderSetorGet(supabase, orgId, id, requestId);
}

async function responderSetorGet(
  supabase: SupabaseClient,
  orgId: string,
  conversationId: string,
  requestId: string,
): Promise<Response> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, sector_id")
    .eq("id", conversationId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const sectorId = (data as { sector_id: string | null }).sector_id;
  if (!sectorId) return ok({ sector: null }, { requestId });

  const { data: setor } = await createAdminClient()
    .from("attendant_sectors")
    .select("id, name, schedule")
    .eq("organization_id", orgId)
    .eq("id", sectorId)
    .maybeSingle();

  return ok({ sector: setor ?? { id: sectorId, name: null, schedule: {} } }, { requestId });
}
