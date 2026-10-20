import type { SupabaseClient } from "@supabase/supabase-js";
import { doEventoDoGoogle, type EventoDoGoogle } from "./evento";
import { ehEventoNosso } from "./escrita";
import { classificarErroDoGoogle } from "./erros";
import { googleTransport, GoogleHttpError, type GoogleFetch } from "./transport";
import { calendarSnapshotSchema, googleRpc, type CalendarFence } from "./sync-store";
import { reconcileAppointment, tokenForConnection } from "./sync-executor";

/** A frase persistida quando a leitura incremental do Google falha. */
export function mensagemDaRecusaDeLeitura(erro: unknown): string {
  if (erro instanceof GoogleHttpError) {
    return classificarErroDoGoogle(erro, "sincronizar").mensagem;
  }
  return "A leitura não terminou. Tente sincronizar novamente nas configurações.";
}

/** Ids por consulta de vínculo: mantém a URL do `.in` bem abaixo de 8 KB. */
const IDS_POR_CONSULTA = 50;

export async function refreshCatalog(
  db: SupabaseClient,
  org: string,
  connectionId: string,
  transport?: GoogleFetch,
) {
  const { data, error } = await db
    .from("calendar_connections")
    .select("calendar_selection_revision::text")
    .eq("organization_id", org)
    .eq("id", connectionId)
    .single();
  if (error) throw error;
  const token = await tokenForConnection(db, org, connectionId);
  const items = await googleTransport(token, transport).calendars();
  await googleRpc(db, "fn_google_catalog", {
    p_org: org,
    p_connection: connectionId,
    p_items: items,
    p_revision: String(data.calendar_selection_revision),
  });
}
export async function syncCalendar(
  db: SupabaseClient,
  org: string,
  calendarId: string,
  transport?: GoogleFetch,
): Promise<"busy" | "complete" | "partial" | "failed"> {
  const raw = await googleRpc(db, "fn_google_calendar", {
    p_org: org,
    p_id: calendarId,
    p_action: "claim",
  });
  if (!raw) return "busy";
  const c = calendarSnapshotSchema.parse(raw);
  if (!c.sync_cursor) throw new Error("Leitura sem cursor reservado.");
  const fence: CalendarFence = { id: c.id, claim: c.claim, cursor: c.sync_cursor };
  const call = (action: string, args: Record<string, unknown> = {}) =>
    googleRpc(db, "fn_google_calendar", {
      p_org: org,
      p_id: calendarId,
      p_action: action,
      p_args: { claim: c.claim, cursor: fence.cursor, ...args },
    });
  try {
    const token = await tokenForConnection(db, org, c.connection_id);
    let timeZone = c.time_zone;
    if (!timeZone) {
      const { data: organization, error } = await db
        .from("organizations")
        .select("timezone")
        .eq("id", org)
        .single();
      if (error || !organization?.timezone) throw new Error("Fuso da organização indisponível.");
      timeZone = organization.timezone;
    }
    const page = await googleTransport(token, transport).page(
      c.external_calendar_id,
      c.sync_cursor,
    );
    const eventIds = page.items
      .map((item) => item.id?.trim())
      .filter((eventId): eventId is string => Boolean(eventId));
    if (eventIds.length !== page.items.length) throw new Error("Evento sem identidade no lote do Google.");
    const linkedByEventId = new Map<string, string>();
    // Em blocos: o `.in` vai na URL do PostgREST, e 250 ids do Google (a página
    // cheia) passam do limite de linha de requisição comum em proxy (8 KB).
    for (let i = 0; i < eventIds.length; i += IDS_POR_CONSULTA) {
      const { data: linkedAppointments, error } = await db
        .from("calendar_appointments")
        .select("id,google_event_id")
        .eq("organization_id", org)
        .eq("google_connection_id", c.connection_id)
        .eq("google_calendar_id", c.external_calendar_id)
        .in("google_event_id", eventIds.slice(i, i + IDS_POR_CONSULTA));
      if (error) throw error;
      for (const appointment of linkedAppointments ?? []) {
        if (appointment.google_event_id) {
          linkedByEventId.set(appointment.google_event_id, appointment.id);
        }
      }
    }
    const items: Record<string, unknown>[] = [];
    const pruneIds = new Set<string>();
    const windowStart = Date.parse(c.sync_cursor.window_start);
    const windowEnd = Date.parse(c.sync_cursor.window_end);
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
      throw new Error("Janela de cobertura inválida.");
    }
    for (const rawEvent of page.items) {
      const event = rawEvent as EventoDoGoogle;
      const eventId = event.id!.trim();
      const linkedAppointmentId = linkedByEventId.get(eventId);
      if (linkedAppointmentId) {
        await call("renew");
        const result = await reconcileAppointment(db, org, linkedAppointmentId, {
          transport,
          calendarFence: fence,
          remote: event,
          token,
        });
        if (result === "busy") return "partial";
        if (result === "failed") throw new Error("Compromisso vinculado ainda não reconciliado.");
        pruneIds.add(eventId);
        continue;
      }
      // A remoção local pode ocorrer depois de cancelar no Google. A lápide
      // autenticada não é uma reserva ativa sem vínculo: processe o cancelamento
      // para remover ocupação antiga e permitir o avanço do cursor. Eventos
      // nossos ainda ativos continuam exigindo a tupla persistida.
      if (ehEventoNosso(event.id) && event.status !== "cancelled")
        throw new Error("Evento do produto sem vínculo. Revise a publicação antiga.");
      const read = doEventoDoGoogle(event, { fusoDoCalendario: timeZone! });
      if (read.tipo === "recusado")
        throw new Error("Evento inválido. A leitura não foi concluída.");
      if (read.tipo === "cancelado") {
        items.push({
          external_event_id: read.externalEventId,
          status: "cancelled",
          recurring_event_id: event.recurringEventId,
          original_start_time: event.originalStartTime,
        });
        continue;
      }
      const begins = Date.parse(read.evento.starts_at);
      const ends = Date.parse(read.evento.ends_at);
      if (ends <= windowStart || begins >= windowEnd) {
        pruneIds.add(eventId);
        continue;
      }
      items.push({
        ...read.evento,
        title: null,
        transparency: read.evento.ocupa ? "opaque" : "transparent",
        recurring_event_id: event.recurringEventId,
        original_start_time: event.originalStartTime,
      });
    }
    const saved = calendarSnapshotSchema.parse(
      await googleRpc(db, "fn_google_calendar_page_batch", {
        p_org: org,
        p_id: calendarId,
        p_args: {
          claim: c.claim,
          cursor: fence.cursor,
          items,
          prune_ids: [...pruneIds],
          next_page_token: page.nextPageToken ?? null,
          next_sync_token: page.nextSyncToken ?? null,
        },
      }),
    );
    // O cursor mudou no commit. Release só usa aquisição, não o cursor anterior.
    fence.cursor = saved.sync_cursor ?? fence.cursor;
    return saved.sync_cursor ? "partial" : "complete";
  } catch (e) {
    try {
      if (e instanceof GoogleHttpError && e.status === 410) await call("reset");
      else await call("error", { message: mensagemDaRecusaDeLeitura(e) });
    } catch {
      /* fence vencido não grava diagnóstico tardio */
    }
    return "failed";
  } finally {
    try {
      await googleRpc(db, "fn_google_calendar", {
        p_org: org,
        p_id: calendarId,
        p_action: "release",
        p_args: { claim: c.claim },
      });
    } catch {
      /* não liberar aquisição nova */
    }
  }
}
