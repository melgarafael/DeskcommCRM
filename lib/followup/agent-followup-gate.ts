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

export async function decidirAgenteDoEnrollmentAutomatico(
  db: FollowupGateDb,
  orgId: string,
  pointerId: string,
  pedeAgente: boolean,
): Promise<{ agentId: string | null; barrado: boolean }> {
  const agentId = await resolveAgentForAutomaticTrigger(db, orgId, pointerId);
  return agenteDoGatilhoAutomatico(agentId, pedeAgente);
}

/** Um agente publicado da org com follow-up habilitado + os pointers que ele arma. */
export interface EnabledFollowupAgent {
  agentId: string;
  pointerIds: string[];
}

/** Interface estreita de DB — mesma doutrina de `AdminClient`/`ReactivityAdminClient`
 *  (narrow por consumidor, não `SupabaseClient` direto, pra ficar testável sem Postgres). */
export interface FollowupGateDb {
  /** Agentes publicados da org com `followup.enabled=true`, cada um com seus `flow_pointer_ids`. */
  loadEnabledPublishedFollowupAgents(orgId: string): Promise<EnabledFollowupAgent[]>;
}

/** Puro: agent_ids que armam este pointer, em ordem determinística (menor uuid primeiro). */
function agentsEnablingPointer(agents: EnabledFollowupAgent[], pointerId: string): string[] {
  return agents
    .filter((a) => a.pointerIds.includes(pointerId))
    .map((a) => a.agentId)
    .sort();
}

/** Gate booleano: existe ao menos 1 agente publicado da org armando este pointer? */
export async function isPointerEnabledForAutomaticTrigger(
  db: FollowupGateDb,
  orgId: string,
  pointerId: string,
): Promise<boolean> {
  const agents = await db.loadEnabledPublishedFollowupAgents(orgId);
  return agentsEnablingPointer(agents, pointerId).length > 0;
}

/**
 * Qual agente ARMA este pointer — o agent_id a pinar no enrollment (persona +
 * exibição na fila). Determinístico quando >1 agente habilita o mesmo pointer:
 * MENOR agent_id (uuid asc). `null` = nenhum agente publicado arma (gate-out) —
 * mesma condição em que `isPointerEnabledForAutomaticTrigger` retorna false.
 */
export async function resolveAgentForAutomaticTrigger(
  db: FollowupGateDb,
  orgId: string,
  pointerId: string,
): Promise<string | null> {
  const agents = await db.loadEnabledPublishedFollowupAgents(orgId);
  return agentsEnablingPointer(agents, pointerId)[0] ?? null;
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
        .select("agent_id, followup")
        .eq("organization_id", orgId)
        .eq("status", "published");
      if (error) throw new Error(`followup_gate_query_failed: ${error.message}`);

      // Um agente tem no máximo 1 versão publicada; ainda assim agrego por
      // agent_id (defensivo) unindo os pointers habilitados.
      const byAgent = new Map<string, Set<string>>();
      for (const row of (data ?? []) as Array<{ agent_id: string; followup: FollowupColumnShape | null }>) {
        const f = row.followup;
        if (!f || f.enabled !== true || !Array.isArray(f.flow_pointer_ids)) continue;
        const set = byAgent.get(row.agent_id) ?? new Set<string>();
        for (const id of f.flow_pointer_ids) {
          if (typeof id === "string") set.add(id);
        }
        if (set.size > 0) byAgent.set(row.agent_id, set);
      }
      return [...byAgent].map(([agentId, ids]) => ({ agentId, pointerIds: [...ids] }));
    },
  };
}
