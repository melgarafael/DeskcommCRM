import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/ia-com-dono — liga/desliga o modo "IA com o
 * dono" nesta conversa (#3967, fatia 1).
 *
 * ## O que o modo resolve
 *
 * Hoje `conversations.assignee_kind='user'` é veto absoluto no gate
 * (`lib/ai/elegibilidade/gate.ts` → `conversa_de_humano`), e a única volta é
 * `reactivate-bot` → `devolverAtendimentoAoAgente`, que faz `release` do dono: a
 * conversa sai da fila de quem estava atendendo, sai da carteira dele e, em org
 * com rodízio, volta para a distribuição. Quem quer a IA como APOIO — respondendo
 * o cliente enquanto ele continua dono do acompanhamento — não tinha caminho.
 *
 * O modo é esse caminho, e é EXPLÍCITO: nada muda para quem não o liga.
 *
 * ## O que esta rota grava (e o que NÃO grava)
 *
 * Só duas coisas, na MESMA linha:
 *
 *   - `metadata.ai_com_dono` — o estado, no jsonb que a conversa já tem (ver o
 *     porquê em `lib/ai/elegibilidade/ia-com-dono.ts`);
 *   - `bot_silenced_until` — `null` ao ligar, `'infinity'` ao desligar.
 *
 * Ligar limpa o silêncio porque, sem isso, o gate calaria a IA no passo seguinte
 * por `conversa_silenciada`: o modo seria um botão que não faz nada. Desligar
 * devolve o silêncio durável que o "Assumir" grava (e que o handoff grava), para
 * que a conversa volte ao estado de hoje — dono + automático calado — em vez de
 * ficar num meio-termo que nenhum outro caminho do produto produz.
 *
 * **Nada de dono, fila, contadores ou carteira.** Não toca
 * `assigned_to_user_id`, `assignee_kind`, `assigned_at`, `status`,
 * `unread_count`, `first_response_at`, nem chama `fn_conversation_assign`: é
 * exatamente o ponto da issue — a conversa não pode perder o dono nem sair da
 * fila ao ganhar a IA. Transferência explícita continua sendo outro gesto
 * (`transfer`), e continua mudando o dono; o modo não congela nada.
 *
 * **Não toca `contacts.force_human`/`ai_opt_out`/`is_blocked`.** Essas travas são
 * do CONTATO e valem em todas as conversas dele; o modo não as fura — por isso a
 * rota RECUSA ligar num contato travado, em vez de aceitar e deixar a IA calada
 * por outro motivo (botão que mente).
 *
 * Auth: cookie session, agent+ (spec 13 §4: escrita é agent+, viewer é
 * read-only), e `requireSupportWrite()` antes: sessão de suporte por
 * impersonação não escreve. LIGAR exige ser o dono da conversa ou manager+,
 * a régua do `reactivate-bot`; desligar segue a do `pause-ai`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import {
  CHAVE_DA_IA_COM_DONO,
  metadataComModoIaComDono,
} from "@/lib/ai/elegibilidade/ia-com-dono";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Conversation } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";

/** O mesmo literal do handoff e do `pause-ai`: `> now()` é sempre verdadeiro. */
const SILENCIO_DURAVEL = "infinity";

