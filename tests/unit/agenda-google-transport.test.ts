// @vitest-environment node
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  googleTransport,
  canReadCalendar,
  canWriteCalendar,
  GoogleHttpError,
} from "@/lib/agenda/google/transport";
let server: Server, base: string;
let requests: Array<{
  path: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}> = [];
let respond: (req: IncomingMessage, res: ServerResponse) => void;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    requests.push({
      path: req.url!,
      method: req.method!,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : null,
    });
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("receiver");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(
  () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
);
beforeEach(() => {
  requests = [];
  respond = (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "event /exact", etag: '"v2"' }));
  };
});
const api = () =>
  googleTransport("test-token", (url, init) =>
    fetch(`${base}${new URL(String(url)).pathname}${new URL(String(url)).search}`, init),
  );
const cursor = {
  generation: "00000000-0000-4000-8000-000000000001",
  mode: "incremental" as const,
  base_sync_token: "original-token",
  page_token: "page-two",
  window_start: "2026-09-01T00:00:00Z",
  window_end: "2026-12-01T00:00:00Z",
};
describe("receiver HTTP real: protocolos Google", () => {
  it("PATCH leva path exato/If-Match e não campos omitidos", async () => {
    await api().write(
      "secondary/calendar@example.test",
      "event /exact",
      "PATCH",
      { start: { dateTime: "2026-09-10T12:00:00Z" } },
      '"v1"',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toContain(
      "secondary%2Fcalendar%40example.test/events/event%20%2Fexact",
    );
    expect(requests[0]!.headers["if-match"]).toBe('"v1"');
    expect(requests[0]!.headers.authorization).toBe("Bearer test-token");
    expect(requests[0]!.body).toEqual({ start: { dateTime: "2026-09-10T12:00:00Z" } });
    expect(requests[0]!.path).toContain("sendUpdates=all");
  });
  it("insert preserva ID reservado sem If-Match", async () => {
    await api().write("destination", "event /exact", "POST", { summary: "Teste" }, null);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers["if-match"]).toBeUndefined();
    expect(requests[0]!.body).toEqual({ summary: "Teste", id: "event /exact" });
  });
  it("409 não dispara PUT nem segunda escrita", async () => {
    respond = (_q, r) => {
      r.statusCode = 409;
      r.end("{}");
    };
    await expect(
      api().write("destination", "event /exact", "POST", {}, null),
    ).rejects.toMatchObject({ status: 409 });
    expect(requests).toHaveLength(1);
  });
  it("412 não sobrescreve a versão nova", async () => {
    respond = (_q, r) => {
      r.statusCode = 412;
      r.end("{}");
    };
    await expect(
      api().write("destination", "event /exact", "PATCH", {}, '"v1"'),
    ).rejects.toBeInstanceOf(GoogleHttpError);
    expect(requests).toHaveLength(1);
  });
  it("DELETE sem etag falha antes do transporte", async () => {
    await expect(
      api().write("destination", "event /exact", "DELETE", undefined, null),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it("página incremental repete syncToken e nunca mistura janela", async () => {
    respond = (_q, r) => r.end(JSON.stringify({ items: [], nextPageToken: "next-empty" }));
    const r = await api().page("destination", cursor);
    expect(r.nextPageToken).toBe("next-empty");
    const q = new URL(requests[0]!.path, base).searchParams;
    expect(q.get("syncToken")).toBe("original-token");
    expect(q.get("pageToken")).toBe("page-two");
    expect(q.has("timeMin")).toBe(false);
    expect(q.has("timeMax")).toBe(false);
    expect(q.get("showDeleted")).toBe("true");
  });
  it("full fixa janela e não envia syncToken", async () => {
    respond = (_q, r) => r.end(JSON.stringify({ items: [], nextSyncToken: "end" }));
    await api().page("destination", {
      ...cursor,
      mode: "full",
      base_sync_token: null,
      page_token: null,
    });
    const q = new URL(requests[0]!.path, base).searchParams;
    expect(q.get("timeMin")).toBe(cursor.window_start);
    expect(q.has("syncToken")).toBe(false);
  });
  it("410 é erro de ciclo; adapter não finge página concluída", async () => {
    respond = (_q, r) => {
      r.statusCode = 410;
      r.end("{}");
    };
    await expect(api().page("destination", cursor)).rejects.toMatchObject({ status: 410 });
  });
  it("GET 404 de calendário inacessível não vira cancelamento", async () => {
    respond = (_q, r) => {
      r.statusCode = 404;
      r.end("{}");
    };
    await expect(api().get("gone", "event /exact")).rejects.toMatchObject({ status: 404 });
    expect(requests).toHaveLength(2);
  });
  it("GET 404 com calendário acessível prova ausência do evento", async () => {
    respond = (q, r) => {
      r.statusCode = q.url!.includes("/events/") ? 404 : 200;
      r.end("{}");
    };
    expect(await api().get("available", "event /exact")).toBeNull();
  });
  it("CalendarList continua depois de página vazia e conserva papéis reais", async () => {
    respond = (q, r) =>
      r.end(
        JSON.stringify(
          q.url!.includes("pageToken")
            ? {
                items: [
                  { id: "limited", accessRole: "writerWithoutPrivateAccess" },
                  { id: "busy", accessRole: "freeBusyReader" },
                ],
              }
            : { items: [], nextPageToken: "p2" },
        ),
      );
    const list = await api().calendars();
    expect(list).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.path.includes("showHidden=true"))).toBe(true);
    expect(canReadCalendar(list[0]!.accessRole)).toBe(true);
    expect(canWriteCalendar(list[0]!.accessRole)).toBe(false);
    expect(canReadCalendar("freeBusyReader")).toBe(false);
    expect(canWriteCalendar("future-role")).toBe(false);
  });
});

it("GET não aceita outro id como confirmação do recurso exato", async () => {
 respond = (_q,r) => r.end(JSON.stringify({ id: "outro-id", etag: '\"v2\"' }));
 await expect(api().get("destination", "event /exact")).rejects.toThrow("outra identidade");
 expect(requests).toHaveLength(1);
});
