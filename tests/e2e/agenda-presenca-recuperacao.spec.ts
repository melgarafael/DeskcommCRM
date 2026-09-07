import pg from "pg";
import { sendTurnMessage } from "../../lib/agent-engine/edge/crm/send-message";
import { completeTurnForEnrollment, createPgAdminClient } from "../../lib/followup/turn-bridge";
import { claimOfJob } from "../../lib/agent-engine/queue/claim";
import { completeJob } from "../../lib/agent-engine/queue/queue";
import { protecaoAgendaPg, protecaoAgendaSupabase } from "../../lib/agenda/protecao-followup";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { escolherDiaDesenhado, irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";
import { enviarTextoFixoPendente } from "../../lib/followup/enviar-texto-fixo";
const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;
test.use({ trace: "on" });
test.describe.configure({ timeout: 180_000 });
const orgs: string[] = [],
  users: string[] = [];
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
  const email = `presenca-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error;
  const user = data.user.id;
  users.push(user);
  const org = await insert("organizations", {
    slug: `presenca-${randomUUID()}`,
    display_name: "Agenda local",
    legal_name: "Agenda local",
    onboarded_at: new Date().toISOString(),
  });
  orgs.push(org);
  await insert("user_organizations", {
    organization_id: org,
    user_id: user,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  const session = await insert("channel_sessions", {
    organization_id: org,
    waha_session_name: randomUUID(),
    display_name: "Canal de teste",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  const type = await insert("calendar_event_types", {
    organization_id: org,
    name: "Consulta de presença",
    slug: "consulta-presenca",
    duration_minutes: 30,
    minimum_notice_minutes: 60,
    booking_window_days: 60,
    is_active: true,
    default_owner_user_id: user,
  });
  const availability = await db.from("attendant_availability").upsert(
    {
      organization_id: org,
      user_id: user,
      is_available: true,
      schedule: {
        timezone: "America/Sao_Paulo",
        windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "09:00", end: "18:00" })),
      },
    },
    { onConflict: "organization_id,user_id" },
  );
  if (availability.error) throw availability.error;
  return { org, user, email, session, type };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function person(f: Fixture, name = "Cliente Presença") {
  const contact = await insert("contacts", {
    organization_id: f.org,
    name,
    display_name: name,
    phone_number: `+55119${randomInt(10000000, 99999999)}`,
  });
  const conversation = await insert("conversations", {
    organization_id: f.org,
    contact_id: contact,
    channel_session_id: f.session,
    status: "open",
    assigned_to_user_id: f.user,
  });
  return { contact, conversation };
}
async function appointment(
  f: Fixture,
  p: Awaited<ReturnType<typeof person>>,
  title: string,
  hoursAgo = 2,
) {
  return insert("calendar_appointments", {
    organization_id: f.org,
    contact_id: p.contact,
    conversation_id: p.conversation,
    event_type_id: f.type,
    owner_user_id: f.user,
    title,
    status: "confirmed",
    starts_at: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
    ends_at: new Date(Date.now() - (hoursAgo - 0.5) * 3600000).toISOString(),
  });
}
async function inbound(
  f: Fixture,
  p: Awaited<ReturnType<typeof person>>,
  body: string,
  at = new Date().toISOString(),
) {
  return insert("messages", {
    organization_id: f.org,
    contact_id: p.contact,
    conversation_id: p.conversation,
    channel_session_id: f.session,
    direction: "inbound",
    type: "text",
    body,
    status: "received",
    sent_via: "ai",
    sent_at: at,
    external_id: randomUUID(),
  });
}
async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60000 });
}
async function detail(page: Page, id: string, title: string) {
  await page.goto(`/app/agenda?compromisso=${id}`);
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}
async function evidence(page: Page, info: TestInfo, name: string) {
  const directory = info.outputPath(name);
  mkdirSync(directory, { recursive: true });
  const measured = await page.getByRole("dialog").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      width: r.width,
      viewport: document.documentElement.clientWidth,
      visibility: getComputedStyle(el).visibility,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });
  expect(measured.width).toBeGreaterThan(200);
  expect(measured.left).toBeGreaterThanOrEqual(0);
  expect(measured.right).toBeLessThanOrEqual(measured.viewport + 1);
  expect(measured.visibility).toBe("visible");
  expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth + 1);
  writeFileSync(`${directory}/measures.json`, JSON.stringify(measured, null, 2));
  await page.screenshot({ path: `${directory}/loaded.png`, fullPage: true });
}
async function recover(f: Fixture, id: string) {
  await expect
    .poll(async () => {
      const found = await db
        .from("event_log")
        .select("id")
        .eq("organization_id", f.org)
        .eq("entity_id", id)
        .eq("event_type", "appointment.outcome_confirmed");
      if (found.error) throw found.error;
      return found.data.length;
    })
    .toBe(1);
  const e = await db
    .from("event_log")
    .select("id")
    .eq("organization_id", f.org)
    .eq("entity_id", id)
    .eq("event_type", "appointment.outcome_confirmed")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (e.error) throw e.error;
  return rpc("fn_appointment_recover", { p_org: f.org, p_event: e.data.id });
}
async function runCron(page: Page, endpoint: "followup-flow-worker" | "event-log-drain") {
  const secret = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!secret) throw new Error("QA precisa da credencial local do cron.");
  const response = await page.request.post(`/api/v1/cron/${endpoint}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(response.status()).toBe(200);
}
async function flow(f: Fixture) {
  const graph = {
    nodes: [
      { id: "t", type: "trigger", label: "Falta", position: { x: 0, y: 0 }, config: {} },
      {
        id: "send",
        type: "action",
        label: "Propor novo horário",
        position: { x: 0, y: 150 },
        config: { mode: "text", body: "Podemos escolher um novo horário?" },
      },
      {
        id: "end",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 300 },
        config: { outcome: "converted" },
      },
    ],
    edges: [
      { id: "ts", source: "t", target: "send", priority: 0, condition: { type: "always" } },
      { id: "se", source: "send", target: "end", priority: 0, condition: { type: "always" } },
    ],
  };
  const version = await insert("followup_flow_versions", { organization_id: f.org, graph });
  const pointer = await insert("followup_flow_pointers", {
    organization_id: f.org,
    name: "Recuperar consulta",
    status: "active",
    active_version_id: version,
    trigger_config: { kind: "manual", cancel_on_reply: true },
  });
  const agent = await insert("ai_agents", {
    organization_id: f.org,
    name: "Assistente de recuperação",
    system_prompt: "Ajude a remarcar.",
  });
  await insert("ai_agent_versions", {
    organization_id: f.org,
    agent_id: agent,
    version_number: 1,
    system_prompt: "Ajude a remarcar.",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    channel_session_id: f.session,
    status: "published",
    followup: { enabled: true, flow_pointer_ids: [pointer] },
  });
  return pointer;
}
test.afterAll(async () => {
  // Contextos do runner encerrados antes da remoção das fixtures.
  for (const org of orgs) {
    const r = await db.from("organizations").delete().eq("id", org);
    if (r.error) throw r.error;
  }
  // A fixture de suporte concede a si própria o papel; granted_by é RESTRICT.
  // Remover só grants dos usuários desta spec antes de excluir o Auth.
  if (users.length) {
    const grants = await db.from("platform_admins").delete().in("user_id", users);
    if (grants.error) throw grants.error;
  }
  for (const user of users) {
    const r = await db.auth.admin.deleteUser(user);
    if (r.error) throw r.error;
  }
});

