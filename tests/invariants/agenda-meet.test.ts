import type { SupabaseClient } from "@supabase/supabase-js";
import { meetPgSupabase } from "../support/meet-pg-supabase";
import { createAdminClient } from "@/lib/supabase/admin";
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedGov, GOV_AGENT_A, GOV_AGENT_B, GOV_VIEWER } from "./gov-helpers";
import { criarOrigemDeFollowup } from "./followup-service-origin";
import { appointmentSnapshotSchema, expectedAppointment } from "@/lib/agenda/google/sync-store";
import { assertMeetingDeliveryPg } from "@/lib/agenda/meet-delivery";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());
async function fixture(owner: string | null = GOV_AGENT_A) {
  const org = randomUUID(),
    id = randomUUID(),
    contact = randomUUID(),
    conn = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Meet','Meet')",
    [org],
  );
  for (const [user, role] of [
    [GOV_AGENT_A, "agent"],
    [GOV_AGENT_B, "agent"],
    [GOV_VIEWER, "viewer"],
  ])
    await pool.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,$3,now())",
      [org, user, role],
    );
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Cliente Meet','Cliente Meet')",
    [contact, org],
  );
  const boundary = await criarOrigemDeFollowup(pool, org, contact);
  if (owner) {
    await pool.query(
      "insert into calendar_connections(id,organization_id,user_id,provider,account_email,status) values($1,$2,$3,'google_calendar',$4,'healthy')",
      [conn, org, owner, `${conn}@example.test`],
    );
    await pool.query(
      "insert into calendar_connection_calendars(organization_id,connection_id,external_calendar_id,name,is_destination,access_role,allowed_conference_types) values($1,$2,'meet-calendar','Meet',true,'owner',array['hangoutsMeet'])",
      [org, conn],
    );
  }
  await pool.query(
    "insert into calendar_appointments(id,organization_id,contact_id,conversation_id,owner_user_id,title,starts_at,ends_at,status,location_kind) values($1,$2,$3,$4,$5,'Reunião',now()+interval '4 days',now()+interval '4 days 1 hour','confirmed','google_meet')",
    [id, org, contact, boundary.conversation_id, owner],
  );
  return { org, id, contact, conn, boundary, owner };
}
async function app(f: Awaited<ReturnType<typeof fixture>>, action: string, args: unknown = {}) {
  return (
    await pool.query("select fn_google_appointment($1,$2,$3,$4) r", [f.org, f.id, action, args])
  ).rows[0].r;
}
async function actor(user: string | null, sql: string, args: unknown[], session?: string, aal = "aal1") {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(user ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({
        sub: user,
        role: user ? "authenticated" : "anon",
        aal,
        ...(session ? { session_id: session } : {}),
      }),
    ]);
    const r = await c.query(sql, args);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const human = "select fn_meet_action($1,$2,$3,$4,$5,$6) r";
