import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, it, expect } from "vitest";
import { seedGov, GOV_ORG, GOV_AGENT_A, GOV_AGENT_B, GOV_VIEWER } from "./gov-helpers";
import { checkpoint, localProjection } from "@/lib/agenda/google/sync-model";
import { appointmentSnapshotSchema, expectedAppointment } from "@/lib/agenda/google/sync-store";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());
async function fixture(owner = GOV_AGENT_A) {
  const conn = randomUUID(),
    cal = randomUUID(),
    id = randomUUID(),
    contact = randomUUID();
  await pool.query(
    "update calendar_connection_calendars set is_destination=false where organization_id=$1",
    [GOV_ORG],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Cliente sync')",
    [contact, GOV_ORG],
  );
  await pool.query(
    "insert into calendar_connections(id,organization_id,user_id,provider,account_email,status) values($1,$2,$3,'google_calendar',$4,'healthy')",
    [conn, GOV_ORG, owner, `${conn}@test.example`],
  );
  await pool.query(
    "insert into calendar_connection_calendars(id,organization_id,connection_id,external_calendar_id,name,is_destination,access_role) values($1,$2,$3,'destino','Agenda',true,'owner')",
    [cal, GOV_ORG, conn],
  );
  await pool.query(
    "insert into calendar_appointments(id,organization_id,contact_id,owner_user_id,title,starts_at,ends_at,status) values($1,$2,$3,$4,'Consulta',now()+interval '5 days',now()+interval '5 days 1 hour','confirmed')",
    [id, GOV_ORG, contact, owner],
  );
  return { conn, cal, id, contact };
}
async function app(id: string, action: string, args: unknown = {}, org = GOV_ORG) {
  return (
    await pool.query("select fn_google_appointment($1,$2,$3,$4) result", [org, id, action, args])
  ).rows[0].result;
}
async function calendar(id: string, action: string, args: unknown = {}) {
  return (
    await pool.query("select fn_google_calendar($1,$2,$3,$4) result", [GOV_ORG, id, action, args])
  ).rows[0].result;
}
async function asUser(user: string, sql: string, values: unknown[], session?: string, aal = "aal1") {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({
        sub: user,
        role: "authenticated",
        aal,
        ...(session ? { session_id: session } : {}),
      }),
    ]);
    const r = await c.query(sql, values);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
