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
 *
 * ## #4517 — a MESMA transição, agora por token
 *
 * Fechar por integração tem de ser o mesmo `fn_service_status` da tela: a
 * revisão, o carimbo de atendimento e a demanda são regras do BANCO, e uma
 * segunda implementação (um UPDATE em `status`) as pularia em silêncio. A
 * sequência inteira mora em `./_handler.ts` (`fecharConversaHandler`), chamada
 * por esta rota e pela ferramenta do agente.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ESCOPO_CONVERSAS_ESCRITA } from "@/lib/api/escopos-do-token";
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { fecharConversaHandler } from "../_handler";

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

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "conversations",
    role: "agent",
    scope: ESCOPO_CONVERSAS_ESCRITA,
    tokenRole: "agent",
  });
  if (!authz.ok) return authz.response;
  // #1999 — rota de `PUBLIC_PATHS`: o `proxy.ts` não decide sobre ela e nada a
  // montante conta as chamadas. Sem este teto, o Bearer escreve sem cota. A
  // sessão passa sem contagem (quem digita é uma pessoa).
  const teto = await tetoDeEscritaDoToken(authz, "conversations", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");

  try {
    const { conversation, devolucao } = await fecharConversaHandler(
      authz.supabase,
      {
        organization_id: authz.organizationId,
        actor: authz.actor,
        requestId,
        idioma: authz.idioma,
        ...(authz.apiTokenId !== undefined ? { apiTokenId: authz.apiTokenId } : {}),
      },
      id,
      {
        ...(parsed.data.expected_revision !== undefined
          ? { expectedRevision: parsed.data.expected_revision }
          : {}),
        ...(parsed.data.devolver_ao_automatico !== undefined
          ? { devolverAoAutomatico: parsed.data.devolver_ao_automatico }
          : {}),
      },
    );

    return ok(devolucao === null ? conversation : { ...conversation, devolucao }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, t(err.message), err.status, { requestId });
    throw err;
  }
}