async function row(id: string) {
  return (await pool.query("select * from calendar_appointments where id=$1", [id])).rows[0];
}
it("metadata Meet não reconhece revisão publicável e protege claim/tenant", async () => {
  const f = await fixture(),
    a = appointmentSnapshotSchema.parse(await app(f, "claim"));
  expect(a.meeting_request_id).toBeTruthy();
  await app(f, "meet", {
    ...expectedAppointment(a),
    result: { state: "pending", received: true, url: null, error: null, etag: "v1" },
  });
  const ready = await app(f, "meet", {
    ...expectedAppointment(a),
    result: {
      state: "ready",
      received: true,
      url: "https://meet.google.com/abc-defg-hij",
      error: null,
      etag: "v2",
    },
  });
  expect(ready.revision).toBe(a.revision);
  expect(ready.google_local_revision).toBe(a.google_local_revision);
  expect(ready.google_synced_local_revision).toBe("0");
  expect(ready.meeting_delivery.state).toBe("none");
  await expect(
    app(f, "meet", {
      ...expectedAppointment(a),
      meeting_request_id: randomUUID(),
      result: { state: "ready", url: "https://meet.google.com/abc-defg-hij" },
    }),
  ).rejects.toThrow("meet_stale");
  await expect(
    pool.query("select fn_google_appointment($1,$2,'meet',$3)", [
      randomUUID(),
      f.id,
      expectedAppointment(a),
    ]),
  ).rejects.toThrow();
});
it("retry desconhecido conserva solicitação; failure confirmado gira só por decisão humana", async () => {
  const f = await fixture(),
    a = appointmentSnapshotSchema.parse(await app(f, "claim"));
  await app(f, "meet", {
    ...expectedAppointment(a),
    result: { state: "failed", received: false, url: null, error: "unknown" },
  });
  await actor(GOV_AGENT_A, human, [f.org, f.id, a.revision, a.meeting_request_id, "retry", null]);
  expect((await row(f.id)).meeting_request_id).toBe(a.meeting_request_id);
  await app(f, "meet", {
    ...expectedAppointment(a),
    result: { state: "failed", received: true, url: null, error: "google_failure" },
  });
  await actor(GOV_AGENT_A, human, [f.org, f.id, a.revision, a.meeting_request_id, "retry", null]);
  expect((await row(f.id)).meeting_request_id).not.toBe(a.meeting_request_id);
});
it("RPC humana: positivo dono A/B; nega outro ator, viewer, anon, outra org e owner NULL", async () => {
  for (const owner of [GOV_AGENT_A, GOV_AGENT_B]) {
    const f = await fixture(owner),
      a = await row(f.id);
    await actor(owner, human, [f.org, f.id, "1", a.meeting_request_id, "retry", null]);
    for (const user of [owner === GOV_AGENT_A ? GOV_AGENT_B : GOV_AGENT_A, GOV_VIEWER, null])
      await expect(
        actor(user, human, [f.org, f.id, "1", a.meeting_request_id, "retry", null]),
      ).rejects.toThrow();
    await expect(
      actor(owner, human, [randomUUID(), f.id, "1", a.meeting_request_id, "retry", null]),
    ).rejects.toThrow();
  }
  const f = await fixture(null),
    a = await row(f.id);
  await expect(
    actor(GOV_AGENT_A, human, [f.org, f.id, "1", a.meeting_request_id, "retry", null]),
  ).rejects.toThrow("meet_forbidden");
});
it("suporte readonly e expirado negam ação; full positivo conserva ator", async () => {
  const f = await fixture(),
    a = await row(f.id),
    session = randomUUID(),
    support = randomUUID();
  await pool.query("insert into auth.sessions(id,user_id,aal) values($1,$2,'aal1')", [
    session,
    GOV_AGENT_A,
  ]);
  await pool.query(
    "insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values($1,$1,'full',false,'Test')",
    [GOV_AGENT_A],
  );
  await pool.query(
    "insert into platform_support_sessions(id,organization_id,actor_user_id,auth_session_id,access_mode,expires_at) values($1,$2,$3,$4,'full',now()+interval '30 minutes')",
    [support, f.org, GOV_AGENT_A, session],
  );
  try {
    await actor(
      GOV_AGENT_A,
      human,
      [f.org, f.id, "1", a.meeting_request_id, "retry", null],
      session,
    );
    for (const mode of [
      "access_mode='support_readonly'",
      "access_mode='full',expires_at=now()-interval '1 second'",
    ]) {
      await pool.query(`update platform_support_sessions set ${mode} where id=$1`, [support]);
      await expect(
        actor(GOV_AGENT_A, human, [f.org, f.id, "1", a.meeting_request_id, "retry", null], session),
      ).rejects.toThrow("meet_forbidden");
    }
  } finally {
    await pool.query("delete from platform_support_sessions where id=$1", [support]);
    await pool.query("delete from platform_admins where user_id=$1", [GOV_AGENT_A]);
    await pool.query("delete from auth.sessions where id=$1", [session]);
  }
});
it("ready enfileira uma entrega explícita; claim antigo não envia/liquida após reclaim", async () => {
  const f = await fixture(),
    a = appointmentSnapshotSchema.parse(await app(f, "claim"));
  await actor(GOV_AGENT_A, human, [
    f.org,
    f.id,
    "1",
    a.meeting_request_id,
    "deliver",
    f.boundary.conversation_id,
  ]);
  expect((await row(f.id)).meeting_delivery.state).toBe("waiting_for_link");
  await app(f, "meet", {
    ...expectedAppointment(a),
    result: {
      state: "ready",
      received: true,
      url: "https://meet.google.com/abc-defg-hij",
      error: null,
    },
  });
  let r = await row(f.id);
  const jid = r.meeting_delivery_job_id;
  await actor(GOV_AGENT_A, human, [
    f.org,
    f.id,
    "1",
    a.meeting_request_id,
    "deliver",
    f.boundary.conversation_id,
  ]);
  expect((await row(f.id)).meeting_delivery_job_id).toBe(jid);
  const claim = async () =>
    claimOfJob(
      (
        await pool.query(
          "update job_queue set status='running',locked_by='same-worker',locked_at=clock_timestamp(),attempts=attempts+1 where id=$1 returning locked_by,locked_at::text claim_acquired_at",
          [jid],
        )
      ).rows[0],
    )!;
  const old = await claim();
  await assertMeetingDeliveryPg(pool, { organizationId: f.org, jobId: jid, jobClaim: old });
  await pool.query(
    "update job_queue set status='pending',locked_by=null,locked_at=null where id=$1",
    [jid],
  );
  const current = await claim();
  await expect(
    assertMeetingDeliveryPg(pool, { organizationId: f.org, jobId: jid, jobClaim: old }),
  ).rejects.toThrow();
  expect(
    (
      await pool.query("select fn_meet_delivery_settle($1,$2,$3,$4,'sent') r", [
        f.org,
        jid,
        old.worker_id,
        old.acquired_at,
      ])
    ).rows[0].r,
  ).toBe(false);
  await assertMeetingDeliveryPg(pool, { organizationId: f.org, jobId: jid, jobClaim: current });
  await expect(
    pool.query("select fn_meet_delivery_settle($1,$2,$3,$4,'sent')", [
      f.org,
      jid,
      current.worker_id,
      current.acquired_at,
    ]),
  ).rejects.toThrow("meet_delivery_not_accepted");
  r = await row(f.id);
  expect(r.meeting_delivery.state).toBe("queued");
  expect(
    JSON.stringify((await pool.query("select payload from job_queue where id=$1", [jid])).rows[0]),
  ).not.toContain("https://");
});
it("cancelamento/redação invalidam solicitação, intenção e URL; contexto auxiliar é minimizado", async () => {
  const f = await fixture(),
    a = appointmentSnapshotSchema.parse(await app(f, "claim"));
  await actor(GOV_AGENT_A, human, [
    f.org,
    f.id,
    "1",
    a.meeting_request_id,
    "deliver",
    f.boundary.conversation_id,
  ]);
  await app(f, "meet", {
    ...expectedAppointment(a),
    result: {
      state: "ready",
      received: true,
      url: "https://meet.google.com/abc-defg-hij",
      error: null,
    },
  });
  const jid = (await row(f.id)).meeting_delivery_job_id;
  await pool.query(
    "insert into lead_checkpoints(organization_id,contact_id,rolling_summary) values($1,$2,'https://meet.google.com/abc-defg-hij')",
    [f.org, f.contact],
  );
  expect(
    (
      await pool.query("select rolling_summary from lead_checkpoints where contact_id=$1", [
        f.contact,
      ])
    ).rows[0].rolling_summary,
  ).not.toContain("https://meet.");
  await pool.query("update contacts set is_anonymized=true,anonymized_at=now() where id=$1", [
    f.contact,
  ]);
  const r = await row(f.id);
  expect(r.meeting_url).toBeNull();
  expect(r.meeting_request_id).toBeNull();
  expect(r.meeting_delivery).toEqual({ state: "blocked" });
  expect(
    (await pool.query("select payload,status from job_queue where id=$1", [jid])).rows[0],
  ).toEqual({ payload: {}, status: "failed" });
  await expect(
    app(f, "meet", {
      ...expectedAppointment(a),
      result: { state: "ready", url: "https://meet.google.com/abc-defg-hij" },
    }),
  ).rejects.toThrow();
  const c = await fixture(),
    b = appointmentSnapshotSchema.parse(await app(c, "claim"));
  await pool.query(
    "update calendar_appointments set status='cancelled',cancelled_at=now() where id=$1",
    [c.id],
  );
  expect((await row(c.id)).meeting_state).toBe("cancelled");
  await expect(
    app(c, "meet", {
      ...expectedAppointment(b),
      result: { state: "ready", url: "https://meet.google.com/abc-defg-hij" },
    }),
  ).rejects.toThrow();
});

