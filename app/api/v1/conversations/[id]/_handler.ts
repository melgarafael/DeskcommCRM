import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * OS COMANDOS DE UMA CONVERSA, num lugar só (#4517).
 *
 * ─── Por que este arquivo existe ──────────────────────────────────────────
 *
 * Pausar a IA, retomar, fechar e reabrir viviam dentro das rotas — cada uma com
 * seu `requireRole`, sua leitura e sua escrita. A issue #4517 pede os mesmos
 * quatro gestos por TOKEN, e a saída óbvia (uma segunda cópia da regra em cada
 * rota nova) é exatamente o defeito que `lib/escalacao/retomada.ts` foi extraído
 * para consertar: duas cópias divergem na primeira mudança, e o sistema passa a
 * mentir para um dos dois lados.
 *
 * Então a regra desceu para cá. As rotas (cookie e Bearer) e as ferramentas do
 * agente chamam ESTAS funções, e a diferença entre elas passa a ser só QUEM
 * autenticou — nunca O QUE acontece.
 *
 * ─── O que o token NÃO pode fazer, e é critério de aceite ─────────────────
 *
 * **Pausar não assume, e retomar não solta.** `assignee_kind='user'` é veto
 * absoluto da IA (lib/ai/elegibilidade/gate.ts). A tela usa esse veto ao
 * contrário: pausar sem dono faz `claim` (pausar sem dono deixaria a conversa
 * sem ator nenhum), e retomar faz `release` do dono.
 *
 * Uma integração não é uma pessoa: ela não tem carteira, não entra na fila e não
 * pode tirar a conversa de quem a está tocando. Por isso o caminho dela é:
 *
 *  - pausar: SÓ `bot_silenced_until` (e o motivo). Sem `claim`, nunca;
 *  - retomar: SÓ `bot_silenced_until`. Se um humano é dono, o automático continua
 *    vetado — e a resposta DIZ isso (`automacao_liberada: false`), em vez de
 *    devolver `reactivated: true` e deixar a integração achando que voltou.
 *
 * Em nenhum dos dois o `crm_leads` do contato é tocado: o dono do NEGÓCIO é do
 * funil, não do atendimento, e `transfer` é que troca os dois. É o que separa
 * este caminho do atalho que a issue veio matar (pausar via transferência).
 */

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { roleAtLeast } from "@/lib/auth/types";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { exigirControleDaConversa } from "@/lib/inbox/controle-da-conversa";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Conversation } from "@/lib/types/messaging";

/** O mesmo literal do handoff: `bot_silenced_until > now()` é sempre verdadeiro. */
export const SILENCIO_DURAVEL = "infinity";

/** O motivo canônico (português; quem traduz é a LEITURA da timeline). */
export const MOTIVO_PAUSA_HUMANA = "Automático pausado pelo atendente";
export const MOTIVO_PAUSA_INTEGRACAO = "Automático pausado pela integração";

/** O ctx do handler, e nada além: é ele que as rotas e as tools montam. */
export type CtxDoComando = Pick<
  HandlerCtx,
  "organization_id" | "actor" | "requestId" | "idioma" | "apiTokenId"
>;

interface LinhaDaConversa {
  id: string;
  organization_id: string;
  contact_id: string | null;
  status: string;
  assigned_to_user_id: string | null;
  assignee_kind: string | null;
  service_revision: number;
  bot_silenced_until: string | null;
}

async function lerConversa(
  supabase: SupabaseClient,
  ctx: CtxDoComando,
  conversationId: string,
): Promise<LinhaDaConversa> {
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id, organization_id, contact_id, status, assigned_to_user_id, assignee_kind, service_revision, bot_silenced_until",
    )
    .eq("id", conversationId)
    // ⚠️ O FILTRO DE ORGANIZAÇÃO É A ÚNICA BARREIRA no caminho do token: com
    // service role não há RLS, e um id de outro tenant tem de virar 404 aqui —
    // não "conversa de outro atendente", não escrita silenciosa.
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  if (!data) throw new ApiError(404, "not_found", "Conversa não encontrada.", ctx.requestId);
  return data as unknown as LinhaDaConversa;
}

