/**
 * Retomar ao devolver — o agente fala NA HORA quando a equipe devolve o
 * atendimento ao automático.
 *
 * ## O buraco que este arquivo fecha
 *
 * `devolverAtendimentoAoAgente` (./retomada.ts) solta as três travas e grava o
 * checkpoint, mas o agente só voltava a falar no PRÓXIMO inbound do cliente. O
 * caso comum é o oposto: a pessoa manda o orçamento, clica em "Devolver ao
 * automático" e espera que o agente faça o fechamento. O cliente lia o
 * orçamento e ninguém falava com ele. O único remendo era um fluxo de silêncio,
 * que tem mínimo de 5 min (`threshold_minutes` em lib/followup/api-schemas.ts)
 * mais o tick do cron — medido numa instalação real: devolução às 12:58, envio
 * às 13:04.
 *
 * ## O desenho
 *
 * Um consumidor de `ai.handoff_resolved` (o sinal durável que a devolução JÁ
 * emite — manual e automática) decide se enfileira UM `followup_turn` com
 * `mode: 'retomada'`. O worker (`lib/agent-engine/agent/followup-turn.ts`)
 * confere de novo na hora de rodar e só então chama o modelo.
 *
 * Por que `followup_turn` e não um kind novo: o kind já está em todas as regras
 * de banco que um turno que fala com o cliente precisa (CHECKs da fila,
 * fronteira de atendimento pelo payload, reserva do Meet, revogação quando
 * alguém assume). Um kind novo exigiria redefinir as quatro.
 *
 * Por que não um `inbound_turn` sintético: ele roda os classificadores sobre a
 * última mensagem do cliente — que costuma ser justamente a que causou a
 * passagem ("quero falar com um atendente", "quanto custa"). O agente
 * escalaria de novo no mesmo segundo em que foi devolvido.
 *
 * ## Desligado por padrão
 *
 * A opção é por agente (`trigger_config.resume_on_handback`). Sem ela ligada,
 * nada muda para quem já usa — inclusive quem resolveu o caso com um fluxo de
 * silêncio e não quer duas mensagens.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { readServiceBoundarySupabase } from "@/lib/atendimento/origem";

import { resolverAgenteDaConversa, type CandidatoDeAgente } from "@/lib/ai/agents/agente-da-conversa";

import { ultimaFalaEDaEquipe, type MensagemParaRegua } from "./fala-da-equipe";

export type UltimaMensagem = MensagemParaRegua;

export type MotivoParaNaoRetomar =
  /** A opção do agente está desligada (o padrão). */
  | "opcao_desligada"
  /** Nenhum agente publicado responde por esta conversa. */
  | "sem_agente_publicado"
  /** A conversa não tem mensagem nenhuma. */
  | "sem_mensagens"
  /**
   * A última fala é do cliente (o turno de resposta normal cuida) ou da própria
   * IA/automação (já houve quem falasse depois da equipe).
   */
  | "ultima_fala_nao_e_da_equipe"
  /**
   * Há follow-up vivo para o contato. UMA VOZ: o fluxo pausado pela passagem
   * retoma no mesmo `ai.handoff_resolved` (lib/followup/reactivity.ts), e o
   * cliente receberia as duas mensagens.
   */
  | "acompanhamento_vivo"
  /** Alguém assumiu de novo, ou a trava voltou, entre a devolução e agora. */
  | "humano_no_comando"
  /** Contato marcado "sempre atendimento humano" ou bloqueado. */
  | "contato_fora_da_ia"
  /** A conversa não existe mais (ou é de grupo). */
  | "conversa_indisponivel"
  /** Sem fronteira de atendimento atual não há como provar que o turno vale. */
  | "fronteira_ilegivel";

export type DecisaoDeRetomada =
  | { retomar: true }
  | { retomar: false; motivo: MotivoParaNaoRetomar };

export interface FatosDaRetomada {
  opcaoLigada: boolean | null;
  ultima: UltimaMensagem | null;
  acompanhamentoVivo: boolean;
  humanoNoComando: boolean;
  contatoForaDaIA: boolean;
}

/**
 * A decisão, pura. A ORDEM importa só para o motivo que aparece no rastro: o
 * primeiro portão que fecha é o que se mostra.
 */
export function decidirRetomadaAoDevolver(f: FatosDaRetomada): DecisaoDeRetomada {
  if (f.opcaoLigada === null) return { retomar: false, motivo: "sem_agente_publicado" };
  if (!f.opcaoLigada) return { retomar: false, motivo: "opcao_desligada" };
  if (f.contatoForaDaIA) return { retomar: false, motivo: "contato_fora_da_ia" };
  if (f.humanoNoComando) return { retomar: false, motivo: "humano_no_comando" };
  if (f.ultima === null) return { retomar: false, motivo: "sem_mensagens" };
  if (!ultimaFalaEDaEquipe(f.ultima)) return { retomar: false, motivo: "ultima_fala_nao_e_da_equipe" };
  if (f.acompanhamentoVivo) return { retomar: false, motivo: "acompanhamento_vivo" };
  return { retomar: true };
}

