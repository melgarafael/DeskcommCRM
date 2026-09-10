import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireAcademia } from "@/lib/modules/require-academia";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { scheduleSchema, scheduleColumns, scheduleValues, type ScheduleRecord, type ScheduleValues } from "@/lib/academia/schedule";

export const dynamic = "force-dynamic";
const table = "academia_weekly_classes";
const createEnvelope = z.object({ values: scheduleSchema }).strict();
const updateEnvelope = z.object({ id: z.uuid(), revision: z.number().int().positive(), values: scheduleSchema }).strict();
const normalize = (row: ScheduleRecord): ScheduleRecord => ({ ...row, start_time: row.start_time.slice(0, 5) });
function sameValues(row: ScheduleRecord, values: ScheduleValues) {
  const previous = scheduleValues(row);
  return Object.entries(values).every(([key, value]) => previous[key as keyof ScheduleValues] === value);
}

export async function GET(req: Request) {
  const requestId = randomUUID();
  const auth = await requireAcademia(requestId);
  if (!auth.ok) return auth.response;
  const cursor = new URL(req.url).searchParams.get("cursor");
  if (cursor && !z.uuid().safeParse(cursor).success) return fail("validation_failed", "Página inválida.", 422, { requestId });
  let query = (await createClient()).from(table).select(scheduleColumns)
    .eq("organization_id", auth.org.orgId).order("id").limit(51);
  if (cursor) query = query.gt("id", cursor);
  const { data, error } = await query;
  if (error) return fail("internal_error", "Não foi possível carregar a grade.", 500, { requestId });
  const rows = (data ?? []) as unknown as ScheduleRecord[];
  return ok(rows.slice(0, 50).map(normalize), {
    requestId, headers: { "Cache-Control": "no-store" },
    meta: { has_more: rows.length > 50, cursor: rows.length > 50 ? rows[49]!.id : null },
  });
}

async function write(req: Request, create: boolean) {
  const requestId = randomUUID();
  const auth = await requireAcademia(requestId, "manager");
  if (!auth.ok) return auth.response;
  const envelope = (create ? createEnvelope : updateEnvelope).safeParse(await req.json().catch(() => null));
  if (!envelope.success) return fail("validation_failed", envelope.error.issues[0]?.message ?? "Dados inválidos.", 422, { requestId });
  const parsedId = z.uuid().safeParse(create ? req.headers.get("Idempotency-Key") : "id" in envelope.data ? envelope.data.id : undefined);
  if (!parsedId.success) return fail("validation_failed", "Identificador inválido. Recarregue o formulário e tente novamente.", 422, { requestId });
  const id = parsedId.data;
  const values = envelope.data.values;
  const db = await createClient();

  // Um retry continua válido se um vínculo tiver sido desativado após a criação.
  // A leitura também não revela identidades pertencentes a outra organização.
  async function existing() {
    return db.from(table).select(scheduleColumns).eq("organization_id", auth.org.orgId).eq("id", id).maybeSingle();
  }
  if (create) {
    const { data: previous, error } = await existing();
    if (error) return fail("internal_error", "Não foi possível conferir a aula. Tente novamente.", 500, { requestId });
    if (previous) {
      const row = previous as unknown as ScheduleRecord;
      return sameValues(row, values) ? ok(normalize(row), { requestId })
        : fail("conflict", "Este identificador já foi usado para outra aula. Atualize a grade antes de tentar novamente.", 409, { requestId });
    }
  }

  const query = create
    ? db.from(table).insert({ id, organization_id: auth.org.orgId, ...values })
    : db.from(table).update(values).eq("organization_id", auth.org.orgId).eq("id", id)
      .eq("revision", "revision" in envelope.data ? envelope.data.revision : 0);
  const { data, error } = await query.select(scheduleColumns).maybeSingle();
  if (error?.code === "23505" && create) {
    const { data: previous } = await existing();
    if (previous && sameValues(previous as unknown as ScheduleRecord, values)) {
      return ok(normalize(previous as unknown as ScheduleRecord), { requestId });
    }
  }
  if (error) {
    if (error.code === "23505") return fail("conflict", "Este identificador já foi usado para outra aula. Atualize a grade antes de tentar novamente.", 409, { requestId });
    if (error.code === "23503" || error.code === "23514") return fail("validation_failed", "Confira os campos e selecione cadastros ativos desta empresa para os vínculos novos ou para reativar a aula.", 422, { requestId });
    if (error.code === "42501") return fail("forbidden", "Você não tem permissão para salvar esta aula.", 403, { requestId });
    return fail("internal_error", "Não foi possível salvar a aula.", 500, { requestId });
  }
  if (!data) return fail("conflict", "Esta aula mudou ou não está disponível. Atualize a grade antes de editar novamente.", 409, { requestId });
  await audit({
    action: create ? "academia_schedule.created" : "academia_schedule.updated",
    organizationId: auth.org.orgId, actorUserId: auth.user.id,
    resourceType: table, resourceId: id, requestId, metadata: { active: values.active, weekday: values.weekday },
  });
  return ok(normalize(data as unknown as ScheduleRecord), { requestId, status: create ? 201 : 200 });
}

export async function POST(req: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  return write(req, true);
}
export async function PATCH(req: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  return write(req, false);
}
