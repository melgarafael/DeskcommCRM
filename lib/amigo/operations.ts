import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashDoCorpo } from "@/lib/api/idempotency";

export type OperationState = "prepared" | "sent" | "confirmed" | "rejected" | "uncertain";
export interface OperationCommand {
  key: string;
  operation: string;
  requestHash: string;
  targetId: string;
  reconciliation?: Record<string, unknown>;
}
export interface OperationRecord extends OperationCommand {
  id: string;
  state: OperationState;
  result: unknown;
}
export interface OperationJournal {
  reserve(command: OperationCommand): Promise<{ created: boolean; record: OperationRecord }>;
  update(id: string, state: OperationState, result?: unknown): Promise<void>;
}
export function operationTarget(operation: string, input: Record<string, unknown>): string {
  if (operation === "patient_update") return `patient:${String(input.patientId)}`;
  const id = input.attendance_id ?? input.id;
  if (operation.startsWith("attendance_") && operation !== "attendance_create" && id)
    return `attendance:${String(id)}`;
  const natural =
    operation === "attendance_create"
      ? {
          patient_id: input.patient_id,
          event_id: input.event_id,
          user_id: input.user_id,
          place_id: input.place_id,
          start_date: input.start_date,
        }
      : input;
  return `${operation}:${hashDoCorpo(natural)}`;
}
export function privateRequestHash(operation: string, input: unknown) {
  return createHash("sha256")
    .update(operation)
    .update(":" + hashDoCorpo(input))
    .digest("hex");
}

/** No lease expiry: a lost response is not permission to resend an external write. */
export async function runDurableOperation(
  journal: OperationJournal,
  command: OperationCommand,
  execute: () => Promise<unknown>,
): Promise<OperationRecord> {
  const reservation = await journal.reserve(command);
  if (reservation.record.requestHash !== command.requestHash)
    throw new Error("Esta chave já foi usada com outro conteúdo.");
  if (!reservation.created) return reservation.record;
  const id = reservation.record.id;
  // Failure to persist the sending state prevents the network side effect.
  await journal.update(id, "sent");
  let result: unknown;
  try {
    result = await execute();
  } catch (error) {
    const known = error as { uncertain?: boolean; code?: string; status?: number };
    const rejected =
      known.uncertain === false &&
      typeof known.status === "number" &&
      known.status >= 400 &&
      known.status < 500;
    const state = rejected ? "rejected" : "uncertain";
    const safeResult = {
      error: {
        code: known.code ?? "amigo_resultado_incerto",
        message: rejected
          ? "O Amigo recusou a operação. Confira os dados antes de tentar novamente."
          : "Não foi possível confirmar o resultado. Confira a consulta no Amigo antes de uma nova tentativa.",
      },
    };
    await journal.update(id, state, safeResult);
    return { ...reservation.record, state, result: safeResult };
  }
  try {
    await journal.update(id, "confirmed", result);
  } catch {
    // The provider confirmed, but the receipt failed. It must remain blocked.
    return { ...reservation.record, state: "uncertain", result: { reconciliation_required: true } };
  }
  return { ...reservation.record, state: "confirmed", result };
}

/** Internal gateway: caller has already authorized organization + effect. */
export function postgresJournal(
  db: SupabaseClient,
  organizationId: string,
  connectionId: string,
): OperationJournal {
  const decode = (row: Record<string, unknown>): OperationRecord => ({
    id: String(row.id),
    key: String(row.key),
    operation: String(row.operation),
    requestHash: String(row.request_hash),
    targetId: String(row.target_id),
    state: row.state as OperationState,
    result: row.result,
  });
  return {
    async reserve(command) {
      const { data, error } = await db
        .from("amigo_operations")
        .insert({
          organization_id: organizationId,
          connection_id: connectionId,
          key: command.key,
          request_hash: command.requestHash,
          operation: command.operation,
          target_id: command.targetId,
          state: "prepared",
          request_context: command.reconciliation ?? {},
        })
        .select("*")
        .single();
      if (!error && data) return { created: true, record: decode(data) };
      if (error?.code !== "23505")
        throw new Error("Não foi possível reservar a operação; nenhuma alteração foi enviada.");
      const { data: previous, error: readError } = await db
        .from("amigo_operations")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("connection_id", connectionId)
        .eq("key", command.key)
        .maybeSingle();
      if (readError || !previous)
        throw new Error(
          "Outra operação desta consulta aguarda confirmação. Confira seu resultado antes de continuar.",
        );
      return { created: false, record: decode(previous) };
    },
    async update(id, state, result) {
      const patch: Record<string, unknown> = { state, updated_at: new Date().toISOString() };
      if (result !== undefined) patch.result = result;
      const { data, error } = await db
        .from("amigo_operations")
        .update(patch)
        .eq("organization_id", organizationId)
        .eq("connection_id", connectionId)
        .eq("id", id)
        .select("id")
        .single();
      if (error || !data) throw new Error("Recibo da operação pendente de reconciliação.");
    },
  };
}