// ─── Leituras e a escrita ───────────────────────────────────────────────────

export interface ConversaDaRetomada {
  contactId: string;
  channelSessionId: string;
  activeAgentId: string | null;
  humanoNoComando: boolean;
}

export interface RetomadaAoDevolverDb {
  carregaConversa(orgId: string, conversationId: string): Promise<ConversaDaRetomada | null>;
  contatoForaDaIA(orgId: string, contactId: string): Promise<boolean>;
  /**
   * `true`/`false` = o que o agente publicado que responde pela conversa diz;
   * `null` = não há agente publicado para esta conversa.
   */
  opcaoDoAgente(orgId: string, channelSessionId: string, activeAgentId: string | null): Promise<boolean | null>;
  ultimaMensagem(orgId: string, conversationId: string): Promise<UltimaMensagem | null>;
  acompanhamentoVivo(orgId: string, contactId: string): Promise<boolean>;
  fronteiraAtual(orgId: string, conversationId: string): Promise<ServiceBoundary | null>;
  /** `false` = já havia job deste evento (dedup por `source_event_id`). */
  enfileiraTurno(input: {
    organizationId: string;
    contactId: string;
    sourceEventId: string;
    payload: Record<string, unknown>;
  }): Promise<boolean>;
}

export type DesfechoDaRetomada =
  | { kind: "enfileirado" }
  | { kind: "ja_enfileirado" }
  | { kind: "pulado"; motivo: MotivoParaNaoRetomar };

/**
 * Rodado pelo consumidor de `ai.handoff_resolved`. Org vem da LINHA do evento
 * (fonte confiável), a conversa do payload é só ponteiro e é relida aqui com a
 * org no filtro.
 */
export async function agendarRetomadaAoDevolver(
  db: RetomadaAoDevolverDb,
  input: { organizationId: string; conversationId: string; eventId: string },
): Promise<DesfechoDaRetomada> {
  const { organizationId: org, conversationId } = input;
  const conversa = await db.carregaConversa(org, conversationId);
  if (conversa === null) return { kind: "pulado", motivo: "conversa_indisponivel" };

  const opcaoLigada = await db.opcaoDoAgente(org, conversa.channelSessionId, conversa.activeAgentId);
  // A opção desligada é o caso de quase todo mundo: corta antes das outras leituras.
  if (opcaoLigada !== true) {
    return { kind: "pulado", motivo: opcaoLigada === null ? "sem_agente_publicado" : "opcao_desligada" };
  }

  const decisao = decidirRetomadaAoDevolver({
    opcaoLigada,
    contatoForaDaIA: await db.contatoForaDaIA(org, conversa.contactId),
    humanoNoComando: conversa.humanoNoComando,
    ultima: await db.ultimaMensagem(org, conversationId),
    acompanhamentoVivo: await db.acompanhamentoVivo(org, conversa.contactId),
  });
  if (!decisao.retomar) return { kind: "pulado", motivo: decisao.motivo };

  const fronteira = await db.fronteiraAtual(org, conversationId);
  if (fronteira === null || fronteira.contact_id !== conversa.contactId) {
    return { kind: "pulado", motivo: "fronteira_ilegivel" };
  }

  const novo = await db.enfileiraTurno({
    organizationId: org,
    contactId: conversa.contactId,
    sourceEventId: input.eventId,
    payload: {
      mode: "retomada",
      reason: "a equipe devolveu o atendimento ao agente",
      conversation_id: conversationId,
      // O hold do número (go-live, bloqueio) acha o canal pela conversa da
      // fronteira OU por esta chave (`CANAL_DO_JOB`, session-watchdog.ts); as
      // duas apontam para a mesma sessão, e esta não depende da fronteira.
      channel_session_id: conversa.channelSessionId,
      service_boundary: fronteira,
    },
  });
  return novo ? { kind: "enfileirado" } : { kind: "ja_enfileirado" };
}

/** Status de inscrição que ocupam a vaga do contato (`idx_followup_enrollments_one_live`). */
const STATUS_VIVOS = ["active", "waiting_reply", "paused_handoff", "paused_manual"];

