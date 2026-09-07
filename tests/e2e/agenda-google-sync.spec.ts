import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { reconcileAppointment } from "../../lib/agenda/google/sync-executor";
import { googlePushCandidates } from "../../lib/agenda/google/candidates";
import { irParaASemanaSeguinte, irParaASemanaDoCompromisso } from "./helpers/agenda-semana-integra";
import type { EventoDoGoogle } from "../../lib/agenda/google/evento";
const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;
const orgs: string[] = [],
  users: string[] = [];
test.use({ trace: "on", timezoneId: "America/Sao_Paulo" });
test.describe.configure({ timeout: 120000 });
async function insert(table: string, value: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw error;
  return data.id as string;
}
async function fixture() {
  const email = `sync-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error;
  const user = data.user.id;
  users.push(user);
  const org = await insert("organizations", {
    slug: `sync-${randomUUID()}`,
    display_name: "Agendas locais",
    legal_name: "Agendas locais",
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
  const second = await insert("calendar_connections", {
    organization_id: org,
    user_id: user,
    provider: "google_calendar",
    account_email: `second-${email}`,
    status: "healthy",
  });
  const primary = await insert("calendar_connection_calendars", {
    organization_id: org,
    connection_id: connection,
    external_calendar_id: "original-calendar",
    name: "Principal local",
    is_primary: true,
    is_destination: true,
    counts_for_conflicts: true,
    access_role: "owner",
    time_zone: "America/Sao_Paulo",
  });
  const destination = await insert("calendar_connection_calendars", {
    organization_id: org,
    connection_id: second,
    external_calendar_id: "new-calendar",
    name: "Destino secundário",
    is_destination: false,
    counts_for_conflicts: false,
    access_role: "writer",
    time_zone: "America/Sao_Paulo",
  });
  const readonly = await insert("calendar_connection_calendars", {
    organization_id: org,
    connection_id: second,
    external_calendar_id: "read-only",
    name: "Agenda de leitura",
    is_destination: false,
    counts_for_conflicts: true,
    access_role: "reader",
    time_zone: "America/Sao_Paulo",
  });
  const type = await insert("calendar_event_types", {
    organization_id: org,
    name: "Consulta Google",
    slug: "google",
    duration_minutes: 60,
    minimum_notice_minutes: 0,
    booking_window_days: 90,
    default_owner_user_id: user,
    is_active: true,
  });
  const availability = await db.from("attendant_availability").upsert(
    {
      organization_id: org,
      user_id: user,
      is_available: true,
      schedule: {
        timezone: "America/Sao_Paulo",
        windows: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "00:00", end: "23:59" })),
      },
    },
    { onConflict: "organization_id,user_id" },
  );
  if (availability.error) throw availability.error;
  return { org, user, email, connection, second, primary, destination, readonly, type };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60000 });
}
async function saveCalendars(page: Page) {
  const section = page.getByRole("region", { name: "Suas agendas Google" });
  await expect(section.getByRole("button", { name: "Descartar alterações" })).toBeVisible();
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/agenda/google/calendarios" &&
        r.request().method() === "PATCH",
    ),
    section.getByRole("button", { name: "Salvar agendas" }).click(),
  ]);
  expect(response.status()).toBe(200);
  // Salvar fica desabilitado também durante busy. O fim do draft e os
  // controles liberados comprovam que o refetch da seleção terminou.
  await expect(section.getByRole("button", { name: "Descartar alterações" })).toHaveCount(0);
  await expect(
    section.getByRole("button", { name: "Atualizar lista e sincronização" }).first(),
  ).toBeEnabled();
  await expect(section.getByRole("button", { name: "Salvar agendas" })).toBeDisabled();
}
async function evidence(
  page: Page,
  info: TestInfo,
  name: string,
  selector: string,
  controlSelector?: string,
) {
  const dir = info.outputPath(name);
  mkdirSync(dir, { recursive: true });
  let control;
  if (controlSelector) {
    const locator = page.locator(controlSelector);
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeInViewport({ ratio: 1 });
    control = await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        viewportHeight: document.documentElement.clientHeight,
        visibility: getComputedStyle(el).visibility,
      };
    });
  }
  const measured = await page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      width: r.width,
      viewport: document.documentElement.clientWidth,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      visibility: getComputedStyle(el).visibility,
    };
  });
  expect(measured.left).toBeGreaterThanOrEqual(0);
  expect(measured.right).toBeLessThanOrEqual(measured.viewport + 1);
  expect(measured.width).toBeGreaterThan(200);
  expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth + 1);
  expect(measured.visibility).toBe("visible");
  writeFileSync(`${dir}/measures.json`, JSON.stringify({ ...measured, control }, null, 2));
  await page.screenshot({ path: `${dir}/loaded.png`, fullPage: true });
}
async function detail(page: Page, id: string) {
  await page.goto(`/app/agenda?compromisso=${id}`);
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Consulta sincronizada", exact: true }),
  ).toBeVisible();
}
async function row(f: Fixture, id: string) {
  const { data, error } = await db
    .from("calendar_appointments")
    .select("*")
    .eq("organization_id", f.org)
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}
async function candidates() {
  const { data, error } = await googlePushCandidates(db);
  if (error) throw error;
  return data ?? [];
}
async function seedAppointment(f: Fixture) {
  return insert("calendar_appointments", {
    organization_id: f.org,
    event_type_id: f.type,
    owner_user_id: f.user,
    title: "Consulta sincronizada",
    status: "confirmed",
    starts_at: new Date(Date.now() + 86400000).toISOString(),
    ends_at: new Date(Date.now() + 90000000).toISOString(),
    time_zone: "America/Sao_Paulo",
  });
}
test.afterAll(async () => {
  for (const org of orgs) await db.from("organizations").delete().eq("id", org);
  for (const id of users) await db.auth.admin.deleteUser(id);
});
test("fontes e destino entre duas contas, somente leitura e ocupação imediatamente removida", async ({
  page,
}, info) => {
  const f = await fixture();
  await login(page, f.email);
  await page.goto("/app/agenda");
  const days = await irParaASemanaSeguinte(page);
  const day = days[2]!;
  const start = new Date(`${day}T10:00:00-03:00`).toISOString();
  const end = new Date(`${day}T11:00:00-03:00`).toISOString();
  const block = page.getByTestId(`bloco-${day}-10:00`);
  await expect(block).toBeEnabled({ timeout: 20000 });
  const externalId = await insert("calendar_external_events", {
    organization_id: f.org,
    connection_id: f.connection,
    external_calendar_id: "original-calendar",
    external_event_id: "occupied",
    starts_at: start,
    ends_at: end,
    status: "confirmed",
    transparency: "opaque",
  });
  await page.goto("/app/agenda");
  await irParaASemanaDoCompromisso(page, start);
  const card = page.getByTestId(`agendamento-${externalId}`);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await expect(block).toBeDisabled();
  await expect(block).toHaveAttribute("aria-label", /já há um compromisso/i);
  await evidence(page, info, "fonte-ocupada-grade", "[data-testid='grade-da-agenda']");
  // O painel também mostra disponibilidade: 12h permanece, 10h está ausente.
  await page.getByTestId(`bloco-${day}-12:00`).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible();
  await expect(page.getByTestId("horario-12:00")).toBeVisible();
  await expect(page.getByTestId("confirmacao")).toContainText("12:00");
  await expect(page.getByTestId("horario-10:00")).toHaveCount(0);
  await evidence(
    page,
    info,
    "fonte-ocupada-horarios",
    "[data-testid='painel-de-marcacao']",
    "[data-testid='horario-12:00']",
  );
  const occupiedUrl = `/api/v1/agenda/agendamentos?de=${encodeURIComponent(start)}&ate=${encodeURIComponent(end)}&owner_user_id=${f.user}`;
  const before = await page.request.get(occupiedUrl);
  expect(before.ok()).toBe(true);
  expect((await before.json()).data.some((item: { id: string }) => item.id === externalId)).toBe(
    true,
  );
  await page.goto("/app/settings/tenant/agenda");
  const section = page.getByRole("region", { name: "Suas agendas Google" });
  await expect(section.getByText("Principal local", { exact: true })).toBeVisible();
  const reader = section
    .locator("div.rounded-md")
    .filter({ has: page.getByText("Agenda de leitura", { exact: true }) });
  await expect(reader.getByRole("radio")).toBeDisabled();
  const target = section
    .locator("div.rounded-md")
    .filter({ has: page.getByText("Destino secundário", { exact: true }) });
  await target.getByRole("radio").check();
  const primary = section
    .locator("div.rounded-md")
    .filter({ has: page.getByText("Principal local", { exact: true }) });
  await primary.getByRole("checkbox").uncheck();
  await saveCalendars(page);
  await expect(target.getByRole("radio")).toBeChecked();
  await expect(primary.getByRole("checkbox")).not.toBeChecked();
  await expect(reader.getByRole("radio")).toBeDisabled();
  const catalog = await page.request.get("/api/v1/agenda/google/calendarios");
  expect(catalog.ok()).toBe(true);
  const state = (await catalog.json()).data;
  expect(
    state.calendars
      .filter((c: { is_destination: boolean }) => c.is_destination)
      .map((c: { id: string }) => c.id),
  ).toEqual([f.destination]);
  const occupied = await page.request.get(
    `/api/v1/agenda/agendamentos?de=${encodeURIComponent(start)}&ate=${encodeURIComponent(end)}&owner_user_id=${f.user}`,
  );
  expect(occupied.ok()).toBe(true);
  expect((await occupied.json()).data.some((item: { id: string }) => item.id === externalId)).toBe(
    false,
  );
  const cache = await db.from("calendar_external_events").select("id").eq("organization_id", f.org);
  expect(cache.data).toHaveLength(1);
  await evidence(page, info, "selecao", "section[aria-label='Suas agendas Google']");
  await page.setViewportSize({ width: 390, height: 844 });
  await evidence(page, info, "selecao-mobile", "section[aria-label='Suas agendas Google']");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app/agenda");
  await irParaASemanaDoCompromisso(page, start);
  await expect(card).toHaveCount(0);
  await block.scrollIntoViewIfNeeded();
  await expect(block).toBeVisible();
  await expect(block).toBeEnabled();
  await expect(block).toHaveAttribute("aria-label", /Marcar às 10:00/);
  await evidence(page, info, "fonte-retirada-grade", "[data-testid='grade-da-agenda']");
  await block.click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible();
  await expect(page.getByTestId("horario-10:00")).toBeVisible();
  await expect(page.getByTestId("confirmacao")).toContainText("10:00");
  await expect(page.getByTestId("horario-12:00")).toBeAttached();
  await evidence(
    page,
    info,
    "fonte-retirada-horarios",
    "[data-testid='painel-de-marcacao']",
    "[data-testid='horario-12:00']",
  );
});
test("retry pela tela usa filtro PostgREST real; conflito exige escolha e conserva identidade antiga", async ({
  page,
}, info) => {
  const f = await fixture(),
    id = await seedAppointment(f);
  let remote: EventoDoGoogle | null = null,
    version = 0;
  const requests: Array<{
    method: string;
    path: string;
    body: Record<string, unknown> | null;
    ifMatch: string | undefined;
  }> = [];
  let server: Server | undefined;
  try {
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = raw ? JSON.parse(raw) : null;
      requests.push({
        method: req.method!,
        path: req.url!,
        body,
        ifMatch: req.headers["if-match"],
      });
      res.setHeader("content-type", "application/json");
      if (!req.url?.includes("/events")) {
        res.end("{}");
        return;
      }
      if (req.method === "GET") {
        res.statusCode = remote ? 200 : 404;
        res.end(JSON.stringify(remote ?? {}));
        return;
      }
      if (req.method === "POST") {
        if (remote) {
          res.statusCode = 409;
          res.end("{}");
          return;
        }
        remote = { ...body, etag: `"v${++version}"` };
      } else if (req.method === "PATCH") {
        if (!remote || req.headers["if-match"] !== remote.etag) {
          res.statusCode = 412;
          res.end("{}");
          return;
        }
        remote = { ...remote, ...body, etag: `"v${++version}"` };
      } else {
        res.statusCode = 405;
        res.end("{}");
        return;
      }
      res.end(JSON.stringify(remote));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("receiver");
    const base = `http://127.0.0.1:${address.port}`;
    const transport: typeof fetch = (url, init) => {
      const parsed = new URL(String(url));
      return fetch(`${base}${parsed.pathname}${parsed.search}`, init);
    };
    const run = () =>
      reconcileAppointment(db, f.org, id, { token: "local-receiver-only", transport });
    // Cinquenta identidades preservadas pela LGPD não podem ocupar o lote
    // antes de o retry saudável passar pelo filtro PostgREST real.
    const redacted = await insert("contacts", { organization_id: f.org, display_name: "Titular" });
    const oldLinks = await db.from("calendar_appointments").insert(
      Array.from({ length: 50 }, (_, n) => ({
        organization_id: f.org,
        contact_id: redacted,
        owner_user_id: f.user,
        title: "Histórico",
        status: "confirmed",
        starts_at: new Date(Date.now() + (30 + n) * 86400000).toISOString(),
        ends_at: new Date(Date.now() + (30 + n) * 86400000 + 3600000).toISOString(),
        google_connection_id: f.connection,
        google_calendar_id: "original-calendar",
        google_event_id: `legacy-${n}`,
        google_next_attempt_at: "2000-01-01T00:00:00Z",
      })),
    );
    if (oldLinks.error) throw oldLinks.error;
    const redact = await db
      .from("contacts")
      .update({ is_anonymized: true, anonymized_at: new Date().toISOString() })
      .eq("organization_id", f.org)
      .eq("id", redacted);
    if (redact.error) throw redact.error;
    const delayed = await db
      .from("calendar_appointments")
      .update({
        google_sync_error: "Conexão indisponível. Tente novamente.",
        google_next_attempt_at: new Date(Date.now() + 3600000).toISOString(),
      })
      .eq("organization_id", f.org)
      .eq("id", id);
    if (delayed.error) throw delayed.error;
    expect((await candidates()).some((a) => a.id === id)).toBe(false);
    await login(page, f.email);
    await detail(page, id);
    await page.getByRole("button", { name: "Tentar sincronizar novamente" }).click();
    await expect.poll(async () => (await candidates()).some((a) => a.id === id)).toBe(true);
    expect(await run()).toBe("processed");
    const published = await row(f, id);
    expect(published.google_calendar_id).toBe("original-calendar");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    await detail(page, id);
    await expect(page.getByText("Alterações sincronizadas.")).toBeVisible();
    await evidence(page, info, "publicado", "[role='dialog']");
    await page.goto("/app/settings/tenant/agenda");
    const settings = page.getByRole("region", { name: "Suas agendas Google" });
    await settings
      .locator("div.rounded-md")
      .filter({ has: page.getByText("Destino secundário", { exact: true }) })
      .getByRole("radio")
      .check();
    await saveCalendars(page);
    const catalog = await page.request.get("/api/v1/agenda/google/calendarios");
    expect(catalog.status()).toBe(200);
    expect(
      (await catalog.json()).data.calendars
        .filter((c: { is_destination: boolean }) => c.is_destination)
        .map((c: { id: string }) => c.id),
    ).toEqual([f.destination]);
    expect((await row(f, id)).google_calendar_id).toBe("original-calendar");
    // Alteração remota e intenção local divergentes exercitam comparação real;
    // a decisão que a resolve é exclusivamente feita pela tela abaixo.
    const snapshot = await row(f, id);
    const from = Date.now() + 2 * 86400000;
    const query = new URLSearchParams({
      event_type_id: f.type,
      owner_user_id: f.user,
      de: new Date(from).toISOString(),
      ate: new Date(from + 86400000).toISOString(),
    });
    const available = await page.request.get(`/api/v1/agenda/horarios-livres?${query}`);
    expect(available.status()).toBe(200);
    const slots: Array<{ inicio: string; fim: string }> = (await available.json()).data.slots;
    expect(slots.length).toBeGreaterThan(0);
    const slot = slots[0]!;
    const changed = await page.request.patch("/api/v1/agenda/agendamentos", {
      data: {
        id,
        revision: snapshot.revision,
        starts_at: slot.inicio,
        ends_at: slot.fim,
      },
    });
    expect(changed.status()).toBe(200);
    remote = {
      ...remote!,
      start: {
        dateTime: new Date(Date.now() + 3 * 86400000).toISOString(),
        timeZone: "America/Sao_Paulo",
      },
      end: {
        dateTime: new Date(Date.now() + 3 * 86400000 + 3600000).toISOString(),
        timeZone: "America/Sao_Paulo",
      },
      summary: "Título preservado no Google",
      etag: `"v${++version}"`,
    };
    expect(await run()).toBe("processed");
    await detail(page, id);
    await expect(
      page.getByText("Este compromisso precisa de uma decisão de sincronização."),
    ).toBeVisible();
    await evidence(page, info, "conflito", "[role='dialog']");
    const before = requests.filter((r) => r.method === "PATCH").length;
    await page.getByRole("button", { name: "Usar horário do Google" }).click();
    await expect
      .poll(async () => Boolean((await row(f, id)).google_conflict?.resolution))
      .toBe(true);
    expect(await run()).toBe("processed");
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(before);
    const resolved = await row(f, id);
    expect(Date.parse(resolved.starts_at)).toBe(Date.parse(remote.start!.dateTime!));
    expect(resolved.title).toBe("Consulta sincronizada");
    expect(resolved.google_event_id).toBe(published.google_event_id);
    expect(resolved.google_connection_id).toBe(published.google_connection_id);
    expect(resolved.google_calendar_id).toBe("original-calendar");
    await detail(page, id);
    await expect(page.getByText("Alterações sincronizadas.")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await evidence(page, info, "resolvido-mobile", "[role='dialog']");
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((e) => (e ? reject(e) : resolve())),
      );
  }
});
