import { protecaoAgendaPg } from "@/lib/agenda/protecao-followup";
import type pg from "pg";

import { calculaScore, type SinaisDoLead } from "@/lib/leads/score-formula";
import { classifyRisk, resolveStageWindow } from "@/lib/leads/risk-radar";

/**
 * Lê os sinais de UM lead e grava (ou apaga) o score dele.
 *
 * É o núcleo do worker — a parte que decide e escreve. O laço que consome
 * `event_log` fica de fora de propósito: ele é infraestrutura de agendamento e
 * não tem regra nenhuma dentro, enquanto tudo o que pode estar errado mora
 * aqui. Separado assim, a decisão é testável sem fila e sem cron.
 *
 * NUNCA por trigger: trigger que calcula score faria o INSERT de qualquer
 * mensagem esperar pelo cálculo, e a doutrina do repo proíbe HTTP/regra pesada
 * dentro de transação de escrita.
 */
export interface ResultadoDaEscrita {
  leadId: string;
  gravou: boolean;
  /** Quando não gravou, o porquê — para o log, nunca para a tela. */
  motivo?: string;
}

export async function recalculaScoreDoLead(
  db: pg.Pool,
  organizationId: string,
  leadId: string,
  agora = new Date(),
): Promise<ResultadoDaEscrita> {
  const { rows } = await db.query<{
    status: "open" | "won" | "lost";
    contact_id: string | null;
    last_activity_at: string | null;
    created_at: string;
    expected_duration_hours: number | null;
    qualification: Record<string, unknown> | null;
    checkpoint_id: string | null;
    commitments: string[] | null;
    objections: string[] | null;
    band_anterior: "frio" | "morno" | "quente" | null;
  }>(
    `select l.status, l.contact_id, l.last_activity_at::text, l.created_at::text,
            s.expected_duration_hours,
            ls.qualification,
            ck.id as checkpoint_id, ck.commitments, ck.objections,
            sc.ai_probability_band as band_anterior
       from crm_leads l
       left join crm_stages s on s.id = l.stage_id
       left join lead_state ls
              on ls.contact_id = l.contact_id and ls.organization_id = l.organization_id
       left join lateral (
         select c.id, c.commitments, c.objections
           from lead_checkpoints c
          where c.contact_id = l.contact_id and c.organization_id = l.organization_id
          order by c.seq desc
          limit 1
       ) ck on true
       left join crm_lead_scores sc on sc.lead_id = l.id
      where l.organization_id = $1 and l.id = $2`,
    [organizationId, leadId],
  );
  const lead = rows[0];
  if (!lead) return { leadId, gravou: false, motivo: "lead_inexistente" };

  // Recência SEMPRE pelo classificador único — a fórmula recebe o bucket
  // pronto e não conhece hora nenhuma.
  const referencia = lead.last_activity_at ?? lead.created_at;
  const agenda = lead.contact_id ? await protecaoAgendaPg(db, organizationId, lead.contact_id, agora) : undefined;
  if (agenda?.motivo === "leitura_indisponivel") return { leadId, gravou: false, motivo: "agenda_indisponivel" };
  const risco = classifyRisk({
    agenda,
    lastActivityAt: new Date(referencia),
    now: agora,
    inFlight: false,
    window: resolveStageWindow({ expected_duration_hours: lead.expected_duration_hours }),
  }).bucket;

  const sinais: SinaisDoLead = {
    commitments: lead.commitments ?? [],
    objections: lead.objections ?? [],
    checkpointId: lead.checkpoint_id,
    qualification: lead.qualification ?? {},
    risco,
    status: lead.status,
    bandAnterior: lead.band_anterior,
  };

  const calculado = calculaScore(sinais);

  if (calculado.score === null || calculado.band === null) {
    // APAGA em vez de deixar o número velho. Score que deixou de ter lastro é
    // pior que score nenhum: continuaria na tela com cara de atual, e o lead
    // fechado é o caso óbvio disso.
    await db.query(
      `update crm_lead_scores
          set ai_probability = null, ai_probability_reason = null,
              ai_probability_evidence = '{}'::jsonb, ai_probability_at = null,
              ai_probability_band = null, ai_probability_band_since = null,
              updated_at = now()
        where organization_id = $1 and lead_id = $2`,
      [organizationId, leadId],
    );
    return { leadId, gravou: false, motivo: calculado.semSinal ?? "sem_score" };
  }

  // `band_since` só se move quando a FAIXA muda — é o que permite dizer "está
  // quente há dois dias" sem recalcular nada. Recalcular o mesmo score não
  // reinicia o relógio.
  await db.query(
    `insert into crm_lead_scores (
       lead_id, organization_id, ai_probability, ai_probability_reason,
       ai_probability_evidence, ai_probability_at, ai_probability_band,
       ai_probability_band_since, updated_at
     ) values ($1, $2, $3, $4, $5::jsonb, now(), $6, now(), now())
     on conflict (lead_id) do update
       set ai_probability = excluded.ai_probability,
           ai_probability_reason = excluded.ai_probability_reason,
           ai_probability_evidence = excluded.ai_probability_evidence,
           ai_probability_at = excluded.ai_probability_at,
           ai_probability_band = excluded.ai_probability_band,
           ai_probability_band_since = case
             when crm_lead_scores.ai_probability_band is distinct from excluded.ai_probability_band
             then now() else crm_lead_scores.ai_probability_band_since end,
           updated_at = now()`,
    [
      leadId,
      organizationId,
      calculado.score,
      calculado.reason,
      JSON.stringify(calculado.evidence),
      calculado.band,
    ],
  );
  return { leadId, gravou: true };
}