export function createSupabaseRetomadaAoDevolverDb(admin: SupabaseClient): RetomadaAoDevolverDb {
  return {
    async carregaConversa(orgId, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select(
          "contact_id, channel_session_id, active_ai_agent_id, is_group, assignee_kind, assigned_to_user_id, bot_silenced_until",
        )
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const c = data as {
        contact_id: string | null;
        channel_session_id: string | null;
        active_ai_agent_id: string | null;
        is_group: boolean | null;
        assignee_kind: string | null;
        assigned_to_user_id: string | null;
        bot_silenced_until: string | null;
      } | null;
      if (!c || !c.contact_id || !c.channel_session_id || c.is_group === true) return null;
      const silenciado =
        c.bot_silenced_until !== null && new Date(c.bot_silenced_until).getTime() > Date.now();
      return {
        contactId: c.contact_id,
        channelSessionId: c.channel_session_id,
        activeAgentId: c.active_ai_agent_id,
        humanoNoComando: c.assignee_kind === "user" || c.assigned_to_user_id !== null || silenciado,
      };
    },

    async contatoForaDaIA(orgId, contactId) {
      const { data, error } = await admin
        .from("contacts")
        .select("ai_opt_out, force_human, is_blocked")
        .eq("organization_id", orgId)
        .eq("id", contactId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const c = data as { ai_opt_out?: boolean; force_human?: boolean; is_blocked?: boolean } | null;
      // Fail-closed: contato que não se lê não recebe mensagem proativa.
      if (!c) return true;
      return c.ai_opt_out === true || c.force_human === true || c.is_blocked === true;
    },

    async opcaoDoAgente(orgId, channelSessionId, activeAgentId) {
      const { data, error } = await admin
        .from("ai_agents")
        .select(
          "id, channel, kind, is_active, paused_at, operation_mode, published_version_id, archived_at, priority, created_at, " +
            "versao:ai_agent_versions!ai_agents_published_version_id_fkey(status, channel_session_id, trigger_config)",
        )
        .eq("organization_id", orgId)
        .is("archived_at", null);
      if (error) throw new Error(error.message);
      return opcaoDoAgenteDaConversa((data ?? []) as unknown as AgenteComVersao[], {
        channelSessionId,
        activeAgentId,
      });
    },

    async ultimaMensagem(orgId, conversationId) {
      const { data, error } = await admin
        .from("messages")
        .select("direction, sent_via")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .order("sent_at", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as UltimaMensagem | null) ?? null;
    },

    async acompanhamentoVivo(orgId, contactId) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("id")
        .eq("organization_id", orgId)
        .eq("contact_id", contactId)
        .in("status", STATUS_VIVOS)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data !== null;
    },

    async fronteiraAtual(orgId, conversationId) {
      const atual = await readServiceBoundarySupabase(admin, orgId, conversationId);
      if (atual === null) return null;
      const { status: _status, demanda_fechada_em: _fechada, ...fronteira } = atual;
      return fronteira;
    },

    async enfileiraTurno(input) {
      const { error } = await admin.from("job_queue").insert({
        organization_id: input.organizationId,
        contact_id: input.contactId,
        kind: "followup_turn",
        source_event_id: input.sourceEventId,
        payload: input.payload,
      });
      if (error) {
        // `uniq_job_queue_source_event`: o mesmo evento entregue de novo.
        if (error.code === "23505") return false;
        throw new Error(error.message);
      }
      return true;
    },
  };
}

/** Lê a opção do `trigger_config` sem confiar na forma (jsonb de versões antigas). */
export function lerRetomarAoDevolver(triggerConfig: unknown): boolean {
  if (typeof triggerConfig !== "object" || triggerConfig === null) return false;
  return (triggerConfig as { resume_on_handback?: unknown }).resume_on_handback === true;
}

interface VersaoDoAgente {
  status: string;
  channel_session_id: string | null;
  trigger_config: unknown;
}

/** Uma linha de `ai_agents` com a versão publicada embutida (PostgREST pode devolver array). */
export interface AgenteComVersao extends CandidatoDeAgente {
  versao: VersaoDoAgente | VersaoDoAgente[] | null;
}

/**
 * A opção de QUEM atenderia esta conversa — nunca a de um vizinho.
 *
 * Antes isto olhava todos os agentes publicados no número com `.some()`: com
 * dois agentes no mesmo número, a opção ligada num agente PAUSADO ou de menor
 * prioridade acordava a retomada do outro (apontado na revisão do PR #5105).
 * Agora a pergunta "quem atende?" é respondida por `resolverAgenteDaConversa`
 * (`lib/ai/agents/agente-da-conversa.ts`) — a régua que já existe, na ordem do
 * motor: o agente grudado na conversa; senão o publicado no número por
 * `priority desc, created_at asc`, pausado fora. Uma quarta régua seria o
 * defeito que aquele arquivo documenta.
 *
 * `null` = ninguém atenderia (ou quem atende rascunha para a equipe no modo
 * assistido, e por isso não "retoma" nada sozinho).
 */
export function opcaoDoAgenteDaConversa(
  agentes: readonly AgenteComVersao[],
  conversa: { channelSessionId: string; activeAgentId: string | null },
): boolean | null {
  const versaoDe = (a: AgenteComVersao): VersaoDoAgente | null =>
    (Array.isArray(a.versao) ? a.versao[0] : a.versao) ?? null;
  const versoesPublicadasNaSessao = agentes
    .filter((a) => {
      const v = versaoDe(a);
      return v !== null && v.status === "published" && v.channel_session_id === conversa.channelSessionId;
    })
    .map((a) => a.published_version_id)
    .filter((id): id is string => typeof id === "string");
  const { agente } = resolverAgenteDaConversa(agentes, {
    active_ai_agent_id: conversa.activeAgentId,
    versoesPublicadasNaSessao,
  });
  if (agente === null || agente.operation_mode === "assisted") return null;
  const versao = versaoDe(agente);
  if (versao === null || versao.status !== "published") return null;
  return lerRetomarAoDevolver(versao.trigger_config);
}