it("HTTP controlado: POST pending, polling GET, success/failure/unknown e convite preservado", async () => {
  const { createServer } = await import("node:http");
  const { reconcileAppointment } = await import("@/lib/agenda/google/sync-executor");
  const f = await fixture();
  await pool.query(
    "update calendar_appointments set guest_email='convidado@example.test' where id=$1",
    [f.id],
  );
  let remote: Record<string, unknown> | null = null;
  const writes: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  const receiver = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === "GET") {
      if (!req.url!.includes("/events/")) {
        res.end(JSON.stringify({ id: "meet-calendar" }));
        return;
      }
      res.statusCode = remote ? 200 : 404;
      res.end(JSON.stringify(remote ?? {}));
      return;
    }
    writes.push({ method: req.method!, url: req.url!, body });
    remote = {
      ...((remote as Record<string, unknown> | null) ?? {}),
      ...body,
      etag: `"v${writes.length}"`,
    };
    if (body.conferenceData)
      remote!.conferenceData = {
        createRequest: {
          requestId: body.conferenceData.createRequest.requestId,
          status: { statusCode: "pending" },
        },
      };
    res.end(JSON.stringify(remote));
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const address = receiver.address();
  if (!address || typeof address === "string") throw Error("receiver");
  const db = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      try {
        return { data: await app(f, String(args.p_action), args.p_args), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  } as unknown as SupabaseClient;
  const options = {
    token: "local-only",
    transport: ((url, init) =>
      fetch(
        `http://127.0.0.1:${address.port}${new URL(String(url)).pathname}${new URL(String(url)).search}`,
        init,
      )) as typeof fetch,
  };
  const due = () =>
    pool.query(
      "update calendar_appointments set meeting_next_attempt_at=now()-interval '1 second' where id=$1",
      [f.id],
    );
  try {
    expect(await reconcileAppointment(db, f.org, f.id, options)).toBe("processed");
    const a = await row(f.id);
    expect(a.meeting_state).toBe("pending");
    expect(a.meeting_received_at).not.toBeNull();
    expect(a.meeting_url).toBeNull();
    expect(a.google_synced_local_revision).toBe(a.google_local_revision);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toContain("conferenceDataVersion=1");
    expect(writes[0]!.url).toContain("sendUpdates=all");
    expect(writes[0]!.body).toMatchObject({
      attendees: [{ email: "convidado@example.test" }],
      conferenceData: {
        createRequest: {
          requestId: a.meeting_request_id,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    });
    await due();
    await reconcileAppointment(db, f.org, f.id, options);
    expect(writes).toHaveLength(1);
    remote = {
      ...((remote as Record<string, unknown> | null) ?? {}),
      etag: '"ready"',
      conferenceData: {
        createRequest: { requestId: a.meeting_request_id, status: { statusCode: "success" } },
        conferenceSolution: { key: { type: "hangoutsMeet" } },
        entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
      },
    };
    await due();
    expect(await reconcileAppointment(db, f.org, f.id, options)).toBe("processed");
    const ready = await row(f.id);
    expect(ready.meeting_state).toBe("ready");
    expect(ready.revision).toBe(a.revision);
    expect(ready.google_local_revision).toBe(a.google_local_revision);
    expect(ready.meeting_delivery.state).toBe("none");
    expect(writes).toHaveLength(1);
    // Nova fixture de intenção existente: falha explícita não vira ready nem outro POST.
    await pool.query(
      "update calendar_appointments set meeting_state='pending',meeting_next_attempt_at=now() where id=$1",
      [f.id],
    );
    remote = {
      ...((remote as Record<string, unknown> | null) ?? {}),
      etag: '"failure"',
      conferenceData: {
        createRequest: { requestId: a.meeting_request_id, status: { statusCode: "failure" } },
      },
    };
    await reconcileAppointment(db, f.org, f.id, options);
    expect((await row(f.id)).meeting_last_error).toBe("google_failure");
    expect(writes).toHaveLength(1);
    await actor(GOV_AGENT_A, human, [f.org, f.id, a.revision, a.meeting_request_id, "retry", null]);
    const retry = await row(f.id);
    expect(retry.meeting_request_id).not.toBe(a.meeting_request_id);
    // O GET de failure antigo não é recibo da nova intenção.
    await reconcileAppointment(db, f.org, f.id, options);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.method).toBe("PATCH");
    expect(writes[1]!.body).not.toHaveProperty("attendees");
    expect((await row(f.id)).meeting_request_id).toBe(retry.meeting_request_id);
    remote = {
      ...((remote as Record<string, unknown> | null) ?? {}),
      conferenceData: {
        createRequest: { requestId: retry.meeting_request_id, status: { statusCode: "success" } },
        conferenceSolution: { key: { type: "unknown" } },
        entryPoints: [{ entryPointType: "phone", uri: "tel:123" }],
      },
    };
    await due();
    await reconcileAppointment(db, f.org, f.id, options);
    expect((await row(f.id)).meeting_last_error).toBe("invalid");
    expect((await row(f.id)).meeting_url).toBeNull();
    expect(writes).toHaveLength(2);
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
  }
});

it("HTTP aceito com resposta perdida conserva request; recibo não reconhece remarcação não enviada", async () => {
  const { createServer } = await import("node:http");
  const { reconcileAppointment } = await import("@/lib/agenda/google/sync-executor");
  const f = await fixture();
  let remote: Record<string, unknown> | null = null,
    posts = 0,
    patches = 0;
  const receipts: Record<string, unknown>[] = [];
  const receiver = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === "GET") {
      if (!req.url!.includes("/events/")) {
        res.end(JSON.stringify({ id: "meet-calendar" }));
        return;
      }
      res.statusCode = remote ? 200 : 404;
      res.end(JSON.stringify(remote ?? {}));
      return;
    }
    if (req.method === "POST") {
      posts++;
      remote = {
        ...body,
        etag: '"created"',
        conferenceData: {
          createRequest: {
            requestId: body.conferenceData.createRequest.requestId,
            status: { statusCode: "pending" },
          },
        },
      };
      req.socket.destroy();
      return;
    }
    patches++;
    expect(body).not.toHaveProperty("conferenceData");
    remote = {
      ...((remote as Record<string, unknown> | null) ?? {}),
      ...body,
      etag: '"rescheduled"',
    };
    res.end(JSON.stringify(remote));
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const address = receiver.address();
  if (!address || typeof address === "string") throw Error("receiver");
  const db = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      try {
        const data = await app(f, String(args.p_action), args.p_args);
        if (args.p_action === "meet") receipts.push(data);
        return { data, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  } as unknown as SupabaseClient;
  const options = {
    token: "local-only",
    transport: ((url, init) =>
      fetch(
        `http://127.0.0.1:${address.port}${new URL(String(url)).pathname}${new URL(String(url)).search}`,
        init,
      )) as typeof fetch,
  };
  try {
    expect(await reconcileAppointment(db, f.org, f.id, options)).toBe("failed");
    const a = await row(f.id);
    await pool.query(
      "update calendar_appointments set starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' where id=$1",
      [f.id],
    );
    await pool.query(
      "update calendar_appointments set meeting_next_attempt_at=now()-interval '1 second' where id=$1",
      [f.id],
    );
    expect(await reconcileAppointment(db, f.org, f.id, options)).toBe("processed");
    expect(posts).toBe(1);
    expect(patches).toBe(1);
    expect(receipts[0]).toMatchObject({
      google_synced_local_revision: "0",
      google_local_revision: "2",
      meeting_request_id: a.meeting_request_id,
      meeting_state: "pending",
    });
    expect((await row(f.id)).google_synced_local_revision).toBe("2");
    expect((await row(f.id)).meeting_request_id).toBe(a.meeting_request_id);
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
  }
});

it("entrega real controlada: fila→gates→ledger→handler→HTTP; replay não duplica nem silencia", async () => {
  const { createServer } = await import("node:http");
  const { createMeetDeliveryHandler } = await import("@/lib/agent-engine/agent/meet-delivery");
  const f = await fixture();
  await pool.query(
    "update contacts set phone_number='+15551234567',ai_authorized_at=now() where id=$1",
    [f.contact],
  );
  const channel = (
    await pool.query("select channel_session_id from conversations where id=$1", [
      f.boundary.conversation_id,
    ])
  ).rows[0].channel_session_id;
  await pool.query(
    "insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,window_start_hour,window_end_hour) values($1,$2,0,0,0,24)",
    [f.org, channel],
  );
  await pool.query(
    "update conversations set assignee_kind='ai',bot_silenced_until=null where id=$1",
    [f.boundary.conversation_id],
  );
  // As alterações de atribuição não reancoram trabalho antigo: intenção nasce DEPOIS.
  const a = appointmentSnapshotSchema.parse(await app(f, "claim"));
  await actor(GOV_AGENT_A, human, [
    f.org,
    f.id,
    a.revision,
    a.meeting_request_id,
    "deliver",
    f.boundary.conversation_id,
  ]);
  await app(f, "meet", {
    ...expectedAppointment(a),
    result: {
      state: "ready",
      received: true,
      url: "https://meet.google.com/abc-defg-hij",
      error: null,
    },
  });
  const jid = (await row(f.id)).meeting_delivery_job_id;
  const acquire = async () =>
    (
      await pool.query(
        "update job_queue set status='running',locked_by='meet-worker',locked_at=clock_timestamp(),attempts=attempts+1 where id=$1 returning *,locked_at::text claim_acquired_at",
        [jid],
      )
    ).rows[0];
  const bodies: Record<string, unknown>[] = [];
  const receiver = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    bodies.push(raw ? JSON.parse(raw) : {});
    res.end(JSON.stringify({ id: "local-message-1" }));
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const addr = receiver.address();
  if (!addr || typeof addr === "string") throw Error("receiver");
  const previousUrl = process.env.WAHA_API_BASE_URL,
    previousKey = process.env.WAHA_API_KEY;
  process.env.WAHA_API_BASE_URL = `http://127.0.0.1:${addr.port}`;
  process.env.WAHA_API_KEY = "receiver-only";
  const db = meetPgSupabase(pool);
  vi.mocked(createAdminClient).mockReturnValue(db.client as never);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = createMeetDeliveryHandler({
    crmCfg: { supabase: db.client },
    log,
    sleep: async () => {},
  });
  try {
    await pool.query("update channel_sessions set status='STOPPED' where id=$1", [channel]);
    await run(await acquire(), pool);
    expect(bodies).toHaveLength(0);
    expect((await row(f.id)).meeting_delivery.state).toBe("queued");
    expect(
      (await pool.query("select status from job_queue where id=$1", [jid])).rows[0].status,
    ).toBe("pending");
    expect(
      (await pool.query("select status from send_ledger where job_id=$1", [jid])).rows[0].status,
    ).toBe("queued");
    await pool.query("update channel_sessions set status='WORKING' where id=$1", [channel]);
    await run(await acquire(), pool);
    const state = await row(f.id);
    expect(state.meeting_delivery.state, JSON.stringify(db.errors)).toBe("sent");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.text).toContain("https://meet.google.com/abc-defg-hij");
    expect(bodies[0]!.text).toContain("America/Sao_Paulo");
    const messages = (
      await pool.query("select * from messages where organization_id=$1 and contact_id=$2", [
        f.org,
        f.contact,
      ])
    ).rows;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ sent_via: "ai", sent_by_user_id: null, status: "sent" });
    expect(
      (
        await pool.query("select bot_silenced_until from conversations where id=$1", [
          f.boundary.conversation_id,
        ])
      ).rows[0].bot_silenced_until,
    ).toBeNull();
    const traces = (
      await pool.query(
        "select trace from before_send_traces where organization_id=$1 and job_id=$2",
        [f.org, jid],
      )
    ).rows;
    expect(traces[0].trace.length).toBeGreaterThan(5);
    const receipt = (await pool.query("select * from send_ledger where job_id=$1", [jid])).rows[0];
    expect(receipt.status).toBe("accepted");
    expect(
      (
        await pool.query("select normalized_text from outbound_copies where organization_id=$1", [
          f.org,
        ])
      ).rows[0].normalized_text,
    ).not.toContain("https://meet.");
    // Simula crash entre receipt e settle; spinning/cap já registraram o primeiro envio.
    await pool.query(
      'update calendar_appointments set meeting_delivery=meeting_delivery||\'{"state":"queued"}\' where id=$1',
      [f.id],
    );
    await pool.query("update send_ledger set status='requested' where job_id=$1", [jid]);
    await pool.query("update job_queue set status='dead',locked_by=null,locked_at=null where id=$1",[jid]);
    await actor(GOV_AGENT_A,human,[f.org,f.id,a.revision,a.meeting_request_id,'deliver',f.boundary.conversation_id]);
    expect((await row(f.id)).meeting_delivery_job_id).toBe(jid);
    await run(await acquire(), pool);
    expect((await row(f.id)).meeting_delivery.state).toBe("sent");
    expect(bodies).toHaveLength(1);
    expect(
      (await pool.query("select count(*) from messages where contact_id=$1", [f.contact])).rows[0]
        .count,
    ).toBe("1");
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("https://meet.");
  } finally {
    if (previousUrl === undefined) delete process.env.WAHA_API_BASE_URL;
    else process.env.WAHA_API_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.WAHA_API_KEY;
    else process.env.WAHA_API_KEY = previousKey;
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
  }
});

