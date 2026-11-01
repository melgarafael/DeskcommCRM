import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/close — fecha a conversa.
 *
 * Não bloqueia por assignee — qualquer membro com permissão (RLS) pode fechar.
 *
 * ## Fechar deixava a trava de humano para trás (#3313, item 1)
 *
 * A trava de humano mora no CONTATO (`contacts.force_human`), não na conversa.
 * Quem fechava para limpar a fila achava que tinha encerrado o atendimento, mas
 * a trava continuava: a próxima mensagem daquele cliente, dias depois, era
 * pulada pela IA (`skip("force_human")`) e ninguém percebia até o cliente
 * reclamar. Medido pela operação que abriu a issue.
 *
 * O corpo aceita `devolver_ao_automatico` — a escolha que a tela apresenta ao
 * fechar uma conversa de contato travado, com "devolver" MARCADO por padrão.
 * Ligado, a rota chama `devolverAtendimentoAoAgente`, a MESMA função do botão
 * "Devolver ao automático" e do cron `handoff-devolucao`: solta as três travas,
 * grava o checkpoint da retomada, emite `ai.handoff_resolved` e a atividade na
 * linha do tempo. Uma segunda regra aqui seria o defeito que `retomada.ts`
 * existe para consertar.
 *
 * `ai_opt_out` (contato "sempre atendimento humano") continua mandando: a
 * função recusa antes de escrever e a conversa fecha do mesmo jeito — o que
 * muda é só a resposta, que diz que a equipe segue com o contato.
 *
 * DESLIGADO (ausente ou `false`) é o comportamento de sempre: fecha e não toca
 * em trava nenhuma. Quem fecha uma conversa sem contato travado não vê escolha
 * nenhuma na tela e não manda a chave — fechar continua sendo só fechar.
 *
 * ## A ORDEM (CR do #3323): devolver ANTES, fechar DEPOIS
 *
 * A primeira versão fechava e devolvia em seguida. Numa conversa COM dono humano
 * isso criava um atendimento fantasma, medido no Postgres com o `baseline.sql`:
 * o release de `fn_conversation_assign` grava `status='open'`, e gravar `open`
 * numa conversa já `closed` é REABERTURA para `fn_service_stamp_status` —
 * revisão +2, `service_started_at` regravado, `current_demanda_id` anulado e um
 * `conversation.routing_requested` emitido para uma conversa encerrada.
 *
 * Devolver primeiro não reabre nada: a conversa ainda está viva, então a escrita
 * do release (`claimed → open`) não carimba atendimento nenhum, e o fechamento
 * que vem depois é a ÚNICA transição que conta.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { devolverAtendimentoAoAgente, type RetomadaResultado } from "@/lib/escalacao/retomada";
import { logger } from "@/lib/logger";
import type { Actor } from "@/lib/api/handlers/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Conversation } from "@/lib/types/messaging";
import { traduzir } from "@/lib/i18n/dicionario";
import { ApiError } from "@/lib/api/types";
import { exigirControleDaConversa } from "@/lib/inbox/controle-da-conversa";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * O desfecho da devolução, como a tela precisa lê-lo. `null` = ninguém pediu
 * devolução (conversa sem contato travado, ou cliente antigo da API): o corpo
 * sai igual ao de antes deste item.
 */