it("reserva original conserva tupla e novo claim não aceita token anterior", async () => {
  const f = await fixture();
  const a = appointmentSnapshotSchema.parse(await app(f.id, "claim"));
  expect(a.google_event_id).toBe(`deskcommapp${f.id.replaceAll("-", "")}`);
  expect(a.google_pending_write).toEqual({ reservation: true });
  expect(await app(f.id, "claim")).toBeNull();
  await pool.query(
    "update calendar_appointments set google_claim_until=now()-interval '1 second' where id=$1",
    [f.id],
  );
  const next = appointmentSnapshotSchema.parse(await app(f.id, "claim"));
  expect(next.claim.epoch).not.toBe(a.claim.epoch);
  expect(next.google_event_id).toBe(a.google_event_id);
  await expect(app(f.id, "release", expectedAppointment(a))).rejects.toThrow("google_stale");
  await app(f.id, "release", expectedAppointment(next));
});
it("metadata, fuso isolado e intenção publicável têm revisões distintas", async () => {
  const f = await fixture();
  const a = appointmentSnapshotSchema.parse(await app(f.id, "claim"));
  await pool.query(
    "update calendar_appointments set notes='nota interna',google_sync_error='erro' where id=$1",
    [f.id],
  );
  let row = (
    await pool.query(
      "select revision,google_local_revision from calendar_appointments where id=$1",
      [f.id],
    )
  ).rows[0];
  expect(row.revision).toBe("1");
  expect(row.google_local_revision).toBe("1");
  await pool.query("update calendar_appointments set time_zone='Asia/Tokyo' where id=$1", [f.id]);
  row = (
    await pool.query(
      "select revision,google_local_revision from calendar_appointments where id=$1",
      [f.id],
    )
  ).rows[0];
  expect(row.revision).toBe("1");
  expect(row.google_local_revision).toBe("2");
  await expect(app(f.id, "renew", expectedAppointment(a))).rejects.toThrow("google_stale");
});
it("aplicação remota usa CAS de domínio sem dirty outbound e preserva vínculos", async () => {
  const f = await fixture();
  const a = appointmentSnapshotSchema.parse(await app(f.id, "claim"));
  const local = localProjection(a);
  const remote = {
    ...local,
    shared: { ...local.shared, starts_at: "2030-01-10T12:00:00Z", ends_at: "2030-01-10T13:00:00Z" },
  };
  const result = await app(f.id, "commit", {
    ...expectedAppointment(a),
    result: {
      apply_remote: true,
      remote: remote.shared,
      base: checkpoint(null, local, remote, [], true),
      etag: '"v1"',
      ack: true,
    },
  });
  expect(result.revision).toBe("2");
  expect(result.google_local_revision).toBe("1");
  expect(result.contact_id).toBe(f.contact);
  expect(result.outcome_user_id).toBeNull();
});
it("presença humana posterior cerca resposta Google antiga", async () => {
  const f = await fixture();
  await pool.query(
    "update calendar_appointments set starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' where id=$1",
    [f.id],
  );
  const a = appointmentSnapshotSchema.parse(await app(f.id, "claim"));
  await asUser(GOV_AGENT_A, 'select fn_appointment_change($1,$2,$3,\'{"status":"completed"}\')', [
    GOV_ORG,
    f.id,
    a.revision,
  ]);
  await expect(
    app(f.id, "commit", { ...expectedAppointment(a), result: { ack: true } }),
  ).rejects.toThrow("google_stale");
  const row = (
    await pool.query("select outcome_user_id,status from calendar_appointments where id=$1", [f.id])
  ).rows[0];
  expect(row.status).toBe("completed");
  expect(row.outcome_user_id).toBe(GOV_AGENT_A);
});
it("redação apaga snapshots e invalida callback tardio", async () => {
  const f = await fixture();
  const a = appointmentSnapshotSchema.parse(await app(f.id, "claim"));
  const l = localProjection(a);
  await app(f.id, "commit", {
    ...expectedAppointment(a),
    result: { base: checkpoint(null, l, l, [], true), etag: '"v1"' },
  });
  await pool.query(
    "update contacts set is_anonymized=true,anonymized_at=now() where organization_id=$1 and id=$2",
    [GOV_ORG, f.contact],
  );
  const row = (
    await pool.query(
      "select google_base_projection,google_pending_write,google_claim_token from calendar_appointments where id=$1",
      [f.id],
    )
  ).rows[0];
  expect(Object.values(row)).toEqual([null, null, null]);
  await expect(
    app(f.id, "commit", {
      ...expectedAppointment(a),
      result: { base: checkpoint(null, l, l, [], true) },
    }),
  ).rejects.toThrow("google_contact_redacted");
});
it("claim/token de calendário cerca cache e página; reclaim conserva geração", async () => {
  const f = await fixture();
  const c = await calendar(f.cal, "claim");
  await calendar(f.cal, "item", {
    claim: c.claim,
    cursor: c.sync_cursor,
    item: {
      external_event_id: "externo",
      status: "confirmed",
      starts_at: "2030-01-01T12:00:00Z",
      ends_at: "2030-01-01T13:00:00Z",
    },
  });
  await pool.query(
    "update calendar_connection_calendars set sync_claim_until=now()-interval '1 second' where id=$1",
    [f.cal],
  );
  const next = await calendar(f.cal, "claim");
  expect(next.sync_cursor.generation).toBe(c.sync_cursor.generation);
  expect(next.claim.epoch).not.toBe(c.claim.epoch);
  await expect(
    calendar(f.cal, "item", {
      claim: c.claim,
      cursor: c.sync_cursor,
      item: { external_event_id: "late", status: "cancelled" },
    }),
  ).rejects.toThrow("google_stale");
  await expect(
    calendar(f.cal, "page", { claim: c.claim, cursor: c.sync_cursor, next_sync_token: "late" }),
  ).rejects.toThrow("google_stale");
  await calendar(f.cal, "page", {
    claim: next.claim,
    cursor: next.sync_cursor,
    next_sync_token: "valid",
  });
  expect(
    (await pool.query("select sync_token from calendar_connection_calendars where id=$1", [f.cal]))
      .rows[0].sync_token,
  ).toBe("valid");
});
it("cancelamento externo mínimo persiste lápide sem ocupar nem perder identidade", async () => {
  const f = await fixture();
  const c = await calendar(f.cal, "claim");
  await calendar(f.cal, "item", {
    claim: c.claim,
    cursor: c.sync_cursor,
    item: {
      external_event_id: "cancelled-instance",
      status: "cancelled",
      recurring_event_id: "series",
    },
  });
  const row = (
    await pool.query(
      "select status,starts_at,recurring_event_id from calendar_external_events where organization_id=$1 and connection_id=$2",
      [GOV_ORG, f.conn],
    )
  ).rows[0];
  expect(row).toEqual({ status: "cancelled", starts_at: null, recurring_event_id: "series" });
});
it("seleção exige dono e papel; duas conexões continuam com um destino e publicação antiga fixa", async () => {
  const f = await fixture();
  const a = appointmentSnapshotSchema.parse(await app(f.id, "claim"));
  const other = randomUUID();
  await pool.query(
    "insert into calendar_connection_calendars(id,organization_id,connection_id,external_calendar_id,name,access_role) values($1,$2,$3,'novo','Novo','owner')",
    [other, GOV_ORG, f.conn],
  );
  const revisions = (
    await pool.query(
      "select id connection_id,calendar_selection_revision::text revision from calendar_connections where organization_id=$1 and user_id=$2 order by id",
      [GOV_ORG, GOV_AGENT_A],
    )
  ).rows;
  await expect(
    asUser(GOV_VIEWER, "select fn_google_selection($1,$2,$3,$4)", [
      GOV_ORG,
      JSON.stringify(revisions),
      [other],
      other,
    ]),
  ).rejects.toThrow();
  await asUser(GOV_AGENT_A, "select fn_google_selection($1,$2,$3,$4)", [
    GOV_ORG,
    JSON.stringify(revisions),
    [other],
    other,
  ]);
  expect(
    (await pool.query("select google_calendar_id from calendar_appointments where id=$1", [f.id]))
      .rows[0].google_calendar_id,
  ).toBe(a.google_calendar_id);
  expect(
    (
      await pool.query(
        "select count(*) from calendar_connection_calendars where organization_id=$1 and is_destination",
        [GOV_ORG],
      )
    ).rows[0].count,
  ).toBe("1");
  const hidden = (
    await pool.query("select fn_google_counts_for_conflicts($1,$2,'destino') result", [
      GOV_ORG,
      f.conn,
    ])
  ).rows[0].result;
  expect(hidden).toBe(false);
});
it("RPC de claim é privada e nunca aceita id cruzado de tenant", async () => {
  const f = await fixture(GOV_AGENT_B);
  await expect(
    asUser(GOV_AGENT_B, "select fn_google_appointment($1,$2,'claim')", [GOV_ORG, f.id]),
  ).rejects.toThrow("permission denied");
  await expect(app(f.id, "claim", {}, randomUUID())).rejects.toThrow("appointment_not_found");
});

