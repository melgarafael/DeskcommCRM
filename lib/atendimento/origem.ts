import { logger } from "@/lib/logger";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertCurrentServiceBoundary,
  parseServiceBoundary,
  type CurrentServiceBoundary,
  type ServiceBoundary,
} from "./fronteira";
import { currentExecutionBoundary, guardServiceEffect } from "./fronteira-server";

/** Leitura confiável reutilizada na origem e imediatamente antes do transporte. */
export async function readServiceBoundarySupabase(
  admin: SupabaseClient,
  org: string,
  conversation: string,
): Promise<CurrentServiceBoundary | null> {
  const { data, error } = await admin.rpc("fn_service_boundary", {
    p_org: org,
    p_conversation: conversation,
  });
  if (error) throw error;
  if (!data) return null;
  const boundary = parseServiceBoundary(data);
  if (!boundary || boundary.organization_id !== org || boundary.conversation_id !== conversation)
    throw new Error("service_scope_mismatch");
  return { ...boundary, status: data.status, demanda_fechada_em: data.demanda_fechada_em };
}
/** Só chamadores internos autorizadores; nunca usado por job/tick/retry. */
export async function beginServiceAtOrigin(
  admin: SupabaseClient,
  org: string,
  contact: string,
  session?: string,
): Promise<ServiceBoundary> {
  const inherited = currentExecutionBoundary();
  if (inherited) {
    await guardServiceEffect();
    if (inherited.organization_id !== org || inherited.contact_id !== contact)
      throw new Error("service_scope_mismatch");
    return inherited;
  }
  const { data, error } = await admin.rpc("fn_service_begin", {
    p_org: org,
    p_contact: contact,
    ...(session ? { p_session: session } : {}),
  });
  if (error) throw error;
  const boundary = parseServiceBoundary(data);
  assertCurrentServiceBoundary(
    boundary,
    boundary
      ? { ...boundary, status: data.status, demanda_fechada_em: data.demanda_fechada_em }
      : null,
  );
  return boundary!;
}
export async function assertServiceBoundarySupabase(
  admin: SupabaseClient,
  boundary: ServiceBoundary | null,
): Promise<void> {
  assertCurrentServiceBoundary(
    boundary,
    boundary
      ? await readServiceBoundarySupabase(admin, boundary.organization_id, boundary.conversation_id)
      : null,
  );
}

export type ServiceOrigin =
  | { kind: "event"; event_id: string; organization_id: string; contact_id: string }
  | { kind: "continuation"; boundary: ServiceBoundary }
  | { kind: "command"; observed: Record<string, unknown> }
  | { kind: "unavailable"; reason: "origin_capture_failed" };
export async function observeServiceOrigin(
  admin: SupabaseClient,
  org: string,
  contact: string | null,
): Promise<ServiceOrigin | null> {
  if (!contact) return null;
  const inherited = currentExecutionBoundary();
  if (inherited) {
    await guardServiceEffect();
    return { kind: "continuation", boundary: inherited };
  }
  try {
    const { data, error } = await admin.rpc("fn_service_observe_command", {
      p_org: org,
      p_contact: contact,
    });
    if (error) throw error;
    return { kind: "command", observed: data };
  } catch {
    // A indisponibilidade do rastro não desfaz o movimento autorizado. O evento
    // carrega a recusa explícita, nunca um snapshot atual inventado no consumo.
    logger.error("service_origin_capture_failed", { organization_id: org, contact_id: contact });
    return { kind: "unavailable", reason: "origin_capture_failed" };
  }
}
/** Recibo do evento: resolução atômica compartilhada por consumers/retries. */
export async function serviceForEvent(
  admin: SupabaseClient,
  org: string,
  eventId: string,
  contact: string,
  session?: string,
): Promise<ServiceBoundary | null> {
  const { data, error } = await admin.rpc("fn_service_event_origin", {
    p_org: org,
    p_event: eventId,
    p_contact: contact,
    ...(session ? { p_session: session } : {}),
  });
  if (error) {
    if (error.code === "40001") return null;
    throw error;
  }
  const boundary = parseServiceBoundary(data);
  if (!boundary || boundary.organization_id !== org || boundary.contact_id !== contact)
    throw new Error("service_scope_mismatch");
  await assertServiceBoundarySupabase(admin, boundary);
  return boundary;
}
