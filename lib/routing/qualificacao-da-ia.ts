/**
 * "A IA AINDA ESTÁ QUALIFICANDO ESTA CONVERSA?" (issue #3966) — uma pergunta, um
 * lugar.
 *
 * ## O defeito que isto fecha
 *
 * Com **rodízio** ou **carga** ligados, a conversa é distribuída NO NASCIMENTO:
 * `trg_conversation_routing_requested` (AFTER INSERT em `conversations`) emite
 * `conversation.routing_requested` e o `routing-worker` entrega — em menos de um
 * minuto, antes de a IA terminar de qualificar. A atribuição grava
 * `assignee_kind = 'user'` (`fn_conversation_assign`, migration 9208) e o gate da
 * IA cala o agente com o motivo `conversa_de_humano`: a própria fila desligava a
 * IA que deveria qualificar, e o lead ficava esperando uma pessoa.
 *
 * ## A régua
 *
 * É OPÇÃO DO NÚMERO, desligada de fábrica, e tem PRAZO (decisão do dono no doc
 * 311): `channel_routing_policies.ai_wait_minutes`. Nulo = desligada, e o worker
 * nem chama este arquivo — o comportamento é o de sempre. Preenchido = espera
 * no máximo aquele tanto de minutos; passou disso sem a IA passar a conversa,
 * ela entra na distribuição e a Central avisa (`prazoDaEspera`, mais abaixo).
 *
 * Só há o que adiar quando as QUATRO coisas valem:
 *
 *   · existe agente de IA publicado e no ar que atende ESTE número — quem
 *     responde é `resolverAgenteDaConversa`, a mesma régua do motor (stickiness
 *     da conversa → versão publicada na sessão → agente único da organização);
 *   · a conversa ainda NÃO passou por um handoff: `last_handoff_at` nulo. Ele é o
 *     marcador durável de "a qualificação terminou" — quem o grava é
 *     `performHumanHandoff` (motor nativo) e quem o limpa é o `reactivate-bot`,
 *     quando a IA volta a atender. A passagem emite o pedido de roteamento UMA
 *     vez (gatilho `trg_routing_assignment_changed`, migration 9333);
 *   · o agente não está CALADO (`bot_silenced_until` no futuro): pausa manual da
 *     IA não é qualificação em curso — é justamente o contrário;
 *   · não há um humano com a conversa (o worker já corta `alreadyAssigned`
 *     antes; a leitura fica registrada aqui para o motivo não depender de ordem).
 *
 * Qualquer uma que falte ⇒ **distribui**. Sem IA ligada, ou com a opção do número
 * desligada, a conversa continua sendo entregue no nascimento como antes: é o
 * que impede a mudança de virar atraso geral em quem nunca pediu a espera.
 *
 * ## Falha de leitura distribui (falha ABERTA)
 *
 * Se a leitura do agente estourar, a resposta é `false` e a conversa segue para a
 * fila. É a mesma escolha de `motivoDoCasoParaRoteamento` (`worker.ts`): não saber
 * não pode virar fila parada para todo mundo. O que se perde no caso raro é o
 * comportamento ANTIGO (entrega durante a qualificação) — que o handoff seguinte
 * conserta, porque reemite o pedido uma vez.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolverAgenteDaConversa, type CandidatoDeAgente } from "@/lib/ai/agents/agente-da-conversa";
import { logger } from "@/lib/logger";

/** Os fatos de que a regra precisa. Puro: sem banco, sem relógio implícito. */
export interface FatosDaQualificacao {
  /** Há agente de IA publicado e no ar atendendo este número. */
  iaAtendeOCanal: boolean;
  /** A conversa já foi passada para humano (`last_handoff_at` gravado). */
  passouParaHumano: boolean;
  /** O agente está calado agora (`bot_silenced_until` no futuro). */
  agenteCalado: boolean;
  /** A conversa já tem um humano (`assigned_to_user_id`/`assignee_kind='user'`). */
  comHumano: boolean;
}

/**
 * A regra, na forma que o `decideRouting` consome. `true` ⇒ o worker marca o
 * evento como "a IA está qualificando" e não distribui.
 */
export function qualificacaoEmCurso(f: FatosDaQualificacao): boolean {
  if (!f.iaAtendeOCanal) return false;
  if (f.passouParaHumano) return false;
  if (f.agenteCalado) return false;
  if (f.comHumano) return false;
  return true;
}

/**
 * O que o worker guarda em `event_log.metadata.espera_pela_ia` enquanto o pedido
 * espera a IA. `desde` é o instante em que a espera começou; `avisada` impede
 * que o aviso da Central se repita a cada nova tentativa depois do prazo.
 */