const Corpo = z.object({ ligado: z.boolean() });

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parse = Corpo.safeParse(await req.json().catch(() => null));
  if (!parse.success) {
    return fail("validation_failed", t("Corpo inválido."), 400, { requestId });
  }
  const { ligado } = parse.data;

  const supabase = await createClient();

  // Client do REQUEST, nunca admin: é a policy `conversations_select` que aplica
  // o `visibility_mode`. Ler com service role deixaria um agent fora de escopo
  // mexer no automático de uma conversa que ele nem enxerga.
  const { data: convData, error: convErr } = await supabase
    .from("conversations")
    .select(
      "id, contact_id, status, assigned_to_user_id, assignee_kind, bot_silenced_until, metadata, contacts:contact_id(force_human, ai_opt_out, is_blocked)",
    )
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!convData) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  type ContatoEmbed = { force_human: boolean | null; ai_opt_out: boolean | null; is_blocked: boolean | null };
  const conv = convData as unknown as {
    id: string;
    contact_id: string | null;
    status: string;
    assigned_to_user_id: string | null;
    assignee_kind: string | null;
    bot_silenced_until: string | null;
    metadata: unknown;
    contacts: ContatoEmbed | null;
  };

  // Conversa encerrada não tem atendimento — nem automático nem humano. Ligar o
  // modo ali só criaria uma conversa que "volta" a responder se reaberta, por um
  // estado que ninguém pediu depois do encerramento (mesma régua do `pause-ai`).
  if (conv.status === "closed" || conv.status === "archived") {
    return fail(
      "state_conflict",
      t("Esta conversa está encerrada — não há atendimento automático a ligar ou desligar."),
      409,
      { requestId },
    );
  }

  if (ligado) {
    // Sem dono não há o que preservar: o modo existe para NÃO soltar o dono.
    // Aceitar aqui criaria um modo ligado em conversa sem dono (estado que
    // nenhuma outra tela produz) e o botão "desligar" nunca apareceria.
    if (conv.assigned_to_user_id === null) {
      return fail(
        "state_conflict",
        t("Esta conversa não tem atendente — assuma a conversa antes de ligar a IA com o dono."),
        409,
        { requestId },
      );
    }
    // A mesma régua de dono do `reactivate-bot` (#3436): pôr a IA para falar
    // numa conversa de outro atendente é decisão dele ou de um gerente para cima.
    // Desligar fica livre, como o `pause-ai`: é o caminho de calar, não de falar.
    if (
      conv.assigned_to_user_id !== user.id &&
      !roleAtLeast(org.role, "manager")
    ) {
      return fail(
        "forbidden",
        t("Esta conversa é de outro atendente. Peça a um gerente ou assuma a conversa."),
        403,
        { requestId },
      );
    }
    // Trava do CONTATO: o modo não fura (ver o cabeçalho). Recusar é mais honesto
    // que aceitar e deixar a IA calada por `force_human`/`ai_opt_out`.
    if (conv.contacts?.force_human === true) {
      return fail("state_conflict", t("O contato está marcado como humano obrigatório."), 409, {
        requestId,
      });
    }
    if (conv.contacts?.ai_opt_out === true) {
      return fail("state_conflict", t("O contato pediu para não falar com a IA."), 409, {
        requestId,
      });
    }
    if (conv.contacts?.is_blocked === true) {
      return fail("state_conflict", t("O contato está bloqueado."), 409, { requestId });
    }
  }

  const metadata = metadataComModoIaComDono(conv.metadata, ligado);

  // O UPDATE é a lista COMPLETA do que o modo escreve. Nada de dono, fila,
  // contadores: se um dia alguém acrescentar um campo aqui, este é o lugar em
  // que a issue #3967 diz "não".
  const { data: atualizada, error: updErr } = await supabase
    .from("conversations")
    .update({
      metadata,
      bot_silenced_until: ligado ? null : SILENCIO_DURAVEL,
    })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select(
      "id, contact_id, organization_id, status, assigned_to_user_id, assignee_kind, bot_silenced_until, metadata",
    )
    .maybeSingle();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });
  if (!atualizada) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const final = atualizada as unknown as Conversation;

  await audit({
    action: ligado ? "conversation.ai_with_owner_enabled" : "conversation.ai_with_owner_disabled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
    metadata: {
      [CHAVE_DA_IA_COM_DONO]: ligado,
      dono: conv.assigned_to_user_id,
    },
  });

  // Log: só `audit()`. Este modo NÃO é troca de comando — ninguém entra, sai ou
  // muda de dono —, então ele não vira linha de `crm_lead_activities` ao lado de
  // assumir/transferir/devolver: uma atividade "ligou a IA com o dono" na
  // timeline do lead contaria uma movimentação que não houve, e o efeito real
  // (a IA voltar a responder) já aparece na própria conversa.
  return ok(
    {
      [CHAVE_DA_IA_COM_DONO]: ligado,
      dono_preservado: conv.assigned_to_user_id,
      conversation: final,
    },
    { requestId },
  );
}
