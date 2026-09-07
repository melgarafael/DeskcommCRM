import pg from "pg";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { reconcileAppointment } from "../../lib/agenda/google/sync-executor";
import { createMeetDeliveryHandler } from "../../lib/agent-engine/agent/meet-delivery";
import { escolherDiaDesenhado, irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;
const orgs: string[] = [],
  users: string[] = [];
const link = "https://meet.google.com/abc-defg-hij";
test.use({ trace: "on", timezoneId: "America/Sao_Paulo", viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 180_000 });
async function insert(table: string, value: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw error;
  return data.id as string;
}
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}
async function fixture() {
  expect(["127.0.0.1", "localhost"]).toContain(new URL(credentials.dbUrl).hostname);
  const email = `meet-ui-${randomUUID()}@invariant.test`;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw created.error;
  const user = created.data.user.id;
  users.push(user);
  const org = await insert("organizations", {
    slug: `meet-ui-${randomUUID()}`,
    display_name: "Agenda Meet local",
    legal_name: "Agenda Meet local",
    onboarded_at: new Date().toISOString(),
  });
  orgs.push(org);
  await insert("user_organizations", {
    organization_id: org,
    user_id: user,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  const connection = await insert("calendar_connections", {
    organization_id: org,
    user_id: user,
    provider: "google_calendar",
    account_email: email,
    status: "healthy",
  });
  await insert("calendar_connection_calendars", {
    organization_id: org,
    connection_id: connection,
    external_calendar_id: "meet-calendar",
    name: "Agenda Meet da equipe",
    is_destination: true,
    counts_for_conflicts: true,
    access_role: "owner",
    time_zone: "America/Sao_Paulo",
    allowed_conference_types: ["hangoutsMeet"],
  });
  await insert("calendar_event_types", {
    organization_id: org,
    name: "Consulta Meet",
    slug: "consulta-meet",
    duration_minutes: 30,
    minimum_notice_minutes: 0,
    booking_window_days: 90,
    location_kind: "google_meet",
    default_owner_user_id: user,
    is_active: true,
  });
  const availability = await db
    .from("attendant_availability")
    .upsert(
      {
        organization_id: org,
        user_id: user,
        is_available: true,
        schedule: {
          timezone: "America/Sao_Paulo",
          windows: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "09:00", end: "18:00" })),
        },
      },
      { onConflict: "organization_id,user_id" },
    );
  if (availability.error) throw availability.error;
  const sessionName = randomUUID();
  const session = await insert("channel_sessions", {
    organization_id: org,
    waha_session_name: sessionName,
    display_name: "Atendimento local",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
    metadata: { ai_gate: "allowlist" },
  });
  const knobs = await db.from("channel_knobs").insert({
    organization_id: org,
    channel_session_id: session,
    throttle_ms: 0,
    jitter_max_ms: 0,
    window_start_hour: 0,
    window_end_hour: 24,
  });
  if (knobs.error) throw knobs.error;
  const contact = await insert("contacts", {
    organization_id: org,
    name: "Maria Meet",
    display_name: "Maria Meet",
    phone_number: "+15551234567",
    force_human: true,
  });
  const conversation = await insert("conversations", {
    organization_id: org,
    contact_id: contact,
    channel_session_id: session,
    status: "open",
    assignee_kind: "user",
    assigned_to_user_id: user,
    bot_silenced_until: "infinity",
  });
  return { org, user, email, session, sessionName, connection, contact, conversation };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function inbound(f: Fixture, body: string) {
  const at = new Date().toISOString();
  await insert("messages", {
    organization_id: f.org,
    contact_id: f.contact,
    conversation_id: f.conversation,
    channel_session_id: f.session,
    direction: "inbound",
    type: "text",
    status: "received",
    sent_via: "ai",
    external_id: randomUUID(),
    body,
    sent_at: at,
  });
  await rpc("fn_mark_conversation_message", {
    p_conv: f.conversation,
    p_direction: "inbound",
    p_preview: body,
    p_at: at,
  });
}
async function row(f: Fixture, id: string) {
  const r = await db
    .from("calendar_appointments")
    .select("*")
    .eq("organization_id", f.org)
    .eq("id", id)
    .single();
  if (r.error) throw r.error;
  return r.data;
}
async function login(page: Page, f: Fixture) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(f.email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}
async function book(page: Page, f: Fixture) {
  await inbound(f, "Quero marcar minha reunião");
  await login(page, f);
  await page.goto(`/app/inbox/${f.conversation}`);
  await page.getByRole("link", { name: "Marcar compromisso", exact: true }).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible();
  await expect(page.getByLabel("Quem será atendido")).toHaveValue(f.contact);
  await expect(page.getByLabel("Conversa vinculada (opcional)")).toHaveValue(f.conversation);
  await page.keyboard.press("Escape");
  const days = await irParaASemanaSeguinte(page);
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await page.getByRole("button", { name: /^Consulta Meet/ }).click();
  await escolherDiaDesenhado(page, days);
  await page.locator('[data-testid^="horario-"]').first().click();
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/v1/agenda/agendamentos" &&
      r.request().method() === "POST",
  );
  await page.getByTestId("confirmar-marcacao").click();
  const saved = await response;
  expect(saved.status(), await saved.text()).toBe(201);
  const a = (await saved.json()).data;
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible();
  expect(await row(f, a.id)).toMatchObject({
    contact_id: f.contact,
    conversation_id: f.conversation,
    location_kind: "google_meet",
    meeting_state: "pending",
    meeting_delivery: { state: "none" },
  });
  return a.id as string;
}
const meet = (page: Page) => page.locator('section[aria-label="Google Meet"]');
async function detail(page: Page, id: string) {
  await page.goto(`/app/agenda?compromisso=${id}`);
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Consulta Meet", exact: true }),
  ).toBeVisible();
  await expect(meet(page)).toBeVisible();
}
async function action(page: Page, label: string, kind: "retry" | "deliver") {
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith(`/google/meet/${kind}`) && r.request().method() === "POST",
  );
  await meet(page).getByRole("button", { name: label, exact: true }).click();
  const saved = await response;
  expect(saved.status(), await saved.text()).toBe(200);
  return JSON.parse(saved.request().postData()!) as {
    revision: string;
    request_id: string;
    conversation_id?: string;
  };
}
async function capture(page: Page, info: TestInfo, name: string, control: string) {
  const dir = info.outputPath(name);
  mkdirSync(dir, { recursive: true });
  const target = meet(page).getByRole("button", { name: control, exact: true });
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport({ ratio: 1 });
  const measured = await meet(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      width: r.width,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      viewport: document.documentElement.clientWidth,
      visibility: getComputedStyle(el).visibility,
      controls: Array.from(el.querySelectorAll("button,a,select")).map((c) => {
        const b = c.getBoundingClientRect();
        return {
          text: c.textContent,
          left: b.left,
          right: b.right,
          top: b.top,
          bottom: b.bottom,
          visibility: getComputedStyle(c).visibility,
        };
      }),
    };
  });
  expect(measured.left).toBeGreaterThanOrEqual(0);
  expect(measured.right).toBeLessThanOrEqual(measured.viewport + 1);
  expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth + 1);
  expect(measured.visibility).toBe("visible");
  for (const c of measured.controls) {
    expect(c.left).toBeGreaterThanOrEqual(0);
    expect(c.right).toBeLessThanOrEqual(measured.viewport + 1);
  }
  writeFileSync(`${dir}/measures.json`, JSON.stringify(measured, null, 2));
  await page.screenshot({ path: `${dir}/loaded.png`, fullPage: true });
}
async function googleReceiver() {
  let remote: Record<string, unknown> | null = null,
    version = 0;
  const requests: Array<{ method: string; body: Record<string, unknown>; path: string }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method!, body, path: req.url! });
    res.setHeader("content-type", "application/json");
    if (!req.url?.includes("/events")) {
      res.end(JSON.stringify({ id: "meet-calendar" }));
      return;
    }
    if (req.method === "GET") {
      res.statusCode = remote ? 200 : 404;
      res.end(JSON.stringify(remote ?? {}));
      return;
    }
    if (req.method === "POST" && remote) {
      res.statusCode = 409;
      res.end("{}");
      return;
    }
    if (req.method === "PATCH" && req.headers["if-match"] !== remote?.etag) {
      res.statusCode = 412;
      res.end("{}");
      return;
    }
    const next: Record<string, unknown> = { ...remote, ...body, etag: `"v${++version}"` };
    if (body.conferenceData)
      next.conferenceData = {
        createRequest: { ...body.conferenceData.createRequest, status: { statusCode: "pending" } },
      };
    remote = next;
    res.end(JSON.stringify(remote));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("receiver");
  return {
    server,
    requests,
    state(status: "success" | "failure") {
      if (!remote) throw Error("missing remote");
      const c = remote.conferenceData as { createRequest: { requestId: string } };
      remote = {
        ...remote,
        etag: `"v${++version}"`,
        conferenceData: {
          createRequest: { ...c.createRequest, status: { statusCode: status } },
          ...(status === "success"
            ? {
                conferenceSolution: { key: { type: "hangoutsMeet" } },
                entryPoints: [{ entryPointType: "video", uri: link }],
              }
            : {}),
        },
      };
    },
    run: (f: Fixture, id: string) =>
      reconcileAppointment(db, f.org, id, {
        token: "local-only",
        transport: (url, init) => {
          const u = new URL(String(url));
          return fetch(`http://127.0.0.1:${address.port}${u.pathname}${u.search}`, init);
        },
      }),
  };
}
async function pollGoogle(
  f: Fixture,
  id: string,
  receiver: Awaited<ReturnType<typeof googleReceiver>>,
) {
  const update = await db
    .from("calendar_appointments")
    .update({ meeting_next_attempt_at: new Date(Date.now() - 1000).toISOString() })
    .eq("organization_id", f.org)
    .eq("id", id);
  if (update.error) throw update.error;
  expect(await receiver.run(f, id)).toBe("processed");
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function deliveryReceiver() {
  const bodies: Record<string, unknown>[] = [];
  const target = new URL(process.env.WAHA_API_BASE_URL!);
  expect(["127.0.0.1", "localhost"]).toContain(target.hostname);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    bodies.push(JSON.parse(raw));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: randomUUID() }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(target.port), target.hostname, resolve);
  });
  return { server, bodies };
}
async function deliver(f: Fixture, id: string, pool: pg.Pool) {
  const a = await row(f, id);
  expect(a.meeting_delivery_job_id).toBeTruthy();
  // Aquisição SQL manual só desta fixture; consumer/ledger/HTTP reais, sem provar scheduler.
  const { rows } = await pool.query(
    "update job_queue set status='running',locked_by='meet-browser',locked_at=clock_timestamp(),attempts=attempts+1 where organization_id=$1 and id=$2 and status='pending' returning *,locked_at::text claim_acquired_at",
    [f.org, a.meeting_delivery_job_id],
  );
  expect(rows).toHaveLength(1);
  await createMeetDeliveryHandler({
    crmCfg: { supabase: db },
    log: { info() {}, warn() {}, error() {} },
    sleep: async () => {},
  })(rows[0], pool);
  expect((await row(f, id)).meeting_delivery.state).toBe("sent");
  return rows[0].id as string;
}
test.afterAll(async () => {
  for (const org of orgs) {
    const result = await db.from("organizations").delete().eq("id", org);
    if (result.error) throw result.error;
  }
  for (const user of users) {
    const result = await db.auth.admin.deleteUser(user);
    if (result.error) throw result.error;
  }
});
test("marca Meet, copia link, autoriza em atendimento humano e entrega novamente após reabrir mesmo UUID", async ({
  page,
}, info) => {
  const f = await fixture(),
    google = await googleReceiver(),
    channel = await deliveryReceiver(),
    pool = new pg.Pool({ connectionString: credentials.dbUrl, max: 5 });
  try {
    const id = await book(page, f);
    await detail(page, id);
    await expect(meet(page).getByText("Criando link do Google Meet")).toBeVisible();
    await expect(meet(page).getByText("O envio do link ainda não foi autorizado.")).toBeVisible();
    await expect(meet(page).getByRole("link")).toHaveCount(0);
    await capture(page, info, "pending-desktop", "Enviar quando ficar pronto");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, info, "pending-mobile", "Enviar quando ficar pronto");
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(await google.run(f, id)).toBe("processed");
    expect((await row(f, id)).meeting_received_at).toBeTruthy();
    google.state("success");
    await pollGoogle(f, id, google);
    await detail(page, id);
    await expect(meet(page).getByRole("link", { name: "Abrir reunião" })).toHaveAttribute(
      "href",
      link,
    );
    expect((await row(f, id)).meeting_delivery.state).toBe("none");
    expect(channel.bodies).toHaveLength(0);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await meet(page).getByRole("button", { name: "Copiar link" }).click();
    await expect(meet(page).getByRole("button", { name: "Link copiado" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    await capture(page, info, "ready-desktop", "Enviar link ao cliente");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, info, "ready-mobile", "Enviar link ao cliente");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(meet(page).getByRole("combobox")).toContainText("Maria Meet");
    const before = (
      await db
        .from("conversations")
        .select("assignee_kind,assigned_to_user_id,bot_silenced_until,service_revision")
        .eq("organization_id", f.org)
        .eq("id", f.conversation)
        .single()
    ).data;
    expect(before).toMatchObject({ assignee_kind: "user", assigned_to_user_id: f.user, bot_silenced_until: "infinity" });
    const beforeSend = await row(f, id);
    const sentRequest = await action(page, "Enviar link ao cliente", "deliver");
    expect(sentRequest.revision).toBe(String(beforeSend.revision));
    expect(sentRequest.conversation_id).toBe(f.conversation);
    const firstJob = await deliver(f, id, pool);
    expect(channel.bodies).toHaveLength(1);
    expect(channel.bodies[0]).toMatchObject({ session: f.sessionName, chatId: "15551234567@c.us" });
    expect(channel.bodies[0]!.text).toContain(link);
    const original = (await row(f, id)).meeting_delivery;
    await detail(page, id);
    await expect(meet(page).getByRole("button", { name: "Link já enviado" })).toBeDisabled();
    const after = (
      await db
        .from("conversations")
        .select("assignee_kind,assigned_to_user_id,bot_silenced_until,service_revision")
        .eq("organization_id", f.org)
        .eq("id", f.conversation)
        .single()
    ).data;
    expect(after).toEqual(before);
    expect((await db.from("contacts").select("force_human,ai_authorized_at").eq("organization_id",f.org).eq("id",f.contact).single()).data).toEqual({force_human:true,ai_authorized_at:null});
    await capture(page, info, "sent-desktop", "Link já enviado");
    const noOp = await page.request.post(`/api/v1/agenda/agendamentos/${id}/google/meet/deliver`, {
      data: sentRequest,
    });
    expect(noOp.status()).toBe(200);
    expect((await noOp.json()).data.changed).toBe(false);
    expect(channel.bodies).toHaveLength(1);
    const oldLedger = (
      await pool.query("select * from send_ledger where organization_id=$1 and job_id=$2", [
        f.org,
        firstJob,
      ])
    ).rows;
    expect(oldLedger).toHaveLength(1);
    expect(oldLedger[0]).toMatchObject({ organization_id: f.org, contact_id: f.contact, job_id: firstJob, seq: 1, status: "accepted" });
    expect(oldLedger[0].crm_message_id).toEqual(expect.any(String));
    const oldJob = (await pool.query("select * from job_queue where organization_id=$1 and id=$2", [f.org, firstJob])).rows;
    expect(oldJob).toHaveLength(1);
    expect(oldJob[0]).toMatchObject({ id: firstJob, organization_id: f.org, contact_id: f.contact, kind: "transactional_delivery", status: "done" });
    await page.goto(`/app/inbox/${f.conversation}`);
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await db.from("conversations").select("status").eq("id", f.conversation).single()).data
            ?.status,
      )
      .toBe("closed");
    await inbound(f, "Voltei, envie o link da reunião novamente");
    await expect
      .poll(
        async () =>
          (await db.from("conversations").select("status").eq("id", f.conversation).single()).data
            ?.status,
      )
      .not.toBe("closed");
    expect((await row(f, id)).meeting_delivery).toEqual(original);
    await detail(page, id);
    await expect(meet(page).getByRole("button", { name: "Enviar link ao cliente" })).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, info, "reopened-mobile", "Enviar link ao cliente");
    const beforeResend = await row(f, id);
    const resentRequest = await action(page, "Enviar link ao cliente", "deliver");
    expect(resentRequest.revision).toBe(String(beforeResend.revision));
    expect((await row(f, id)).meeting_delivery.generation).not.toBe(original.generation);
    expect(await deliver(f, id, pool)).not.toBe(firstJob);
    expect(channel.bodies).toHaveLength(2);
    expect(channel.bodies[1]).toMatchObject({ session: f.sessionName, chatId: "15551234567@c.us" });
    expect(channel.bodies[1]!.text).toContain(link);
    expect(
      (
        await pool.query("select * from send_ledger where organization_id=$1 and job_id=$2", [
          f.org,
          firstJob,
        ])
      ).rows,
    ).toEqual(oldLedger);
    expect((await pool.query("select * from job_queue where organization_id=$1 and id=$2", [f.org, firstJob])).rows).toEqual(oldJob);
    await detail(page, id);
    await expect(meet(page).getByRole("button", { name: "Link já enviado" })).toBeDisabled();
    expect(google.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  } finally {
    await page.close();
    await close(google.server);
    await close(channel.server);
    await pool.end();
  }
});
test("falha chega à Central, navegação conserva aviso e retry humano mantém identidade do evento", async ({
  page,
}, info) => {
  const f = await fixture(),
    google = await googleReceiver();
  try {
    const id = await book(page, f);
    expect(await google.run(f, id)).toBe("processed");
    const pending = await row(f, id);
    google.state("failure");
    await pollGoogle(f, id, google);
    await page.goto("/app/ai/inbox");
    // A Central resolve o destino no servidor e não liquida o aviso ao navegar.
    const destination = page.getByRole("link", { name: "Abrir compromisso", exact: true });
    await expect(destination).toHaveAttribute("href", `/app/agenda?compromisso=${id}`);
    await destination.click();
    await expect(
      meet(page).getByText("O Google não conseguiu criar o link. Tente criar novamente."),
    ).toBeVisible();
    const notices = await db
      .from("agent_inbox_items")
      .select("status")
      .eq("organization_id", f.org)
      .eq("ref_id", id);
    expect(notices.error).toBeNull();
    expect(notices.data?.some((n) => n.status === "open")).toBe(true);
    await capture(page, info, "failure-desktop", "Tentar criar link novamente");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, info, "failure-mobile", "Tentar criar link novamente");
    const beforeRetry = await row(f, id);
    const request = await action(page, "Tentar criar link novamente", "retry");
    expect(request.revision).toBe(String(beforeRetry.revision));
    expect(request.request_id).toBe(pending.meeting_request_id);
    const retry = await row(f, id);
    expect(retry.meeting_request_id).not.toBe(pending.meeting_request_id);
    expect(retry.google_event_id).toBe(pending.google_event_id);
    expect(await google.run(f, id)).toBe("processed");
    expect(google.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    google.state("success");
    await pollGoogle(f, id, google);
    await detail(page, id);
    await expect(meet(page).getByRole("link", { name: "Abrir reunião" })).toHaveAttribute(
      "href",
      link,
    );
    await capture(page, info, "retry-ready-mobile", "Enviar link ao cliente");
    expect((await row(f, id)).meeting_delivery.state).toBe("none");
  } finally {
    await page.close();
    await close(google.server);
  }
});
