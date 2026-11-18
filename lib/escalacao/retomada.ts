/**
 * Devolver o atendimento ao agente — a regra, num lugar só.
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * `POST /conversations/[id]/reactivate-bot` limpava `bot_silenced_until` e
 * declarava `{ reactivated: true }`. Só que a passagem para humano tem TRÊS
 * travas, não uma, e ela soltava a mais fraca:
 *
 *   1. `contacts.force_human = true`   → `workers/ai-response-worker.ts` pula com
 *      `skip("force_human")`, `isLeadInHandoff` (harness) devolve true antes de
 *      qualquer chamada de modelo, e `before-send.ts` veta TODO envio com
 *      `(is_blocked or force_human) as stopped`;
 *   2. `conversations.assignee_kind = 'user'` → `skip("assigned_to_human")`;
 *   3. `conversations.bot_silenced_until` → a única que era limpa.
 *
 * Ninguém, em lugar nenhum do repo, escrevia `force_human = false`. Ou seja: o
 * botão de devolver o atendimento não devolvia nada, e o modo de falha era o pior
 * possível — a rota respondia sucesso e o agente ficava mudo para sempre.
 *
 * ## Por que a função e não a rota
 *
 * A tool do agente e a rota da tela precisam operar pela MESMA regra. Se a IA
 * devolvesse o atendimento por um caminho e a pessoa por outro, o sistema mentiria
 * para um dos dois — e este arquivo é justamente a prova de que isso acontece
 * quando a regra mora dentro do `route.ts`.
 *
 * `force_human` continua **irrevogável pelo agente** (a regra dura do harness):
 * quem chama isto decide devolver, e a tool que expõe esta função ao modelo é
 * marcada como capacidade de risco crítico — não entra ligada por pacote.
 *
 * ─── A trava PERMANENTE (issue 2379) ────────────────────────────────────────
 *
 * Existe uma segunda marca no contato, `contacts.ai_opt_out` (migration 0624):
 * "sempre atendimento humano". Ela é separada de `force_human` de propósito —
 * `force_human` nasce da escalação e morre aqui, e misturar os dois faria toda
 * escalação automática virar permanente.
 *
 * `ai_opt_out` é o pred que este arquivo consulta PRIMEIRO, antes de qualquer
 * escrita. Com ela ligada, devolver o comando é exatamente o gesto que a
 * operação pediu para não acontecer: a conversa ficaria com a IA de novo sem
 * ninguém decidir. Então a função recusa (`erro: "contato_sempre_humano"`) e o
 * estado volta intacto — silêncio, dono, `force_human` e autorização.
 *
 * A leitura sozinha não basta: a marca pode ser ligada entre ela e a escrita.
 * Por isso a PRIMEIRA escrita é a que limpa `force_human`, e ela carrega a
 * condição `ai_opt_out = false` no próprio UPDATE. Zero linhas = a marca está
 * ligada agora, e a função recusa antes de tocar em dono, silêncio ou
 * autorização. Se um passo seguinte falhar, a trava é restaurada.
 *
 * Os dois caminhos passam por aqui: o botão da tela/tool e o cron
 * `handoff-devolucao` (chama esta MESMA função com `origem.automatica`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { logger } from "@/lib/logger";
import { autorizarContatoParaIA } from "@/lib/ai/elegibilidade/autorizacao";

import { lerContinuidadeHumana, type ContinuidadeHumana } from "./continuidade";

export interface RetomadaDeps {
  /** Admin client (service role) OU client do request — os dois filtram org aqui. */
  supabase: SupabaseClient;
  organizationId: string;
  actor: Actor;
  requestId: string;
  apiTokenId?: string | null;
}

export type RetomadaFalha =
  | "conversation_not_found"
  /** Alguém assumiu a conversa entre a leitura e a escrita. */
  | "assignment_conflict"
  /** O sinal de retomada do follow-up não foi emitido — ver comentário abaixo. */
  | "resume_signal_failed"
  /**
   * Contato marcado "sempre atendimento humano" (`contacts.ai_opt_out`,
   * migration 0624 / issue 2379). NÃO é falha técnica e NÃO é corrida: é o
   * estado que a operação pediu, então o chamador loga como recusa esperada
   * (cron `handoff-devolucao`) em vez de como erro.
   */
  | "contato_sempre_humano"
  /**
   * A leitura da marca permanente falhou. Fail-closed: sem ler `ai_opt_out` não
   * dá para provar que a devolução é segura, então nada é escrito — mesmo
   * custo de um defeito de banco, e nunca o de devolver um contato que pediu
   * para ficar com humano.
   */
  | "contact_state_unreadable";