test("Inbox marca cliente/conversa; detalhe antigo confirma presença com evidência e snooze", async ({
  page,
}, info) => {
  const f = await fixture(),
    p = await person(f);
  await inbound(f, p, "Preciso marcar uma consulta");
  await login(page, f.email);
  await page.goto(`/app/inbox/${p.conversation}`);
  await page.getByRole("link", { name: "Marcar compromisso", exact: true }).click();
  const panel = page.getByTestId("painel-de-marcacao");
  await expect(panel).toBeVisible();
  await expect(page.getByLabel("Quem será atendido")).toHaveValue(p.contact);
  await expect(page.getByLabel("Conversa vinculada (opcional)")).toHaveValue(p.conversation);
  // Fecha o painel para navegar a grade; reabre pela mesma entrada contextual.
  await page.keyboard.press("Escape");
  const days = await irParaASemanaSeguinte(page);
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await page.getByRole("button", { name: /^Consulta de presença/ }).click();
  await escolherDiaDesenhado(page, days);
  await page.locator('[data-testid^="horario-"]').first().click();
  const posted = page.waitForResponse(
    (r) => r.url().includes("/api/v1/agenda/agendamentos") && r.request().method() === "POST",
  );
  await page.getByTestId("confirmar-marcacao").click();
  const response = await posted;
  expect(response.ok()).toBe(true);
  const created = (await response.json()).data;
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible();
  const bound = await db
    .from("calendar_appointments")
    .select("contact_id,conversation_id")
    .eq("organization_id", f.org)
    .eq("id", created.id)
    .single();
  expect(bound.data).toMatchObject({ contact_id: p.contact, conversation_id: p.conversation });
  await detail(page, created.id, "Consulta de presença");
  await expect(page.getByRole("button", { name: "Faltou", exact: true })).toBeDisabled();
  const past = await appointment(f, p, "Consulta da semana anterior", 24 * 8);
  await runCron(page, "followup-flow-worker");
  await page.goto("/app/ai/inbox");
  const notice = page.getByTestId("inbox-item").filter({ hasText: "Consulta da semana anterior" });
  await expect(notice).toBeVisible();
  await notice.getByRole("link", { name: "Abrir compromisso" }).click();
  await expect(page).toHaveURL(new RegExp(`compromisso=${past}`));
  await page.getByRole("button", { name: "Lembrar em uma hora" }).click();
  await expect
    .poll(
      async () =>
        (
          await db
            .from("agent_inbox_items")
            .select("status")
            .eq("organization_id", f.org)
            .eq("ref_id", past)
            .single()
        ).data?.status,
    )
    .toBe("resolved");
  const msg = await inbound(f, p, "Compareci à consulta, obrigado.");
  await page.reload();
  await page.getByLabel("Mensagem de evidência").selectOption(msg);
  await page.getByRole("button", { name: "Compareceu", exact: true }).click();
  await expect(page.getByText("Presença registrada pela equipe", { exact: false })).toBeVisible();
  const outcome = await db
    .from("calendar_appointments")
    .select("status,outcome_user_id,outcome_message_id")
    .eq("organization_id", f.org)
    .eq("id", past)
    .single();
  expect(outcome.data).toEqual({
    status: "completed",
    outcome_user_id: f.user,
    outcome_message_id: msg,
  });
  await evidence(page, info, "presenca-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await evidence(page, info, "presenca-mobile");
});

test.describe("datas do compromisso seguem idioma e fuso próprios", () => {
  test.use({ locale: "en-US", timezoneId: "Pacific/Honolulu" });

  test("PT e ES preservam a virada de dia e o instante da presença", async ({ page }, info) => {
    const f = await fixture(),
      p = await person(f);
    // 23h30 de 29/08 até 00h30 de 30/08 em São Paulo. No navegador,
    // os dois instantes ainda são 29/08, às 16h30 e 17h30 respectivamente.
    const starts = "2026-08-30T02:30:00.000Z",
      ends = "2026-08-30T03:30:00.000Z";
    const id = await insert("calendar_appointments", {
      organization_id: f.org,
      contact_id: p.contact,
      conversation_id: p.conversation,
      event_type_id: f.type,
      owner_user_id: f.user,
      title: "Consulta atravessa meia-noite",
      status: "confirmed",
      starts_at: starts,
      ends_at: ends,
      time_zone: "America/Sao_Paulo",
    });
    await login(page, f.email);
    const loaded = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/v1/agenda/agendamentos/${id}`) && r.request().method() === "GET",
    );
    await detail(page, id, "Consulta atravessa meia-noite");
    const response = await loaded;
    expect(response.ok()).toBe(true);
    expect((await response.json()).data.time_zone).toBe("America/Sao_Paulo");
    expect(
      await page.evaluate(
        ({ starts, ends }) => ({
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          start: [
            new Date(starts).getDate(),
            new Date(starts).getHours(),
            new Date(starts).getMinutes(),
          ],
          end: [new Date(ends).getDate(), new Date(ends).getHours(), new Date(ends).getMinutes()],
        }),
        { starts, ends },
      ),
    ).toEqual({
      locale: "en-US",
      timeZone: "Pacific/Honolulu",
      start: [29, 16, 30],
      end: [29, 17, 30],
    });
    await expect(page.getByTestId("compromisso-horario")).toHaveText(
      "29 de ago. de 2026, 23:30 – 30 de ago. de 2026, 00:30",
    );
    const confirmed = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/agenda/agendamentos") && r.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Compareceu", exact: true }).click();
    expect((await confirmed).ok()).toBe(true);
    const outcome = await db
      .from("calendar_appointments")
      .select("starts_at,ends_at,time_zone,outcome_recorded_at,outcome_user_id,revision")
      .eq("organization_id", f.org)
      .eq("id", id)
      .single();
    if (outcome.error) throw outcome.error;
    expect(outcome.data.outcome_user_id).toBe(f.user);
    expect(outcome.data.revision).toBe(2);
    // Oráculo independente do formatter: UTC−3 no calendário moderno de São Paulo.
    const recorded = new Date(Date.parse(outcome.data.outcome_recorded_at) - 3 * 3600000);
    const day = recorded.getUTCDate(),
      year = recorded.getUTCFullYear();
    const hour = recorded.getUTCHours(),
      minute = String(recorded.getUTCMinutes()).padStart(2, "0");
    for (const locale of ["pt-BR", "es"] as const) {
      if (locale === "es") {
        await page.keyboard.press("Escape");
        await page.getByTestId("seletor-de-idioma").click();
        const reload = page.waitForEvent("load");
        await page.getByTestId("idioma-es").click();
        await reload;
        await expect(page.getByTestId("seletor-de-idioma")).toHaveText("ES");
        await detail(page, id, "Consulta atravessa meia-noite");
        await expect(page.getByTestId("compromisso-horario")).toHaveText(
          "29 ago 2026, 23:30 – 30 ago 2026, 0:30",
        );
      }
      const label =
        locale === "es" ? "Asistencia registrada por el equipo" : "Presença registrada pela equipe";
      await expect(page.getByRole("dialog").getByText(new RegExp(`^${label}:`))).toHaveText(
        new RegExp(`^${label}: ${day}\\b.*\\b${year}, 0?${hour}:${minute}$`),
      );
      await evidence(page, info, `datas-${locale}-desktop`);
      await page.setViewportSize({ width: 390, height: 844 });
      await evidence(page, info, `datas-${locale}-mobile`);
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    const preserved = await db
      .from("calendar_appointments")
      .select("starts_at,ends_at,time_zone,outcome_recorded_at,outcome_user_id,revision")
      .eq("organization_id", f.org)
      .eq("id", id)
      .single();
    if (preserved.error) throw preserved.error;
    expect(preserved.data).toEqual(outcome.data);
    expect(new Date(preserved.data.starts_at).toISOString()).toBe(starts);
    expect(new Date(preserved.data.ends_at).toISOString()).toBe(ends);
  });
});

test("gestão configura prazos e gatilho; falta inicia uma vez e resposta interrompe", async ({
  page,
}) => {
  const f = await fixture(),
    p = await person(f),
    pointer = await flow(f);
  await inbound(f, p, "Quero uma consulta");
  await login(page, f.email);
  await page.goto("/app/settings/tenant/agenda");
  await page.getByLabel("Pedir confirmação após o fim (minutos)").fill("15");
  await page.getByLabel("Proteger de cobranças por silêncio após o fim (minutos)").fill("120");
  await page.getByRole("button", { name: "Salvar prazos" }).click();
  await expect(page.getByText("Prazos salvos.")).toBeVisible();
  expect(
    (await db.from("organizations").select("settings").eq("id", f.org).single()).data?.settings
      .agenda,
  ).toEqual({ confirmation_delay_minutes: 15, unknown_protection_minutes: 120 });
  await page.goto(`/app/ai/followups/${pointer}`);
  await page.getByTestId("trigger-config-button").click();
  await page.getByLabel("Tipo de gatilho").click();
  await page.getByRole("option", { name: "Falta confirmada pela equipe", exact: true }).click();
  const savedTrigger = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/ai/followup-flows/${pointer}`) &&
      response.request().method() === "PATCH",
  );
  await page
    .getByTestId("trigger-config-panel")
    .getByRole("button", { name: /Salvar/ })
    .click();
  expect((await savedTrigger).status()).toBe(200);
  expect(
    (
      await db
        .from("followup_flow_pointers")
        .select("trigger_config")
        .eq("organization_id", f.org)
        .eq("id", pointer)
        .single()
    ).data?.trigger_config.kind,
  ).toBe("appointment_no_show");
  const id = await appointment(f, p, "Consulta com recuperação");
  await detail(page, id, "Consulta com recuperação");
  await page.getByRole("button", { name: "Faltou", exact: true }).click();
  // A jornada prova o produtor e o consumer registrado pelo endpoint real.
  // A RPC direta abaixo só testa replay DEPOIS de o drain tomar a decisão.
  await expect
    .poll(
      async () =>
        (
          await db
            .from("event_log")
            .select("id")
            .eq("organization_id", f.org)
            .eq("entity_id", id)
            .eq("event_type", "appointment.outcome_confirmed")
        ).data?.length,
    )
    .toBe(1);
  const source = await db
    .from("event_log")
    .select("id,status")
    .eq("organization_id", f.org)
    .eq("entity_id", id)
    .eq("event_type", "appointment.outcome_confirmed")
    .single();
  if (source.error) throw source.error;
  expect(source.data.status).toBe("pending");
  expect(
    (
      await db
        .from("appointment_recovery_receipts")
        .select("appointment_id")
        .eq("organization_id", f.org)
        .eq("appointment_id", id)
    ).data,
  ).toEqual([]);
  await expect
    .poll(
      async () => {
        await runCron(page, "event-log-drain");
        const event = await db
          .from("event_log")
          .select("status")
          .eq("organization_id", f.org)
          .eq("id", source.data.id)
          .single();
        if (event.error) throw event.error;
        return event.data.status;
      },
      { timeout: 30000, intervals: [100, 250, 500] },
    )
    .toBe("done");
  const recovery = await db
    .from("appointment_recovery_receipts")
    .select("*")
    .eq("organization_id", f.org)
    .eq("appointment_id", id)
    .single();
  if (recovery.error) throw recovery.error;
  const receipt = recovery.data;
  expect(receipt.result).toBe("started");
  expect((await recover(f, id)).enrollment_id).toBe(receipt.enrollment_id);
  await expect(page.getByText("Recuperação iniciada", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole("link", { name: "Abrir acompanhamento" }).click();
  await expect(page).toHaveURL(new RegExp(receipt.enrollment_id));
  await inbound(f, p, "Quero remarcar para amanhã");
  await detail(page, id, "Consulta com recuperação");
  await expect(
    page.getByText("Recuperação iniciada e interrompida porque o cliente respondeu."),
  ).toBeVisible();
  expect(
    (
      await db
        .from("followup_enrollments")
        .select("status")
        .eq("id", receipt.enrollment_id)
        .eq("organization_id", f.org)
        .single()
    ).data?.status,
  ).toBe("cancelled");
});

test("falta sem configuração e contato ocupado deixam impedimento terminal visível", async ({
  page,
}) => {
  const f = await fixture(),
    p = await person(f);
  await inbound(f, p, "Consulta solicitada");
  await login(page, f.email);
  const first = await appointment(f, p, "Consulta sem fluxo");
  await detail(page, first, "Consulta sem fluxo");
  await page.getByRole("button", { name: "Faltou", exact: true }).click();
  expect((await recover(f, first)).result).toBe("not_configured");
  await expect(page.getByText(/Não iniciada: configure um fluxo/)).toBeVisible({ timeout: 10000 });
  const pointer = await flow(f);
  const configured = await db
    .from("followup_flow_pointers")
    .update({ trigger_config: { kind: "appointment_no_show", cancel_on_reply: false } })
    .eq("organization_id", f.org)
    .eq("id", pointer);
  if (configured.error) throw configured.error;
  const second = await appointment(f, p, "Primeira falta confirmada");
  await detail(page, second, "Primeira falta confirmada");
  await page.getByRole("button", { name: "Faltou", exact: true }).click();
  const running = await recover(f, second);
  expect(running.result).toBe("started");
  const third = await appointment(f, p, "Consulta com acompanhamento ativo");
  await detail(page, third, "Consulta com acompanhamento ativo");
  await page.getByRole("button", { name: "Faltou", exact: true }).click();
  expect((await recover(f, third)).result).toBe("other_flow");
  await expect(page.getByText("Não iniciada: outro acompanhamento já está ativo.")).toBeVisible({
    timeout: 10000,
  });
  const end = await db
    .from("followup_enrollments")
    .update({ status: "completed" })
    .eq("organization_id", f.org)
    .eq("id", running.enrollment_id);
  if (end.error) throw end.error;
  expect((await recover(f, third)).result).toBe("other_flow");
});

// A jornada acima usa o frontend; este caso adicional mede o transporte real e
// a corrida entre preparar a mensagem e executar beforeSend, sem simular resposta HTTP.
test("receiver reconcilia inline/daemon, barra claim antigo e protege agenda além de mil linhas", async ({
  page,
}) => {
  const f = await fixture(),
    p = await person(f),
    pointer = await flow(f);
  await inbound(f, p, "Podemos conversar sobre a consulta?");
  await login(page, f.email);
  const configured = await db
    .from("followup_flow_pointers")
    .update({ trigger_config: { kind: "appointment_no_show" } })
    .eq("organization_id", f.org)
    .eq("id", pointer);
  if (configured.error) throw configured.error;
  const hits: string[] = [];
  const receiver = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `test-${randomUUID()}` }));
  });
  const target = new URL(process.env.WAHA_API_BASE_URL!);
  expect(target.hostname).toBe("127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(Number(target.port), target.hostname, resolve);
  });
  const dbTarget = new URL(credentials.dbUrl);
  expect(["127.0.0.1", "localhost"].includes(dbTarget.hostname)).toBe(true);
  const pool = new pg.Pool({ connectionString: credentials.dbUrl, max: 3 });
  try {
    async function prepared(title: string) {
      const id = await appointment(f, p, title);
      await detail(page, id, title);
      await page.getByRole("button", { name: "Faltou", exact: true }).click();
      const r = await recover(f, id);
      expect(r.result).toBe("started");
      const updated = await db
        .from("followup_enrollments")
        // O tick grava send:1 e incrementa steps_taken antes de entregar o job.
        .update({ current_node_id: "send", steps_taken: 2 })
        .eq("organization_id", f.org)
        .eq("id", r.enrollment_id)
        .select("service_boundary")
        .single();
      if (updated.error) throw updated.error;
      await insert("followup_enrollment_events", {
        organization_id: f.org,
        enrollment_id: r.enrollment_id,
        node_id: "send",
        event_type: "turn_enqueued",
        idempotency_key: "send:1",
      });
      const job = await insert("job_queue", {
        organization_id: f.org,
        contact_id: p.contact,
        kind: "followup_turn",
        payload: {
          service_boundary: updated.data.service_boundary,
          followup_enrollment_id: r.enrollment_id,
          node_id: "send",
          source_step_key: "send:1",
          purpose: "send_message",
          fixed_body: "Podemos escolher um novo horário?",
        },
      });
      return { id, job, enrollment: r.enrollment_id };
    }
    const first = await prepared("Recuperação permitida");
    let callbackFailure = true;
    const callbackUnavailable = createClient(credentials.url, credentials.serviceRole, {
      auth: { persistSession: false },
      global: {
        fetch: async (input, init) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (callbackFailure && url.includes("/rpc/fn_followup_apply_step")) {
            callbackFailure = false;
            return new Response(JSON.stringify({ message: "callback unavailable before commit" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          }
          return fetch(input, init);
        },
      },
    });
    expect(await enviarTextoFixoPendente(callbackUnavailable, [p.contact])).toBe(1);
    expect(callbackFailure).toBe(false);
    expect(hits.filter((url) => url.includes("sendText"))).toHaveLength(1);
    expect(
      (
        await pool.query(
          "select current_node_id,steps_taken from followup_enrollments where id=$1",
          [first.enrollment],
        )
      ).rows[0],
    ).toEqual({ current_node_id: "send", steps_taken: 2 });
    async function claim(job: string, expired = false) {
      return claimOfJob(
        (
          await pool.query(
            "update job_queue set status='running',locked_by='receiver-daemon',locked_at=clock_timestamp()-($2::int*interval '2 minutes'),attempts=attempts+1 where id=$1 returning locked_by,locked_at::text as claim_acquired_at",
            [job, expired ? 1 : 0],
          )
        ).rows[0],
      )!;
    }
    async function daemon(job: string, c: ReturnType<typeof claimOfJob>) {
      return sendTurnMessage(
        pool,
        { supabase: db },
        {
          tenantId: f.org,
          leadId: p.contact,
          jobId: job,
          jobClaim: c,
          seq: 1,
          conversationId: p.conversation,
          body: "Podemos escolher um novo horário?",
        },
      );
    }
    const retryClaim = await claim(first.job);
    expect((await daemon(first.job, retryClaim)).kind).toBe("already_sent");
    await completeTurnForEnrollment(
      createPgAdminClient(pool),
      f.org,
      first.enrollment,
      "send",
      { kind: "sent" },
      undefined,
      first.job,
      retryClaim,
    );
    await completeJob(pool, first.job, retryClaim.worker_id, undefined, retryClaim.acquired_at);
    expect(hits.filter((url) => url.includes("sendText"))).toHaveLength(1);
    expect(
      (
        await pool.query(
          "select count(*)::int n from followup_enrollment_events where enrollment_id=$1 and event_type='action_sent'",
          [first.enrollment],
        )
      ).rows[0].n,
    ).toBe(1);
    const terminal = await db
      .from("followup_enrollments")
      .update({ status: "completed" })
      .eq("organization_id", f.org)
      .eq("id", first.enrollment);
    if (terminal.error) throw terminal.error;
    const reverse = await prepared("Retry do daemon pelo inline");
    const old = await claim(reverse.job, true);
    await pool.query(
      "update job_queue set status='pending',locked_by=null,locked_at=null where id=$1",
      [reverse.job],
    );
    const fresh = await claim(reverse.job);
    await expect(daemon(reverse.job, old)).rejects.toThrow();
    expect(hits.filter((url) => url.includes("sendText"))).toHaveLength(1);
    expect((await daemon(reverse.job, fresh)).kind).toBe("sent");
    const unavailableBridge = {
      ...createPgAdminClient(pool),
      applyEnrollmentStep: async () => {
        throw new Error("callback unavailable before commit");
      },
    };
    await expect(
      completeTurnForEnrollment(
        unavailableBridge,
        f.org,
        reverse.enrollment,
        "send",
        { kind: "sent" },
        undefined,
        reverse.job,
        fresh,
      ),
    ).rejects.toThrow("callback unavailable before commit");
    // Falha antes do callback deixa ledger aceito; outro executor assume o retry.
    await pool.query(
      "update job_queue set status='pending',locked_by=null,locked_at=null,run_after=now() where id=$1",
      [reverse.job],
    );
    expect(await enviarTextoFixoPendente(db, [p.contact])).toBe(1);
    expect(hits.filter((url) => url.includes("sendText"))).toHaveLength(2);
    expect(
      (
        await pool.query(
          "select count(*)::int n from followup_enrollment_events where enrollment_id=$1 and event_type='action_sent'",
          [reverse.enrollment],
        )
      ).rows[0].n,
    ).toBe(1);
    await pool.query("update followup_enrollments set status='completed' where id=$1", [
      reverse.enrollment,
    ]);
    const second = await prepared("Recuperação interrompida no preparo");
    // IDs ordenados asseguram que o protetor criado no último efeito vem APÓS
    // as mil pendências vencidas, mesmo com max_rows=1000 no servidor.
    const oldRows = Array.from({ length: 1001 }, (_, n) => ({
      id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`,
      organization_id: f.org,
      contact_id: p.contact,
      conversation_id: p.conversation,
      title: "Presença antiga",
      status: "confirmed",
      starts_at: "2020-01-01T12:00:00Z",
      ends_at: "2020-01-01T13:00:00Z",
    }));
    const bulk = await db.from("calendar_appointments").insert(oldRows);
    if (bulk.error) throw bulk.error;

    let armed = true;
    const racing = createClient(credentials.url, credentials.serviceRole, {
      auth: { persistSession: false },
      global: {
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (
            armed &&
            url.includes("/rest/v1/messages") &&
            init?.method === "POST" &&
            response.ok
          ) {
            armed = false;
            await insert("calendar_appointments", {
              id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
              organization_id: f.org,
              contact_id: p.contact,
              conversation_id: p.conversation,
              title: "Novo compromisso protege o cliente",
              status: "confirmed",
              starts_at: new Date(Date.now() + 86400000).toISOString(),
              ends_at: new Date(Date.now() + 90000000).toISOString(),
            });
          }
          return response;
        },
      },
    });
    expect(await enviarTextoFixoPendente(racing, [p.contact])).toBe(0);
    expect(armed).toBe(false);
    expect(hits.filter((url) => url.includes("sendText"))).toHaveLength(2);
    const now = new Date();
    const viaSupa = (await protecaoAgendaSupabase(db, f.org, [p.contact], now)).get(p.contact);
    expect(viaSupa).toEqual(await protecaoAgendaPg(pool, f.org, p.contact, now));
    expect(viaSupa).toMatchObject({
      adiar: true,
      appointment_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    expect(
      (
        await db
          .from("job_queue")
          .select("status")
          .eq("organization_id", f.org)
          .eq("id", second.job)
          .single()
      ).data?.status,
    ).toBe("pending");
    expect(
      (
        await db
          .from("followup_enrollments")
          .select("current_node_id")
          .eq("organization_id", f.org)
          .eq("id", second.enrollment)
          .single()
      ).data?.current_node_id,
    ).toBe("send");
  } finally {
    await pool.end();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});

test("Radar recorta demandas pela RLS real, além do pool frio, e preserva gestão/suporte", async ({
  page,
}) => {
  const f = await fixture();
  const members: Record<string, { id: string; email: string }> = {};
  for (const role of ["agent", "other", "manager", "viewer"]) {
    const email = `radar-${role}-${randomUUID()}@invariant.test`;
    const made = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (made.error || !made.data.user) throw made.error;
    const id = made.data.user.id;
    users.push(id);
    members[role] = { id, email };
    await insert("user_organizations", {
      organization_id: f.org,
      user_id: id,
      role: role === "other" ? "agent" : role,
      accepted_at: new Date().toISOString(),
    });
  }
  const pipeline = await insert("crm_pipelines", {
    organization_id: f.org,
    name: "Radar presença",
    slug: "radar-presenca",
  });
  const stage = await insert("crm_stages", {
    organization_id: f.org,
    pipeline_id: pipeline,
    name: "Entrada",
    slug: "entrada",
    position: 1,
  });
  const cold = await db.from("crm_leads").insert(
    Array.from({ length: 501 }, (_, i) => ({
      organization_id: f.org,
      pipeline_id: pipeline,
      stage_id: stage,
      title: `Frio ${i}`,
      owner_user_id: members.agent!.id,
      last_activity_at: "2025-01-01T00:00:00Z",
    })),
  );
  if (cold.error) throw cold.error;
  const expected: Record<string, string> = {};
  for (const [label, owner, withLead] of [
    ["Própria fora do pool", members.agent!.id, true],
    ["Lead de outro dono", members.other!.id, true],
    ["Conversa própria sem lead", members.agent!.id, false],
    ["Conversa não atribuída", null, false],
    ["Conversa de outro dono", members.other!.id, false],
    ["Órfã de gestão", null, false],
  ] as const) {
    const p = await person(f, label);
    const assigned = await db
      .from("conversations")
      .update({ assigned_to_user_id: owner })
      .eq("organization_id", f.org)
      .eq("id", p.conversation);
    if (assigned.error) throw assigned.error;
    const lead = withLead
      ? await insert("crm_leads", {
          organization_id: f.org,
          pipeline_id: pipeline,
          stage_id: stage,
          contact_id: p.contact,
          title: label,
          owner_user_id: owner,
          last_activity_at: new Date().toISOString(),
        })
      : null;
    const demand = await insert("demandas", {
      organization_id: f.org,
      contact_id: p.contact,
      lead_id: lead,
      origem: "manual",
      assunto: label,
      aberta_em: "2025-01-01T00:00:00Z",
    });
    expected[label] = demand;
    if (!withLead && label !== "Órfã de gestão") {
      const linked = await db.from("demanda_conversas").insert({
        organization_id: f.org,
        demanda_id: demand,
        conversation_id: p.conversation,
        service_revision: 1,
      });
      if (linked.error) throw linked.error;
    }
  }
  const policy = async (mode: string) => {
    const changed = await db
      .from("organizations")
      .update({ settings: { visibility_mode: mode } })
      .eq("id", f.org);
    if (changed.error) throw changed.error;
  };
  const read = async () => {
    const response = await page.request.get("/api/v1/leads/at-risk?limit=200");
    expect(response.status()).toBe(200);
    return (await response.json()).data as {
      sem_proximo_passo: Array<{ id: string }>;
      total_sem_proximo_passo: number;
    };
  };
  await policy("own");
  await login(page, members.agent!.email);
  await page.goto("/app/radar");
  await expect(page.getByTestId("radar-sem-proximo-passo")).toContainText("Própria fora do pool");
  const own = await read();
  expect(own.sem_proximo_passo.map((d) => d.id).sort()).toEqual(
    [expected["Própria fora do pool"], expected["Conversa própria sem lead"]].sort(),
  );
  expect(own.total_sem_proximo_passo).toBe(2);
  await policy("own_and_unassigned");
  await page.reload();
  const unassigned = await read();
  expect(unassigned.sem_proximo_passo.map((d) => d.id).sort()).toEqual(
    [
      expected["Própria fora do pool"],
      expected["Conversa própria sem lead"],
      expected["Conversa não atribuída"],
    ].sort(),
  );
  expect(unassigned.total_sem_proximo_passo).toBe(3);
  await login(page, members.manager!.email);
  await page.goto("/app/radar");
  await expect(page.getByTestId("radar-sem-proximo-passo")).toContainText("Órfã de gestão");
  expect((await read()).total_sem_proximo_passo).toBe(6);
  await login(page, members.viewer!.email);
  expect((await page.request.get("/api/v1/leads/at-risk")).status()).toBe(403);
  // Suporte começa em outra organização, sem membership no tenant observado.
  const home = await fixture();
  const pa = await db.from("platform_admins").insert({
    user_id: home.user,
    granted_by: home.user,
    scope: "full",
    mfa_required: false,
    reason: "E2E Radar",
  });
  if (pa.error) throw pa.error;
  await login(page, home.email);
  await page.goto(`/admin/tenants/${f.org}`);
  await page.getByRole("button", { name: /Acompanhar/ }).click();
  await page.getByRole("button", { name: "Confirmar e entrar" }).click();
  await page.waitForURL("**/app/inbox");
  await page.goto("/app/radar");
  await expect(page.getByTestId("radar-sem-proximo-passo")).toContainText("Órfã de gestão");
  expect((await read()).total_sem_proximo_passo).toBe(6);
  await page.getByRole("button", { name: "Sair do acompanhamento" }).click();
  await page.waitForURL("**/app/inbox");
  await page.goto(`/admin/tenants/${f.org}`);
  await page.getByRole("button", { name: /Acompanhar/ }).click();
  await page.getByLabel("Somente leitura", { exact: true }).check();
  await page.getByRole("button", { name: "Confirmar e entrar" }).click();
  await page.waitForURL("**/app/inbox");
  expect((await page.request.get("/api/v1/leads/at-risk")).status()).toBe(403);
  await page.getByRole("button", { name: "Sair do acompanhamento" }).click();
  await page.waitForURL("**/app/inbox");
});

test("duas sessões: remarcação não reautoriza cancelamento em rascunho", async ({
  page,
  browser,
}) => {
  const f = await fixture(),
    p = await person(f);
  const id = await appointment(f, p, "Consulta concorrente");
  await login(page, f.email);
  await detail(page, id, "Consulta concorrente");
  await page.getByLabel("Motivo do cancelamento").fill("Decisão antes da remarcação");
  const other = await browser.newContext();
  try {
    const colleague = await other.newPage();
    await login(colleague, f.email);
    const availableDay = new Date(Date.now() + 86400000);
    while ([0, 6].includes(availableDay.getUTCDay()))
      availableDay.setUTCDate(availableDay.getUTCDate() + 1);
    availableDay.setUTCHours(13, 0, 0, 0); // 10h no fuso da disponibilidade semeada.
    const starts = availableDay.toISOString(),
      ends = new Date(availableDay.getTime() + 30 * 60000).toISOString();
    const changed = await colleague.request.patch("/api/v1/agenda/agendamentos", {
      data: { id, revision: 1, starts_at: starts, ends_at: ends },
    });
    expect(changed.status()).toBe(200);
    await expect(page.getByRole("alert").filter({ hasText: "O compromisso mudou" })).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByRole("button", { name: "Cancelar agendamento", exact: true }),
    ).toBeDisabled();
    expect(
      (
        await db
          .from("calendar_appointments")
          .select("revision,status")
          .eq("organization_id", f.org)
          .eq("id", id)
          .single()
      ).data,
    ).toMatchObject({ revision: 2, status: "confirmed" });
    await page.getByRole("button", { name: "Descartar rascunho e revisar" }).click();
    await expect(page.getByLabel("Motivo do cancelamento")).toHaveValue("");
    await page.getByLabel("Motivo do cancelamento").fill("Revisei o novo horário e confirmei");
    await page.getByRole("button", { name: "Cancelar agendamento", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await db
              .from("calendar_appointments")
              .select("status")
              .eq("organization_id", f.org)
              .eq("id", id)
              .single()
          ).data?.status,
      )
      .toBe("cancelled");
  } finally {
    await other.close();
  }
});