export type DesfechoDaDevolucao = { ok: true } | { ok: false; motivo: string };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  let body: unknown = {};
  const text = await req.text();
  try { body = text ? JSON.parse(text) : {}; } catch { return fail("validation_failed", "Corpo inválido.", 422, { requestId }); }
  const parsed = z.object({
    expected_revision: z.number().int().positive().optional(),
    devolver_ao_automatico: z.boolean().optional(),
  }).safeParse(body);
  if (!parsed.success) return fail("validation_failed", "Revisão inválida.", 422, { requestId });
  const { id } = await ctx.params;
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const user = authz.user;

  const { data: visible, error: readError } = await supabase.from("conversations")
    .select("id, organization_id, assigned_to_user_id, service_revision").eq("id", id)
    .eq("organization_id", authz.org.orgId).maybeSingle();
  if (readError) return fail("internal_error", readError.message, 500, { requestId });
  if (!visible) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  try {
    await exigirControleDaConversa(supabase, {
      organization_id: authz.org.orgId, actor: { type: "user", id: user.id }, requestId,
      idioma: user.idioma,
    }, visible);
  } catch (erro) {
    if (erro instanceof ApiError) return fail(erro.code, erro.message, erro.status, { requestId });
    throw erro;
  }

  // (1) A CONFERÊNCIA DA REVISÃO, ANTES DE QUALQUER ESCRITA. Revisão obsoleta
  // não pode deixar o contato destravado nem a conversa encerrada pela metade:
  // o 409 sai daqui, sem tocar em nada.
  const revisaoEsperada = parsed.data.expected_revision ?? visible.service_revision;
  if (revisaoEsperada !== visible.service_revision) {
    return fail("conflict", t("O atendimento mudou. Atualize e tente novamente."), 409, { requestId });
  }

  // (2) A ESCOLHA VEM ANTES DO FECHAMENTO — a ordem é o conserto do CR (#3323).
  //
  // Fechar e devolver DEPOIS passava a conversa por `open` no meio do caminho:
  // numa conversa com dono humano, o release da `fn_conversation_assign` grava
  // `status='open'`, e gravar `open` numa conversa já `closed` é REABERTURA para
  // os gatilhos do banco (revisão +2, `service_started_at` regravado,
  // `current_demanda_id` anulado, `conversation.routing_requested` para uma
  // conversa encerrada).
  //
  // Devolver antes não reabre nada: a conversa ainda está viva, então a escrita
  // do release (`claimed → open`) não muda atendimento nenhum, e o fechamento
  // que vem depois é a ÚNICA transição que conta. É o que a tela descreve:
  // encerra o atendimento e, no mesmo gesto, devolve o contato ao automático.
  //
  // A MESMA regra de dono do botão "Devolver ao automático" (#3436, em
  // `reactivate-bot/route.ts`): conversa com dono que NÃO é quem fecha só volta
  // ao agente pela mão de um `manager` ou acima. Aqui a recusa não é 403 — fechar
  // é o gesto pedido e segue —, mas a devolução não acontece e o motivo viaja no
  // corpo. E o dono lido vai como `expectedAssignee`: se alguém assumiu a
  // conversa entre a leitura e a devolução, ela recusa (`assignment_conflict`).
  const dono = visible.assigned_to_user_id ?? null;
  const devolucao: DesfechoDaDevolucao | null = parsed.data.devolver_ao_automatico !== true
    ? null
    : dono !== null && dono !== user.id && !roleAtLeast(authz.org.role, "manager")
      ? { ok: false, motivo: "conversa_de_outro_atendente" }
      : await devolverAntesDeFechar({
          supabase,
          conversationId: id,
          organizationId: visible.organization_id,
          actor: { type: "user", id: user.id, role: authz.org.role },
          requestId,
          expectedAssignee: dono,
        });

  // (3) E FECHA, com a MESMA revisão que o cliente mandou (ou a que foi lida
  // quando ele não mandou nenhuma). O CAS da `fn_service_status` (PT409) segue
  // sendo a última palavra: se alguém mexeu na conversa entre a leitura e este
  // UPDATE, a resposta é 409, e não um fechamento por cima de estado alheio.
  const { data, error } = await createAdminClient().rpc("fn_service_status", {
    p_org: visible.organization_id, p_conversation: id, p_status: "closed",
    p_expected: revisaoEsperada,
  });
  // PT409: revisão obsoleta (migration 0514). 40001: contato trocou no meio, ou banco anterior à 0514.
  const conflito = error?.code === "PT409" || error?.code === "40001";
  if (error) return fail(conflito ? "conflict" : "internal_error",
    conflito ? t("O atendimento mudou. Atualize e tente novamente.") : error.message,
    conflito ? 409 : 500, { requestId });
  const convFechada = data as unknown as Conversation;

  await audit({
    action: "conversation.closed",
    actorUserId: user.id,
    organizationId: convFechada.organization_id,
    resourceType: "conversation",
    resourceId: convFechada.id,
    requestId,
  });

  return ok(devolucao === null ? convFechada : { ...convFechada, devolucao }, { requestId });
}

/**
 * A devolução propriamente dita, pela função compartilhada — e a tradução do
 * desfecho para o corpo da resposta.
 *
 * FALHA AQUI NÃO DERRUBA O FECHAMENTO: encerrar é o gesto pedido, e a devolução
 * veio junto como escolha. Devolver erro faria a tela mostrar "não consegui
 * fechar" para uma conversa que o passo seguinte fecha — mentira que atrapalha
 * mais do que a recusa que se quer contar. O que a recusa faz é viajar no corpo
 * (`devolucao`), para a tela dizer: encerrei, mas a trava CONTINUA.
 *
 * `contato_sempre_humano` (contato marcado "sempre atendimento humano") é a
 * recusa ESPERADA, e a mesma leitura do cron: o contato pediu para ficar com
 * gente e nenhuma devolução pode desfazer isso. As demais ficam no log, porque
 * são defeito de banco: soltar a trava do contato falhou.
 */
async function devolverAntesDeFechar(deps: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  conversationId: string;
  organizationId: string;
  actor: Actor;
  requestId: string;
  expectedAssignee: string | null;
}): Promise<DesfechoDaDevolucao> {
  const resultado: RetomadaResultado = await devolverAtendimentoAoAgente(
    {
      supabase: deps.supabase,
      organizationId: deps.organizationId,
      actor: deps.actor,
      requestId: deps.requestId,
    },
    { conversationId: deps.conversationId, expectedAssignee: deps.expectedAssignee },
  );

  if (resultado.ok) return { ok: true };

  if (resultado.erro !== "contato_sempre_humano") {
    logger.error("[conversations.close] devolução ao automático falhou antes de fechar", {
      conversation_id: deps.conversationId,
      organization_id: deps.organizationId,
      erro: resultado.erro,
      detalhe: resultado.detalhe,
      requestId: deps.requestId,
    });
  }
  return { ok: false, motivo: resultado.erro };
}

