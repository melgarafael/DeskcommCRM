import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/pause-ai — a pessoa assume o comando e o
 * atendimento automático para nesta conversa.
 *
 * ## Por que esta rota não existia
 *
 * Existia só a VOLTA (`reactivate-bot`). Não havia caminho nenhum, em rota ou em
 * tela, para desligar o automático numa conversa: ele calava por efeito colateral
 * — o agente escalando sozinho, ou a janela deslizante de 5 minutos que um envio
 * manual abre (`extendBotSilence`). Um par ligar/desligar com só um dos lados é
 * um interruptor que não desliga.
 *
 * ## O que ela grava, e por que não é `triggerHandoff`
 *
 * `triggerHandoff` (lib/ai/handoff/orchestrator.ts) faz quase isto e é o caminho
 * do AGENTE escalando: ele força `status='pending'`, que significa "na fila,
 * esperando um atendente". Aqui é o oposto — quem clicou está assumindo —, e
 * mandar a conversa para `pending` apagaria o dono da tela no exato gesto em que
 * a pessoa disse que ia cuidar.
 *
 * Então: silêncio durável (`bot_silenced_until='infinity'`, o mesmo literal que o
 * handoff usa e que os três guards do motor leem) e, **se ninguém for dono, um
 * claim para quem clicou**. Pausar sem dono deixaria a conversa sem ator nenhum —
 * automático desligado e nenhuma pessoa responsável —, que é morte por definição
 * (invariante 4 do Sistema Vivo: nenhuma demanda sem próximo passo).
 *
 * **Não toca `contacts.force_human`.** Aquela trava é do CONTATO e vale para
 * todas as conversas dele; pausar UMA conversa não pode virar bloqueio geral do
 * cliente. Ela continua sendo escrita só por quem escala de verdade.
 *
 * Auth: cookie session, agent+ (spec 13 §4: escrita é agent+, viewer é read-only).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { createClient } from "@/lib/supabase/server";
import type { Conversation } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";

/** O mesmo literal do handoff: `bot_silenced_until > now()` é sempre verdadeiro. */
const SILENCIO_DURAVEL = "infinity";
const MOTIVO = "Automático pausado pelo atendente";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const supabase = await createClient();

  // Client do REQUEST, nunca admin: é a policy `conversations_select` que aplica
  // o `visibility_mode`, e ler com service role aqui deixaria um agent fora de
  // escopo pausar o automático de uma conversa que ele nem enxerga.
  const { data: convData, error: convErr } = await supabase
    .from("conversations")
    .select("id, contact_id, status, assigned_to_user_id, bot_silenced_until")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!convData) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const conv = convData as unknown as {
    id: string;
    contact_id: string | null;
    status: string;
    assigned_to_user_id: string | null;
    bot_silenced_until: string | null;
  };

  if (conv.status === "closed" || conv.status === "archived") {
    return fail(
      "state_conflict",
      "Esta conversa está encerrada — não há atendimento automático a pausar.",
      409,
      { requestId },
    );
  }

  let assumiu = false;

  if (conv.assigned_to_user_id === null) {
    // Sem dono: quem pausa assume. Pela RPC, que grava o evento de atribuição na
    // MESMA transação e — desde a migration 0173 — já deixa o silêncio durável.
    const { data: atribuida, error: rpcErr } = await supabase.rpc("fn_conversation_assign", {
      p_organization_id: org.orgId,
      p_conversation_id: id,
      p_to_user_id: user.id,
      p_reason: "claim",
      p_expected_assignee: null,
      p_enforce_expected: true,
    });
    if (rpcErr) return fail("internal_error", rpcErr.message, 500, { requestId });
    if (!atribuida || (atribuida as unknown[]).length === 0) {
      return fail("state_conflict", "Outro atendente assumiu esta conversa agora.", 409, {
        requestId,
      });
    }
    assumiu = true;
  }

  // Com dono (o próprio ou outro): só o silêncio. Não roubamos a conversa de
  // quem já a tem — pausar o automático e trocar o dono são gestos diferentes, e
  // um gerente pausando a conversa de um colega não pode virar takeover mudo.
  //
  // Roda também no caminho do claim: a RPC já grava `'infinity'`, e reafirmar é
  // barato e imune a um clone cuja função ainda seja a versão anterior — o
  // `update.sh` aplica o baseline, mas nada garante que este código não chegou
  // primeiro.
  const { data: atualizada, error: updErr } = await supabase
    .from("conversations")
    .update({ bot_silenced_until: SILENCIO_DURAVEL, last_handoff_reason: MOTIVO })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id, contact_id, organization_id, status, assigned_to_user_id, bot_silenced_until")
    .maybeSingle();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });
  if (!atualizada) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const final = atualizada as unknown as Conversation;

  await audit({
    action: "conversation.ai_paused",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
    metadata: { assumiu_ao_pausar: assumiu },
  });

  // O log que aparece na TELA (invariante 3: log invisível é log morto). A
  // auditoria acima só `admin` lê; esta linha vai para o painel da conversa.
  await registrarTrocaDeComando({
    supabase,
    organizationId: org.orgId,
    conversationId: id,
    contactId: conv.contact_id,
    tipo: "conversation_ai_paused",
    actor: { type: "user", id: user.id, role: org.role },
    motivo: assumiu
      ? "Assumiu a conversa e pausou o atendimento automático"
      : MOTIVO,
    payload: { assumiu_ao_pausar: assumiu },
  });

  return ok({ paused: true, assumiu_ao_pausar: assumiu, conversation: final }, { requestId });
}
