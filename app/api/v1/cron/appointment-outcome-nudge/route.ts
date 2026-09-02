/**
 * GET/POST /api/v1/cron/appointment-outcome-nudge
 *
 * Agendamento `scheduled` cujo horário+duração já passou há mais de 1h NÃO é
 * auto-marcado como completed/no_show — só um humano sabe se o cliente veio.
 * Abre aviso na Central pedindo confirmação. Fecha o invariante "nada morre
 * sem próximo passo" (Sistema Vivo): sem isso, o agendamento ficaria
 * `scheduled` para sempre, mentindo pra qualquer relatório de no-show.
 *
 * O corte usa `ends_at` (coluna gerada, migration 0166:
 * `scheduled_at + duration_minutes * interval '1 minute'`), não
 * `scheduled_at` puro — um agendamento de 2h "termina" bem depois de começar.
 * `ends_at` foi adicionada em migration NOVA (0166), nunca editando a 0165 já
 * commitada (doutrina de migrations: "nunca edite migration já aplicada").
 *
 * `agent_inbox_items.kind = 'appointment_outcome_pending'` também entrou na
 * 0166 (extensão do bloco único de `agent_inbox_items_kind_check`) — sem
 * isso, todo INSERT deste cron falharia com 23514 num Postgres real.
 *
 * Dedup contra reaviso: o cron roda de hora em hora e o mesmo agendamento
 * atrasado continuaria candidato enquanto ninguém mudar o status (que este
 * cron nunca faz sozinho) — sem checar se já existe um aviso `open` para o
 * MESMO agendamento, a Central ganharia um item novo por hora, para sempre.
 * Mesmo padrão de dedup já usado no baseline para `budget_warning`
 * (`not exists (select 1 from agent_inbox_items i where ... and i.status =
 * 'open')`), aqui feito como um SELECT em lote (`ref_id in (...)`) antes do
 * loop de insert, para não disparar uma query por candidato.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const GRACE_MS = 60 * 60 * 1000; // 1h após o fim do agendamento
const BATCH_LIMIT = 100;
const KIND = "appointment_outcome_pending";

export interface NudgeResult {
  nudged: number;
}

interface PastAppointment {
  id: string;
  organization_id: string;
  lead_id: string;
}

export async function nudgePendingOutcomes(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
): Promise<NudgeResult> {
  const cutoff = new Date(now.getTime() - GRACE_MS).toISOString();

  // Corte real no banco (não pós-fetch): esta varredura é cross-tenant por
  // desenho (sem filtro de organization_id — é uma manutenção de plataforma,
  // não uma leitura de tela) e roda a cada hora, então um `.limit()` fora do
  // SQL seria uma leitura ilimitada recorrente numa instância movimentada.
  const { data, error } = await admin
    .from("appointments")
    .select("id, organization_id, lead_id")
    .eq("status", "scheduled")
    .lt("ends_at", cutoff)
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`select_past_failed: ${error.message}`);

  const past = (data ?? []) as PastAppointment[];
  if (past.length === 0) return { nudged: 0 };

  // Quem já tem aviso ABERTO para o mesmo agendamento não recebe outro nesta
  // rodada — sem isto, o mesmo atraso ganharia um item novo por hora até um
  // humano agir, e o conjunto de candidatos nunca encolheria.
  const ids = past.map((appt) => appt.id);
  const { data: existentes, error: existentesError } = await admin
    .from("agent_inbox_items")
    .select("ref_id")
    .eq("kind", KIND)
    .eq("status", "open")
    .in("ref_id", ids);
  if (existentesError) throw new Error(`select_existing_failed: ${existentesError.message}`);

  const jaAvisados = new Set(((existentes ?? []) as { ref_id: string }[]).map((r) => r.ref_id));

  let nudged = 0;
  for (const appt of past) {
    if (jaAvisados.has(appt.id)) continue;
    await admin.from("agent_inbox_items").insert({
      organization_id: appt.organization_id,
      kind: KIND,
      severity: "info",
      title: "Confirme o desfecho de um agendamento",
      body: "Um horário marcado já passou e ainda não foi marcado como concluído, cancelado ou falta.",
      ref_kind: "appointment",
      ref_id: appt.id,
    });
    nudged += 1;
  }

  return { nudged };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: NudgeResult;
  try {
    result = await nudgePendingOutcomes(createAdminClient(), new Date());
  } catch (err) {
    logger.error("[appointment-outcome-nudge] falhou", { error: err instanceof Error ? err.message : String(err) });
    return fail("internal_error", "Failed to nudge pending outcomes.", 500, { requestId });
  }
  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
