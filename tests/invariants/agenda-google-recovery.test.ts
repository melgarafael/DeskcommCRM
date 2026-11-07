import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedGov, GOV_ORG, GOV_AGENT_A } from "./gov-helpers";
import { reconcileAppointment } from "@/lib/agenda/google/sync-executor";
import { syncCalendar } from "@/lib/agenda/google/calendar-executor";
import { googlePushCandidates } from "@/lib/agenda/google/candidates";
import { hash } from "@/lib/agenda/google/sync-model";
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => "receiver-only"),
}));
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());
let sequence = 0;
async function fixture(guest: string | null = null) {
  const id = randomUUID(),
    conn = randomUUID(),
    cal = randomUUID(),
    contact = randomUUID();
  await pool.query(
    "update calendar_connection_calendars set is_destination=false where organization_id=$1",
    [GOV_ORG],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Titular')",
    [contact, GOV_ORG],
  );
  await pool.query(
    "insert into calendar_connections(id,organization_id,user_id,provider,account_email,status) values($1,$2,$3,'google_calendar',$4,'healthy')",
    [conn, GOV_ORG, GOV_AGENT_A, `${conn}@local.test`],
  );
  await pool.query(
    "insert into calendar_connection_calendars(id,organization_id,connection_id,external_calendar_id,name,is_destination,counts_for_conflicts,access_role,time_zone) values($1,$2,$3,'destination','Local',true,true,'owner','America/Sao_Paulo')",
    [cal, GOV_ORG, conn],
  );
  // ⚠️ `google_next_attempt_at` EXPLÍCITO, e não o default `now()`.
  //
  // `googlePushCandidates` filtra `google_next_attempt_at <= now`, onde `now` é
  // `new Date()` — o relógio do PROCESSO — e a coluna default é `now()` — o
  // relógio do BANCO, que aqui roda dentro de um container. Com o default, o
  // veredito de I3 passa a depender de os dois relógios concordarem na casa dos
  // MILISSEGUNDOS: medido nesta máquina, a folga é de 6 a 204 ms, e uma
  // sabotagem de 5 ms (`now()+interval '5 milliseconds'`) reproduz na hora o
  // vermelho do CI — `:377:61 expected false to be true`, 1 em 2 rodadas.
  // Um minuto no passado, no relógio do próprio banco, tira o relógio de fora do
  // veredito sem afrouxar nada: o que I3 mede é que os 50 vínculos redigidos não
  // ocupam o lote, não a resolução de dois relógios.
  await pool.query(
    "insert into calendar_appointments(id,organization_id,contact_id,owner_user_id,title,starts_at,ends_at,status,time_zone,guest_email,google_next_attempt_at) values($1,$2,$3,$4,'Consulta',now()+$5*interval '1 day',now()+$5*interval '1 day'+interval '1 hour','confirmed','America/Sao_Paulo',$6,now()-interval '1 minute')",
    [id, GOV_ORG, contact, GOV_AGENT_A, 3 * ++sequence, guest],
  );
  return { id, conn, cal, contact };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function row(f: Fixture) {
  return (
    await pool.query("select * from calendar_appointments where organization_id=$1 and id=$2", [
      GOV_ORG,
      f.id,
    ])
  ).rows[0];
}
// Ponte de testes: executa SELECT/RPC no Postgres real. O .or é validado antes
// da tradução; a mesma string também é exercitada no PostgREST do browser.
function pgClient(): SupabaseClient {
  const ident = (name: string) => {
    if (!/^[a-z_]+$/.test(name)) throw new Error(`unexpected SQL identifier ${name}`);
    return `"${name}"`;
  };
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      try {
        // A página entra em lote, numa RPC de três argumentos (sem p_action).
        if (name === "fn_google_calendar_page_batch") {
          const result = await pool.query(`select ${name}($1,$2,$3) result`, [
            args.p_org,
            args.p_id,
            args.p_args,
          ]);
          return { data: result.rows[0].result, error: null };
        }
        const names = ["fn_google_appointment", "fn_google_calendar"];
        if (!names.includes(name)) throw new Error(name);
        const result = await pool.query(`select ${name}($1,$2,$3,$4) result`, [
          args.p_org,
          args.p_id,
          args.p_action,
          args.p_args ?? {},
        ]);
        return { data: result.rows[0].result, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
    from: (table: string) => {
      let columns = "*",
        limit: number | undefined,
        order = "";
      const filters: string[] = [],
        values: unknown[] = [];
      const where = (key: string, value: unknown, operator = "=") => {
        values.push(value);
        filters.push(`${ident(key)}${operator}$${values.length}`);
        return q;
      };
      const execute = async (single = false) => {
        try {
          const result = await pool.query(
            `select ${columns} from ${ident(table)}${filters.length ? ` where ${filters.join(" and ")}` : ""}${order}${limit === undefined ? "" : ` limit ${limit}`}`,
            values,
          );
          return { data: single ? (result.rows[0] ?? null) : result.rows, error: null };
        } catch (error) {
          return { data: null, error };
        }
      };
      const q = {
        select: (s: string) => {
          columns = s
            .split(",")
            .map((c) => {
              const [alias, source] = c.split(":");
              return source ? `${ident(source)} as ${ident(alias!)}` : ident(alias!);
            })
            .join(",");
          return q;
        },
        eq: (k: string, v: unknown) => where(k, v),
        lte: (k: string, v: unknown) => where(k, v, "<="),
        in: (k: string, vs: readonly unknown[]) => {
          values.push(vs);
          filters.push(`${ident(k)} = any($${values.length})`);
          return q;
        },
        is: (k: string, v: null) => {
          expect(v).toBeNull();
          filters.push(`${ident(k)} is null`);
          return q;
        },
        not: (k: string, op: string, v: null) => {
          expect([op, v]).toEqual(["is", null]);
          filters.push(`${ident(k)} is not null`);
          return q;
        },
        or: (s: string) => {
          expect(s).toBe(
            "needs_google_push.eq.true,and(google_event_id.not.is.null,google_conflict.is.null),google_conflict->resolution.not.is.null",
          );
          filters.push(
            "(needs_google_push or (google_event_id is not null and google_conflict is null) or google_conflict->'resolution' is not null)",
          );
          return q;
        },
        order: (s: string) => {
          order = ` order by ${ident(s)}`;
          return q;
        },
        limit: (n: number) => {
          limit = n;
          return q;
        },
        single: () => execute(true),
        maybeSingle: () => execute(true),
        then: (resolve: (value: unknown) => void) => execute().then(resolve),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}
interface Event {
  id: string;
  etag: string;
  summary?: string;
  start?: { dateTime: string; timeZone: string };
  end?: { dateTime: string; timeZone: string };
  recurrence?: string[];
  attendees?: Array<{ email: string; responseStatus: string }>;
  [key: string]: unknown;
}
async function receiver() {
  let remote: Event | null = null,
    version = 0,
    rejectPosts = 0;
  let afterPatch: (() => Promise<void>) | null = null;
  let page: Record<string, unknown> = { items: [], nextSyncToken: "finished" };
  const requests: Array<{
      method: string;
      path: string;
      body: Record<string, unknown> | null;
      headers: IncomingMessage["headers"];
    }> = [],
    errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method!, path: req.url!, body, headers: req.headers });
      res.setHeader("content-type", "application/json");
      const path = new URL(req.url!, "http://local").pathname;
      if (req.method === "GET") {
        if (path.endsWith("/events")) {
          res.end(JSON.stringify(page));
          return;
        }
        if (!path.includes("/events/")) {
          res.end(JSON.stringify({ id: "destination" }));
          return;
        }
        res.statusCode = remote ? 200 : 404;
        res.end(JSON.stringify(remote ?? {}));
        return;
      }
      if (req.method === "POST") {
        expect(req.headers["if-match"]).toBeUndefined();
        expect(path.endsWith("/events")).toBe(true);
        if (rejectPosts > 0) {
          rejectPosts--;
          res.statusCode = 503;
          res.end("{}");
          return;
        }
        if (remote) {
          res.statusCode = 409;
          res.end("{}");
          return;
        }
        remote = { ...body, etag: `"v${++version}"` };
      } else if (req.method === "PATCH") {
        expect(req.headers["if-match"]).toBe(remote?.etag);
        expect(path.endsWith(`/events/${remote?.id}`)).toBe(true);
        remote = { ...remote!, ...body, etag: `"v${++version}"` };
        const callback = afterPatch;
        afterPatch = null;
        if (callback) await callback();
      } else {
        throw new Error(`unexpected method ${req.method}`);
      }
      res.end(JSON.stringify(remote));
    } catch (error) {
      errors.push(error);
      res.statusCode = 500;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("receiver");
  const transport: typeof fetch = (url, init) => {
    const parsed = new URL(String(url));
    return fetch(`http://127.0.0.1:${address.port}${parsed.pathname}${parsed.search}`, init);
  };
  return {
    get remote() {
      return remote;
    },
    set remote(value: Event | null) {
      remote = value;
    },
    set rejectPosts(n: number) {
      rejectPosts = n;
    },
    set afterPatch(fn: (() => Promise<void>) | null) {
      afterPatch = fn;
    },
    set page(value: Record<string, unknown>) {
      page = value;
    },
    requests,
    transport,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      expect(errors).toEqual([]);
    },
  };
}
it("I1: POST recusado, GET ausente e segundo POST conservam intenção/tupla/ID", async () => {
  const f = await fixture(),
    http = await receiver(),
    db = pgClient();
  const run = () =>
    reconcileAppointment(db, GOV_ORG, f.id, { token: "local", transport: http.transport });
  try {
    http.rejectPosts = 1;
    expect(await run()).toBe("failed");
    const first = await row(f);
    expect(first.google_pending_write.method).toBe("POST");
    expect(first.google_base_projection).toBeNull();
    expect(await run()).toBe("processed");
    const saved = await row(f);
    const posts = http.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    expect(saved.google_event_id).toBe(first.google_event_id);
    expect(saved.google_calendar_id).toBe(first.google_calendar_id);
    expect(saved.google_connection_id).toBe(first.google_connection_id);
    expect(saved.google_conflict).toBeNull();
    expect(saved.google_pending_write).toBeNull();
    expect(saved.google_local_revision).toBe(saved.google_synced_local_revision);
    expect(
      http.requests.map((r) => [
        r.method,
        new URL(r.path, "http://local").pathname.split("/").slice(-2).join("/"),
      ]),
    ).toEqual([
      ["GET", `events/${first.google_event_id}`],
      ["GET", "calendars/destination"],
      ["POST", "destination/events"],
      ["GET", `events/${first.google_event_id}`],
      ["GET", "calendars/destination"],
      ["POST", "destination/events"],
    ]);
    // Controle: ausência depois de publicação não volta a criar evento.
    http.remote = null;
    await run();
    expect(http.requests.filter((r) => r.method === "POST")).toHaveLength(2);
    expect((await row(f)).status).toBe("cancelled");
  } finally {
    await http.close();
  }
});
it("I2: B aceito com CAS perdido é reconhecido historicamente antes de enviar C", async () => {
  const f = await fixture("a@local.test"),
    http = await receiver(),
    db = pgClient();
  const run = () =>
    reconcileAppointment(db, GOV_ORG, f.id, { token: "local", transport: http.transport });
  try {
    expect(await run()).toBe("processed");
    http.remote = {
      ...http.remote!,
      attendees: [
        { email: "a@local.test", responseStatus: "accepted" },
        { email: "outside@local.test", responseStatus: "accepted" },
      ],
      etag: '"rsvp"',
    };
    await pool.query("update calendar_appointments set guest_email='b@local.test' where id=$1", [
      f.id,
    ]);
    http.afterPatch = async () => {
      await pool.query("update calendar_appointments set guest_email='c@local.test' where id=$1", [
        f.id,
      ]);
    };
    expect(await run()).toBe("failed");
    const pending = await row(f);
    expect(pending.google_pending_write.desired.outbound.guest).toBe(hash("b@local.test"));
    expect(pending.google_synced_local_revision).not.toBe(pending.google_local_revision);
    expect(http.remote!.attendees!.some((a) => a.email === "b@local.test")).toBe(true);
    let stateBeforeC: Record<string, unknown> | null = null;
    http.afterPatch = async () => {
      stateBeforeC = await row(f);
    };
    expect(await run()).toBe("processed");
    expect(stateBeforeC).toMatchObject({
      guest_email: "c@local.test",
      google_synced_local_revision: pending.google_synced_local_revision,
      google_base_projection: expect.objectContaining({
        local: expect.objectContaining({ guest: hash("b@local.test") }),
        remote: expect.objectContaining({ guest: hash("b@local.test") }),
      }),
    });
    const patches = http.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[0]!.headers["if-match"]).toBe('"rsvp"');
    expect(patches[1]!.headers["if-match"]).toBe('"v2"');
    expect(http.remote!.attendees).toEqual([
      { email: "outside@local.test", responseStatus: "accepted" },
      { email: "c@local.test", responseStatus: "needsAction" },
    ]);
    const saved = await row(f);
    expect(saved.google_local_revision).toBe(saved.google_synced_local_revision);
    expect(saved.google_conflict).toBeNull();
    expect(saved.google_pending_write).toBeNull();
  } finally {
    await http.close();
  }
});
it("I3: cinquenta vínculos redigidos não ocupam lote e candidato redigido em corrida é terminal", async () => {
  const f = await fixture(),
    http = await receiver(),
    db = pgClient();
  try {
    await pool.query(
      "insert into calendar_appointments(organization_id,owner_user_id,contact_id,title,starts_at,ends_at,google_connection_id,google_calendar_id,google_event_id,google_next_attempt_at) select $1,$2,$3,'Antigo',now()+n*interval '2 hours',now()+n*interval '2 hours'+interval '1 hour',$4,'destination','old-'||n,'2000-01-01'::timestamptz from generate_series(1,50) n",
      [GOV_ORG, GOV_AGENT_A, f.contact, f.conn],
    );
    await pool.query("update contacts set is_anonymized=true,anonymized_at=now() where id=$1", [
      f.contact,
    ]);
    const healthy = await fixture();
    const selected = await googlePushCandidates(db);
    expect(selected.error).toBeNull();
    expect(selected.data!.some((a) => a.id === healthy.id)).toBe(true);
    expect(selected.data!.some((a) => a.id === f.id)).toBe(false);
    expect(
      (
        await pool.query(
          "select count(*) from calendar_google_reconcilable_appointments where contact_id=$1",
          [f.contact],
        )
      ).rows[0].count,
    ).toBe("0");
    expect(
      await reconcileAppointment(db, GOV_ORG, f.id, { token: "local", transport: http.transport }),
    ).toBe("terminal");
    expect(
      await reconcileAppointment(db, GOV_ORG, f.id, { token: "local", transport: http.transport }),
    ).toBe("terminal");
    expect(http.requests).toHaveLength(0);
    const saved = await row(f);
    expect(saved.google_base_projection).toBeNull();
    expect(saved.google_claim_token).toBeNull();
  } finally {
    await http.close();
  }
});
it("I3: página com vínculo redigido e terceiro avança sem GET exato nem reidratação", async () => {
  const f = await fixture(),
    http = await receiver(),
    db = pgClient();
  try {
    expect(
      await reconcileAppointment(db, GOV_ORG, f.id, { token: "local", transport: http.transport }),
    ).toBe("processed");
    const published = await row(f);
    await pool.query("update contacts set is_anonymized=true,anonymized_at=now() where id=$1", [
      f.contact,
    ]);
    http.requests.length = 0;
    http.page = {
      items: [
        { id: published.google_event_id, status: "cancelled" },
        {
          id: "outside",
          start: http.remote!.start,
          end: http.remote!.end,
          summary: "Título privado",
        },
      ],
      nextSyncToken: "page-complete",
    };
    expect(await syncCalendar(db, GOV_ORG, f.cal, http.transport)).toBe("complete");
    expect(http.requests).toHaveLength(1);
    expect(new URL(http.requests[0]!.path, "http://local").pathname.endsWith("/events")).toBe(true);
    const saved = await row(f);
    expect(saved.google_event_id).toBe(published.google_event_id);
    expect([
      saved.google_base_projection,
      saved.google_pending_write,
      saved.google_conflict,
    ]).toEqual([null, null, null]);
    expect(
      (
        await pool.query(
          "select sync_token,sync_cursor from calendar_connection_calendars where id=$1",
          [f.cal],
        )
      ).rows[0],
    ).toEqual({ sync_token: "page-complete", sync_cursor: null });
    expect(
      (
        await pool.query(
          "select external_event_id,title from calendar_external_events where connection_id=$1",
          [f.conn],
        )
      ).rows,
    ).toEqual([{ external_event_id: "outside", title: null }]);
  } finally {
    await http.close();
  }
});
it.each([false, true])(
  "I4: série corrigida vira comparação normal (divergência=%s)",
  async (divergent) => {
    const f = await fixture(),
      http = await receiver(),
      db = pgClient();
    const run = () =>
      reconcileAppointment(db, GOV_ORG, f.id, { token: "local", transport: http.transport });
    try {
      await run();
      const original = structuredClone(http.remote!);
      http.remote = { ...original, recurrence: ["RRULE:FREQ=WEEKLY"], etag: '"series"' };
      await run();
      expect((await row(f)).google_conflict.reason).toBe("series");
      http.remote = { ...original, etag: '"single"' };
      if (divergent) {
        await pool.query(
          "update calendar_appointments set starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' where id=$1",
          [f.id],
        );
        http.remote = {
          ...http.remote,
          start: {
            ...original.start!,
            dateTime: new Date(Date.parse(original.start!.dateTime) + 7200000).toISOString(),
          },
          end: {
            ...original.end!,
            dateTime: new Date(Date.parse(original.end!.dateTime) + 7200000).toISOString(),
          },
        };
      }
      expect(await run()).not.toBe("failed");
      const saved = await row(f);
      expect(saved.google_event_id).toBe(original.id);
      expect(saved.status).toBe("confirmed");
      expect(http.requests.filter((r) => r.method === "POST")).toHaveLength(1);
      expect(http.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
      if (divergent) {
        expect(saved.google_conflict).toMatchObject({
          reason: "shared",
          etag: '"single"',
          revision: saved.revision,
          local_revision: saved.google_local_revision,
        });
        expect(saved.google_conflict.remote.starts_at).toBe(http.remote.start!.dateTime);
      } else {
        expect(saved.google_conflict).toBeNull();
        expect(saved.google_local_revision).toBe(saved.google_synced_local_revision);
      }
    } finally {
      await http.close();
    }
  },
);

it.each(["completed", "no_show", "cancelled"])(
  "I4: retorno a evento simples conserva desfecho %s",
  async (status) => {
    const f = await fixture(),
      http = await receiver(),
      db = pgClient();
    const run = () =>
      reconcileAppointment(db, GOV_ORG, f.id, { token: "local", transport: http.transport });
    try {
      await pool.query(
        "update calendar_appointments set starts_at=now()-$2*interval '1 day',ends_at=now()-$2*interval '1 day'+interval '1 hour' where id=$1",
        [f.id, sequence + 1],
      );
      await run();
      const original = structuredClone(http.remote!);
      const current = await row(f);
      const actor = await pool.connect();
      try {
        await actor.query("begin");
        await actor.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: GOV_AGENT_A, role: "authenticated" }),
        ]);
        await actor.query("select fn_appointment_change($1,$2,$3,$4)", [
          GOV_ORG,
          f.id,
          current.revision,
          { status, ...(status === "cancelled" ? { cancellation_reason: "Decisão humana" } : {}) },
        ]);
        await actor.query("commit");
      } catch (error) {
        await actor.query("rollback");
        throw error;
      } finally {
        actor.release();
      }
      const human = await row(f);
      http.remote = { ...original, recurrence: ["RRULE:FREQ=WEEKLY"], etag: '\"series\"' };
      await run();
      expect((await row(f)).google_conflict.reason).toBe("series");
      http.remote = {
        ...original,
        etag: '\"single\"',
        start: {
          ...original.start!,
          dateTime: new Date(Date.parse(original.start!.dateTime) + 7200000).toISOString(),
        },
        end: {
          ...original.end!,
          dateTime: new Date(Date.parse(original.end!.dateTime) + 7200000).toISOString(),
        },
      };
      expect(await run()).not.toBe("failed");
      const saved = await row(f);
      expect(saved.status).toBe(status);
      expect([
        saved.outcome_user_id,
        saved.outcome_recorded_at,
        saved.cancelled_at,
        saved.cancellation_reason,
      ]).toEqual([
        human.outcome_user_id,
        human.outcome_recorded_at,
        human.cancelled_at,
        human.cancellation_reason,
      ]);
      expect(saved.google_event_id).toBe(original.id);
      expect(saved.google_conflict.reason).toBe(status === "cancelled" ? "shared" : "outcome");
      expect(http.requests.filter((r) => r.method !== "GET")).toHaveLength(1);
    } finally {
      await http.close();
    }
  },
);

