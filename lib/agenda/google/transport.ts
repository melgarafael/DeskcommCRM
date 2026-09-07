import { z } from "zod";
import { conferenceSchema } from "./meet";
import type { EventoDoGoogle } from "./evento";
import type { SyncCursor } from "./sync-model";

const endpoint = "https://www.googleapis.com/calendar/v3";
/** Injeção de transporte só por dependência no harness; não existe env/base URL público. */
export type GoogleFetch = typeof fetch;
export class GoogleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: number | null = null,
  ) {
    super(
      status === 412
        ? "O evento mudou no Google. Releia antes de publicar."
        : `Google HTTP ${status}`,
    );
  }
}
const eventSchema = z
  .object({ id: z.string().min(1), etag: z.string().optional(), status: z.string().optional(), conferenceData: conferenceSchema.optional(), hangoutLink: z.string().optional() })
  .passthrough();
export function googleTransport(accessToken: string, transport: GoogleFetch = fetch) {
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    etag?: string | null,
  ): Promise<unknown> {
    const r = await transport(`${endpoint}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(etag ? { "If-Match": etag } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!r.ok)
      throw new GoogleHttpError(
        r.status,
        r.headers.has("retry-after") ? Number(r.headers.get("retry-after")) : null,
      );
    return r.status === 204 ? null : r.json();
  }
  const path = (calendar: string, event?: string) =>
    `/calendars/${encodeURIComponent(calendar)}/events${event ? `/${encodeURIComponent(event)}` : ""}`;
  return {
    async get(calendar: string, event: string): Promise<EventoDoGoogle | null> {
      try {
        const parsed = eventSchema.parse(await request(path(calendar, event)));
        if (parsed.id !== event) throw new Error("Google devolveu outra identidade de evento.");
        return parsed as EventoDoGoogle;
      } catch (e) {
        if (e instanceof GoogleHttpError && (e.status === 404 || e.status === 410)) {
          await request(`/calendars/${encodeURIComponent(calendar)}`);
          return null;
        }
        throw e;
      }
    },
    async write(
      calendar: string,
      event: string,
      method: "POST" | "PATCH" | "DELETE",
      body: Record<string, unknown> | undefined,
      etag: string | null,
    ): Promise<EventoDoGoogle | null> {
      if (method !== "POST" && !etag) throw new Error("Escrita sem versão remota recusada.");
      try {
        const result = await request(
          `${path(calendar, method === "POST" ? undefined : event)}?sendUpdates=all${method === "DELETE" ? "" : "&conferenceDataVersion=1"}`,
          method,
          method === "POST" ? { ...body, id: event } : body,
          etag,
        );
        if (result === null) return null;
        const parsed = eventSchema.parse(result);
        if (parsed.id !== event) throw new Error("Google devolveu outra identidade de evento.");
        return parsed as EventoDoGoogle;
      } catch (e) {
        if (method === "DELETE" && e instanceof GoogleHttpError && [404, 410].includes(e.status)) {
          await request(`/calendars/${encodeURIComponent(calendar)}`);
          return null;
        }
        throw e;
      }
    },
    async page(calendar: string, cursor: SyncCursor) {
      const q = new URLSearchParams({
        singleEvents: "true",
        maxResults: "100",
        showDeleted: "true",
      });
      if (cursor.base_sync_token) q.set("syncToken", cursor.base_sync_token);
      else {
        q.set("timeMin", cursor.window_start);
        q.set("timeMax", cursor.window_end);
      }
      if (cursor.page_token) q.set("pageToken", cursor.page_token);
      return z
        .object({
          items: z.array(eventSchema).default([]),
          nextPageToken: z.string().optional(),
          nextSyncToken: z.string().optional(),
        })
        .parse(await request(`${path(calendar)}?${q}`));
    },
    async calendars() {
      const entries: CalendarEntry[] = [];
      let page: string | undefined;
      const seen = new Set<string>();
      do {
        const q = new URLSearchParams({ showHidden: "true", maxResults: "250" });
        if (page) q.set("pageToken", page);
        const r = z
          .object({
            items: z.array(calendarEntrySchema).default([]),
            nextPageToken: z.string().optional(),
          })
          .parse(await request(`/users/me/calendarList?${q}`));
        entries.push(...r.items);
        page = r.nextPageToken;
        if (page && seen.has(page))
          throw new Error("Catálogo sem progresso. Tente atualizar novamente.");
        if (page) seen.add(page);
      } while (page);
      return entries;
    },
  };
}
export const calendarEntrySchema = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
  summaryOverride: z.string().optional(),
  timeZone: z.string().optional(),
  primary: z.boolean().optional(),
  deleted: z.boolean().optional(),
  accessRole: z.string(),
  conferenceProperties: z.object({ allowedConferenceSolutionTypes: z.array(z.string()) }).optional(),
});
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;
export const canReadCalendar = (role: string) =>
  ["reader", "writer", "owner", "writerWithoutPrivateAccess"].includes(role);
export const canWriteCalendar = (role: string) => ["writer", "owner"].includes(role);