it("booking aceita somente contexto interno do job original; metadados diretos são privados", async () => {
  const f = await fixture(),
    jid = randomUUID();
  const job = (
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,status,locked_by,locked_at,payload) values($1,$2,$3,'operator_turn','running','booker',clock_timestamp(),$4) returning *,locked_at::text claim_acquired_at",
      [jid, f.org, f.contact, { service_boundary: f.boundary }],
    )
  ).rows[0];
  const intent = {
    state: "waiting_for_link",
    generation: randomUUID(),
    source_operation_id: jid,
    service_boundary: f.boundary,
    booking_claim: claimOfJob(job),
    authorized_by: { kind: "ai_agent", id: "agent-engine" },
  };
  const insert =
    "insert into calendar_appointments(organization_id,contact_id,conversation_id,owner_user_id,title,starts_at,ends_at,location_kind,meeting_delivery) values($1,$2,$3,$4,'Meet combinado',now()+interval '9 days',now()+interval '9 days 1 hour','google_meet',$5) returning *";
  const a = (
    await pool.query(insert, [f.org, f.contact, f.boundary.conversation_id, GOV_AGENT_A, intent])
  ).rows[0];
  expect(a.meeting_delivery.state).toBe("waiting_for_link");
  expect(a.meeting_delivery).not.toHaveProperty("booking_claim");
  await pool.query("update job_queue set locked_at=clock_timestamp() where id=$1", [jid]);
  await expect(
    pool.query(insert, [f.org, f.contact, f.boundary.conversation_id, GOV_AGENT_A, intent]),
  ).rejects.toThrow("meet_booking_stale");
  await expect(
    actor(GOV_AGENT_A, "update calendar_appointments set meeting_delivery=$1 where id=$2", [
      intent,
      a.id,
    ]),
  ).rejects.toThrow("meet_metadata_private");
  await expect(
    actor(GOV_AGENT_A, insert, [f.org, f.contact, f.boundary.conversation_id, GOV_AGENT_A, intent]),
  ).rejects.toThrow("meet_metadata_private");
});

