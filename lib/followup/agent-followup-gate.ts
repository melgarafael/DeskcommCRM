/**
 * Gate de gatilho AUTOMÁTICO de follow-up (Task 7.2) + resolução do agente que
 * ARMA o pointer (Task 8.6).
 *
 * Um gatilho AUTOMÁTICO cujo grafo pede IA (`ai_classify`, espera `smart`,
 * ação `ai_message`) só enrolla se algum agente PUBLICADO tem
 * `followup.enabled=true` e o pointer em `flow_pointer_ids`.
 *
 * Grafo só de texto fixo / template / `match_reply` / espera fixa NÃO pede
 * agente: o enrollment nasce com `agent_id` nulo, igual a `manual`/`webhook`.
 * Sem isto, uma instalação sem chave de LLM publica o fluxo, vê "Ativo" e
 * ninguém recebe a mensagem.
 *
 * Enrollment MANUAL (`POST /api/v1/ai/followups/enrollments`) NÃO passa por
 * este gate — é escolha explícita de um humano (mas o manual TAMBÉM resolve o
 * agente pinado por aqui pra registro).
 *
 * Task 8.6: quando o grafo pede IA, o consumidor precisa saber QUAL agente
 * pinar. `resolveAgentForAutomaticTrigger` devolve o agent_id — menor uuid
 * se >1 agente publicado habilita o mesmo pointer.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * OS GATILHOS QUE MORREM SEM AGENTE — a lista, com o produtor de cada um ao lado.
 *
 * Levantada no código, não presumida. Cada kind aqui tem um produtor que chama
 * este gate e desiste quando ele devolve nada:
 *
 *   silence              → `lib/followup/silence-sweep.ts`
 *   stage_change         → `lib/followup/gatilho-etapa.ts`
 *   case_opened          → `lib/followup/gatilho-caso.ts`
 *   lead_created         → `lib/followup/gatilho-lead.ts`
 *   appointment_no_show  → `fn_appointment_recover` (a MESMA condição em SQL:
 *                          o `exists` sobre `ai_agent_versions` publicadas com
 *                          `followup->'enabled'` e o ponteiro em
 *                          `flow_pointer_ids` — SQL ainda não lê o grafo)
 *
 * ⚠️ `manual` e `webhook` NÃO entram. Os dois enrollam por `lib/followup/enroll.ts`
 * com `agent_id = null` quando não há agente. Avisar sobre eles seria alarme
 * falso. O cron `followup-sem-agente` recorta por esta lista, dispensa o aviso
 * se o grafo publicado não pede IA (`fluxoPedeAgente`), e em
 * `appointment_no_show` ainda avisa sempre (o SQL não acompanhou).
 *
 * `inbound_after_silence` entra: o handler aplica o mesmo gate, e a Central
 * precisa poder avisar quando o grafo TEM nó de IA e ninguém arma o pointer.
 */
export const GATILHOS_QUE_EXIGEM_AGENTE = [
  "silence",
  "stage_change",
  "case_opened",
  "appointment_no_show",
  "inbound_after_silence",
  "lead_created",
] as const;

export type GatilhoQueExigeAgente = (typeof GATILHOS_QUE_EXIGEM_AGENTE)[number];

export function exigeAgente(kind: string): kind is GatilhoQueExigeAgente {
  return (GATILHOS_QUE_EXIGEM_AGENTE as readonly string[]).includes(kind);
}

/** Nó de gatilho do grafo publicado + se o fluxo precisa de um agente de IA. */
export type NoDeGatilho = { id: string; pedeAgente: boolean };

type NoDoGrafo = { id: string; type: string; config?: Record<string, unknown> };

/**
 * O grafo pede um agente publicado quando algum nó chama modelo.
 * Texto fixo, template, `match_reply` e espera fixa não pedem.
 */
export function fluxoPedeAgente(graph: { nodes: ReadonlyArray<NoDoGrafo> }): boolean {
  return graph.nodes.some((n) => {
    if (n.type === "ai_classify") return true;
    const mode = n.config?.mode;
    return (n.type === "wait" && mode === "smart") || (n.type === "action" && mode === "ai_message");
  });
}

export function noDeGatilhoDoGrafo(graph: { nodes: ReadonlyArray<NoDoGrafo> }): NoDeGatilho | null {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (!trigger) return null;
  return { id: trigger.id, pedeAgente: fluxoPedeAgente(graph) };
}

/**
 * Sem agente: fluxo de texto fixo segue (`agent_id` nulo); fluxo que pede IA
 * é barrado. Com agente, pina o id — o grafo não muda essa escolha.
 */
export function agenteDoGatilhoAutomatico(
  agentId: string | null,
  pedeAgente: boolean,
): { agentId: string | null; barrado: boolean } {
  if (agentId !== null) return { agentId, barrado: false };
  if (!pedeAgente) return { agentId: null, barrado: false };
  return { agentId: null, barrado: true };
}

/**
 * Decide o agente do enrollment — agora com o CANAL da conversa (#3852).
 *
 * `canal` é o `channel_sessions.id` do número em que a conversa acontece. Com
 * ele, só concorrem os agentes publicados NESSE número: o fluxo do agente A
 * deixa de pegar lead que falou no número do agente B e escrever com a persona
 * errada. Sem ele (`undefined`/`null`/vazio), a escolha é a de sempre — menor
 * uuid entre todos os agentes que armam o pointer —, que é o que mantém
 * compatíveis os chamadores sem conversa (prévia de fluxos, testes antigos).
 */
