import "server-only";
import { checkConnection } from "./connection";
import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { amigoInputSchemas, isAmigoMutation, type AmigoOperation } from "./contracts";
import { requestAmigo } from "./transport";
import { loadAmigoConnection } from "./store";
import { AmigoDomainError, requireAmigoAccess } from "./access";
import {
  operationTarget,
  postgresJournal,
  privateRequestHash,
  runDurableOperation,
} from "./operations";
import { amigoInstant, projectAttendance } from "./projection";

export interface AmigoContext {
  organizationId: string;
  actor: Actor;
  requestId: string;
  role?: string;
  contactId?: string;
  conversationId?: string;
  /** Original connection resolved by the server from a persisted appointment, never a request argument. */
  connectionId?: string;
  expectedConnectionId?: string;
}
export interface AmigoResult {
  data: unknown;
  connection_id?: string;
  operation_id?: string;
  state?: string;
  uncertain?: boolean;
  local_appointment_id?: string | null;
}
function denied(message = "O paciente não está vinculado a este atendimento."): never {
  throw new AmigoDomainError("amigo_scope_denied", 403, message);
}
function rows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data)
    ? data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    : [];
}
function cellphone(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("55") ? digits.slice(2) : digits;
}

/** Shared business boundary for REST, the agenda and MCP. Context is server-owned. */
export async function executeAmigo(
  ctx: AmigoContext,
  operation: AmigoOperation,
  rawInput: unknown,
  operationKey?: string,
): Promise<AmigoResult> {
  const automated = ctx.actor.type !== "user";
  requireAmigoAccess(
    {
      role: ctx.role ?? ("role" in ctx.actor ? ctx.actor.role : undefined) ?? "viewer",
      automated,
      contactId: ctx.contactId,
    },
    operation,
  );
  const parsed = amigoInputSchemas[operation].safeParse(rawInput);
  if (!parsed.success)
    throw new AmigoDomainError("amigo_invalid_input", 422, "Confira os campos da operação Amigo.");
  let input = parsed.data as Record<string, unknown>;
  const db = createAdminClient();
  let contactPhone: string | null = null;
  if (ctx.contactId) {
    const { data: contact, error } = await db
      .from("contacts")
      .select("id,phone_number,is_anonymized")
      .eq("organization_id", ctx.organizationId)
      .eq("id", ctx.contactId)
      .maybeSingle();
    if (error || !contact || contact.is_anonymized) denied();
    contactPhone = cellphone(contact.phone_number);
  }
  const connection = await loadAmigoConnection(ctx.organizationId, ctx.connectionId);
  if (!connection)
    throw new AmigoDomainError(
      "amigo_not_configured",
      422,
      "Configure o token na área Amigo API antes de usar a integração.",
    );
  checkConnection(
    connection.id,
    ctx.expectedConnectionId ?? ctx.connectionId,
    isAmigoMutation(operation) ||
      Object.keys(input).some((k) => k.endsWith("_id") || k === "patientId" || k === "id"),
  );
  const historicalChange =
    ctx.connectionId &&
    [
      "attendance_status",
      "attendance_cancel",
      "attendance_reschedule",
      "patient_attendances",
    ].includes(operation);
  if (!connection.active && !historicalChange && (automated || isAmigoMutation(operation)))
    throw new AmigoDomainError(
      "amigo_inactive",
      422,
      "Ative o modo Amigo após conferir a unidade e o fuso.",
    );

  if (operation === "patient_search" && ctx.contactId) {
    if (!contactPhone || contactPhone.length < 10)
      denied("Cadastre um telefone válido no contato para procurar seus pacientes.");
    // Neither a model-supplied CPF nor another phone widens a conversation's scope.
    input = { contact_cellphone: contactPhone };
  }
  if (operation === "patient_create" && ctx.contactId) {
    if (!contactPhone || contactPhone.length < 10)
      denied("Cadastre o telefone do responsável antes de criar o paciente.");
    input = { ...input, contact_cellphone: contactPhone };
  }
  const patientId = input.patientId ?? input.patient_id;
  if (ctx.contactId && patientId !== undefined) {
    const { data: link, error } = await db
      .from("amigo_patient_links")
      .select("patient_id")
      .eq("organization_id", ctx.organizationId)
      .eq("connection_id", connection.id)
      .eq("contact_id", ctx.contactId)
      .eq("patient_id", patientId)
      .maybeSingle();
    if (error || !link) denied();
  }
  if (operation === "patient_birthdays") {
    const { diaLocalISO } = await import("@/lib/agenda/fuso");
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    if (
      ![
        diaLocalISO(today, connection.timezone).slice(5),
        diaLocalISO(tomorrow, connection.timezone).slice(5),
      ].includes(String(input.date))
    ) {
      throw new AmigoDomainError(
        "amigo_invalid_input",
        422,
        "Aniversariantes podem ser consultados somente para hoje ou amanhã.",
      );
    }
  }
  if (operation === "attendances") input = { ...input, status: input.status ?? "ALL" };
  if (operation === "doctor_dates")
    input = {
      ...(connection.allow_same_day === undefined
        ? {}
        : { allow_same_day: connection.allow_same_day }),
      ...(connection.months_ahead === undefined ? {} : { months_ahead: connection.months_ahead }),
      ...input,
    };
  if (operation === "attendance_status" && automated && input.status !== "confirmed")
    denied(
      "Chegada e cancelamento de status exigem ação humana; para cancelar use a operação de cancelamento.",
    );

  const changedId = operation === "attendance_status" ? input.attendance_id : input.id;
  let previous: Record<string, unknown> | null = null;
  if (operation.startsWith("attendance_") && operation !== "attendance_create") {
    const { data: link, error } = await db
      .from("amigo_appointment_links")
      .select("*")
      .eq("organization_id", ctx.organizationId)
      .eq("connection_id", connection.id)
      .eq("attendance_id", changedId)
      .maybeSingle();
    if (error || !link) denied("Atualize a agenda antes de alterar esta consulta.");
    previous = link;
    if (patientId !== undefined && Number(patientId) !== Number(link.patient_id)) denied();
    if (ctx.contactId) {
      const { data: patientLink, error: linkError } = await db
        .from("amigo_patient_links")
        .select("contact_id")
        .eq("organization_id", ctx.organizationId)
        .eq("connection_id", connection.id)
        .eq("patient_id", link.patient_id)
        .eq("contact_id", ctx.contactId)
        .maybeSingle();
      if (linkError || !patientLink) denied();
    }
  }
  if (!isAmigoMutation(operation)) {
    const response = await requestAmigo(connection.token, operation, input);
    if (operation === "attendances" || operation === "patient_attendances") {
      const bootstrap = connection.last_sync_at === null;
      for (const attendance of rows(response.data))
        await projectAttendance(
          db,
          { id: connection.id, organizationId: ctx.organizationId, timezone: connection.timezone },
          attendance,
          { bootstrap, contactId: ctx.contactId, actor: ctx.actor },
        );
    }
    return { data: response.data, connection_id: connection.id };
  }

  const command = {
    key:
      operationKey ??
      `${ctx.requestId}:${operation}:${privateRequestHash(operation, input).slice(0, 24)}`,
    operation,
    requestHash: privateRequestHash(operation, input),
    targetId: operationTarget(operation, input),
    reconciliation: Object.fromEntries(
      Object.entries(input).filter(([key]) =>
        [
          "patient_id",
          "event_id",
          "user_id",
          "place_id",
          "start_date",
          "id",
          "attendance_id",
          "date",
          "status",
        ].includes(key),
      ),
    ),
  };
  const receipt = await runDurableOperation(
    postgresJournal(db, ctx.organizationId, connection.id),
    command,
    async () => {
      if (operation === "attendance_reschedule" && previous) {
        const a = previous.remote_data as Record<string, unknown>;
        if (!a.doctorId || !a.eventId || !a.placeId)
          throw Object.assign(new Error("Atualize os dados da consulta antes de remarcar."), {
            status: 409,
            uncertain: false,
            code: "amigo_refresh_required",
          });
        const free = await requestAmigo(connection.token, "doctor_dates", {
          id: a.doctorId,
          event_id: a.eventId,
          place_id: a.placeId,
          patient_id: previous.patient_id,
          date: (await import("@/lib/agenda/fuso")).diaLocalISO(
            new Date(amigoInstant(String(input.date), connection.timezone)),
            connection.timezone,
          ),
          ...(connection.allow_same_day === undefined
            ? {}
            : { allow_same_day: connection.allow_same_day }),
        });
        const desired = amigoInstant(String(input.date), connection.timezone);
        if (
          !rows(free.data).some(
            (s) =>
              typeof s.start_date === "string" &&
              amigoInstant(s.start_date, connection.timezone) === desired &&
              Number(s.user_id) === Number(a.doctorId) &&
              (s.place_id == null || Number(s.place_id) === Number(a.placeId)),
          )
        )
          throw Object.assign(new Error("Horário indisponível."), {
            status: 409,
            uncertain: false,
            code: "amigo_slot_unavailable",
          });
      }
      if (operation === "attendance_create") {
        const date = String(input.start_date).slice(0, 10);
        const free = await requestAmigo(connection.token, "doctor_dates", {
          id: input.user_id,
          event_id: input.event_id,
          place_id: input.place_id,
          patient_id: input.patient_id,
          date,
          ...(input.insurance_id ? { insurance_id: input.insurance_id } : {}),
          ...(input.insurance_product_id
            ? { insurance_product_id: input.insurance_product_id }
            : {}),
          ...(connection.allow_same_day === undefined
            ? {}
            : { allow_same_day: connection.allow_same_day }),
        });
        const desired = amigoInstant(String(input.start_date), connection.timezone);
        const found = rows(free.data).some(
          (s) =>
            typeof s.start_date === "string" &&
            amigoInstant(s.start_date, connection.timezone) === desired &&
            Number(s.user_id) === Number(input.user_id) &&
            (s.place_id == null || Number(s.place_id) === Number(input.place_id)),
        );
        if (!found)
          throw Object.assign(new Error("Horário indisponível."), {
            code: "amigo_slot_unavailable",
            status: 409,
            uncertain: false,
          });
        const existing = await requestAmigo(connection.token, "patient_attendances", {
          patient_id: input.patient_id,
          place_id: input.place_id,
          start_date: date,
          end_date: date,
        });
        if (
          rows(existing.data).some(
            (a) =>
              !a.canceled &&
              a.status !== "canceled" &&
              Number(a.event_id) === Number(input.event_id) &&
              Number((a.user as Record<string, unknown> | undefined)?.id ?? a.user_id) ===
                Number(input.user_id) &&
              typeof a.start_date === "string" &&
              amigoInstant(a.start_date, connection.timezone) === desired,
          )
        ) {
          throw Object.assign(new Error("Consulta já existente."), {
            code: "amigo_duplicate_appointment",
            status: 409,
            uncertain: false,
          });
        }
        input = {
          ...input,
          ...(connection.allow_same_day === undefined
            ? {}
            : { allow_same_day: connection.allow_same_day }),
        };
      }
      return requestAmigo(connection.token, operation, input);
    },
  );
  if (receipt.state !== "confirmed")
    return {
      data: receipt.result,
      operation_id: receipt.id,
      state: receipt.state,
      uncertain: receipt.state !== "rejected",
    };
  const result = receipt.result as { data: unknown };
  let superseded = false;
  let localId: string | null = null;
  try {
    if (
      operation === "patient_create" &&
      ctx.contactId &&
      result.data &&
      typeof result.data === "object"
    ) {
      await linkAmigoPatient(ctx, {
        patient_id: Number((result.data as Record<string, unknown>).id),
        contact_id: ctx.contactId,
      });
    }
    if (operation === "attendance_create") {
      const latest = await requestAmigo(connection.token, "patient_attendances", {
        patient_id: input.patient_id,
      });
      const current = rows(latest.data).find(
        (a) => Number(a.id) === Number((result.data as Record<string, unknown>)?.id),
      );
      if (!current) throw new Error("Consulta não encontrada na reconciliação.");
      const { normalizeAttendance } = await import("./projection");
      const state = normalizeAttendance(current, connection.timezone);
      superseded =
        !["scheduled", "confirmed"].includes(state.remoteStatus) ||
        state.startsAt !== amigoInstant(String(input.start_date), connection.timezone);
      result.data = current;
      localId = (
        await projectAttendance(
          db,
          { id: connection.id, organizationId: ctx.organizationId, timezone: connection.timezone },
          result.data,
          { actor: ctx.actor, contactId: ctx.contactId },
        )
      ).appointmentId;
    } else if (previous) {
      const current = await requestAmigo(connection.token, "patient_attendances", {
        patient_id: previous.patient_id,
      });
      const matching = rows(current.data).find((a) => Number(a.id) === Number(changedId));
      if (!matching) throw new Error("Consulta não encontrada na reconciliação.");
      localId = (
        await projectAttendance(
          db,
          { id: connection.id, organizationId: ctx.organizationId, timezone: connection.timezone },
          matching,
          { actor: ctx.actor, contactId: ctx.contactId },
        )
      ).appointmentId;
    }
  } catch {
    // The remote receipt is kept confirmed; repeating the operation only retries projection.
    return {
      data: {
        message:
          "O Amigo respondeu, mas a atualização local precisa ser conferida. Use Atualizar agenda antes de repetir uma ação.",
      },
      state: "projection_pending",
      uncertain: true,
      operation_id: receipt.id,
    };
  }
  await audit({
    action: "amigo.operation",
    organizationId: ctx.organizationId,
    actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    resourceType: "amigo_operation",
    resourceId: receipt.id,
    requestId: ctx.requestId,
    metadata: { operation, state: receipt.state },
  });
  return {
    data: result.data,
    operation_id: receipt.id,
    state: superseded ? "superseded" : "confirmed",
    ...(superseded ? { uncertain: true } : {}),
    local_appointment_id: localId,
  };
}

