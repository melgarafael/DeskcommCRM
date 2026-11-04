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
 *
 * ─── O canal da conversa (#3852) ──────────────────────────────────────────
 *
 * Com dois números, cada um com seu agente, a escolha por ponteiro só pegava
 * lead que conversou no número do OUTRO agente e escrevia com a persona
 * errada. `decidirAgenteDoEnrollmentAutomatico` aceita, como ÚLTIMO parâmetro
 * OPCIONAL, o canal da conversa (`conversations.channel_session_id`); quando
 * ele vem, os candidatos são só os agentes que armam o ponteiro E atendem
 * naquele número (`channelSessionIds`).
 *
 * ─── Os NÚMEROS em que um agente atende (#3928) ───────────────────────────
 *
 * "O número do agente" não é só o da própria versão publicada. Desde a
 * migration 0749 (#3284) um ESPECIALISTA de roteador de intenções pode ser
 * publicado SEM número próprio (`ai_agent_versions.channel_session_id` nulo) e
 * atende pelo número do ROTEADOR — é o que o portão do dreno conta
 * (`lib/ai/agents/quem-atende-a-sessao.ts`: membros e fallback do roteador
 * ATIVO naquele número). Ler esse nulo como "canal desconhecido" fazia um
 * fluxo de IA armado só por especialistas nunca inscrever numa organização com
 * roteador — o defeito que o #3852 veio consertar, de volta pela porta dos
 * fundos.
 *
 * Por isso o adapter devolve a LISTA de números em que o agente atende: o da
 * versão publicada mais o dos roteadores ATIVOS da organização em que ele é
 * membro ou fallback. A régua é a MESMA do portão do dreno, na direção
 * inversa (de agente para números), e não uma segunda: mesmas tabelas
 * (`ai_routers`, `ai_router_members`), mesmas colunas (`channel_session_id`,
 * `fallback_agent_id`, `is_active`), mesmo recorte por `organization_id`.
 *
 * Sem o parâmetro, a decisão é EXATAMENTE a de antes: todos os agentes que
 * armam o ponteiro, menor uuid vence. É o que mantém compatível a tela de
 * etapas (`fluxos-da-etapa.ts`, pergunta por ORGANIZAÇÃO, não por número) e o
 * enrollment manual (`enroll.ts`, escolha explícita de um humano).
 *
 * Canal conhecido e sem candidato NÃO cai no agente de outro número: a
 * resolução devolve `null` e `agenteDoGatilhoAutomatico` decide — fluxo que
 * pede IA é BARRADO (não inscreve), fluxo de texto fixo segue com `agent_id`
 * nulo, como já era. Inscrever sem agente um fluxo de IA entregaria turno sem
 * persona; escolher o agente do outro número é o defeito que este parâmetro
 * fecha.
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

export async function decidirAgenteDoEnrollmentAutomatico(
  db: FollowupGateDb,
  orgId: string,
  pointerId: string,
  pedeAgente: boolean,
  /** Canal da conversa (`conversations.channel_session_id`). Ausente/nulo = decisão por organização, a de sempre. */
  canalConversa?: string | null,
): Promise<{ agentId: string | null; barrado: boolean }> {
  const agentId = await resolveAgentForAutomaticTrigger(db, orgId, pointerId, canalConversa);
  return agenteDoGatilhoAutomatico(agentId, pedeAgente);
}

/** Um agente publicado da org com follow-up habilitado + os pointers que ele arma. */
export interface EnabledFollowupAgent {
  agentId: string;
  pointerIds: string[];
  /**
   * Os NÚMEROS em que este agente atende (`channel_session_id`).
   *
   * É uma LISTA desde o #3928: o número da própria versão publicada mais o dos
   * roteadores ATIVOS em que ele é membro ou fallback (migration 0749/#3284 —
   * especialista de roteador pode ser publicado sem número próprio e atende
   * pelo número do roteador). Duas versões publicadas em números diferentes
   * somam as duas entradas em vez de virar "canal desconhecido".
   *
   * OPCIONAL de propósito: os dublês dos testes montam só `{agentId, pointerIds}`
   * e o contrato antigo continua valendo. Ausente/vazia = NENHUM número
   * conhecido, e agente sem número só compete quando a chamada não pede canal —
   * nunca é escolhido "por eliminação" para um número que não é o dele.
   */
  channelSessionIds?: readonly string[];
}

/** Interface estreita de DB — mesma doutrina de `AdminClient`/`ReactivityAdminClient`
 *  (narrow por consumidor, não `SupabaseClient` direto, pra ficar testável sem Postgres). */
export interface FollowupGateDb {
  /** Agentes publicados da org com `followup.enabled=true`, cada um com seus `flow_pointer_ids`. */
  loadEnabledPublishedFollowupAgents(orgId: string): Promise<EnabledFollowupAgent[]>;
}

/** Puro: agent_ids que armam este pointer — e, com `canalConversa`, que também atendem nele —, em ordem determinística (menor uuid primeiro). */
function agentsEnablingPointer(
  agents: EnabledFollowupAgent[],
  pointerId: string,
  canalConversa?: string | null,
): string[] {
  const canal = canalConversa ?? null;
  return agents
    .filter((a) => a.pointerIds.includes(pointerId))
    // Agente que não atende neste número não é candidato a um canal CONCRETO:
    // escolher "quem sobrou" é exatamente o defeito do #3852 (persona do número
    // errado). "Atende" é a LISTA — número próprio + roteadores ativos de que é
    // membro ou fallback (#3928); sem canal, a lista não filtra nada.
    .filter((a) => canal === null || (a.channelSessionIds ?? []).includes(canal))
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
 *
 * Com `canalConversa`, o universo encolhe para os agentes que armam o pointer E
 * ATENDEM naquele número (`channelSessionIds`: o número próprio e os dos
 * roteadores ativos de que é membro ou fallback, #3928): `null` passa a
 * significar "nenhum agente deste número arma este fluxo", e o consumidor barra
 * o fluxo de IA em vez de escrever com a persona do outro número (#3852).
 */
export async function resolveAgentForAutomaticTrigger(
  db: FollowupGateDb,
  orgId: string,
  pointerId: string,
  canalConversa?: string | null,
): Promise<string | null> {
  const agents = await db.loadEnabledPublishedFollowupAgents(orgId);
  return agentsEnablingPointer(agents, pointerId, canalConversa)[0] ?? null;
}

interface FollowupColumnShape {
  enabled?: unknown;
  flow_pointer_ids?: unknown;
}

/**
 * Canal (`conversations.channel_session_id`) — o número em que a conversa
 * aconteceu. É a chave do filtro do #3852: quem escreve num número só pode ser
 * o agente publicado NELE.
 *
 * Uma leitura por conversa, não por contato: um contato com dois números tem
 * DUAS conversas, e é a da mensagem/evento que manda — escolher a "do contato"
 * seria repetir o defeito de escolher por aproximação.
 *
 * `null` (conversa sem número, ou linha ausente) significa canal DESCONHECIDO e
 * o chamador volta ao comportamento por organização — nunca inventa um número.
 */
export async function canalDaConversaSupabase(
  admin: SupabaseClient,
  orgId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("conversations")
    .select("channel_session_id")
    .eq("organization_id", orgId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const canal = (data as { channel_session_id?: string | null } | null)?.channel_session_id;
  return typeof canal === "string" && canal.length > 0 ? canal : null;
}

/**
 * Os números que os ROTEADORES ATIVOS da organização dão a cada agente — o
 * INVERSO de `palavrasDeQuemPodeAtender`
 * (`lib/ai/agents/quem-atende-a-sessao.ts:136`), que vai do número para quem
 * atende. Mesmas tabelas, mesmas colunas, mesmo `is_active` do portão do dreno:
 * `ai_routers` (com `channel_session_id`, `fallback_agent_id`) recortado por
 * `organization_id` e `is_active`, e `ai_router_members` (o par
 * `router_id`/`agent_id`) recortado por `organization_id`.
 *
 * O outro lado do predicado do dreno — "membro/fallback que PODE EXECUTAR",
 * isto é, com versão publicada — já vale por construção aqui: esta lista só é
 * montada para agentes que vieram de uma versão publicada com follow-up
 * ligado. Arquivamento e pausa do agente são outra frente e não passam por
 * aqui.
 *
 * Roteador ativo sem número (`channel_session_id` nulo) não empresta número
 * nenhum — não existe "canal vazio" para casar com conversa.
 */
async function numerosDosRoteadores(
  admin: SupabaseClient,
  orgId: string,
  agentIds: readonly string[],
): Promise<Map<string, string[]>> {
  const porAgente = new Map<string, string[]>();
  const alvos = new Set(agentIds);
  const anota = (agentId: string | null, canal: string | null): void => {
    if (agentId === null || canal === null || !alvos.has(agentId)) return;
    const lista = porAgente.get(agentId) ?? [];
    if (!lista.includes(canal)) lista.push(canal);
    porAgente.set(agentId, lista);
  };

  const { data: roteadores, error: erroRoteadores } = await admin
    .from("ai_routers")
    .select("id, channel_session_id, fallback_agent_id")
    .eq("organization_id", orgId)
    .eq("is_active", true);
  if (erroRoteadores) throw new Error(`followup_gate_query_failed: ${erroRoteadores.message}`);

  const canalDoRoteador = new Map<string, string>();
  for (const r of (roteadores ?? []) as Array<{
    id: string;
    channel_session_id: string | null;
    fallback_agent_id: string | null;
  }>) {
    const canal = typeof r.channel_session_id === "string" && r.channel_session_id.length > 0 ? r.channel_session_id : null;
    if (canal === null) continue;
    canalDoRoteador.set(r.id, canal);
    anota(r.fallback_agent_id, canal);
  }
  const routerIds = [...canalDoRoteador.keys()];
  if (routerIds.length === 0) return porAgente;

  const { data: membros, error: erroMembros } = await admin
    .from("ai_router_members")
    .select("router_id, agent_id")
    .eq("organization_id", orgId)
    .in("router_id", routerIds);
  if (erroMembros) throw new Error(`followup_gate_query_failed: ${erroMembros.message}`);

  for (const m of (membros ?? []) as Array<{ router_id: string; agent_id: string }>) {
    anota(m.agent_id, canalDoRoteador.get(m.router_id) ?? null);
  }
  return porAgente;
}

/**
 * Production adapter: lê `ai_agent_versions.{agent_id,followup,channel_session_id}`
 * via o client service-role real e completa cada agente com os números dos
 * roteadores ativos em que ele atende (`numerosDosRoteadores`). Sem agente
 * habilitado não há o que completar: nenhuma consulta a mais.
 */
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
      const byAgent = new Map<string, Set<string>>();
      // O número de cada agente vem da MESMA linha — nenhuma ida a mais ao banco.
      // Duas versões publicadas em números DIFERENTES somam as duas entradas:
      // com a lista, "ambíguo" deixou de ser um estado (era o que virava "canal
      // desconhecido" e tirava o agente de qualquer decisão com canal).
      const canais = new Map<string, string[]>();
      for (const row of (data ?? []) as Array<{
        agent_id: string;
        followup: FollowupColumnShape | null;
        channel_session_id: string | null;
      }>) {
        const f = row.followup;
        if (!f || f.enabled !== true || !Array.isArray(f.flow_pointer_ids)) continue;
        if (typeof row.channel_session_id === "string" && row.channel_session_id.length > 0) {
          const doAgente = canais.get(row.agent_id) ?? [];
          if (!doAgente.includes(row.channel_session_id)) doAgente.push(row.channel_session_id);
          canais.set(row.agent_id, doAgente);
        }
        const set = byAgent.get(row.agent_id) ?? new Set<string>();
        for (const id of f.flow_pointer_ids) {
          if (typeof id === "string") set.add(id);
        }
        if (set.size > 0) byAgent.set(row.agent_id, set);
      }
      if (byAgent.size === 0) return [];

      const dosRoteadores = await numerosDosRoteadores(admin, orgId, [...byAgent.keys()]);
      return [...byAgent].map(([agentId, ids]) => ({
        agentId,
        pointerIds: [...ids],
        channelSessionIds: [...new Set([...(canais.get(agentId) ?? []), ...(dosRoteadores.get(agentId) ?? [])])],
      }));
    },
  };
}
