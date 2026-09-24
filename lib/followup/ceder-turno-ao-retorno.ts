/**
 * UMA VOZ SÓ quando o cliente volta.
 *
 * O drain do agente (`ai_agent.dispatch_requested` → `inbound_turn`) e o
 * gatilho `inbound_after_silence` acordam no MESMO inbound. Sem este skip,
 * o cliente recebe a mensagem do fluxo E a resposta do LLM.
 *
 * Fail-open: se a consulta falhar ou não der para AFIRMAR que o retorno
 * enrollaria, o turno segue. Calar o agente na dúvida deixa o cliente sem
 * ninguém — pior do que duas vozes pontuais.
 *
 * O predicado do buraco é o mesmo do produtor (`gapQualificaRetorno`). O
 * resto (humano, segmento, gate, slot vivo) também: pular o turno quando o
 * enroll NÃO aconteceria calaria o agente à toa.
 *
 * ⚠️ O gate do agente é `agenteDoGatilhoAutomatico` — a MESMA função que o
 * produtor chama, alimentada pelo MESMO `fluxoPedeAgente` do grafo publicado.
 * Perguntar só "algum agente arma este ponteiro?" é o gate ERRADO: fluxo de
 * texto fixo enrolla sem agente nenhum, e o silenciador que não sabe disso
 * deixa o LLM responder por cima da primeira mensagem do fluxo — as duas
 * vozes no mesmo retorno que este arquivo existe para evitar.
 */
import type pg from "pg";

import { agenteDoGatilhoAutomatico, noDeGatilhoDoGrafo } from "./agent-followup-gate";
import { triggerConfigSchema } from "./api-schemas";
import { flowGraphSchema } from "./graph-schema";
import { gapQualificaRetorno, segmentoCasa } from "./gap-de-retorno";
import { humanoNoComando, type EstadoDaConversaDeRetorno } from "./gatilho-retorno";

export interface PedidoDeCessao {
  organizationId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  agora?: Date;
}

interface PointerArmado {
  id: string;
  active_version_id: string;
  threshold_minutes: number;
  segments: string[];
}

function tagsDe(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string");
}

/**
 * `true` = não enfileirar `inbound_turn`; o follow-up de retorno fala.
 */