it("entrega antiga não reancora após encerrar/reabrir; nova intenção exige novo clique", async () => {
  const { createMeetDeliveryHandler } = await import("@/lib/agent-engine/agent/meet-delivery");
  const f = await fixture(),
    a = appointmentSnapshotSchema.parse(await app(f, "claim"));
  await actor(GOV_AGENT_A, human, [
    f.org,
    f.id,
    a.revision,
    a.meeting_request_id,
    "deliver",
    f.boundary.conversation_id,
  ]);
  await app(f, "meet", {
    ...expectedAppointment(a),
    result: {
      state: "ready",
      received: true,
      url: "https://meet.google.com/abc-defg-hij",
      error: null,
    },
  });
  const old = (await row(f.id)).meeting_delivery_job_id;
  const job = (
    await pool.query(
      "update job_queue set status='running',locked_by='worker',locked_at=clock_timestamp() where id=$1 returning *,locked_at::text claim_acquired_at",
      [old],
    )
  ).rows[0];
  await pool.query("update conversations set status='closed' where id=$1", [
    f.boundary.conversation_id,
  ]);
  const fresh = (await pool.query("select fn_service_begin($1,$2) b", [f.org, f.contact])).rows[0]
    .b;
  const send = vi.fn();
  const db = meetPgSupabase(pool);
  const run = createMeetDeliveryHandler({
    crmCfg: { supabase: db.client },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    channel: () => ({ send }) as never,
  });
  await run(job, pool);
  expect(send).not.toHaveBeenCalled();
  expect((await row(f.id)).meeting_delivery.state).toBe("stale");
  expect(
    (
      await pool.query(
        "select count(*) from agent_inbox_items where organization_id=$1 and ref_id=$2 and status='open'",
        [f.org, f.id],
      )
    ).rows[0].count,
  ).toBe("1");
  await actor(GOV_AGENT_A, human, [
    f.org,
    f.id,
    a.revision,
    a.meeting_request_id,
    "deliver",
    fresh.conversation_id,
  ]);
  const next = await row(f.id);
  expect(next.meeting_delivery_job_id).not.toBe(old);
  expect(next.meeting_delivery.service_boundary.service_revision).not.toBe(
    job.payload.service_boundary.service_revision,
  );
  await run(job, pool);
  expect((await row(f.id)).meeting_delivery_job_id).toBe(next.meeting_delivery_job_id);
  expect((await row(f.id)).meeting_delivery.state).toBe("queued");
  expect(send).not.toHaveBeenCalled();
});

