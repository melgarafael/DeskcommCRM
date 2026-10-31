import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/conversations/[id]/sector — a FILA de uma conversa (migration 9062).
 *
 * ─── Por que esta rota existe ────────────────────────────────────────────────
 *
 * A 0801 entregou setores de atendimento que AGRUPAM: filtram a aba Atendimento
 * da Equipe e não mudam quem recebe as conversas (é o que diz o texto do próprio
 * módulo). Sem uma coluna que ligue conversa → setor, "fila" continua sendo o
 * nome de um filtro. Esta rota grava esse vínculo, e é a ÚNICA porta de escrita
 * dele — o worker e o handoff só LEEM.
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
 * Módulo `setores` desligado ⇒ 404, igual a toda rota de setor.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { requireRole } from "@/lib/auth/require-role";
import { conversationSectorSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
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

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId; // fonte confiável (cookie validado), nunca o body

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

  // Quem mexe precisa ENXERGAR a conversa: leitura pelo cliente da SESSÃO, com a
  // RLS de sempre. Quem não vê a conversa não escolhe a fila dela.
  const supabase = await createClient();
  const { data: conversa, error: erroConversa } = await supabase
    .from("conversations")
    .select("id, contact_id, status, assigned_to_user_id, sector_id")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (erroConversa) return fail("internal_error", erroConversa.message, 500, { requestId });
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  // A fila tem de existir NESTA organização. A FK composta do banco também
  // recusaria o contrário — conferir aqui é o que troca um 500 opaco por um 422
  // que a tela sabe explicar.
  if (input.sector_id) {
    const admin = createAdminClient();
    const { data: setor, error: erroSetor } = await admin
      .from("attendant_sectors")
      .select("id, name")
      .eq("organization_id", orgId)
      .eq("id", input.sector_id)
      .maybeSingle();
    if (erroSetor) return fail("internal_error", erroSetor.message, 500, { requestId });
    if (!setor) {
      return fail("unprocessable_entity", t("Setor inexistente nesta organização."), 422, {
        requestId,
      });
    }
  }

  const { data: atualizada, error: erroUpdate } = await supabase
    .from("conversations")
    .update({ sector_id: input.sector_id })
    .eq("id", id)
    .eq("organization_id", orgId)
    .select("id, sector_id, assigned_to_user_id, status")
    .maybeSingle();
  if (erroUpdate) return fail("internal_error", erroUpdate.message, 500, { requestId });
  if (!atualizada) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  // Sem dono e em aberto: o vínculo novo pede distribuição. A RPC é a MESMA que
  // o trigger de atribuição usa (`fn_request_channel_routing`) — não inventamos
  // um segundo caminho para a fila nascer.
  let redistribuiu = false;
  if (!atualizada.assigned_to_user_id && ["open", "pending"].includes(String(atualizada.status))) {
    const { error: erroFila } = await createAdminClient().rpc("fn_request_channel_routing", {
      p_org: orgId,
      p_conversation: id,
    });
    if (erroFila) {
      // A conversa já está com a fila gravada; o evento de distribuição é o que
      // faltou, e o próximo ciclo de atribuição a alcança. Não desfazemos a
      // escrita por causa disso — mas o rastro fica.
      console.error("[conversation.sector] fn_request_channel_routing falhou", erroFila.message);
    } else {
      redistribuiu = true;
    }
  }

  await audit({
    action: "conversation.sector_changed",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
    metadata: {
      de: (conversa as { sector_id: string | null }).sector_id,
      para: input.sector_id,
      redistribuiu,
    },
  });

  // Sem `emit_event` de propósito: nenhuma tela acompanha a fila ao vivo nesta
  // fatia, e evento sem consumidor é exatamente o que o #3697 tirou da
  // publicação em tempo real. Quando a fatia 2 (menu/IA e filtro no Inbox)
  // chegar, o evento nasce junto com quem o escuta.

  return ok({ id, sector_id: input.sector_id, redistribuiu }, { requestId });
}

/** GET /api/v1/conversations/[id]/sector — a fila atual da conversa. */
export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const moduloDesligado = await seSetoresDesligado(requestId);
  if (moduloDesligado) return moduloDesligado;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("conversations")
    .select("id, sector_id")
    .eq("id", id)
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
