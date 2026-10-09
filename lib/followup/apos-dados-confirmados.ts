import type pg from "pg";
import { z } from "zod";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { parseServiceBoundary, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { requireCurrentServiceBoundary } from "@/lib/atendimento/fronteira-server";
import { paymentReviewPending } from "@/lib/agent-engine/agent/payment-review-followup";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { fluxoPedeAgente } from "@/lib/followup/agent-followup-gate";

export const EVENTO_DADOS_CONFIRMADOS = "ai.case_task_delivery_confirmed";
const payloadSchema = z.object({
  case_id: z.uuid(),
  task_generation: z.number().int().nonnegative(),
  decision_event_id: z.uuid(),
  delivery_job_id: z.uuid(),
  post_delivery_pointer_id: z.uuid(),
});
interface FonteDaRetomada {
  id: string;
  conversation_id: string;
  contact_id: string;
  lead_id: string | null;
  task_kind: string;
  task_state: string;
  status: string;
  wait_generation: string | number;
  decision_event_id: string | null;
  delivery_job_id: string | null;
  task_payload: Record<string, unknown>;
  context_snapshot: Record<string, unknown> | null;
}

/** IDs e prova são relidos do caso, nunca inferidos do texto da mensagem. */
export function fonteConfere(
  fonte: FonteDaRetomada,
  payload: z.infer<typeof payloadSchema>,
): boolean {
  return (
    fonte.id === payload.case_id &&
    fonte.task_kind === "payment_details" &&
    fonte.task_state === "completed" &&
    fonte.status === "resolved" &&
    Number(fonte.wait_generation) === payload.task_generation &&
    fonte.decision_event_id === payload.decision_event_id &&
    fonte.delivery_job_id === payload.delivery_job_id &&
    fonte.task_payload.decision === "details_release" &&
    fonte.task_payload.post_delivery_pointer_id === payload.post_delivery_pointer_id
  );
}

/** Matrícula + recibo na mesma transação; reentrega nunca inicia outra cobrança. */
export async function iniciarAposDadosConfirmados(
  pool: pg.Pool,
  evento: EventRow,
): Promise<{ enrolled: boolean; reason: string }> {
  const parsed = payloadSchema.safeParse(evento.payload);
  if (
    evento.event_type !== EVENTO_DADOS_CONFIRMADOS ||
    !parsed.success ||
    evento.entity_id !== parsed.data.case_id
  )
    return { enrolled: false, reason: "evento_sem_configuracao_valida" };
  const p = parsed.data;
  const db = await pool.connect();
  let committed = false;
  try {
    await db.query("begin");
    const scope = await db.query<{ conversation_id: string }>(
      "select conversation_id from agent_cases where organization_id=$1 and id=$2",
      [evento.organization_id, p.case_id],
    );
    if (!scope.rows[0]) return { enrolled: false, reason: "caso_ausente" };
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${evento.organization_id}:case:${scope.rows[0].conversation_id}`,
    ]);
    const { rows } = await db.query<FonteDaRetomada>(
      `select ac.*,c.contact_id from agent_cases ac
      join conversations c on c.id=ac.conversation_id and c.organization_id=ac.organization_id
      where ac.organization_id=$1 and ac.id=$2 for update of ac`,
      [evento.organization_id, p.case_id],
    );
    const source = rows[0];
    if (!source || !fonteConfere(source, p)) return { enrolled: false, reason: "entrega_superada" };
    if (
      source.task_payload.post_delivery_event_id === evento.id ||
      typeof source.task_payload.post_delivery_enrollment_id === "string"
    )
      return { enrolled: false, reason: "ja_processado" };
    const receipt = await db.query<{ id: string }>(
      "select id from send_ledger where organization_id=$1 and job_id=$2 and seq=1 and status='accepted'",
      [evento.organization_id, p.delivery_job_id],
    );
    if (!receipt.rows[0]) return { enrolled: false, reason: "envio_sem_recibo_confirmado" };
    // A decisão financeira é autoridade mesmo se seu aviso falhou ou a tarefa
    // já terminou. O snapshot no evento preserva a compra quando o caso muda.
    const confirmed = await db.query<{ id: string }>(
      `select ev.id from agent_case_events ev
      join agent_cases ac on ac.organization_id=ev.organization_id and ac.id=ev.case_id
      where ev.organization_id=$1 and ev.kind='human_replied' and ev.actor_kind='human'
        and ev.metadata->>'task_action'='payment_confirmed'
        and ((ev.metadata->>'lead_id'=$2::text and ev.metadata->>'conversation_id'=$3::text)
          or (not (ev.metadata ? 'lead_id') and not (ev.metadata ? 'conversation_id')
            and ac.lead_id=$2::uuid and ac.conversation_id=$3::uuid
            and ac.decision_event_id=ev.id and ac.task_payload->>'decision'='payment_confirmed'))
      limit 1`,
      [evento.organization_id, source.lead_id, source.conversation_id],
    );
    if (confirmed.rows[0]) return { enrolled: false, reason: "pagamento_confirmado_pela_equipe" };
    if (
      source.lead_id &&
      (await paymentReviewPending(db, evento.organization_id, source.conversation_id, source.lead_id))
    )
      return { enrolled: false, reason: "conferencia_pendente" };
    const { rows: leads } = await db.query<{ id: string }>(
      "select id from crm_leads where organization_id=$1 and id=$2 and contact_id=$3 and status='open' for share",
      [evento.organization_id, source.lead_id, source.contact_id],
    );
    if (!leads[0]) return { enrolled: false, reason: "compra_encerrada" };
    const boundary = parseServiceBoundary(source.context_snapshot?.service_boundary);
    if (
      !boundary ||
      boundary.organization_id !== evento.organization_id ||
      boundary.contact_id !== source.contact_id ||
      boundary.conversation_id !== source.conversation_id
    )
      return { enrolled: false, reason: "origem_obsoleta" };
    await requireCurrentServiceBoundary(db, boundary);
    const { rows: contacts } = await db.query<{ id: string }>(
      "select id from contacts where organization_id=$1 and id=$2 and not is_anonymized and not is_blocked and not force_human",
      [evento.organization_id, source.contact_id],
    );
    if (!contacts[0]) return { enrolled: false, reason: "contato_indisponivel" };
    if (evento.created_at) {
      const { rows: replies } = await db.query<{ id: string }>(
        "select id from messages where organization_id=$1 and conversation_id=$2 and direction='inbound' and sent_at>$3::timestamptz limit 1",
        [evento.organization_id, source.conversation_id, evento.created_at],
      );
      if (replies[0]) return { enrolled: false, reason: "cliente_ja_respondeu" };
    }
    const { rows: pointers } = await db.query<{ active_version_id: string; graph: unknown }>(
      `select p.active_version_id,v.graph from followup_flow_pointers p
      join followup_flow_versions v on v.organization_id=p.organization_id and v.id=p.active_version_id
      where p.organization_id=$1 and p.id=$2 and p.status='active' and p.surface <> 'atendimento'
        and public.fn_org_operante(p.organization_id) for share of p`,
      [evento.organization_id, p.post_delivery_pointer_id],
    );
    if (!pointers[0]) return { enrolled: false, reason: "fluxo_nao_publicado" };
    const graph = flowGraphSchema.parse(pointers[0].graph);
    const trigger = graph.nodes.find((n) => n.type === "trigger");
    if (!trigger) return { enrolled: false, reason: "fluxo_sem_inicio" };
    const { rows: agents } = await db.query<{ agent_id: string }>(
      `select agent_id from ai_agent_versions where organization_id=$1 and status='published'
      and followup->>'enabled'='true' and (followup->'flow_pointer_ids') ? $2 order by agent_id limit 1`,
      [evento.organization_id, p.post_delivery_pointer_id],
    );
    if (fluxoPedeAgente(graph) && !agents[0])
      return { enrolled: false, reason: "fluxo_sem_agente" };
    const { rows: enrollments } = await db.query<{ id: string }>(
      `insert into followup_enrollments
      (organization_id,pointer_id,version_id,contact_id,current_node_id,status,agent_id,service_boundary,conversation_id)
      values($1,$2,$3,$4,$5,'active',$6,$7,$8) on conflict do nothing returning id`,
      [
        evento.organization_id,
        p.post_delivery_pointer_id,
        pointers[0].active_version_id,
        source.contact_id,
        trigger.id,
        agents[0]?.agent_id ?? null,
        boundary,
        source.conversation_id,
      ],
    );
    if (!enrollments[0]) return { enrolled: false, reason: "acompanhamento_ja_ativo" };
    const enrollment = enrollments[0].id;
    await db.query(
      `insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
      values($1,$2,$3,'enrolled',$4,$5)`,
      [
        evento.organization_id,
        enrollment,
        trigger.id,
        { source_case_id: source.id, delivery_event_id: evento.id },
        `delivery:${evento.id}`,
      ],
    );
    await db.query(
      `update agent_cases set task_payload=task_payload || jsonb_build_object('post_delivery_event_id',$3::text,'post_delivery_enrollment_id',$4::text)
      where organization_id=$1 and id=$2`,
      [evento.organization_id, source.id, evento.id, enrollment],
    );
    await db.query("commit");
    committed = true;
    return { enrolled: true, reason: "matriculado_apos_envio_confirmado" };
  } catch (error) {
    if (error instanceof StaleServiceBoundaryError)
      return { enrolled: false, reason: "origem_obsoleta" };
    throw error;
  } finally {
    // Também encerra as saídas sem efeito; nenhum retorno deixa lock pendurado.
    try {
      if (!committed) await db.query("rollback");
    } finally {
      db.release();
    }
  }
}
