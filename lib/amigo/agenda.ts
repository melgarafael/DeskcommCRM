import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { diaLocalISO, partesNoFuso } from "@/lib/agenda/fuso";
import { z } from "zod";
import { roleAtLeast } from "@/lib/auth/types";
import { executeAmigo, type AmigoContext, type AmigoResult } from "./service";
import { AmigoDomainError } from "./access";
import type { AmigoOperation } from "./contracts";

export const AMIGO_AGENDA_PATH = "/app/integrations/amigo";
export const AMIGO_CONTEXT_REQUIRED = `Esta agenda usa o Amigo. Selecione paciente, unidade, atendimento e médico nas ferramentas Amigo ou em ${AMIGO_AGENDA_PATH} e escolha uma vaga retornada pelo provedor.`;

const externalId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const amigoBookingContextSchema = z
  .strictObject({
    patient_id: externalId,
    user_id: externalId,
    place_id: externalId,
    insurance_id: externalId.optional(),
    insurance_product_id: externalId.optional(),
  })
  .refine(
    (v) => v.insurance_product_id === undefined || v.insurance_id !== undefined,
    "Selecione o convênio do produto.",
  );
export type AmigoBookingContext = z.infer<typeof amigoBookingContextSchema>;
export interface AgendaConnection {
  id: string;
  timezone: string;
  default_place_id: number | null;
}
export type AgendaAuthority =
  | { provider: "local" }
  | { provider: "amigo"; connectionId: string; connection?: AgendaConnection };

/** Read safe metadata through the caller's client. No credentials or hidden service role. */
export async function agendaAuthority(
  db: SupabaseClient,
  org: string,
  appointment?: Record<string, unknown>,
): Promise<AgendaAuthority> {
  if (appointment) {
    if (appointment.authority === "amigo") {
      if (typeof appointment.external_connection_id !== "string")
        throw new ApiError(
          409,
          "agenda_provider_unavailable",
          undefined,
          "agenda",
          "Atualize a agenda Amigo para conferir a conexão deste compromisso.",
        );
      return { provider: "amigo", connectionId: appointment.external_connection_id };
    }
    if (appointment.authority && appointment.authority !== "local")
      throw new ApiError(
        422,
        "agenda_provider_unavailable",
        undefined,
        "agenda",
        "Gerencie este compromisso no provedor de origem.",
      );
    return { provider: "local" };
  }
  const { data, error } = await db.rpc("fn_calendar_agenda_provider", { p_org: org });
  // The member-checked RPC handles unprovisioned modules. RLS must never hide an active provider.
  if (error)
    throw new ApiError(
      503,
      "agenda_provider_unavailable",
      undefined,
      "agenda",
      "Não foi possível verificar o provedor da agenda. Tente novamente antes de marcar.",
    );
  if (!data || data.active !== true) return { provider: "local" };
  return {
    provider: "amigo",
    connectionId: String(data.id),
    connection: {
      id: String(data.id),
      timezone: String(data.timezone),
      default_place_id: data.default_place_id,
    },
  };
}

export function providerContext(authority: AgendaAuthority) {
  return authority.provider === "amigo"
    ? {
        provider: "amigo" as const,
        provider_context: {
          connection_id: authority.connectionId,
          path: AMIGO_AGENDA_PATH,
          required: ["patient_id", "place_id", "user_id", "event_id"],
          instruction: AMIGO_CONTEXT_REQUIRED,
        },
      }
    : { provider: "local" as const };
}

