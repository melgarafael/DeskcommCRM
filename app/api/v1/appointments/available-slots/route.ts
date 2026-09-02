import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeAvailableSlots } from "@/lib/agenda/available-slots";
import { wallClockParts } from "@/lib/tempo/zoned-clock";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  type_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "appointments" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const parsedQuery = querySchema.safeParse({
    type_id: url.searchParams.get("type_id"),
    date: url.searchParams.get("date"), // "YYYY-MM-DD"
  });
  if (!parsedQuery.success) {
    return fail("validation_failed", "type_id e date são obrigatórios e devem ser válidos.", 422, {
      requestId,
      details: parsedQuery.error.flatten(),
    });
  }
  const { type_id: typeId, date } = parsedQuery.data;

  const admin = createAdminClient();

  const { data: type, error: typeErr } = await admin
    .from("appointment_types")
    .select("duration_minutes, responsible_user_id")
    .eq("id", typeId)
    .eq("organization_id", authz.org.orgId)
    .single();
  if (typeErr || !type) return fail("not_found", "Tipo de agendamento não encontrado.", 404, { requestId });

  const { data: org } = await admin
    .from("organizations")
    .select("timezone")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  const timezone = (org as { timezone: string } | null)?.timezone ?? "UTC";

  // dia da semana do `date` NO FUSO DA ORG (meio-dia UTC evita virada de dia
  // por causa de offset em fusos extremos — o cálculo real de slot usa a hora
  // do bloco, não este instante).
  const dayOfWeek = wallClockParts(new Date(`${date}T12:00:00Z`), timezone).weekday;

  const { data: blocks, error: blocksErr } = await admin
    .from("attendant_schedule")
    .select("starts_at, ends_at")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", (type as { responsible_user_id: string }).responsible_user_id)
    .eq("day_of_week", dayOfWeek)
    .order("starts_at", { ascending: true });
  if (blocksErr) return fail("internal_error", "Erro ao consultar horário do responsável.", 500, { requestId });

  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;
  const { data: existing, error: existingErr } = await admin
    .from("appointments")
    .select("scheduled_at, duration_minutes")
    .eq("organization_id", authz.org.orgId)
    .eq("responsible_user_id", (type as { responsible_user_id: string }).responsible_user_id)
    .eq("status", "scheduled")
    .lt("scheduled_at", dayEnd)
    .gte("scheduled_at", dayStart);
  if (existingErr) return fail("internal_error", "Erro ao consultar agendamentos existentes.", 500, { requestId });

  const slots = computeAvailableSlots({
    date,
    timezone,
    durationMinutes: (type as { duration_minutes: number }).duration_minutes,
    scheduleBlocks: (blocks ?? []) as { starts_at: string; ends_at: string }[],
    existingAppointments: (existing ?? []) as { scheduled_at: string; duration_minutes: number }[],
  });

  // O cálculo puro não conhece "agora" — filtra aqui os slots que já
  // passaram (relevante em "hoje": o primeiro horário do turno pode já ter
  // ficado no passado). Comparação de dois instantes absolutos, então
  // independe do fuso da org.
  const futuros = slots.filter((s) => new Date(s.startsAt).getTime() > Date.now());

  return ok(futuros, { requestId });
}