export interface EsperaPelaIA {
  desde: string;
  avisada?: boolean;
}

/** Lê a marca do `metadata` do evento sem confiar na forma. Lixo ⇒ `null`. */
export function lerEsperaPelaIA(metadata: Record<string, unknown> | null): EsperaPelaIA | null {
  const bruto = metadata?.espera_pela_ia;
  if (!bruto || typeof bruto !== "object") return null;
  const { desde, avisada } = bruto as { desde?: unknown; avisada?: unknown };
  if (typeof desde !== "string" || Number.isNaN(Date.parse(desde))) return null;
  return { desde, avisada: avisada === true };
}

/**
 * O PRAZO MÁXIMO da espera. Conta do instante em que a espera começou (a
 * primeira vez que o worker adiou ESTE pedido), e não de cada mensagem: reiniciar
 * a cada fala deixaria o cliente que conversa muito e nunca é passado sem
 * nenhuma pessoa para sempre. `vencida` ⇒ a conversa entra na distribuição.
 *
 * Pura: sem banco e sem relógio implícito.
 */
export function prazoDaEspera(
  espera: EsperaPelaIA | null,
  agora: Date,
  minutos: number,
): { desde: string; ate: string; vencida: boolean; avisada: boolean } {
  const desde = espera?.desde ?? agora.toISOString();
  const ate = new Date(Date.parse(desde) + minutos * 60_000);
  return {
    desde,
    ate: ate.toISOString(),
    vencida: agora.getTime() >= ate.getTime(),
    avisada: espera?.avisada === true,
  };
}

/** `bot_silenced_until > agora` — o mesmo predicado do gate da IA. */
export function silenciadoAgora(ate: string | null, agora: Date): boolean {
  if (ate === null) return false;
  const t = Date.parse(ate);
  if (Number.isNaN(t)) return false;
  return t > agora.getTime();
}

/** Os campos da conversa de que a leitura precisa (select explícito no worker). */
export interface ConversaParaQualificar {
  channel_session_id: string | null;
  active_ai_agent_id: string | null;
  bot_silenced_until: string | null;
  last_handoff_at: string | null;
  assigned_to_user_id: string | null;
}

/**
 * Lê o que falta e aplica a regra. As três leituras são as MESMAS de
 * `lib/escalacao/comando-de-canal.ts` — stickiness, versões publicadas no número
 * e candidatos da organização —, pela mesma função de resolução; nenhuma regra
 * nova de "quem atende este número" nasce aqui.
 */
export async function lerQualificacaoDaIA(
  supabase: Pick<SupabaseClient, "from">,
  organizationId: string,
  conversa: ConversaParaQualificar,
  agora: Date,
): Promise<boolean> {
  try {
    let versoesPublicadasNaSessao: string[] = [];
    if (conversa.channel_session_id) {
      const { data: versoes, error: versoesErr } = await supabase
        .from("ai_agent_versions")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("channel_session_id", conversa.channel_session_id)
        .eq("status", "published");
      if (versoesErr) throw new Error(versoesErr.message);
      versoesPublicadasNaSessao = (versoes ?? []).map((v) => v.id as string);
    }

    const { data: candidatos, error: agentesErr } = await supabase
      .from("ai_agents")
      .select("id, kind, is_active, paused_at, published_version_id, archived_at, priority, created_at")
      .eq("organization_id", organizationId)
      .is("archived_at", null);
    if (agentesErr) throw new Error(agentesErr.message);

    const { agente } = resolverAgenteDaConversa(
      (candidatos ?? []) as CandidatoDeAgente[],
      {
        active_ai_agent_id: conversa.active_ai_agent_id,
        versoesPublicadasNaSessao,
      },
    );

    return qualificacaoEmCurso({
      iaAtendeOCanal: agente !== null,
      passouParaHumano: conversa.last_handoff_at !== null,
      agenteCalado: silenciadoAgora(conversa.bot_silenced_until, agora),
      comHumano: conversa.assigned_to_user_id !== null,
    });
  } catch (err) {
    // Falha ABERTA, com rastro: não saber se há agente não pode parar a fila de
    // quem não tem IA. O detalhe vai para o log porque `false` silencioso é
    // indistinguível de "não há agente" — e é justamente o que se investigaria.
    logger.warn("[routing] não consegui ler o agente da conversa — distribuindo como antes", {
      organization_id: organizationId,
      channel_session_id: conversa.channel_session_id,
      error: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
    return false;
  }
}