function refuse(ctx: HandlerCtx, code: string, message: string): never {
  throw new ApiError(
    422,
    code,
    { provider: "amigo", path: AMIGO_AGENDA_PATH },
    ctx.requestId,
    message,
  );
}
async function serviceContext(
  db: SupabaseClient,
  ctx: HandlerCtx,
  contactId?: string,
  connectionId?: string,
): Promise<AmigoContext> {
  let role = "role" in ctx.actor ? ctx.actor.role : undefined;
  if (ctx.actor.type === "user" && !role) {
    const { data, error } = await db
      .from("user_organizations")
      .select("role")
      .eq("organization_id", ctx.organization_id)
      .eq("user_id", ctx.actor.id)
      .is("revoked_at", null)
      .not("accepted_at", "is", null)
      .maybeSingle();
    if (error || !data || !roleAtLeast(data.role, "agent"))
      throw new ApiError(
        403,
        "forbidden",
        undefined,
        ctx.requestId,
        "Seu perfil não pode alterar a agenda Amigo.",
      );
    role = data.role;
  }
  return {
    organizationId: ctx.organization_id,
    actor: ctx.actor,
    requestId: ctx.requestId,
    contactId,
    connectionId,
    agentExecution: ctx.amigoAgentExecution,
    agentToolIds: ctx.amigoAgentToolIds,
    role,
  };
}
function civilMinute(value: string, timezone: string, ctx: HandlerCtx): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || instant.getUTCSeconds() || instant.getUTCMilliseconds())
    refuse(
      ctx,
      "agenda_amigo_context_required",
      "Escolha o horário exato de uma vaga Amigo, com precisão de minutos.",
    );
  const p = partesNoFuso(instant, timezone);
  return `${diaLocalISO(instant, timezone)} ${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
}
function key(ctx: HandlerCtx, action: string, target: string) {
  return (
    ctx.idempotencyKey ??
    (ctx.sourceJobId
      ? `agent-job:${ctx.sourceJobId}:${action}:${target}`
      : `${ctx.requestId}:${action}:${target}`)
  );
}
async function execute(
  ctx: HandlerCtx,
  context: AmigoContext,
  operation: AmigoOperation,
  input: unknown,
  target: string,
): Promise<AmigoResult> {
  let result: AmigoResult;
  try {
    result = await executeAmigo(context, operation, input, key(ctx, operation, target));
  } catch (error) {
    if (error instanceof AmigoDomainError)
      throw new ApiError(
        error.status,
        error.code,
        { provider: "amigo", path: AMIGO_AGENDA_PATH },
        ctx.requestId,
        error.message,
      );
    throw error;
  }
  if (result.state !== "confirmed" || result.uncertain || !result.local_appointment_id) {
    throw new ApiError(
      409,
      "agenda_amigo_unconfirmed",
      {
        provider: "amigo",
        operation_id: result.operation_id,
        state: result.state,
        path: AMIGO_AGENDA_PATH,
      },
      ctx.requestId,
      "A operação ainda não foi confirmada com sua projeção local. Confira a consulta em Amigo API antes de repetir; não anuncie sucesso ao paciente.",
    );
  }
  return result;
}
async function receipt(
  db: SupabaseClient,
  ctx: HandlerCtx,
  result: AmigoResult,
  attendanceId: number,
) {
  const { data, error } = await db
    .from("calendar_appointments")
    .select(
      "id,starts_at,ends_at,status,time_zone,revision,authority,external_status,external_connection_id",
    )
    .eq("organization_id", ctx.organization_id)
    .eq("id", result.local_appointment_id!)
    .maybeSingle();
  if (error || !data || data.authority !== "amigo")
    throw new ApiError(
      409,
      "agenda_amigo_unconfirmed",
      { operation_id: result.operation_id },
      ctx.requestId,
      "Atualize a agenda Amigo para conferir a projeção desta consulta.",
    );
  return {
    ...data,
    id: result.local_appointment_id,
    attendance_id: attendanceId,
    operation_id: result.operation_id,
  };
}

export async function createAmigoAppointment(
  db: SupabaseClient,
  ctx: HandlerCtx,
  input: {
    event_type_id: string;
    starts_at: string;
    contact_id?: string;
    conversation_id?: string;
    amigo?: AmigoBookingContext;
  },
  connection: AgendaConnection,
): Promise<Record<string, unknown>> {
  const parsed = amigoBookingContextSchema.safeParse(input.amigo);
  if (!parsed.success) refuse(ctx, "agenda_amigo_context_required", AMIGO_CONTEXT_REQUIRED);
  const { data: type, error } = await db
    .from("calendar_event_types")
    .select("id,external_provider,external_id,external_connection_id,is_active")
    .eq("organization_id", ctx.organization_id)
    .eq("id", input.event_type_id)
    .maybeSingle();
  if (error)
    throw new ApiError(
      503,
      "agenda_provider_unavailable",
      undefined,
      ctx.requestId,
      "Não foi possível conferir o atendimento Amigo.",
    );
  if (
    !type ||
    type.external_provider !== "amigo" ||
    type.external_connection_id !== connection.id ||
    type.is_active === false ||
    !externalId.safeParse(Number(type.external_id)).success
  )
    refuse(ctx, "agenda_amigo_context_required", AMIGO_CONTEXT_REQUIRED);
  const result = await execute(
    ctx,
    {
      ...(await serviceContext(db, ctx, input.contact_id)),
      conversationId: input.conversation_id,
      expectedConnectionId: connection.id,
    },
    "attendance_create",
    {
      ...parsed.data,
      event_id: Number(type.external_id),
      start_date: civilMinute(input.starts_at, connection.timezone, ctx),
    },
    input.event_type_id,
  );
  const remote = result.data as { id?: number } | null;
  return receipt(db, ctx, result, Number(remote?.id));
}

export async function changeAmigoAppointment(
  db: SupabaseClient,
  ctx: HandlerCtx,
  appointment: Record<string, unknown>,
  input: {
    starts_at?: string;
    status?: string;
    [field: string]: unknown;
  },
  action: "change" | "cancel",
): Promise<Record<string, unknown>> {
  const authority = await agendaAuthority(db, ctx.organization_id, appointment);
  if (authority.provider !== "amigo")
    refuse(ctx, "agenda_amigo_context_required", AMIGO_CONTEXT_REQUIRED);
  const unsupported = Object.keys(input).some(
    (field) => !["id", "revision", "starts_at", "status", "reason"].includes(field),
  );
  if (
    action === "change" &&
    (unsupported ||
      (input.status !== undefined && input.status !== "confirmed") ||
      !!input.starts_at === !!input.status)
  )
    refuse(
      ctx,
      "agenda_amigo_unsupported_change",
      `O Amigo permite confirmar ou remarcar, uma ação por vez. Presença, conclusão e alterações de cadastro devem ser conferidas em ${AMIGO_AGENDA_PATH}.`,
    );
  const context = await serviceContext(
    db,
    ctx,
    typeof appointment.contact_id === "string" ? appointment.contact_id : undefined,
    authority.connectionId,
  );
  const { data: link, error } = await db.rpc("fn_calendar_amigo_target", {
    p_org: ctx.organization_id,
    p_id: appointment.id,
    p_connection: authority.connectionId,
  });
  if (error || !link)
    refuse(
      ctx,
      "agenda_amigo_context_required",
      `Atualize a consulta em ${AMIGO_AGENDA_PATH} antes de alterá-la.`,
    );
  const operation =
    action === "cancel"
      ? "attendance_cancel"
      : input.starts_at
        ? "attendance_reschedule"
        : "attendance_status";
  const payload =
    action === "cancel"
      ? { id: link.attendance_id }
      : input.starts_at
        ? {
            id: link.attendance_id,
            date: civilMinute(input.starts_at, String(appointment.time_zone), ctx),
          }
        : { attendance_id: link.attendance_id, patient_id: link.patient_id, status: "confirmed" };
  const result = await execute(ctx, context, operation, payload, String(appointment.id));
  return receipt(db, ctx, result, Number(link.attendance_id));
}
