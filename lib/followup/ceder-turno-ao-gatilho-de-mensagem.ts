/**
 * UMA VOZ SÓ quando a mensagem dispara um fluxo (palavra-chave, link/QR de
 * entrada, anúncio de clique para o WhatsApp).
 *
 * Irmão de `ceder-turno-ao-retorno.ts`, com a mesma forma e o mesmo fail-open:
 * se a consulta falhar ou não der para AFIRMAR que o gatilho inscreveria, o
 * turno do agente segue. Calar o agente na dúvida deixa o cliente sem ninguém.
 *
 * A regra de casamento é a do produtor (`gatilho-mensagem-regra.ts`), e o gate
 * do agente é o mesmo `agenteDoGatilhoAutomatico`.
 *
 * A resposta padrão (`default_reply`) não passa por aqui: ela nunca fala onde
 * há agente publicado no número (`haAgenteQueResponde` do produtor), e o drain
 * só existe onde há agente — os dois nunca disputam a mesma mensagem.
 */
import type pg from "pg";

import { agenteDoGatilhoAutomatico, noDeGatilhoDoGrafo } from "./agent-followup-gate";
import { flowGraphSchema } from "./graph-schema";
import { EVENTO_DO_ENROLLMENT_POR_MENSAGEM, gatilhoDoPointer } from "./gatilho-mensagem";
import { ordenarCandidatos, type FatosDaMensagem, type GatilhoEspecifico } from "./gatilho-mensagem-regra";
import { humanoNoComando, type EstadoDaConversaDeRetorno } from "./gatilho-retorno";
import type { PedidoDeCessao } from "./ceder-turno-ao-retorno";

interface PointerArmado {
  id: string;
  active_version_id: string;
  gatilho: GatilhoEspecifico;
}

function tagsDe(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string");
}

function dataOuNula(raw: unknown): Date | null {
  if (typeof raw !== "string" && !(raw instanceof Date)) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `true` = não enfileirar `inbound_turn`; o fluxo disparado pela mensagem fala.
 */
export async function deveCederTurnoAoGatilhoDeMensagem(
  pool: Pick<pg.Pool, "query">,
  pedido: PedidoDeCessao,
): Promise<boolean> {
  try {
    const { rows: pointerRows } = await pool.query<{
      id: string;
      active_version_id: string;
      trigger_config: unknown;
      surface: string | null;
    }>(
      `select id, active_version_id, trigger_config, surface
         from followup_flow_pointers
        where organization_id = $1
          and status = 'active'
          and active_version_id is not null
          and trigger_config->>'kind' in ('keyword','ref_link','ad_click')
        order by id`,
      [pedido.organizationId],
    );
    const pointers: PointerArmado[] = [];
    for (const row of pointerRows) {
      if (row.surface === "atendimento") continue;
      const gatilho = gatilhoDoPointer(row.trigger_config);
      if (!gatilho || gatilho.kind === "default_reply") continue;
      pointers.push({ id: row.id, active_version_id: row.active_version_id, gatilho });
    }
    if (pointers.length === 0) return false;

    const { rows: estadoRows } = await pool.query<{
      is_group: boolean;
      assignee_kind: string | null;
      bot_silenced_until: string | null;
      is_blocked: boolean | null;
      force_human: boolean | null;
      tags: unknown;
      source_metadata: Record<string, unknown> | null;
    }>(
      `select c.is_group, c.assignee_kind, c.bot_silenced_until,
              ct.is_blocked, ct.force_human, ct.tags, ct.source_metadata
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

    // O produtor costuma rodar antes deste drain (dreno do request) e grava o
    // `message_id` no evento de inscrição: se ele existe, o fluxo já é a voz.
    const { rows: inscritoPorEsta } = await pool.query(
      `select 1 from followup_enrollments e
         join followup_enrollment_events ev
           on ev.organization_id = e.organization_id and ev.enrollment_id = e.id
        where e.organization_id = $1 and e.contact_id = $2
          and ev.event_type = $4
          and ev.payload->>'message_id' = $3
        limit 1`,
      [pedido.organizationId, pedido.contactId, pedido.messageId, EVENTO_DO_ENROLLMENT_POR_MENSAGEM],
    );
    if (inscritoPorEsta[0]) return true;

    const { rows: vivos } = await pool.query<{ pointer_id: string; nasceu_depois: boolean | null }>(
      `select e.pointer_id, e.started_at >= m.created_at as nasceu_depois
         from followup_enrollments e
         left join messages m
           on m.organization_id = e.organization_id and m.id = $3
        where e.organization_id = $1 and e.contact_id = $2
          and e.status in ('active','waiting_reply','paused_handoff','paused_manual')`,
      [pedido.organizationId, pedido.contactId, pedido.messageId],
    );
    const ids = new Set(pointers.map((p) => p.id));
    if (vivos.some((v) => v.nasceu_depois === true && ids.has(v.pointer_id))) return true;
    if (vivos[0]) return false;

    const { rows: mensagens } = await pool.query<{ body: string | null; created_at: string | Date }>(
      `select body, created_at from messages where organization_id = $1 and id = $2`,
      [pedido.organizationId, pedido.messageId],
    );
    const msg = mensagens[0];
    if (!msg) return false;
    const meta = raw.source_metadata;
    const fatos: FatosDaMensagem = {
      texto: msg.body,
      recebida_em: dataOuNula(msg.created_at) ?? agora,
      anuncio:
        meta && typeof meta === "object" && meta.ad_platform
          ? {
              ad_id: typeof meta.ad_id === "string" ? meta.ad_id : null,
              ad_source_id: typeof meta.ad_source_id === "string" ? meta.ad_source_id : null,
              capturado_em: dataOuNula(meta.ad_captured_at),
            }
          : null,
    };
    const candidatos = ordenarCandidatos(pointers, fatos);
    if (candidatos.length === 0) return false;

    const { rows: grafos } = await pool.query<{ id: string; graph: unknown }>(
      `select id, graph from followup_flow_versions
        where organization_id = $1 and id = any($2::uuid[])`,
      [pedido.organizationId, [...new Set(candidatos.map((p) => p.active_version_id))]],
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
    const agentePorPointer = new Map<string, string>();
    for (const v of versoes) {
      const f = v.followup;
      if (!f || f.enabled !== true || !Array.isArray(f.flow_pointer_ids)) continue;
      for (const id of f.flow_pointer_ids) {
        if (typeof id === "string" && !agentePorPointer.has(id)) agentePorPointer.set(id, v.agent_id);
      }
    }

    for (const pointer of candidatos) {
      const pedeAgente = pedeAgentePorVersao.get(pointer.active_version_id);
      if (pedeAgente === undefined) continue;
      const { barrado } = agenteDoGatilhoAutomatico(agentePorPointer.get(pointer.id) ?? null, pedeAgente);
      if (barrado) continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