it.each(["reclaim", "cancel", "redact"] as const)(
  "fence até o sink/callback HTTP: %s em voo",
  async (mode) => {
    const { createServer } = await import("node:http");
    const { createMeetDeliveryHandler } = await import("@/lib/agent-engine/agent/meet-delivery");
    const f = await fixture();
    await pool.query(
      "update contacts set phone_number='+5531998765432',ai_authorized_at=now() where id=$1",
      [f.contact],
    );
    const channel = (
      await pool.query("select channel_session_id from conversations where id=$1", [
        f.boundary.conversation_id,
      ])
    ).rows[0].channel_session_id;
    await pool.query(
      "insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,window_start_hour,window_end_hour) values($1,$2,0,0,0,24)",
      [f.org, channel],
    );
    const a = appointmentSnapshotSchema.parse(await app(f, "claim"));
    await actor(GOV_AGENT_A, human, [
      f.org,
      f.id,
      a.revision,
      a.meeting_request_id,
      "deliver",
      f.boundary.conversation_id,
    ]);
    await app(f, "meet", {
      ...expectedAppointment(a),
      result: {
        state: "ready",
        received: true,
        url: "https://meet.google.com/abc-defg-hij",
        error: null,
      },
    });
    const jid = (await row(f.id)).meeting_delivery_job_id;
    const job = (
      await pool.query(
        "update job_queue set status='running',locked_by='same-worker',locked_at=clock_timestamp() where id=$1 returning *,locked_at::text claim_acquired_at",
        [jid],
      )
    ).rows[0];
    let mutation = false,
      posted = 0,
      receiverError: unknown = null;
    const mutate = async () => {
      mutation = true;
      if (mode === "reclaim")
        await pool.query("update job_queue set locked_at=clock_timestamp() where id=$1", [jid]);
      else if (mode === "cancel")
        await pool.query(
          "update calendar_appointments set status='cancelled',cancelled_at=now() where id=$1",
          [f.id],
        );
      else
        await pool.query("select fn_lgpd_cascade_redact_contact($1,$2,null)", [f.org, f.contact]);
    };
    const receiver = createServer(async (req, res) => {
      try {
        if (req.method === "GET") {
          if (mode !== "redact" && !mutation) await mutate();
          res.end(JSON.stringify({ numberExists: true, chatId: "553198765432@c.us" }));
          return;
        }
        for await (const _chunk of req) {
        }
        posted++;
        if (mode === "redact" && !mutation) await mutate();
        res.end(JSON.stringify({ id: "accepted-before-redaction" }));
      } catch (error) {
        receiverError = error;
        res.statusCode = 500;
        res.end("{}");
      }
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    const addr = receiver.address();
    if (!addr || typeof addr === "string") throw Error("receiver");
    const previousUrl = process.env.WAHA_API_BASE_URL,
      previousKey = process.env.WAHA_API_KEY;
    process.env.WAHA_API_BASE_URL = `http://127.0.0.1:${addr.port}`;
    process.env.WAHA_API_KEY = "receiver-only";
    const db = meetPgSupabase(pool);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    try {
      await createMeetDeliveryHandler({
        crmCfg: { supabase: db.client },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        sleep: async () => {},
      })(job, pool);
      expect(receiverError).toBeNull();
      expect(mutation).toBe(true);
      expect(posted).toBe(mode === "redact" ? 1 : 0);
      const current = await row(f.id);
      expect(current.meeting_delivery.state).not.toBe("sent");
      if (mode === "reclaim") {
        const j = (await pool.query("select status,locked_by from job_queue where id=$1", [jid]))
          .rows[0];
        expect(j).toEqual({ status: "running", locked_by: "same-worker" });
        expect(current.meeting_delivery.state).toBe("queued");
      }
      if (mode === "redact") {
        expect(current.meeting_url).toBeNull();
        expect(current.meeting_request_id).toBeNull();
        expect(current.meeting_delivery).toEqual({ state: "blocked" });
        const messages = (
          await pool.query("select body,metadata from messages where contact_id=$1", [f.contact])
        ).rows;
        expect(JSON.stringify(messages)).not.toContain("https://meet.");
        const conv = (
          await pool.query("select last_message_preview from conversations where id=$1", [
            f.boundary.conversation_id,
          ])
        ).rows[0];
        expect(JSON.stringify(conv)).not.toContain("https://meet.");
      }
    } finally {
      if (previousUrl === undefined) delete process.env.WAHA_API_BASE_URL;
      else process.env.WAHA_API_BASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.WAHA_API_KEY;
      else process.env.WAHA_API_KEY = previousKey;
      receiver.closeAllConnections();
      await new Promise<void>((r) => receiver.close(() => r()));
    }
  },
);

it("erros repetidos têm teto e backoff; retry incerto não gira requestId", async () => {
  const f = await fixture(),
    a = appointmentSnapshotSchema.parse(await app(f, "claim"));
  for (let n = 0; n < 20; n++)
    await app(f, "error", { ...expectedAppointment(a), message: "Falha transitória sanitizada" });
  const failed = await row(f.id);
  expect(failed.meeting_state).toBe("failed");
  expect(failed.meeting_last_error).toBe("unknown");
  expect(failed.meeting_attempts).toBe(20);
  expect(new Date(failed.meeting_next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  await actor(GOV_AGENT_A, human, [f.org, f.id, a.revision, a.meeting_request_id, "retry", null]);
  const retry = await row(f.id);
  expect(retry.meeting_request_id).toBe(a.meeting_request_id);
  expect(retry.meeting_attempts).toBe(0);
});
it("dois executores Google: busy e reclaim cercam resposta antiga sem segundo POST/sala", async () => {
  const { createServer } = await import("node:http");
  const { reconcileAppointment } = await import("@/lib/agenda/google/sync-executor");
  const f = await fixture();
  let remote: Record<string, unknown> | null = null,
    posts = 0;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => (entered = r)),
    hold = new Promise<void>((r) => (release = r));
  const receiver = createServer(async (req, res) => {
    if (req.method === "GET") {
      if (!req.url!.includes("/events/")) {
        res.end("{}");
        return;
      }
      res.statusCode = remote ? 200 : 404;
      res.end(JSON.stringify(remote ?? {}));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw);
    posts++;
    remote = {
      ...body,
      etag: '"accepted"',
      conferenceData: {
        createRequest: {
          requestId: body.conferenceData.createRequest.requestId,
          status: { statusCode: "pending" },
        },
      },
    };
    entered();
    await hold;
    res.end(JSON.stringify(remote));
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const address = receiver.address();
  if (!address || typeof address === "string") throw Error("receiver");
  const db = meetPgSupabase(pool);
  const options = {
    token: "local-only",
    transport: ((url, init) =>
      fetch(
        `http://127.0.0.1:${address.port}${new URL(String(url)).pathname}${new URL(String(url)).search}`,
        init,
      )) as typeof fetch,
  };
  const first = reconcileAppointment(db.client, f.org, f.id, options);
  try {
    await reached;
    expect(await reconcileAppointment(db.client, f.org, f.id, options)).toBe("busy");
    await pool.query(
      "update calendar_appointments set google_claim_until=now()-interval '1 second' where id=$1",
      [f.id],
    );
    expect(await reconcileAppointment(db.client, f.org, f.id, options)).toBe("processed");
    const winner = await row(f.id);
    expect(winner.meeting_received_at).not.toBeNull();
    release();
    expect(await first).toBe("failed");
    const final = await row(f.id);
    expect(posts).toBe(1);
    expect(final.meeting_request_id).toBe(winner.meeting_request_id);
    expect(final.google_claim_epoch).toBe(winner.google_claim_epoch);
    expect(final.meeting_state).toBe("pending");
    expect(final.google_claim_token).toBeNull();
  } finally {
    release();
    await first;
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
  }
});

it("FIX1 I1: RPC direta exige aal2 com TOTP verificado, sem fator preserva acesso", async () => {
  const f = await fixture(),
    a = await row(f.id),
    factor = randomUUID();
  const args = [f.org, f.id, "1", a.meeting_request_id, "retry", null];
  await expect(actor(GOV_AGENT_A, human, args)).resolves.toBeTruthy();
  await pool.query(
    "insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp')",
    [factor, GOV_AGENT_A],
  );
  try {
    await expect(
      actor(GOV_AGENT_A, human, args, undefined, "aal1"),
    ).rejects.toThrow("meet_mfa_required");
    await expect(
      actor(GOV_AGENT_A, human, args, undefined, "aal2"),
    ).resolves.toBeTruthy();
  } finally {
    await pool.query("delete from auth.mfa_factors where id=$1", [factor]);
  }
});

async function deliveryFixture(
  origin: "user" | "ai_agent",
  restriction: string | null = null,
) {
  const f = await fixture();
  const channel = (
    await pool.query(
      "select channel_session_id from conversations where id=$1",
      [f.boundary.conversation_id],
    )
  ).rows[0].channel_session_id;
  await pool.query(
    "update contacts set phone_number='+15551234567',ai_authorized_at=now() where id=$1",
    [f.contact],
  );
  await pool.query(
    "update conversations set assignee_kind='ai',bot_silenced_until=null where id=$1",
    [f.boundary.conversation_id],
  );
  if (restriction === "force_human")
    await pool.query("update contacts set force_human=true where id=$1", [
      f.contact,
    ]);
  if (restriction === "conversa_silenciada")
    await pool.query(
      "update conversations set bot_silenced_until='infinity' where id=$1",
      [f.boundary.conversation_id],
    );
  if (restriction === "conversa_de_humano")
    await pool.query(
      "update conversations set assignee_kind='user',assigned_to_user_id=$2 where id=$1",
      [f.boundary.conversation_id, GOV_AGENT_A],
    );
  if (restriction === "sem_autorizacao") {
    await pool.query("update contacts set ai_authorized_at=null where id=$1", [
      f.contact,
    ]);
    await pool.query(
      'update channel_sessions set metadata=metadata||\'{"ai_gate":"allowlist"}\' where id=$1',
      [channel],
    );
  }
  await pool.query(
    "insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,window_start_hour,window_end_hour) values($1,$2,0,0,0,24)",
    [f.org, channel],
  );
  f.boundary = (
    await pool.query(
      "select fn_service_boundary($1,$2)-'status'-'demanda_fechada_em'-'service_started_at' b",
      [f.org, f.boundary.conversation_id],
    )
  ).rows[0].b;
  if (origin === "ai_agent") {
    const source = (
      await pool.query(
        "insert into job_queue(organization_id,contact_id,kind,status,locked_by,locked_at,payload) values($1,$2,'operator_turn','running','booking',clock_timestamp(),$3) returning *,locked_at::text claim_acquired_at",
        [f.org, f.contact, { service_boundary: f.boundary }],
      )
    ).rows[0];
    const intent = {
      state: "waiting_for_link",
      generation: randomUUID(),
      source_operation_id: source.id,
      service_boundary: f.boundary,
      booking_claim: claimOfJob(source),
      authorized_by: { kind: origin, id: "agent-engine" },
    };
    const newId = randomUUID();
    await pool.query(
      "insert into calendar_appointments(id,organization_id,contact_id,conversation_id,owner_user_id,title,starts_at,ends_at,status,location_kind,meeting_delivery) select $2,organization_id,contact_id,conversation_id,owner_user_id,title,starts_at+interval '1 day',ends_at+interval '1 day',status,location_kind,$3 from calendar_appointments where id=$1",
      [f.id, newId, intent],
    );
    await pool.query(
      "update job_queue set status='done',locked_by=null,locked_at=null where id=$1",
      [source.id],
    );
    f.id = newId;
  }
  const a = appointmentSnapshotSchema.parse(await app(f, "claim"));
  if (origin === "user")
    await actor(GOV_AGENT_A, human, [
      f.org,
      f.id,
      a.revision,
      a.meeting_request_id,
      "deliver",
      f.boundary.conversation_id,
    ]);
  await app(f, "meet", {
    ...expectedAppointment(a),
    result: {
      state: "ready",
      received: true,
      url: "https://meet.google.com/abc-defg-hij",
      error: null,
    },
  });
  const jid = (await row(f.id)).meeting_delivery_job_id;
  const job = (
    await pool.query(
      "update job_queue set status='running',locked_by='delivery',locked_at=clock_timestamp() where id=$1 returning *,locked_at::text claim_acquired_at",
      [jid],
    )
  ).rows[0];
  return { f, a, channel, job };
}
async function controlledDelivery(
  setup: Awaited<ReturnType<typeof deliveryFixture>>,
  onResolve?: () => Promise<void>,
  crashBeforeSettle = false,
) {
  const { createServer } = await import("node:http");
  const { createMeetDeliveryHandler } =
    await import("@/lib/agent-engine/agent/meet-delivery");
  const bodies: Record<string, unknown>[] = [];
  let mutation = false,
    receiverError: unknown;
  const receiver = createServer(async (req, res) => {
    try {
      if (req.method === "GET") {
        if (onResolve && !mutation) {
          mutation = true;
          await onResolve();
        }
        res.end(
          JSON.stringify({ numberExists: true, chatId: "553198765432@c.us" }),
        );
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      bodies.push(JSON.parse(raw));
      res.end(JSON.stringify({ id: randomUUID() }));
    } catch (error) {
      receiverError = error;
      res.statusCode = 500;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  const address = receiver.address();
  if (!address || typeof address === "string") throw Error("receiver");
  const previousUrl = process.env.WAHA_API_BASE_URL,
    previousKey = process.env.WAHA_API_KEY;
  process.env.WAHA_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.WAHA_API_KEY = "receiver-only";
  const db = meetPgSupabase(pool);
  vi.mocked(createAdminClient).mockReturnValue(db.client as never);
  try {
    const executionPool = crashBeforeSettle ? new Proxy(pool, {
      get(target, key) {
        if (key === "query") return (text: string, values: unknown[]) => {
          if (text.includes("fn_meet_delivery_settle")) throw new Error("test_crash_before_settle");
          return target.query(text, values);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) : pool;
    const run = createMeetDeliveryHandler({
      crmCfg: { supabase: db.client },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sleep: async () => {},
    })(setup.job, executionPool);
    if (crashBeforeSettle) await expect(run).rejects.toThrow("test_crash_before_settle");
    else await run;
    expect(receiverError).toBeUndefined();
    return { bodies, mutation, errors: db.errors };
  } finally {
    if (previousUrl === undefined) delete process.env.WAHA_API_BASE_URL;
    else process.env.WAHA_API_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.WAHA_API_KEY;
    else process.env.WAHA_API_KEY = previousKey;
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
}
it.each([
  "force_human",
  "conversa_silenciada",
  "conversa_de_humano",
  "sem_autorizacao",
])(
  "FIX1 M1: comando humano vence somente veto de autonomia %s; booking automático não",
  async (restriction) => {
    for (const origin of ["user", "ai_agent"] as const) {
      const setup = await deliveryFixture(origin, restriction),
        { f } = setup;
      const readFlags = async () =>
        (
          await pool.query(
            "select c.force_human,c.ai_authorized_at,v.assignee_kind,v.assigned_to_user_id,v.bot_silenced_until::text,s.metadata from contacts c join conversations v on v.organization_id=c.organization_id and v.contact_id=c.id join channel_sessions s on s.organization_id=v.organization_id and s.id=v.channel_session_id where c.id=$1 and v.id=$2",
            [f.contact, f.boundary.conversation_id],
          )
        ).rows[0];
      const before = await readFlags(),
        result = await controlledDelivery(setup);
      expect(result.bodies.length, JSON.stringify(result.errors)).toBe(
        origin === "user" ? 1 : 0,
      );
      expect(await readFlags()).toEqual(before);
      const state = await row(f.id);
      expect(state.meeting_delivery.state).toBe(
        origin === "user" ? "sent" : "blocked",
      );
      if (origin === "ai_agent")
        expect(state.meeting_delivery.error).toBe(restriction);
      else {
        expect(
          (
            await pool.query(
              "select sent_via,sent_by_user_id from messages where contact_id=$1",
              [f.contact],
            )
          ).rows[0],
        ).toEqual({ sent_via: "ai", sent_by_user_id: null });
        expect(state.meeting_delivery.authorized_by).toEqual({
          kind: "user",
          id: GOV_AGENT_A,
        });
      }
    }
  },
);
it.each(["opt_out", "channel", "actor", "claim", "boundary"])(
  "FIX1 M1: %s continua impedindo ambos os caminhos",
  async (restriction) => {
    for (const origin of ["user", "ai_agent"] as const) {
      const setup = await deliveryFixture(origin),
        { f, channel } = setup;
      if (restriction === "opt_out")
        await pool.query("update contacts set is_blocked=true where id=$1", [
          f.contact,
        ]);
      if (restriction === "channel")
        await pool.query(
          "update channel_sessions set archived_at=now() where id=$1",
          [channel],
        );
      if (restriction === "actor")
        await pool.query(
          "update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2",
          [f.org, GOV_AGENT_A],
        );
      if (restriction === "claim")
        await pool.query(
          "update job_queue set locked_at=clock_timestamp() where id=$1",
          [setup.job.id],
        );
      if (restriction === "boundary")
        await pool.query(
          "update conversations set status='closed' where id=$1",
          [f.boundary.conversation_id],
        );
      const result = await controlledDelivery(setup);
      expect(result.bodies).toHaveLength(0);
      expect((await row(f.id)).meeting_delivery.state).not.toBe("sent");
      if (restriction === "claim") {
        expect((await row(f.id)).meeting_delivery.state).toBe("queued");
        expect(
          (
            await pool.query("select status from job_queue where id=$1", [
              setup.job.id,
            ])
          ).rows[0].status,
        ).toBe("running");
      } else
        expect((await row(f.id)).meeting_delivery.error).toBe(
          restriction === "actor"
            ? "access_or_stale"
            : restriction === "boundary"
              ? "meet_delivery_stale"
              : restriction,
        );
    }
  },
);
it.each(["user", "ai_agent"] as const)(
  "FIX1 M1: autoridade revogada durante preparo HTTP barra sink %s",
  async (origin) => {
    const setup = await deliveryFixture(origin);
    await pool.query(
      "update contacts set phone_number='+5531998765432' where id=$1",
      [setup.f.contact],
    );
    const result = await controlledDelivery(setup, async () => {
      await pool.query(
        "update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2",
        [setup.f.org, GOV_AGENT_A],
      );
    });
    expect(result.mutation).toBe(true);
    expect(result.bodies).toHaveLength(0);
    expect((await row(setup.f.id)).meeting_delivery.state).not.toBe("sent");
  },
);
it("FIX1 I4: enviado→close/reopen mesmo UUID precisa clique novo; intenção antiga nunca reancora", async () => {
  const setup = await deliveryFixture("user"),
    { f, a } = setup;
  expect((await controlledDelivery(setup)).bodies).toHaveLength(1);
  const previous = (await row(f.id)).meeting_delivery;
  const args = [
    f.org,
    f.id,
    a.revision,
    a.meeting_request_id,
    "deliver",
    f.boundary.conversation_id,
  ];
  expect((await actor(GOV_AGENT_A, human, args)).rows[0].r).toBe(false);
  await pool.query("update conversations set status='closed' where id=$1", [
    f.boundary.conversation_id,
  ]);
  await pool.query("update conversations set status='open' where id=$1", [
    f.boundary.conversation_id,
  ]);
  expect((await row(f.id)).meeting_delivery).toEqual(previous);
  const { meetingAuthorizationCurrent } =
    await import("@/lib/agenda/google/meet");
  const current = (
    await pool.query("select fn_service_boundary($1,$2) b", [
      f.org,
      f.boundary.conversation_id,
    ])
  ).rows[0].b;
  expect(meetingAuthorizationCurrent(previous.service_boundary, current)).toBe(
    false,
  );
  expect((await actor(GOV_AGENT_A, human, args)).rows[0].r).toBe(true);
  const next = await row(f.id);
  expect(next.meeting_delivery.generation).not.toBe(previous.generation);
  expect(next.meeting_delivery.service_boundary.conversation_id).toBe(
    previous.service_boundary.conversation_id,
  );
  expect(
    next.meeting_delivery.service_boundary.service_revision,
  ).toBeGreaterThan(previous.service_boundary.service_revision);
  expect(
    meetingAuthorizationCurrent(
      next.meeting_delivery.service_boundary,
      current,
    ),
  ).toBe(true);
  expect((await actor(GOV_AGENT_A, human, args)).rows[0].r).toBe(false);
});
it("FIX1 M1: booking não pode forjar recibo humano mesmo com claim válido", async () => {
  const f = await fixture(),
    jid = randomUUID();
  const job = (
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,status,locked_by,locked_at,payload) values($1,$2,$3,'operator_turn','running','booker',clock_timestamp(),$4) returning *,locked_at::text claim_acquired_at",
      [jid, f.org, f.contact, { service_boundary: f.boundary }],
    )
  ).rows[0];
  const intent = {
    state: "waiting_for_link",
    generation: randomUUID(),
    source_operation_id: jid,
    service_boundary: f.boundary,
    booking_claim: claimOfJob(job),
    authorized_by: { kind: "user", id: GOV_AGENT_A },
  };
  await expect(
    pool.query(
      "insert into calendar_appointments(id,organization_id,contact_id,conversation_id,owner_user_id,title,starts_at,ends_at,status,location_kind,meeting_delivery) select $2,organization_id,contact_id,conversation_id,owner_user_id,title,starts_at,ends_at,status,location_kind,$3 from calendar_appointments where id=$1",
      [f.id, randomUUID(), intent],
    ),
  ).rejects.toThrow("meet_booking_origin_invalid");
});
it("FIX1 M1: troca de canal não transporta autorização antiga; clique explícito cria intenção nova", async () => {
  const setup = await deliveryFixture("user"), { f, a } = setup;
  const original = (await row(f.id)).meeting_delivery;
  const channel = (await pool.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,gen_random_uuid()::text,'WORKING',decode('00','hex')) returning id", [f.org])).rows[0].id;
  await pool.query("update conversations set channel_session_id=$2 where id=$1", [f.boundary.conversation_id, channel]);
  await expect(assertMeetingDeliveryPg(pool, { organizationId:f.org, jobId:setup.job.id, jobClaim:claimOfJob(setup.job)! })).rejects.toThrow();
  expect((await row(f.id)).meeting_delivery).toEqual(original);
  await actor(GOV_AGENT_A, human, [f.org,f.id,a.revision,a.meeting_request_id,"deliver",f.boundary.conversation_id]);
  const next = (await row(f.id)).meeting_delivery;
  expect(next.generation).not.toBe(original.generation);
  expect(next.channel_session_id).toBe(channel);
});


it.each(["removed", "expired"] as const)(
  "FIX2 N1: aceite anterior reconcilia com autonomia %s; sem aceite continua bloqueado",
  async (mode) => {
    const setup = await deliveryFixture("ai_agent"),
      { f, channel, job } = setup;
    await pool.query(
      'update channel_sessions set metadata=metadata||\'{"ai_gate":"allowlist"}\' where id=$1',
      [channel],
    );
    const sent = await controlledDelivery(setup, undefined, true);
    expect(sent.bodies).toHaveLength(1);
    const ledgerBefore = (
      await pool.query(
        "select id,status,crm_message_id from send_ledger where job_id=$1",
        [job.id],
      )
    ).rows[0];
    expect(ledgerBefore.status).toBe("accepted");
    expect((await row(f.id)).meeting_delivery.state).toBe("queued");
    const disable = async (contact: string) =>
      pool.query(
        "update contacts set ai_authorized_at=case when $2='removed' then null else now()-interval '1000 days' end where id=$1",
        [contact, mode],
      );
    await disable(f.contact);
    expect(
      (
        await pool.query(
          "select fn_service_boundary($1,$2)-'status'-'demanda_fechada_em'-'service_started_at' b",
          [f.org, f.boundary.conversation_id],
        )
      ).rows[0].b,
    ).toEqual(f.boundary);
    const reacquired = (
      await pool.query(
        "update job_queue set locked_at=clock_timestamp() where id=$1 returning *,locked_at::text claim_acquired_at",
        [job.id],
      )
    ).rows[0];
    expect(claimOfJob(reacquired)!.acquired_at).not.toBe(
      claimOfJob(job)!.acquired_at,
    );
    // Aquisição antiga não reconhece nem liquida a tomada nova, mesmo com aceite.
    expect((await controlledDelivery(setup)).bodies).toHaveLength(0);
    expect((await row(f.id)).meeting_delivery.state).toBe("queued");
    expect(
      (await pool.query("select status from job_queue where id=$1", [job.id]))
        .rows[0].status,
    ).toBe("running");
    expect(
      (await controlledDelivery({ ...setup, job: reacquired })).bodies,
    ).toHaveLength(0);
    expect((await row(f.id)).meeting_delivery.state).toBe("sent");
    expect(
      (
        await pool.query(
          "select id,status,crm_message_id from send_ledger where job_id=$1",
          [job.id],
        )
      ).rows[0],
    ).toEqual(ledgerBefore);
    const messages = (
      await pool.query("select id,status from messages where contact_id=$1", [
        f.contact,
      ])
    ).rows;
    expect(messages).toEqual([
      { id: ledgerBefore.crm_message_id, status: "sent" },
    ]);
    expect(
      (await pool.query("select status from job_queue where id=$1", [job.id]))
        .rows[0].status,
    ).toBe("done");

    const unsent = await deliveryFixture("ai_agent");
    await pool.query(
      'update channel_sessions set metadata=metadata||\'{"ai_gate":"allowlist"}\' where id=$1',
      [unsent.channel],
    );
    await disable(unsent.f.contact);
    expect((await controlledDelivery(unsent)).bodies).toHaveLength(0);
    expect((await row(unsent.f.id)).meeting_delivery).toMatchObject({
      state: "blocked",
      error: mode === "removed" ? "sem_autorizacao" : "autorizacao_expirada",
    });
    expect(
      (
        await pool.query("select count(*) from send_ledger where job_id=$1", [
          unsent.job.id,
        ])
      ).rows[0].count,
    ).toBe("0");
  },
);
