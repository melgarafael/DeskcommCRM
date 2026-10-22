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
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { devolverAtendimentoAoAgente, type RetomadaResultado } from "@/lib/escalacao/retomada";
import { logger } from "@/lib/logger";
import type { Actor } from "@/lib/api/handlers/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Conversation } from "@/lib/types/messaging";
import { traduzir } from "@/lib/i18n/dicionario";

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
    .select("id, organization_id, service_revision").eq("id", id)
    .eq("organization_id", authz.org.orgId).maybeSingle();
  if (readError) return fail("internal_error", readError.message, 500, { requestId });
  if (!visible) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  const { data, error } = await createAdminClient().rpc("fn_service_status", {
    p_org: visible.organization_id, p_conversation: id, p_status: "closed",
    p_expected: parsed.data.expected_revision ?? visible.service_revision,
  });
  // PT409: revisão obsoleta (migration 0514). 40001: contato trocou no meio, ou banco anterior à 0514.
  const conflito = error?.code === "PT409" || error?.code === "40001";
  if (error) return fail(conflito ? "conflict" : "internal_error",
    conflito ? t("O atendimento mudou. Atualize e tente novamente.") : error.message,
    conflito ? 409 : 500, { requestId });
  const conv = data as unknown as Conversation;

  await audit({
    action: "conversation.closed",
    actorUserId: user.id,
    organizationId: conv.organization_id,
    resourceType: "conversation",
    resourceId: conv.id,
    requestId,
  });

  // A ESCOLHA VEM DEPOIS DO FECHAMENTO, de propósito: `devolverAtendimentoAoAgente`
  // não reabre conversa encerrada (o status `closed` está fora da lista de
  // reativáveis), então devolver antes faria a `fn_service_status` reescrever o
  // status logo em seguida, com o risco adicional de a revisão mudar entre a
  // leitura e o UPDATE otimista do fechamento (PT409 numa corrida que não
  // existe). Fechar primeiro e soltar a trava depois é a ordem que a operação
  // descreveu: encerra o atendimento e, no mesmo gesto, devolve o contato ao
  // automático.
  const devolucao = parsed.data.devolver_ao_automatico === true
    ? await devolverAposFechar({
        supabase,
        conversationId: id,
        organizationId: conv.organization_id,
        actor: { type: "user", id: user.id, role: authz.org.role },
        requestId,
      })
    : null;

  return ok(devolucao === null ? conv : { ...conv, devolucao }, { requestId });
}

/**
 * A devolução propriamente dita, pela função compartilhada — e a tradução do
 * desfecho para o corpo da resposta.
 *
 * FALHA AQUI NÃO DERRUBA O FECHAMENTO: a conversa já está encerrada e repetir o
 * `POST` não desfaz nada. Devolver erro faria a tela mostrar "não consegui
 * fechar" para uma conversa fechada — mentira pior que a recusa que se quer
 * contar. O que a recusa faz é viajar no corpo (`devolucao`), para a tela
 * dizer: encerrei, mas a trava CONTINUA.
 *
 * `contato_sempre_humano` (contato marcado "sempre atendimento humano") é a
 * recusa ESPERADA, e a mesma leitura do cron: o contato pediu para ficar com
 * gente e nenhuma devolução pode desfazer isso. As demais ficam no log, porque
 * são defeito de banco: soltar a trava do contato falhou.
 */
async function devolverAposFechar(deps: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  conversationId: string;
  organizationId: string;
  actor: Actor;
  requestId: string;
}): Promise<DesfechoDaDevolucao> {
  const resultado: RetomadaResultado = await devolverAtendimentoAoAgente(
    {
      supabase: deps.supabase,
      organizationId: deps.organizationId,
      actor: deps.actor,
      requestId: deps.requestId,
    },
    { conversationId: deps.conversationId },
  );

  if (resultado.ok) return { ok: true };

  if (resultado.erro !== "contato_sempre_humano") {
    logger.error("[conversations.close] devolução ao automático falhou depois de fechar", {
      conversation_id: deps.conversationId,
      organization_id: deps.organizationId,
      erro: resultado.erro,
      detalhe: resultado.detalhe,
      requestId: deps.requestId,
    });
  }
  return { ok: false, motivo: resultado.erro };
}