/** Explicit patient selection; never the first result from a shared phone. */
export async function linkAmigoPatient(
  ctx: AmigoContext,
  input: { patient_id: number; contact_id: string; lead_id?: string },
) {
  requireAmigoAccess(
    {
      role: ctx.role ?? ("role" in ctx.actor ? ctx.actor.role : undefined) ?? "viewer",
      automated: ctx.actor.type !== "user",
      contactId: ctx.contactId,
    },
    "patient_get",
  );
  const db = createAdminClient();
  if (ctx.contactId && input.contact_id !== ctx.contactId) denied();
  const { data: contact, error } = await db
    .from("contacts")
    .select("id,phone_number,is_anonymized")
    .eq("organization_id", ctx.organizationId)
    .eq("id", input.contact_id)
    .maybeSingle();
  if (error || !contact || contact.is_anonymized) denied();
  if (input.lead_id) {
    const { data: lead, error: leadError } = await db
      .from("crm_leads")
      .select("id,contact_id")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.lead_id)
      .maybeSingle();
    if (leadError || !lead || lead.contact_id !== input.contact_id)
      denied("O negócio não pertence ao contato selecionado.");
  }
  const connection = await loadAmigoConnection(ctx.organizationId);
  if (!connection)
    throw new AmigoDomainError(
      "amigo_not_configured",
      422,
      "Configure o Amigo antes de vincular pacientes.",
    );
  checkConnection(connection.id, ctx.expectedConnectionId ?? ctx.connectionId, true);
  const response = await requestAmigo(connection.token, "patient_get", {
    patientId: input.patient_id,
  });
  if (ctx.actor.type !== "user") {
    const search = await requestAmigo(connection.token, "patient_search", {
      contact_cellphone: cellphone(contact.phone_number),
    });
    const patients = Array.isArray(search.data) ? search.data : [search.data];
    if (
      !patients.some(
        (p) =>
          !!p &&
          typeof p === "object" &&
          Number((p as Record<string, unknown>).id) === input.patient_id,
      )
    )
      denied();
  }
  const { data: previous } = await db
    .from("amigo_patient_links")
    .select("contact_id")
    .eq("organization_id", ctx.organizationId)
    .eq("connection_id", connection.id)
    .eq("patient_id", input.patient_id)
    .maybeSingle();
  if (previous && previous.contact_id !== input.contact_id)
    throw new AmigoDomainError(
      "amigo_patient_already_linked",
      409,
      "Esse paciente já possui outro contato responsável. Confira o vínculo antes de alterá-lo.",
    );
  const { error: saveError } = await db.from("amigo_patient_links").upsert(
    {
      organization_id: ctx.organizationId,
      connection_id: connection.id,
      patient_id: input.patient_id,
      contact_id: input.contact_id,
      lead_id: input.lead_id ?? null,
    },
    { onConflict: "organization_id,connection_id,patient_id" },
  );
  if (saveError)
    throw new AmigoDomainError(
      "amigo_link_failed",
      409,
      "Não foi possível vincular o paciente. Confira os dados e tente novamente.",
    );
  await audit({
    action: "amigo.patient_linked",
    organizationId: ctx.organizationId,
    actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    resourceType: "contact",
    resourceId: input.contact_id,
    requestId: ctx.requestId,
    metadata: { connection_id: connection.id, patient_id: input.patient_id },
  });
  const appointments = await requestAmigo(connection.token, "patient_attendances", {
    patient_id: input.patient_id,
  });
  for (const row of rows(appointments.data))
    await projectAttendance(
      db,
      { id: connection.id, organizationId: ctx.organizationId, timezone: connection.timezone },
      row,
      { bootstrap: true, contactId: input.contact_id },
    );
  return { patient: response.data, contact_id: input.contact_id };
}

export function newOperationKey(): string {
  return randomUUID();
}
