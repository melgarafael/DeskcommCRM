import type { SupabaseClient } from "@supabase/supabase-js";
import { doEventoDoGoogle, type EventoDoGoogle } from "./evento";
import { ehEventoNosso } from "./escrita";
import { googleTransport, GoogleHttpError, type GoogleFetch } from "./transport";
import { calendarSnapshotSchema, googleRpc, type CalendarFence } from "./sync-store";
import { reconcileAppointment, tokenForConnection } from "./sync-executor";

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
    for (const rawEvent of page.items) {
      await call("renew");
      const event = rawEvent as EventoDoGoogle;
      const { data: linked, error } = await db
        .from("calendar_appointments")
        .select("id")
        .eq("organization_id", org)
        .eq("google_connection_id", c.connection_id)
        .eq("google_calendar_id", c.external_calendar_id)
        .eq("google_event_id", event.id!)
        .maybeSingle();
      if (error) throw error;
      if (linked) {
        const result = await reconcileAppointment(db, org, linked.id, {
          transport,
          calendarFence: fence,
          remote: event,
          token,
        });
        if (result === "busy") return "partial";
        if (result === "failed") throw new Error("Compromisso vinculado ainda não reconciliado.");
        await call("item", { item: { external_event_id: event.id } });
        continue;
      }
      if (ehEventoNosso(event.id))
        throw new Error("Evento do produto sem vínculo. Revise a publicação antiga.");
      const read = doEventoDoGoogle(event, { fusoDoCalendario: timeZone! });
      if (read.tipo === "recusado")
        throw new Error("Evento inválido. A leitura não foi concluída.");
      await call("item", {
        item:
          read.tipo === "cancelado"
            ? {
                external_event_id: read.externalEventId,
                status: "cancelled",
                recurring_event_id: event.recurringEventId,
                original_start_time: event.originalStartTime,
              }
            : {
                ...read.evento,
                title: null,
                transparency: read.evento.ocupa ? "opaque" : "transparent",
                recurring_event_id: event.recurringEventId,
                original_start_time: event.originalStartTime,
              },
      });
    }
    const saved = calendarSnapshotSchema.parse(
      await call("page", {
        next_page_token: page.nextPageToken ?? null,
        next_sync_token: page.nextSyncToken ?? null,
      }),
    );
    // O cursor mudou no commit. Release só usa aquisição, não o cursor anterior.
    fence.cursor = saved.sync_cursor ?? fence.cursor;
    return saved.sync_cursor ? "partial" : "complete";
  } catch (e) {
    try {
      if (e instanceof GoogleHttpError && e.status === 410) await call("reset");
      else
        await call("error", {
          message:
            e instanceof GoogleHttpError
              ? e.message
              : "A leitura não terminou. Tente sincronizar novamente nas configurações.",
        });
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