it("executor atravessa banco e receiver: unknown insert, título externo, CAS local e 412", async () => {
  const { createServer } = await import("node:http");
  const { reconcileAppointment } = await import("@/lib/agenda/google/sync-executor");
  const { PREFIXO_PROPRIEDADE } = await import("@/lib/agenda/google/evento");
  const f = await fixture();
  let remote: Record<string, unknown> | null = null,
    inserts = 0,
    patches = 0,
    loseInsert = true,
    editDuringPatch = false,
    raceEtag = false;
  const headers: string[] = [];
  const receiver = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "GET") {
        if (req.url!.includes("/events/")) {
          if (!remote) {
            res.statusCode = 404;
            res.end("{}");
            return;
          }
          res.end(JSON.stringify(remote));
          return;
        }
        res.end(JSON.stringify({ id: "destino" }));
        return;
      }
      if (req.method === "POST") {
        inserts++;
        remote = { ...body, etag: '"1"' };
        expect(body.extendedProperties.private[`${PREFIXO_PROPRIEDADE}_org`]).toBe(GOV_ORG);
        if (loseInsert) {
          loseInsert = false;
          req.socket.destroy();
          return;
        }
      }
      if (req.method === "PATCH") {
        patches++;
        headers.push(String(req.headers["if-match"]));
        if (raceEtag) {
          raceEtag = false;
          remote = {
            ...remote,
            etag: '"rsvp"',
            attendees: [{ email: "outsider@example.test", responseStatus: "accepted" }],
          };
          res.statusCode = 412;
          res.end("{}");
          return;
        }
        expect(req.headers["if-match"]).toBe(remote!.etag);
        remote = { ...remote, ...body, etag: `"p${patches}"` };
        if (editDuringPatch) {
          editDuringPatch = false;
          await pool.query(
            "update calendar_appointments set starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' where id=$1",
            [f.id],
          );
        }
      }
      res.end(JSON.stringify(remote));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const address = receiver.address();
  if (!address || typeof address === "string") throw new Error("receiver");
  // Ponte SQL real só para as RPCs internas do executor; token é de teste e o
  // transporte só aponta ao receiver deste caso. Nenhum segredo externo.
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      try {
        expect(name).toBe("fn_google_appointment");
        const result = await pool.query("select fn_google_appointment($1,$2,$3,$4) result", [
          args.p_org,
          args.p_id,
          args.p_action,
          args.p_args,
        ]);
        return { data: result.rows[0].result, error: null };
      } catch (e) {
        return { data: null, error: e };
      }
    },
  } as unknown as SupabaseClient;
  const options = {
    token: "receiver-only",
    transport: ((url, init) =>
      fetch(
        `http://127.0.0.1:${address.port}${new URL(String(url)).pathname}${new URL(String(url)).search}`,
        init,
      )) as typeof fetch,
  };
  try {
    expect(await reconcileAppointment(db, GOV_ORG, f.id, options)).toBe("failed");
    expect(inserts).toBe(1);
    expect(await reconcileAppointment(db, GOV_ORG, f.id, options)).toBe("processed");
    expect(inserts).toBe(1);
    remote = { ...remote!, summary: "Título externo", etag: '"external-title"' };
    await pool.query(
      "update calendar_appointments set starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' where id=$1",
      [f.id],
    );
    editDuringPatch = true;
    expect(await reconcileAppointment(db, GOV_ORG, f.id, options)).toBe("failed");
    const pending = (
      await pool.query("select google_pending_write from calendar_appointments where id=$1", [f.id])
    ).rows[0].google_pending_write;
    expect(pending).not.toBeNull();
    expect(JSON.stringify(pending)).not.toContain("Título externo");
    expect(await reconcileAppointment(db, GOV_ORG, f.id, options)).toBe("processed");
    expect(patches).toBe(2);
    expect(remote!.summary).toBe("Título externo");
    expect(
      (
        await pool.query(
          "select google_conflict,google_local_revision=google_synced_local_revision synced from calendar_appointments where id=$1",
          [f.id],
        )
      ).rows[0],
    ).toEqual({ google_conflict: null, synced: true });
    await pool.query(
      "update calendar_appointments set starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' where id=$1",
      [f.id],
    );
    raceEtag = true;
    expect(await reconcileAppointment(db, GOV_ORG, f.id, options)).toBe("failed");
    expect(await reconcileAppointment(db, GOV_ORG, f.id, options)).toBe("processed");
    expect(patches).toBe(4);
    expect(headers.at(-1)).toBe('"rsvp"');
    expect(remote!.attendees).toEqual([
      { email: "outsider@example.test", responseStatus: "accepted" },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      receiver.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
it("perda de conexão permite diagnóstico cercado, mas recusa publicação e callback", async () => {
  const f = await fixture();
  const a = appointmentSnapshotSchema.parse(await app(f.id, "claim"));
  await pool.query("update calendar_connections set status='disconnected' where id=$1", [f.conn]);
  await expect(app(f.id, "renew", expectedAppointment(a))).rejects.toThrow(
    "google_connection_unavailable",
  );
  await app(f.id, "error", { ...expectedAppointment(a), message: "Reconecte a conta Google." });
  expect(
    (await pool.query("select google_sync_error from calendar_appointments where id=$1", [f.id]))
      .rows[0].google_sync_error,
  ).toBe("Reconecte a conta Google.");
  await expect(
    app(f.id, "commit", { ...expectedAppointment(a), result: { ack: true } }),
  ).rejects.toThrow("google_connection_unavailable");
});
it("catálogo atrasado não recupera ACL nem escolha; mudança de ACL invalida página em voo", async () => {
  const f = await fixture();
  const c = await calendar(f.cal, "claim");
  await pool.query("update calendar_connection_calendars set available=false where id=$1", [f.cal]);
  await expect(
    calendar(f.cal, "page", { claim: c.claim, cursor: c.sync_cursor, next_sync_token: "late" }),
  ).rejects.toThrow("google_stale");
  await pool.query(
    "update calendar_connections set calendar_selection_revision=calendar_selection_revision+1 where id=$1",
    [f.conn],
  );
  await expect(
    pool.query("select fn_google_catalog($1,$2,$3,'0')", [
      GOV_ORG,
      f.conn,
      JSON.stringify([{ id: "destino", accessRole: "owner" }]),
    ]),
  ).rejects.toThrow("google_selection_stale");
  expect(
    (await pool.query("select available from calendar_connection_calendars where id=$1", [f.cal]))
      .rows[0].available,
  ).toBe(false);
});
it("capacidade perdida torna cobertura parcial mesmo com janela recente", async () => {
  const f = await fixture();
  await pool.query(
    "update calendar_connection_calendars set counts_for_conflicts=true,sync_coverage=jsonb_build_object('window_start',now()-interval '1 day','window_end',now()+interval '90 days'),last_sync_at=now(),available=false where id=$1",
    [f.cal],
  );
  expect(
    (
      await pool.query("select fn_google_coverage($1,$2,now(),now()+interval '1 hour') partial", [
        GOV_ORG,
        GOV_AGENT_A,
      ])
    ).rows[0].partial,
  ).toBe(true);
});
it("revogação depois do claim impede renovar, publicar e consumir página", async () => {
  const f = await fixture(GOV_AGENT_B);
  const a = appointmentSnapshotSchema.parse(await app(f.id, "claim")),
    c = await calendar(f.cal, "claim");
  try {
    await pool.query(
      "update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2",
      [GOV_ORG, GOV_AGENT_B],
    );
    await expect(app(f.id, "renew", expectedAppointment(a))).rejects.toThrow(
      "google_owner_unavailable",
    );
    await expect(
      app(f.id, "commit", { ...expectedAppointment(a), result: { ack: true } }),
    ).rejects.toThrow("google_owner_unavailable");
    await expect(
      calendar(f.cal, "item", {
        claim: c.claim,
        cursor: c.sync_cursor,
        item: { external_event_id: "late", status: "cancelled" },
      }),
    ).rejects.toThrow("google_connection_unavailable");
  } finally {
    await pool.query(
      "update user_organizations set revoked_at=null where organization_id=$1 and user_id=$2",
      [GOV_ORG, GOV_AGENT_B],
    );
  }
});
it("sucesso/erro/lease são privados; membro vizinho não pode rearmar publicação pessoal", async () => {
  const f = await fixture();
  for (const patch of [
    "google_synced_at=now()",
    "google_sync_error='sucesso falso'",
    "google_claim_token=gen_random_uuid()",
    "google_synced_local_revision=google_local_revision",
  ]) {
    await expect(
      asUser(
        GOV_AGENT_A,
        `update calendar_appointments set ${patch} where organization_id=$1 and id=$2`,
        [GOV_ORG, f.id],
      ),
    ).rejects.toThrow("google_metadata_private");
  }
  await pool.query(
    "update calendar_appointments set google_next_attempt_at=now()+interval '1 hour' where id=$1",
    [f.id],
  );
  await expect(
    asUser(
      GOV_AGENT_B,
      "update calendar_appointments set google_next_attempt_at=now() where organization_id=$1 and id=$2",
      [GOV_ORG, f.id],
    ),
  ).rejects.toThrow("google_metadata_private");
  await asUser(GOV_AGENT_A, "select fn_google_resolve($1,$2,'1','1',null,'retry')", [
    GOV_ORG,
    f.id,
  ]);
  expect(
    (
      await pool.query(
        "select google_next_attempt_at<=now() due from calendar_appointments where id=$1",
        [f.id],
      )
    ).rows[0].due,
  ).toBe(true);
});
it("dois tenants reais: catálogo e ocupação não atravessam organização ou dono", async () => {
  const f = await fixture(),
    otherOrg = randomUUID(),
    otherConn = randomUUID(),
    otherCal = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,display_name,legal_name) values($1,$2,'Outra','Outra')",
    [otherOrg, otherOrg],
  );
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())",
    [otherOrg, GOV_AGENT_B],
  );
  await pool.query(
    "insert into calendar_connections(id,organization_id,user_id,provider,account_email,status) values($1,$2,$3,'google_calendar','other@local.test','healthy')",
    [otherConn, otherOrg, GOV_AGENT_B],
  );
  await pool.query(
    "insert into calendar_connection_calendars(id,organization_id,connection_id,external_calendar_id,name,counts_for_conflicts,access_role) values($1,$2,$3,'other','Outra',true,'owner')",
    [otherCal, otherOrg, otherConn],
  );
  await pool.query(
    "insert into calendar_external_events(organization_id,connection_id,external_calendar_id,external_event_id,starts_at,ends_at) values($1,$2,'other','private',now(),now()+interval '1 hour')",
    [otherOrg, otherConn],
  );
  expect(
    (
      await asUser(
        GOV_AGENT_A,
        "select id from calendar_connection_calendars where organization_id=$1",
        [otherOrg],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await asUser(
        GOV_AGENT_A,
        "select id from calendar_selected_external_events where organization_id=$1",
        [otherOrg],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await asUser(
        GOV_AGENT_B,
        "select id from calendar_selected_external_events where organization_id=$1",
        [otherOrg],
      )
    ).rows,
  ).toHaveLength(1);
  const rev = (
    await pool.query(
      "select id connection_id,calendar_selection_revision::text revision from calendar_connections where organization_id=$1 and user_id=$2 order by id",
      [GOV_ORG, GOV_AGENT_A],
    )
  ).rows;
  await expect(
    asUser(GOV_AGENT_A, "select fn_google_selection($1,$2,$3,$4)", [
      GOV_ORG,
      JSON.stringify(rev),
      [otherCal],
      f.cal,
    ]),
  ).rejects.toThrow("google_source_unavailable");
  await expect(app(f.id, "claim", {}, otherOrg)).rejects.toThrow("appointment_not_found");
});
it("suporte full conserva dono efetivo; readonly e expirado não decidem nem selecionam", async () => {
  const f = await fixture(),
    session = randomUUID(),
    support = randomUUID(),
    factor = randomUUID();
  await pool.query("insert into auth.sessions(id,user_id,aal) values($1,$2,'aal1')", [
    session,
    GOV_AGENT_A,
  ]);
  await pool.query(
    "insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values($1,$1,'full',false,'Local test')",
    [GOV_AGENT_A],
  );
  await pool.query(
    "insert into platform_support_sessions(id,organization_id,actor_user_id,auth_session_id,access_mode,expires_at) values($1,$2,$3,$4,'full',now()+interval '30 minutes')",
    [support, GOV_ORG, GOV_AGENT_A, session],
  );
  const revisions = async () =>
    (
      await pool.query(
        "select id connection_id,calendar_selection_revision::text revision from calendar_connections where organization_id=$1 and user_id=$2 order by id",
        [GOV_ORG, GOV_AGENT_A],
      )
    ).rows;
  try {
    await asUser(
      GOV_AGENT_A,
      "select fn_google_selection($1,$2,$3,$4)",
      [GOV_ORG, JSON.stringify(await revisions()), [f.cal], f.cal],
      session,
    );
    await asUser(
      GOV_AGENT_A,
      "select fn_google_resolve($1,$2,'1','1',null,'retry')",
      [GOV_ORG, f.id],
      session,
    );
    await pool.query("insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp')", [factor, GOV_AGENT_A]);
    const protectedState = async () => (await pool.query("select jsonb_build_object('appointment',(select to_jsonb(a) from calendar_appointments a where id=$1),'calendars',(select jsonb_agg(to_jsonb(k)) from calendar_connection_calendars k where organization_id=$2),'connections',(select jsonb_agg(to_jsonb(c)) from calendar_connections c where organization_id=$2)) state", [f.id, GOV_ORG])).rows[0].state;
    const beforeMfa = await protectedState();
    for (const [sql, values] of [
      ["select fn_google_selection($1,$2,$3,$4)", [GOV_ORG, JSON.stringify(await revisions()), [], f.cal]],
      ["select fn_google_resolve($1,$2,'1','1',null,'retry')", [GOV_ORG, f.id]],
    ] as const) await expect(asUser(GOV_AGENT_A, sql, [...values], session, "aal1")).rejects.toMatchObject({ code: "42501" });
    expect(await protectedState()).toEqual(beforeMfa);
    await asUser(GOV_AGENT_A, "select fn_google_selection($1,$2,$3,$4)", [GOV_ORG, JSON.stringify(await revisions()), [], f.cal], session, "aal2");
    await asUser(GOV_AGENT_A, "select fn_google_resolve($1,$2,'1','1',null,'retry')", [GOV_ORG, f.id], session, "aal2");
    expect((await pool.query("select counts_for_conflicts from calendar_connection_calendars where id=$1", [f.cal])).rows[0].counts_for_conflicts).toBe(false);
    await pool.query("delete from auth.mfa_factors where id=$1", [factor]);
    for (const state of [
      "access_mode='support_readonly'",
      "access_mode='full',expires_at=now()-interval '1 second'",
    ]) {
      await pool.query(`update platform_support_sessions set ${state} where id=$1`, [support]);
      await expect(
        asUser(
          GOV_AGENT_A,
          "select fn_google_selection($1,$2,$3,$4)",
          [GOV_ORG, JSON.stringify(await revisions()), [f.cal], f.cal],
          session,
        ),
      ).rejects.toThrow("google_selection_forbidden");
      await expect(
        asUser(
          GOV_AGENT_A,
          "select fn_google_resolve($1,$2,'1','1',null,'retry')",
          [GOV_ORG, f.id],
          session,
        ),
      ).rejects.toThrow("google_resolution_forbidden");
    }
  } finally {
    await pool.query("delete from auth.mfa_factors where id=$1", [factor]);
    await pool.query("delete from platform_support_sessions where id=$1", [support]);
    await pool.query("delete from platform_admins where user_id=$1", [GOV_AGENT_A]);
    await pool.query("delete from auth.sessions where id=$1", [session]);
  }
});