export async function decidirAgenteDoEnrollmentAutomatico(
  db: FollowupGateDb,
  orgId: string,
  pointerId: string,
  pedeAgente: boolean,
  canal?: string | null,
): Promise<{ agentId: string | null; barrado: boolean }> {
  const agentId = await resolveAgentForAutomaticTrigger(db, orgId, pointerId, canal);
  return agenteDoGatilhoAutomatico(agentId, pedeAgente);
}

/** Um agente publicado da org com follow-up habilitado + os pointers que ele arma. */
export interface EnabledFollowupAgent {
  agentId: string;
  pointerIds: string[];
  /**
   * `channel_sessions.id` do número em que a versão publicada atende. Vazio ou
   * ausente = canal desconhecido. Quando o chamador informa um canal, agente
   * sem canal NÃO é candidato: escolhê-lo sem saber o número é exatamente o
   * defeito do #3852 (persona do agente A no lead do número B). O adapter de
   * produção sempre preenche; os falsos antigos só são exercitados sem canal.
   */
  channelSessionIds?: string[];
}

/** Interface estreita de DB — mesma doutrina de `AdminClient`/`ReactivityAdminClient`
 *  (narrow por consumidor, não `SupabaseClient` direto, pra ficar testável sem Postgres). */
export interface FollowupGateDb {
  /** Agentes publicados da org com `followup.enabled=true`, cada um com seus `flow_pointer_ids`. */
  loadEnabledPublishedFollowupAgents(orgId: string): Promise<EnabledFollowupAgent[]>;
}

/** Puro: agent_ids que armam este pointer, em ordem determinística (menor uuid primeiro).
 *
 *  Com `canal` informado, o recorte é duplo: arma o pointer E está publicado
 *  naquele número. Canal vazio/ausente mantém a lista inteira (compatibilidade). */
function agentsEnablingPointer(
  agents: EnabledFollowupAgent[],
  pointerId: string,
  canal?: string | null,
): string[] {
  const filtroDeCanal = typeof canal === "string" && canal.trim() !== "" ? canal : null;
  return agents
    .filter((a) => a.pointerIds.includes(pointerId))
    .filter((a) => filtroDeCanal === null || (a.channelSessionIds ?? []).includes(filtroDeCanal))
    .map((a) => a.agentId)
    .sort();
}

/** Gate booleano: existe ao menos 1 agente publicado da org armando este pointer?
 *  Com `canal`, a pergunta é a mesma restrita ao número da conversa (#3852). */
export async function isPointerEnabledForAutomaticTrigger(
  db: FollowupGateDb,
  orgId: string,
  pointerId: string,
  canal?: string | null,
): Promise<boolean> {
  const agents = await db.loadEnabledPublishedFollowupAgents(orgId);
  return agentsEnablingPointer(agents, pointerId, canal).length > 0;
}

/**
 * Qual agente ARMA este pointer — o agent_id a pinar no enrollment (persona +
 * exibição na fila). Determinístico quando >1 agente habilita o mesmo pointer:
 * MENOR agent_id (uuid asc). `null` = nenhum agente publicado arma (gate-out) —
 * mesma condição em que `isPointerEnabledForAutomaticTrigger` retorna false.
 *
 * Com `canal`, só entram os agentes publicados naquele número (#3852): com dois
 * números, cada um com seu agente, cada fluxo escolhe o agente do número em que
 * a conversa acontece. Sem canal, a escolha é a de sempre.
 */
export async function resolveAgentForAutomaticTrigger(
  db: FollowupGateDb,
  orgId: string,
  pointerId: string,
  canal?: string | null,
): Promise<string | null> {
  const agents = await db.loadEnabledPublishedFollowupAgents(orgId);
  return agentsEnablingPointer(agents, pointerId, canal)[0] ?? null;
}

interface FollowupColumnShape {
  enabled?: unknown;
  flow_pointer_ids?: unknown;
}

/** Production adapter: lê `ai_agent_versions.{agent_id,followup}` via o client service-role real. */
export function createSupabaseFollowupGateDb(admin: SupabaseClient): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupAgents(orgId) {
      const { data, error } = await admin
        .from("ai_agent_versions")
        .select("agent_id, followup, channel_session_id")
        .eq("organization_id", orgId)
        .eq("status", "published");
      if (error) throw new Error(`followup_gate_query_failed: ${error.message}`);

      // Um agente tem no máximo 1 versão publicada; ainda assim agrego por
      // agent_id (defensivo) unindo os pointers habilitados.
      const byAgent = new Map<string, { pointerIds: Set<string>; channelSessionIds: Set<string> }>();
      for (const row of (data ?? []) as Array<{
        agent_id: string;
        followup: FollowupColumnShape | null;
        channel_session_id: string | null;
      }>) {
        const f = row.followup;
        if (!f || f.enabled !== true || !Array.isArray(f.flow_pointer_ids)) continue;
        const atual = byAgent.get(row.agent_id) ?? {
          pointerIds: new Set<string>(),
          channelSessionIds: new Set<string>(),
        };
        for (const id of f.flow_pointer_ids) {
          if (typeof id === "string") atual.pointerIds.add(id);
        }
        // #3852: o número em que ESTA versão publicada atende. É o que separa o
        // agente do WhatsApp A do agente do WhatsApp B na hora de pinar.
        if (typeof row.channel_session_id === "string" && row.channel_session_id !== "") {
          atual.channelSessionIds.add(row.channel_session_id);
        }
        if (atual.pointerIds.size > 0) byAgent.set(row.agent_id, atual);
      }
      return [...byAgent].map(([agentId, v]) => ({
        agentId,
        pointerIds: [...v.pointerIds],
        channelSessionIds: [...v.channelSessionIds],
      }));
    },
  };
}