/**
 * De onde veio a devolução. Ausente = alguém clicou (tela ou tool do agente).
 * `automatica` = o prazo de `settings.routing.handoff_return_after_minutes`
 * venceu sem sinal humano (cron `handoff-devolucao`) — o rastro tem de dizer
 * isso, senão a linha do tempo mostra "devolvido ao agente" sem ninguém ter
 * devolvido, e quem lê procura o colega que clicou.
 */
export type OrigemDaRetomada = { automatica: { minutos: number } };

export type RetomadaResultado =
  | {
      ok: true;
      conversationId: string;
      /** true = já estava com o agente; a operação é idempotente. */
      jaEstavaComOAgente: boolean;
      continuidade: ContinuidadeHumana;
    }
  | { ok: false; erro: RetomadaFalha; detalhe?: string };

/** Status em que faz sentido devolver o comando ao agente (encerrada, não). */
const STATUS_REATIVAVEIS = new Set(["open", "pending", "claimed", "ai_handling"]);

interface ConversaRow {
  id: string;
  contact_id: string | null;
  status: string | null;
  assigned_to_user_id: string | null;
  assignee_kind: string | null;
  bot_silenced_until: string | null;
}

export async function devolverAtendimentoAoAgente(
  deps: RetomadaDeps,
  input: {
    conversationId: string;
    origem?: OrigemDaRetomada;
    /** Dono autorizado pela rota; ausente nos chamadores automáticos. null é uma precondição. */
    expectedAssignee?: string | null;
  },
): Promise<RetomadaResultado> {
  const { supabase, organizationId } = deps;

  const { data: convData, error: convErr } = await supabase
    .from("conversations")
    .select("id, contact_id, status, assigned_to_user_id, assignee_kind, bot_silenced_until")
    .eq("id", input.conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (convErr) return { ok: false, erro: "conversation_not_found", detalhe: convErr.message };
  if (!convData) return { ok: false, erro: "conversation_not_found" };
  const conv = convData as unknown as ConversaRow;
  // A autorização da rota não se transfere para quem assumiu depois dela.
  // Recusa antes da primeira escrita no contato, inclusive quando estava vaga.
  if (input.expectedAssignee !== undefined && conv.assigned_to_user_id !== input.expectedAssignee) {
    return { ok: false, erro: "assignment_conflict" };
  }

  // (0) A TRAVA PERMANENTE (issue 2379) — ANTES de ler continuidade e, sobretudo,
  // antes de escrever qualquer coisa. `contacts.ai_opt_out` diz que este contato
  // é de atendimento humano para sempre, e a devolução é justamente o caminho
  // que antigamente desfazia a marca sem ninguém decidir (o cron automático
  // chama esta MESMA função). Nada aqui mexe em silêncio, dono, `force_human` nem
  // autorização: o estado volta intacto e quem chamou decide o que fazer com a
  // recusa. Fail-closed na leitura: erro de banco não pode virar devolução.
  let travaEstavaLigada = false;
  if (conv.contact_id !== null) {
    const { data: contatoData, error: contatoLeituraErr } = await supabase
      .from("contacts")
      .select("ai_opt_out, force_human")
      .eq("id", conv.contact_id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (contatoLeituraErr) {
      return { ok: false, erro: "contact_state_unreadable", detalhe: contatoLeituraErr.message };
    }
    const contato = contatoData as { ai_opt_out?: boolean; force_human?: boolean } | null;
    if (contato?.ai_opt_out === true) return recusarSempreHumano(input, conv.contact_id);
    travaEstavaLigada = contato?.force_human === true;

    // (0b) A trava que ninguém soltava, AGORA a primeira escrita — e condicionada
    // à marca no MESMO comando. Sem esta linha as outras não servem de nada: os
    // três guards (worker nativo, harness, before-send) leem `force_human`.
    // `ai_opt_out` é NOT NULL, então `= false` é o mesmo que `is not true`.
    const { data: liberado, error: contatoErr } = await supabase
      .from("contacts")
      .update({ force_human: false })
      .eq("id", conv.contact_id)
      .eq("organization_id", organizationId)
      .eq("ai_opt_out", false)
      .select("id")
      .maybeSingle();
    if (contatoErr) {
      logger.error("[escalacao.retomada] force_human não foi limpo", {
        conversation_id: input.conversationId,
        error: contatoErr.message,
      });
      return { ok: false, erro: "assignment_conflict", detalhe: contatoErr.message };
    }
    // Zero linhas: a marca foi ligada depois da leitura acima. Nada mais é escrito.
    if (!liberado) return recusarSempreHumano(input, conv.contact_id);
  }

  const jaEstavaComOAgente =
    conv.assigned_to_user_id === null &&
    conv.bot_silenced_until === null &&
    conv.assignee_kind !== "user";

  // A continuidade é lida ANTES de mexer em qualquer coisa: depois da devolução o
  // chamado pode ser fechado por outro caminho e o rastro do que a pessoa fez
  // ficaria mais pobre justamente no momento em que ele importa.
  const continuidade = await lerContinuidadeHumana(
    supabase,
    organizationId,
    input.conversationId,
  );

  // (1) Solta somente o dono que a rota autorizou. A RPC compara sob lock
  // da linha; perder a comparação retorna SETOF vazio, sem erro SQL. A ausência
  // desse recibo também recusa antes dos efeitos de retomada. Cron/tool sem
  // precondição explícita conservam o contrato de liberação anterior.
  if (conv.assigned_to_user_id !== null) {
    const exigeDono = input.expectedAssignee !== undefined;
    const { data: liberadas, error: releaseErr } = await supabase.rpc("fn_conversation_assign", {
      p_organization_id: organizationId,
      p_conversation_id: input.conversationId,
      p_to_user_id: null,
      p_reason: "release",
      p_expected_assignee: exigeDono ? input.expectedAssignee : null,
      p_enforce_expected: exigeDono,
    });
    const recibo = Array.isArray(liberadas) && liberadas.length === 1 &&
      (liberadas[0] as { id?: unknown } | null)?.id === input.conversationId;
    if (releaseErr || (exigeDono && !recibo)) {
      await restaurarTrava(deps, conv.contact_id, travaEstavaLigada);
      return { ok: false, erro: "assignment_conflict", ...(releaseErr ? { detalhe: releaseErr.message } : {}) };
    }
  }

  // (2) Devolve o comando. `assignee_kind='ai'` exige `assigned_to_user_id is
  // null` (CHECK conversations_assignee_kind_coherence) — o filtro `.is(...)` é o
  // guarda otimista: se alguém assumiu entre o release e aqui, 0 linhas e a gente
  // reporta o conflito em vez de estourar a constraint.
  const proximoStatus = STATUS_REATIVAVEIS.has(conv.status ?? "")
    ? "ai_handling"
    : (conv.status ?? "open");
  const { data: atualizada, error: updErr } = await supabase
    .from("conversations")
    .update({
      bot_silenced_until: null,
      last_handoff_at: null,
      last_handoff_reason: null,
      assignee_kind: "ai",
      status: proximoStatus,
      status_changed_at: new Date().toISOString(),
    })
    .eq("id", input.conversationId)
    .eq("organization_id", organizationId)
    .is("assigned_to_user_id", null)
    .select("id")
    .maybeSingle();
  if (updErr || !atualizada) {
    await restaurarTrava(deps, conv.contact_id, travaEstavaLigada);
    return updErr
      ? { ok: false, erro: "assignment_conflict", detalhe: updErr.message }
      : { ok: false, erro: "assignment_conflict" };
  }

  // (3b) ELEGIBILIDADE: devolver o atendimento à IA é uma decisão humana
  // explícita — no gate `allowlist`, é ela que RE-AUTORIZA o contato. Sem isto,
  // o botão "devolver ao automático" apagaria as três travas de handoff e a IA
  // continuaria muda, porque `contacts.ai_authorized_at` seguiria nulo/expirado.
  if (conv.contact_id !== null) {
    await autorizarContatoParaIA(supabase, {
      organizationId,
      contactId: conv.contact_id,
      // A automática entra como regra de automação — é o que ela é — e não
      // como "manual": `ai_authorized_reason` é lido por quem investiga por
      // que a IA voltou a falar com um contato.
      reason: input.origem ? "automacao:devolucao_apos_prazo" : "retomada_manual",
    });
  }

  // (3c) A PASSAGEM SE FECHA. O episódio acabou sem ninguém assumir — e é isso
  // que `reconhecido_em` preenchido COM `reconhecido_por` nulo significa.
  //
  // Sem esta chamada o dedup do aviso impede a PRÓXIMA passagem de nascer: o
  // aviso daquela conversa continua `open`, o motor o trata como episódio vivo,
  // e o cliente que pedir um atendente de novo não gera aviso nenhum.
  //
  // `fn_passagem_devolvida` e não um `update` daqui: a policy da tabela é `for
  // select` apenas, então o client de sessão não tem `update` — de propósito,
  // para que ninguém reescreva um fato. Falha aqui NÃO derruba a devolução: o
  // comando já voltou para a IA, e um aviso que sobra é recuperável pela tela.
  const { error: passagemErr } = await supabase.rpc("fn_passagem_devolvida", {
    p_organization_id: organizationId,
    p_conversation_id: input.conversationId,
  });
  if (passagemErr) {
    logger.warn("[escalacao.retomada] passagem não foi fechada", {
      conversation_id: input.conversationId,
      error: passagemErr.message,
    });
  }

  // (4) Sinal durável de fim do episódio. AWAITED, não fire-and-forget, pela
  // mesma razão que a rota original documentava: é o ÚNICO produtor do sinal que
  // retoma um follow-up pausado por passagem a humano (lib/followup/reactivity.ts).
  // Perder aqui órfã o enrollment para sempre.
  const { error: emitErr } = await supabase.rpc("emit_event", {
    p_event_type: "ai.handoff_resolved",
    p_entity_kind: "conversation",
    p_entity_id: input.conversationId,
    p_payload: {
      conversation_id: input.conversationId,
      contact_id: conv.contact_id,
      organization_id: organizationId,
    },
    p_metadata: { source: "escalacao.retomada", request_id: deps.requestId },
    p_organization_id: organizationId,
  });
  if (emitErr) {
    return { ok: false, erro: "resume_signal_failed", detalhe: emitErr.message };
  }

  // (5) O input estruturado que a IA lê para retomar (invariante 2 da doutrina).
  if (conv.contact_id !== null && continuidade.houveAtendimentoHumano) {
    await gravarCheckpointDeRetomada(supabase, organizationId, conv.contact_id, continuidade);
  }

  // (6) Passagem de atendimento é evento de vida do negócio — a ida já emitia
  // `handoff_triggered` e a volta não emitia nada, então a linha do tempo mostrava
  // o cliente saindo para uma pessoa e nunca voltando.
  if (conv.contact_id !== null) {
    await emitirAtividadeDeRetomada(
      deps,
      conv.contact_id,
      input.conversationId,
      continuidade,
      input.origem,
    );
  }

  await audit({
    action: "ai.reactivated_by_agent",
    actorUserId: deps.actor.type === "user" ? deps.actor.id : null,
    actorApiTokenId: deps.apiTokenId ?? null,
    organizationId,
    resourceType: "conversation",
    resourceId: input.conversationId,
    requestId: deps.requestId,
    metadata: {
      actor_type: deps.actor.type,
      houve_atendimento_humano: continuidade.houveAtendimentoHumano,
      decisoes: continuidade.decisoes.length,
      notas: continuidade.notas.length,
      ...(input.origem ? { automatica: true, apos_minutos: input.origem.automatica.minutos } : {}),
    },
  });

  return { ok: true, conversationId: input.conversationId, jaEstavaComOAgente, continuidade };
}

function recusarSempreHumano(
  input: { conversationId: string; origem?: OrigemDaRetomada },
  contactId: string,
): RetomadaResultado {
  logger.info("[escalacao.retomada] devolução recusada: contato é sempre atendimento humano", {
    conversation_id: input.conversationId,
    contact_id: contactId,
    origem: input.origem ? "automatica" : "manual",
  });
  return { ok: false, erro: "contato_sempre_humano" };
}

/**
 * A devolução falhou depois de limpar `force_human`: a trava volta ao que era.
 * Devolver metade (conversa com humano e contato destravado) é pior que não
 * devolver. Falha aqui só loga — o erro original é o que o chamador precisa ver.
 */
async function restaurarTrava(
  deps: RetomadaDeps,
  contactId: string | null,
  estavaLigada: boolean,
): Promise<void> {
  if (contactId === null || !estavaLigada) return;
  const { error } = await deps.supabase
    .from("contacts")
    .update({ force_human: true })
    .eq("id", contactId)
    .eq("organization_id", deps.organizationId);
  if (error) {
    logger.error("[escalacao.retomada] force_human não foi restaurado após falha", {
      contact_id: contactId,
      error: error.message,
    });
  }
}

/**
 * O texto do que a pessoa fez entra na memória durável do lead.
 *
 * Escolhido em vez de uma tabela nova porque `lead_checkpoints` já É o lugar onde
 * o agente busca contexto na abertura de TODO turno (`latestCheckpoint` →
 * `ritualBlocks` → bloco "Resumo acumulado da conversa"). Criar uma superfície
 * paralela exigiria um leitor novo no motor, e uma peça que só o autor sabe
 * consultar é ilha — a doutrina do sistema vivo é exatamente contra isso.
 *
 * O resumo é ACRESCENTADO ao anterior, nunca substituído: sobrescrever apagaria o
 * histórico da conversa justamente para contar um pedaço dela.
 */
async function gravarCheckpointDeRetomada(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  continuidade: ContinuidadeHumana,
): Promise<void> {
  const { data: anteriorData } = await supabase
    .from("lead_checkpoints")
    .select("commitments, objections, next_action, rolling_summary")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  const anterior = (anteriorData ?? null) as {
    commitments: unknown;
    objections: unknown;
    next_action: string | null;
    rolling_summary: string | null;
  } | null;

  const acumulado = (anterior?.rolling_summary ?? "").trim();
  const { error } = await supabase.from("lead_checkpoints").insert({
    organization_id: organizationId,
    contact_id: contactId,
    // Não nasceu de um run do agente — a pessoa é que devolveu o atendimento.
    job_id: null,
    commitments: anterior?.commitments ?? [],
    objections: anterior?.objections ?? [],
    next_action: continuidade.pendenciaComOCliente ?? anterior?.next_action ?? null,
    rolling_summary:
      acumulado === "" ? continuidade.resumo : `${acumulado}\n\n${continuidade.resumo}`,
  });
  if (error) {
    // Sem o checkpoint o agente volta CEGO — isso é degradação de verdade, e
    // silenciar aqui reproduziria o defeito que este arquivo conserta.
    logger.error("[escalacao.retomada] checkpoint de retomada não foi gravado", {
      contact_id: contactId,
      error: error.message,
    });
  }
}

/** A volta na linha do tempo do negócio. Fire-and-forget: timeline não derruba operação. */
async function emitirAtividadeDeRetomada(
  deps: RetomadaDeps,
  contactId: string,
  conversationId: string,
  continuidade: ContinuidadeHumana,
  origem?: OrigemDaRetomada,
): Promise<void> {
  const { data: leadsData } = await deps.supabase
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
    .eq("organization_id", deps.organizationId)
    .eq("contact_id", contactId);
  const { data: defaultPipeline } = await deps.supabase
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", deps.organizationId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();

  const alvo = resolveActiveLeadForContact((leadsData ?? []) as LeadCandidate[], {
    defaultPipelineId: (defaultPipeline as { id: string } | null)?.id ?? null,
  });
  if (!alvo.routed) return;

  const resultado = await emitLeadActivity(deps.supabase, {
    organizationId: deps.organizationId,
    leadId: alvo.leadId,
    contactId,
    type: "handoff_resolved",
    sourceModule: "escalacao.retomada",
    sourceId: conversationId,
    actor: deps.actor,
    reason: origem
      ? `Atendimento devolvido ao agente automaticamente após ${origem.automatica.minutos} min sem resposta da equipe`
      : continuidade.houveAtendimentoHumano
        ? "Atendimento devolvido ao agente com o registro do que a equipe decidiu"
        : "Atendimento devolvido ao agente",
    payload: {
      conversation_id: conversationId,
      decisoes: continuidade.decisoes.length,
      notas: continuidade.notas.length,
      ...(origem ? { automatica: true, apos_minutos: origem.automatica.minutos } : {}),
    },
  });
  if (!resultado.ok) {
    logger.warn("[escalacao.retomada] atividade da volta não foi gravada", {
      conversation_id: conversationId,
      error: resultado.error,
    });
  }
}