async function pessoaDaEquipe(apelido: string) {
  const id = randomUUID(),
    email = `${apelido}-${id}@local.test`;
  await pool.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())",
    [GOV_ORG, id],
  );
  await pool.query(
    "insert into calendar_connections(id,organization_id,user_id,provider,account_email,status) values($1,$2,$3,'google_calendar',$4,'healthy')",
    [randomUUID(), GOV_ORG, id, email],
  );
  return { id, email };
}
const convidados = (http: { remote: Event | null }) =>
  (http.remote?.attendees ?? []).map((p) => p.email).sort();

// `deskcomm_guests` e o checkpoint só existem depois do POST; por isso a publicação
// real, e não um evento montado à mão. Com 2 ou mais convidados o hash do checkpoint
// é o da lista inteira e não reconhece ninguém individualmente: é o caso que importa.
async function publicadoComEquipe(ids: string[]) {
  const f = await fixture(),
    http = await receiver(),
    db = pgClient();
  await pool.query("update calendar_appointments set team_guest_user_ids=$2::uuid[] where id=$1", [
    f.id,
    ids,
  ]);
  const run = () =>
    reconcileAppointment(db, GOV_ORG, f.id, { token: "local", transport: http.transport });
  expect(await run()).toBe("processed");
  return { f, http, db, run };
}
it("I-equipe-1: tirar uma pessoa de lista com 2 ou mais a tira do evento, sem conflito", async () => {
  const [bruna, caio] = [await pessoaDaEquipe("bruna"), await pessoaDaEquipe("caio")];
  const { f, http, run } = await publicadoComEquipe([bruna.id, caio.id]);
  try {
    expect(convidados(http)).toEqual([bruna.email, caio.email].sort());
    http.remote = {
      ...http.remote!,
      attendees: [
        { email: bruna.email, responseStatus: "accepted" },
        { email: caio.email, responseStatus: "accepted" },
      ],
    };
    await pool.query("update calendar_appointments set team_guest_user_ids=$2::uuid[] where id=$1", [
      f.id,
      [bruna.id],
    ]);
    expect(await run()).toBe("processed");
    expect(http.remote!.attendees).toEqual([{ email: bruna.email, responseStatus: "accepted" }]);
    expect((await row(f)).google_conflict).toBeNull();
  } finally {
    await http.close();
  }
});
it("I-equipe-2: trocar uma pessoa da lista publica a troca, sem virar conflito", async () => {
  const [bruna, caio, duda] = [
    await pessoaDaEquipe("bruna"),
    await pessoaDaEquipe("caio"),
    await pessoaDaEquipe("duda"),
  ];
  const { f, http, run } = await publicadoComEquipe([bruna.id, caio.id]);
  try {
    await pool.query("update calendar_appointments set team_guest_user_ids=$2::uuid[] where id=$1", [
      f.id,
      [bruna.id, duda.id],
    ]);
    expect(await run()).toBe("processed");
    expect(convidados(http)).toEqual([bruna.email, duda.email].sort());
    expect((await row(f)).google_conflict).toBeNull();
  } finally {
    await http.close();
  }
});
it("I-equipe-3: membro revogado sai do evento na alteração seguinte, mesmo seguindo na lista", async () => {
  const [bruna, caio] = [await pessoaDaEquipe("bruna"), await pessoaDaEquipe("caio")];
  const { f, http, run } = await publicadoComEquipe([bruna.id, caio.id]);
  try {
    await pool.query(
      "update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2",
      [GOV_ORG, caio.id],
    );
    await pool.query("update calendar_appointments set title='Consulta alterada' where id=$1", [f.id]);
    expect(await run()).toBe("processed");
    expect(http.remote!.summary).toBe("Consulta alterada");
    expect(convidados(http)).toEqual([bruna.email]);
    expect((await row(f)).google_conflict).toBeNull();
  } finally {
    await http.close();
  }
});
it.each([
  ["entradas inválidas", ["nao-e-uuid", "{x}", "", "12345"]],
  ["25 entradas inválidas antes dos ids", Array.from({ length: 25 }, (_, i) => `invalida-${i}`)],
])("I-equipe-5: %s na lista publicada não travam a passada e quem é de verdade sai", async (_, invalidas) => {
  const [bruna, caio] = [await pessoaDaEquipe("bruna"), await pessoaDaEquipe("caio")];
  const { f, http, run } = await publicadoComEquipe([bruna.id, caio.id]);
  try {
    const privadas = (http.remote!.extendedProperties as { private: Record<string, string> }).private;
    privadas.deskcomm_guests = [...invalidas, bruna.id, caio.id].join(",");
    await pool.query("update calendar_appointments set team_guest_user_ids=$2::uuid[] where id=$1", [
      f.id,
      [bruna.id],
    ]);
    expect(await run()).toBe("processed");
    expect(convidados(http)).toEqual([bruna.email]);
    expect((await row(f)).google_conflict).toBeNull();
    expect((http.remote!.extendedProperties as { private: Record<string, string> }).private.deskcomm_guests).toBe(
      bruna.id,
    );
  } finally {
    await http.close();
  }
});
it("I-equipe-6: a lista publicada só é lida em evento associado a este compromisso", async () => {
  const [bruna, caio] = [await pessoaDaEquipe("bruna"), await pessoaDaEquipe("caio")];
  const { f, http, db } = await publicadoComEquipe([bruna.id, caio.id]);
  try {
    const leituras: string[] = [];
    const espiao = {
      ...db,
      from: (tabela: string) => {
        const q = db.from(tabela);
        const select = q.select.bind(q);
        return Object.assign(q, {
          select: (colunas: string) => {
            leituras.push(colunas);
            return select(colunas);
          },
        });
      },
    } as unknown as SupabaseClient;
    (http.remote!.extendedProperties as { private: Record<string, string> }).private.deskcomm_org =
      randomUUID();
    await pool.query("update calendar_appointments set team_guest_user_ids=$2::uuid[] where id=$1", [
      f.id,
      [bruna.id],
    ]);
    await reconcileAppointment(espiao, GOV_ORG, f.id, { token: "local", transport: http.transport });
    expect(leituras.length).toBeGreaterThan(0);
    expect(leituras.filter((c) => c.includes("revoked_at"))).toEqual([]);
    expect(convidados(http)).toContain(caio.email);
  } finally {
    await http.close();
  }
});
it("I-equipe-4: sem conseguir ler quem saiu, nada é escrito e a lista publicada não avança", async () => {
  const [bruna, caio] = [await pessoaDaEquipe("bruna"), await pessoaDaEquipe("caio")];
  const { f, http, db, run } = await publicadoComEquipe([bruna.id, caio.id]);
  try {
    const publicada = (http.remote!.extendedProperties as { private: Record<string, string> }).private
      .deskcomm_guests;
    await pool.query("update calendar_appointments set team_guest_user_ids=$2::uuid[] where id=$1", [
      f.id,
      [bruna.id],
    ]);
    const patchesAntes = http.requests.filter((r) => r.method === "PATCH").length;
    const leituraDerrubada = {
      ...db,
      from: (tabela: string) => {
        if (tabela !== "user_organizations") return db.from(tabela);
        // A 1ª leitura é a do membro ativo, que degrada de propósito. Só a de
        // quem saiu pede `revoked_at` no select.
        const q = db.from(tabela);
        const select = q.select.bind(q);
        return {
          ...q,
          select: (colunas: string) => {
            if (!colunas.includes("revoked_at")) return select(colunas);
            const falha = {
              eq: () => falha,
              in: async () => ({ data: null, error: { message: "fora do ar" } }),
            };
            return falha;
          },
        };
      },
    } as unknown as SupabaseClient;
    expect(
      await reconcileAppointment(leituraDerrubada, GOV_ORG, f.id, {
        token: "local",
        transport: http.transport,
      }),
    ).toBe("failed");
    expect(http.requests.filter((r) => r.method === "PATCH")).toHaveLength(patchesAntes);
    expect((http.remote!.extendedProperties as { private: Record<string, string> }).private.deskcomm_guests).toBe(
      publicada,
    );
    expect(await run()).toBe("processed");
    expect(convidados(http)).toEqual([bruna.email]);
  } finally {
    await http.close();
  }
});
