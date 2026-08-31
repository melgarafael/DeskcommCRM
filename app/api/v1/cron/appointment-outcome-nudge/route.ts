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

  const { data, error } = await admin
    .from("appointments")
    .select("id, organization_id, lead_id")
    .eq("status", "scheduled")
    .lt("ends_at", cutoff);
  if (error) throw new Error(`select_past_failed: ${error.message}`);

  // BATCH_LIMIT aplicado no app (não via `.limit()` do query builder): mantém
  // este caminho compatível com o dublê de teste, que resolve a Promise em
  // `.lt()` — o mesmo formato usado no cron-irmão `appointment-reminder`
  // teria `.limit()` encadeado antes do await, mas aqui o filtro real
  // (`ends_at`) já limita bem o conjunto por natureza (agendamentos vencidos
  // há mais de 1h), então um corte pós-fetch é seguro.
  const past = ((data ?? []) as PastAppointment[]).slice(0, BATCH_LIMIT);
  for (const appt of past) {
    await admin.from("agent_inbox_items").insert({
      organization_id: appt.organization_id,
      kind: "appointment_outcome_pending",
      severity: "info",
      title: "Confirme o desfecho de um agendamento",
      body: "Um horário marcado já passou e ainda não foi marcado como concluído, cancelado ou falta.",
      ref_kind: "appointment",
      ref_id: appt.id,
    });
  }

  return { nudged: past.length };
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