export async function deveCederTurnoAoRetorno(
  pool: Pick<pg.Pool, "query">,
  pedido: PedidoDeCessao,
): Promise<boolean> {
  try {
    const { rows: pointerRows } = await pool.query<{
      id: string;
      active_version_id: string;
      trigger_config: unknown;
    }>(
      `select id, active_version_id, trigger_config
         from followup_flow_pointers
        where organization_id = $1
          and status = 'active'
          and active_version_id is not null
          and trigger_config->>'kind' = 'inbound_after_silence'`,
      [pedido.organizationId],
    );
    const pointers: PointerArmado[] = [];
    for (const row of pointerRows) {
      const parsed = triggerConfigSchema.safeParse(row.trigger_config);
      if (!parsed.success || parsed.data.kind !== "inbound_after_silence") continue;
      pointers.push({
        id: row.id,
        active_version_id: row.active_version_id,
        threshold_minutes: parsed.data.params.threshold_minutes,
        segments: parsed.data.params.segments ?? [],
      });
    }
    if (pointers.length === 0) return false;

    const { rows: estadoRows } = await pool.query<{
      is_group: boolean;
      assignee_kind: string | null;
      bot_silenced_until: string | null;
      is_blocked: boolean | null;
      force_human: boolean | null;
      tags: unknown;
    }>(
      `select c.is_group, c.assignee_kind, c.bot_silenced_until,
              ct.is_blocked, ct.force_human, ct.tags
         from conversations c
         join contacts ct
           on ct.organization_id = c.organization_id and ct.id = $3
        where c.organization_id = $1 and c.id = $2`,
      [pedido.organizationId, pedido.conversationId, pedido.contactId],
    );
    const raw = estadoRows[0];
    if (!raw) return false;
    const estado: EstadoDaConversaDeRetorno = {
      is_group: Boolean(raw.is_group),
      is_blocked: Boolean(raw.is_blocked),
      force_human: Boolean(raw.force_human),
      assignee_kind: raw.assignee_kind,
      bot_silenced_until: raw.bot_silenced_until,
      tags: tagsDe(raw.tags),
    };
    const agora = pedido.agora ?? new Date();
    if (estado.is_group || estado.is_blocked || humanoNoComando(estado, agora)) return false;

    // O produtor costuma rodar ANTES deste drain: `aplicarEfeitosPosEntrada`
    // drena o event_log na própria requisição e só depois pede o despacho do
    // agente. Aí a inscrição que ESTA mensagem criou já está viva, e a checagem
    // de "vivos" abaixo a confundiria com outro fluxo ocupando o slot. O
    // produtor grava o `message_id` no evento de inscrição: se ele existe, o
    // fluxo já é a voz deste retorno.
    const { rows: inscritoPorEsta } = await pool.query(
      `select 1 from followup_enrollments e
         join followup_enrollment_events ev
           on ev.organization_id = e.organization_id and ev.enrollment_id = e.id
        where e.organization_id = $1 and e.contact_id = $2
          and ev.event_type = 'enrolled_by_inbound_after_silence'
          and ev.payload->>'message_id' = $3
        limit 1`,
      [pedido.organizationId, pedido.contactId, pedido.messageId],
    );
    if (inscritoPorEsta[0]) return true;

    const { rows: vivos } = await pool.query<{ pointer_id: string }>(
      `select pointer_id from followup_enrollments
        where organization_id = $1 and contact_id = $2
          and status in ('active','waiting_reply','paused_handoff','paused_manual')
        limit 1`,
      [pedido.organizationId, pedido.contactId],
    );
    if (vivos[0]) return false;

    const { rows: anteriores } = await pool.query<{ sent_at: string | null }>(
      `select sent_at from messages
        where organization_id = $1 and contact_id = $2
          and direction = 'inbound' and id <> $3
        order by coalesce(sent_at, created_at) desc
        limit 1`,
      [pedido.organizationId, pedido.contactId, pedido.messageId],
    );
    const rawAt = anteriores[0]?.sent_at;
    const anterior = rawAt ? new Date(rawAt) : null;
    if (anterior && Number.isNaN(anterior.getTime())) return false;

    const { rows: grafos } = await pool.query<{ id: string; graph: unknown }>(
      `select id, graph from followup_flow_versions
        where organization_id = $1 and id = any($2::uuid[])`,
      [pedido.organizationId, [...new Set(pointers.map((p) => p.active_version_id))]],
    );
    const pedeAgentePorVersao = new Map<string, boolean>();
    for (const row of grafos) {
      const parsed = flowGraphSchema.safeParse(row.graph);
      if (!parsed.success) continue;
      const no = noDeGatilhoDoGrafo(parsed.data);
      if (no) pedeAgentePorVersao.set(row.id, no.pedeAgente);
    }

    const { rows: versoes } = await pool.query<{
      agent_id: string;
      followup: { enabled?: unknown; flow_pointer_ids?: unknown } | null;
    }>(
      `select agent_id, followup from ai_agent_versions
        where organization_id = $1 and status = 'published'`,
      [pedido.organizationId],
    );
    // Qual agente arma cada ponteiro. O gate só lê "é nulo ou não", então não
    // repito o desempate por menor uuid que o produtor faz para PINAR o agente.
    const agentePorPointer = new Map<string, string>();
    for (const v of versoes) {
      const f = v.followup;
      if (!f || f.enabled !== true || !Array.isArray(f.flow_pointer_ids)) continue;
      for (const id of f.flow_pointer_ids) {
        if (typeof id === "string" && !agentePorPointer.has(id)) agentePorPointer.set(id, v.agent_id);
      }
    }

    for (const pointer of pointers) {
      if (!gapQualificaRetorno(anterior, agora, pointer.threshold_minutes)) continue;
      if (!segmentoCasa(pointer.segments, estado.tags)) continue;
      // Grafo ilegível ou sem nó de gatilho: o produtor também não enrolla.
      const pedeAgente = pedeAgentePorVersao.get(pointer.active_version_id);
      if (pedeAgente === undefined) continue;
      const { barrado } = agenteDoGatilhoAutomatico(
        agentePorPointer.get(pointer.id) ?? null,
        pedeAgente,
      );
      if (barrado) continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