/** A linha de auditoria assinada por quem agiu — pessoa ou token. */
function autorDoAudit(ctx: CtxDoComando) {
  if (ctx.actor.type === "user") {
    return { actorUserId: ctx.actor.id, actorApiTokenId: null as string | null };
  }
  return { actorUserId: null, actorApiTokenId: ctx.apiTokenId ?? ctx.actor.id };
}

// ───────────────────────────────────────────────────────────────────────────
// PAUSAR
// ───────────────────────────────────────────────────────────────────────────

export interface ResultadoDaPausa {
  conversation: Conversation;
  assumiu_ao_pausar: boolean;
}

/**
 * Desliga o atendimento automático desta conversa.
 *
 * `assumiu_ao_pausar` só é `true` quando uma PESSOA pausou uma conversa sem
 * dono e o `claim` aconteceu (comportamento da tela, preservado). Para o token é
 * sempre `false`, e a conversa sem dono CONTINUA sem dono: pausar não é assumir.
 */
export async function pausarIaHandler(
  supabase: SupabaseClient,
  ctx: CtxDoComando,
  conversationId: string,
): Promise<ResultadoDaPausa> {
  const conv = await lerConversa(supabase, ctx, conversationId);

  if (conv.status === "closed" || conv.status === "archived") {
    throw new ApiError(
      409,
      "state_conflict",
      "Esta conversa está encerrada — não há atendimento automático a pausar.",
    );
  }

  const ehPessoa = ctx.actor.type === "user";
  let assumiu = false;

  if (ehPessoa && conv.assigned_to_user_id === null) {
    // Sem dono: quem pausa assume — invariante 4 do Sistema Vivo (nenhuma
    // demanda sem próximo passo). Só a PESSOA faz isto; o token não tem carteira.
    const { data: atribuida, error: rpcErr } = await supabase.rpc("fn_conversation_assign", {
      p_organization_id: ctx.organization_id,
      p_conversation_id: conversationId,
      p_to_user_id: ctx.actor.id,
      p_reason: "claim",
      p_expected_assignee: null,
      p_enforce_expected: true,
    });
    if (rpcErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, rpcErr.message);
    if (!atribuida || (atribuida as unknown[]).length === 0) {
      throw new ApiError(409, "state_conflict", "Outro atendente assumiu esta conversa agora.");
    }
    assumiu = true;
  }

  // Com dono (o próprio ou outro): SÓ o silêncio. Pausar o automático e trocar o
  // dono são gestos diferentes — e é a linha que a sabotagem nº 2 ataca.
  const { data: atualizada, error: updErr } = await supabase
    .from("conversations")
    .update({
      bot_silenced_until: SILENCIO_DURAVEL,
      last_handoff_reason: ehPessoa ? MOTIVO_PAUSA_HUMANA : MOTIVO_PAUSA_INTEGRACAO,
    })
    .eq("id", conversationId)
    .eq("organization_id", ctx.organization_id)
    .select(
      "id, contact_id, organization_id, status, assigned_to_user_id, bot_silenced_until",
    )
    .maybeSingle();
  if (updErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  if (!atualizada) throw new ApiError(404, "not_found", "Conversa não encontrada.");

  const autor = autorDoAudit(ctx);
  await audit({
    action: ehPessoa ? "conversation.ai_paused" : "conversation.ai_paused_by_token",
    actorUserId: autor.actorUserId,
    actorApiTokenId: autor.actorApiTokenId,
    organizationId: ctx.organization_id,
    resourceType: "conversation",
    resourceId: conversationId,
    requestId: ctx.requestId,
    metadata: { assumiu_ao_pausar: assumiu },
  });

  // O log que aparece na TELA (invariante 3: log invisível é log morto).
  await registrarTrocaDeComando({
    supabase,
    organizationId: ctx.organization_id,
    conversationId,
    contactId: conv.contact_id,
    tipo: "conversation_ai_paused",
    actor: ctx.actor,
    motivo: assumiu
      ? "Assumiu a conversa e pausou o atendimento automático"
      : ehPessoa
        ? MOTIVO_PAUSA_HUMANA
        : MOTIVO_PAUSA_INTEGRACAO,
    payload: { assumiu_ao_pausar: assumiu },
  });

  return {
    conversation: atualizada as unknown as Conversation,
    assumiu_ao_pausar: assumiu,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// RETOMAR
// ───────────────────────────────────────────────────────────────────────────

export interface ResultadoDaRetomada {
  /** `false` quando uma pessoa segura a conversa ou o contato está travado. */
  automacao_liberada: boolean;
  /** `null` quando liberou; senão, o que segura o automático. */
  motivo_bloqueio: "responsavel_humano" | "contato_sempre_humano" | null;
  continuidade?: {
    houve_atendimento_humano: boolean;
    resumo: string | null;
    decisoes: number;
    notas: number;
  };
}

/**
 * Devolve o atendimento ao automático.
 *
 * DUAS ROTAS, UM EFEITO COMUM: o silêncio sai. A diferença é o que acontece com
 * o dono, e ela é a regra, não um detalhe:
 *
 *  - **pessoa**: `devolverAtendimentoAoAgente`, a função de sempre — solta as
 *    três travas e grava o checkpoint da retomada. É o botão da tela.
 *  - **token**: só `bot_silenced_until = null`. O dono humano NÃO é solto, o
 *    `contacts.force_human` NÃO é limpo (é trava do CONTATO, vale para todas as
 *    conversas dele, e só quem escala de verdade a escreve), e o negócio não é
 *    tocado. Se algum dos dois segue de pé, a resposta diz que o automático NÃO
 *    voltou — em vez de mentir `reactivated: true`.
 */
export async function retomarIaHandler(
  supabase: SupabaseClient,
  ctx: CtxDoComando,
  conversationId: string,
): Promise<ResultadoDaRetomada> {
  // O agente NÃO se des-trava: quem pausa é gente ou integração, e devolver o
  // comando a si mesmo é a porta que `lib/escalacao/retomada.ts` já fecha em voz
  // alta (`resume_requires_person`). A regra mora no handler, não no papel.
  if (ctx.actor.type === "ai_agent") {
    throw new ApiError(
      403,
      "forbidden",
      "Quem retoma o atendimento automático é uma pessoa ou uma integração autorizada — o próprio agente não se des-trava.",
    );
  }

  const conv = await lerConversa(supabase, ctx, conversationId);
  const autor = autorDoAudit(ctx);

  if (ctx.actor.type === "user") {
    // #3436 — conversa com dono que NÃO é quem pediu só volta pela mão de um
    // `manager` ou acima. A regra fica AQUI (e não em `devolverAtendimento…`)
    // porque o cron `handoff-devolucao` chama a mesma função sem sessão.
    const dono = conv.assigned_to_user_id;
    const papel = ctx.actor.role ?? "agent";
    if (dono !== null && dono !== ctx.actor.id && !roleAtLeast(papel, "manager")) {
      throw new ApiError(
        403,
        "forbidden",
        "Esta conversa é de outro atendente. Peça a um gerente ou assuma a conversa.",
      );
    }

    const resultado = await devolverAtendimentoAoAgente(
      {
        supabase,
        organizationId: ctx.organization_id,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      { conversationId, expectedAssignee: dono },
    );

    if (!resultado.ok) {
      if (resultado.erro === "conversation_not_found") {
        throw new ApiError(404, "not_found", "Conversa não encontrada.");
      }
      if (resultado.erro === "assignment_conflict") {
        throw new ApiError(
          409,
          "state_conflict",
          "Alguém assumiu esta conversa agora — recarregue e tente de novo.",
        );
      }
      if (resultado.erro === "contato_sempre_humano") {
        // NA TELA ESTE CASO É 409 (#2379): a marca permanente recusou ANTES de
        // qualquer escrita, e a mensagem genérica de sucesso mentiria. O
        // desfecho suave existe só para o token, que não tem tela para ler.
        throw new ApiError(
          409,
          "state_conflict",
          "Este contato está marcado como sempre atendimento humano. Para a IA voltar a atendê-lo, remova a marca na ficha do contato.",
        );
      }
      if (resultado.erro === "contact_state_unreadable") {
        throw new ApiError(
          500,
          "internal_error",
          "Não foi possível conferir o contato desta conversa — nada foi alterado. Tente de novo.",
        );
      }
      throw new ApiError(
        500,
        "internal_error",
        "Atendimento devolvido, mas o sinal de retomada do acompanhamento falhou — tente de novo.",
      );
    }

    return {
      automacao_liberada: true,
      motivo_bloqueio: null,
      continuidade: {
        houve_atendimento_humano: resultado.continuidade.houveAtendimentoHumano,
        resumo: resultado.continuidade.resumo,
        decisoes: resultado.continuidade.decisoes.length,
        notas: resultado.continuidade.notas.length,
      },
    };
  }

  // ── TOKEN: só o silêncio sai ─────────────────────────────────────────────
  const { error: updErr } = await supabase
    .from("conversations")
    .update({ bot_silenced_until: null })
    .eq("id", conversationId)
    .eq("organization_id", ctx.organization_id)
    // Nem `assigned_to_user_id` nem `assignee_kind` entram no payload: é uma
    // atualização de UMA coluna, e a sabotagem nº 2 é justamente acrescentar a
    // segunda.
    .select("id")
    .maybeSingle();
  if (updErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);

  const { data: contato } = await supabase
    .from("contacts")
    .select("force_human")
    .eq("id", conv.contact_id ?? "")
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  const contatoTravado = (contato as { force_human?: boolean } | null)?.force_human === true;

  const bloqueio: ResultadoDaRetomada["motivo_bloqueio"] =
    conv.assignee_kind === "user" || conv.assigned_to_user_id !== null
      ? "responsavel_humano"
      : contatoTravado
        ? "contato_sempre_humano"
        : null;

  await audit({
    action: "conversation.ai_resumed_by_token",
    actorUserId: autor.actorUserId,
    actorApiTokenId: autor.actorApiTokenId,
    organizationId: ctx.organization_id,
    resourceType: "conversation",
    resourceId: conversationId,
    requestId: ctx.requestId,
    metadata: { automacao_liberada: bloqueio === null, motivo_bloqueio: bloqueio },
  });

  return { automacao_liberada: bloqueio === null, motivo_bloqueio: bloqueio };
}

// ───────────────────────────────────────────────────────────────────────────
// FECHAR
// ───────────────────────────────────────────────────────────────────────────

export type DesfechoDaDevolucao = { ok: true } | { ok: false; motivo: string };

export interface ResultadoDoFechamento {
  conversation: Conversation;
  /** `null` = ninguém pediu devolução (é o caso do token, por padrão). */
  devolucao: DesfechoDaDevolucao | null;
}

/**
 * Fecha a conversa pelo `fn_service_status` — a MESMA transição da tela.
 *
 * A ordem é o conserto do CR #3323 e não pode ser trocada: devolver ANTES,
 * fechar DEPOIS. O `release` do `fn_conversation_assign` grava `status='open'`, e
 * gravar `open` numa conversa já `closed` é REABERTURA para os gatilhos do banco
 * (revisão +2, `service_started_at` regravado, `current_demanda_id` anulado, um
 * `conversation.routing_requested` para uma conversa encerrada).
 */
export async function fecharConversaHandler(
  supabase: SupabaseClient,
  ctx: CtxDoComando,
  conversationId: string,
  opcoes: { expectedRevision?: number; devolverAoAutomatico?: boolean } = {},
): Promise<ResultadoDoFechamento> {
  const conv = await lerConversa(supabase, ctx, conversationId);

  // O convite amplia leitura e resposta, não a autoridade sobre o atendimento.
  // Para token/agente a função é no-op (não são "user").
  await exigirControleDaConversa(supabase, ctx, conv);

  const revisaoEsperada = opcoes.expectedRevision ?? conv.service_revision;
  if (revisaoEsperada !== conv.service_revision) {
    throw new ApiError(409, "conflict", "O atendimento mudou. Atualize e tente novamente.");
  }

  let devolucao: DesfechoDaDevolucao | null = null;
  if (opcoes.devolverAoAutomatico === true) {
    const dono = conv.assigned_to_user_id;
    const papel = ctx.actor.role ?? "agent";
    if (ctx.actor.type === "user" && dono !== null && dono !== ctx.actor.id && !roleAtLeast(papel, "manager")) {
      // A recusa não é erro: fechar é o gesto pedido e segue. O motivo viaja.
      devolucao = { ok: false, motivo: "conversa_de_outro_atendente" };
    } else {
      const resultado = await devolverAtendimentoAoAgente(
        {
          supabase,
          organizationId: ctx.organization_id,
          actor: ctx.actor,
          requestId: ctx.requestId,
        },
        { conversationId, expectedAssignee: dono },
      );
      devolucao = resultado.ok ? { ok: true } : { ok: false, motivo: resultado.erro };
    }
  }

  const { data, error } = await createAdminClient().rpc("fn_service_status", {
    p_org: conv.organization_id,
    p_conversation: conversationId,
    p_status: "closed",
    p_expected: revisaoEsperada,
  });
  const conflito = error?.code === "PT409" || error?.code === "40001";
  if (error) {
    throw new ApiError(
      conflito ? 409 : 500,
      conflito ? "conflict" : "internal_error",
      conflito ? "O atendimento mudou. Atualize e tente novamente." : error.message,
    );
  }
  const fechada = data as unknown as Conversation;

  const autor = autorDoAudit(ctx);
  await audit({
    action: ctx.actor.type === "user" ? "conversation.closed" : "conversation.closed_by_token",
    actorUserId: autor.actorUserId,
    actorApiTokenId: autor.actorApiTokenId,
    organizationId: conv.organization_id,
    resourceType: "conversation",
    resourceId: conversationId,
    requestId: ctx.requestId,
  });

  return { conversation: fechada, devolucao };
}

// ───────────────────────────────────────────────────────────────────────────
// REABRIR
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reabre uma conversa fechada — a MESMA transição do botão "Reabrir" da tela
 * (`PATCH /api/v1/conversations/[id]` com `status: "open"`), que por baixo chama
 * `fn_service_status`. Não existe caminho alternativo: reabrir escrevendo
 * `status` na mão pularia a revisão, o carimbo de atendimento e a demanda.
 */
export async function reabrirConversaHandler(
  supabase: SupabaseClient,
  ctx: CtxDoComando,
  conversationId: string,
  opcoes: { expectedRevision?: number } = {},
): Promise<{ conversation: Conversation }> {
  const conv = await lerConversa(supabase, ctx, conversationId);
  await exigirControleDaConversa(supabase, ctx, conv);

  const revisaoEsperada = opcoes.expectedRevision ?? conv.service_revision;
  if (revisaoEsperada !== conv.service_revision) {
    throw new ApiError(409, "conflict", "O atendimento mudou. Atualize e tente novamente.");
  }

  const { data, error } = await createAdminClient().rpc("fn_service_status", {
    p_org: conv.organization_id,
    p_conversation: conversationId,
    p_status: "open",
    p_expected: revisaoEsperada,
  });
  const conflito = error?.code === "PT409" || error?.code === "40001";
  if (error) {
    throw new ApiError(
      conflito ? 409 : 500,
      conflito ? "conflict" : "internal_error",
      conflito ? "O atendimento mudou. Atualize e tente novamente." : error.message,
    );
  }
  const aberta = data as unknown as Conversation;

  const autor = autorDoAudit(ctx);
  await audit({
    action: ctx.actor.type === "user" ? "conversation.reopened" : "conversation.reopened_by_token",
    actorUserId: autor.actorUserId,
    actorApiTokenId: autor.actorApiTokenId,
    organizationId: conv.organization_id,
    resourceType: "conversation",
    resourceId: conversationId,
    requestId: ctx.requestId,
  });

  return { conversation: aberta };
}
