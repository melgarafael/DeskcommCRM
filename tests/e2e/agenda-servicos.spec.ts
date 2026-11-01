import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { reconcileAppointment } from "../../lib/agenda/google/sync-executor";
import { googleRpc } from "../../lib/agenda/google/sync-store";
import { reciboDoServico } from "../../lib/agenda/servicos/escrita";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const password = `Synthetic-${randomUUID()}!`;
const orgs: string[] = [], users: string[] = [];
test.use({ timezoneId: "America/Sao_Paulo", trace: "on" });
test.describe.configure({ timeout: 180000 });
async function insert(table: string, fields: Record<string, unknown>) {
  const result = await db.from(table).insert(fields).select("id").single();
  if (result.error) throw result.error; return result.data.id as string;
}
async function fixture() {
  const email = `services-${randomUUID()}@example.test`;
  const result = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (result.error || !result.data.user) throw result.error;
  const user = result.data.user.id; users.push(user);
  const org = await insert("organizations", { slug: `services-${randomUUID()}`, legal_name: "Serviços fictícios", display_name: "Serviços fictícios", onboarded_at: new Date().toISOString() }); orgs.push(org);
  await insert("user_organizations", { organization_id: org, user_id: user, role: "admin", accepted_at: new Date().toISOString() });
  const contact = await insert("contacts", { organization_id: org, name: "Responsável fictício", display_name: "Responsável fictício" });
  const session = await insert("channel_sessions", { organization_id: org, waha_session_name: `synthetic-${randomUUID()}`, status: "WORKING", webhook_secret_encrypted: "\\x00" });
  const conversation = await insert("conversations", { organization_id: org, contact_id: contact, channel_session_id: session, status: "ai_handling", is_group: false });
  return { org, user, email, contact, conversation };
}
async function login(page: Page, email: string) {
  await page.context().clearCookies(); await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email); await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click(); await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60000 });
}
async function clickAndAssert(page: Page, path: string, name: string, expected = 200) {
  const [response] = await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === "POST"), page.getByRole("button", { name, exact: true }).click()]);
  expect(response.status(), await response.text()).toBe(expected);
}
test.afterAll(async () => {
  for (const org of orgs) { const result = await db.from("organizations").delete().eq("id", org); if (result.error) throw result.error; }
  for (const user of users) { const result = await db.auth.admin.deleteUser(user); if (result.error) throw result.error; }
});
test("configuração por Bearer chega ao handler, exige gerente e conserva o isolamento da organização", async ({ request }) => {
  const f = await fixture(), other = await fixture();
  const type = await insert("calendar_event_types", { organization_id: f.org, name: "Serviço fictício por integração", slug: "integration", duration_minutes: 40, service_enabled: true, is_active: false });
  const foreign = await insert("calendar_event_types", { organization_id: other.org, name: "Serviço da outra organização", slug: "other-integration", duration_minutes: 40, service_enabled: true, is_active: false });
  async function token(role: "viewer" | "manager") {
    const prefix = `dsk_synthetic_${randomUUID()}`, plaintext = `${prefix}_${randomUUID()}`;
    const id = await insert("api_tokens", { organization_id: f.org, created_by: f.user, name: "Integração fictícia", prefix, token_hash: `\\x${createHash("sha256").update(plaintext).digest("hex")}`, scopes: ["mcp:write", `role:${role}`], expires_at: new Date(Date.now() + 300000).toISOString() });
    return { id, headers: { Authorization: `Bearer ${plaintext}` } };
  }
  const config = { event_type_id: type, expected_revision: 1, service_enabled: true, is_active: true, requires_confirmation: false, booking_mode: "collective_unlimited", service_timezone: "America/Sao_Paulo", service_publication_mode: "none", professionals: [], resources: [], calendar_sources: [], schedule: [{ weekday: 2, timing_kind: "fixed", start_minute: 840, duration_minutes: 40, capacity_rule: "inherit" }] };
  const url = "/api/v1/agenda/servicos", data = { action: "configure", config };
  expect((await request.post(url, { data })).status()).toBe(401);
  const viewer = await token("viewer"), manager = await token("manager");
  expect((await request.post(url, { data, headers: viewer.headers })).status()).toBe(403);
  // O body não pode redirecionar a organização resolvida da linha do token.
  const crossOrg = await request.post(url, { data: { action: "configure", config: { ...config, event_type_id: foreign, organization_id: other.org } }, headers: manager.headers });
  expect(crossOrg.status(), await crossOrg.text()).toBe(404);
  const unchanged = await db.from("calendar_event_types").select("service_revision,is_active").eq("organization_id", other.org).eq("id", foreign).single();
  expect(unchanged.error).toBeNull(); expect(Number(unchanged.data?.service_revision)).toBe(1); expect(unchanged.data?.is_active).toBe(false);
  const configured = await request.post(url, { data, headers: manager.headers });
  expect(configured.status(), await configured.text()).toBe(200);
  const saved = await db.from("calendar_event_types").select("service_revision,is_active").eq("organization_id", f.org).eq("id", type).single();
  expect(saved.error).toBeNull(); expect(Number(saved.data?.service_revision)).toBe(2); expect(saved.data?.is_active).toBe(true);
  const revoked = await db.from("api_tokens").update({ revoked_at: new Date().toISOString() }).eq("organization_id", f.org).eq("id", manager.id);
  expect(revoked.error).toBeNull();
  expect((await request.post(url, { data: { action: "configure", config: { ...config, expected_revision: 2 } }, headers: manager.headers })).status()).toBe(401);
  // A entrada exata não torna irmãos ou caminhos novos acessíveis por carona.
  expect((await request.post(`${url}/novo-caminho`, { data, headers: viewer.headers })).status()).toBe(401);
});
test("painel configura, bloqueia e reserva três pessoas pela conversa; publicação e comunicação permanecem distintas", async ({ page }, info) => {
  const f = await fixture(); const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const weekday = String(new Date(`${day}T12:00:00Z`).getUTCDay());
  await login(page, f.email); await page.goto("/app/settings/tenant/agenda");
  await page.getByTestId("abrir-novo-tipo").click(); await page.getByTestId("novo-tipo-nome").fill("Atividade coletiva fictícia");
  await page.getByTestId("novo-tipo-duracao").fill("40"); await page.getByRole("checkbox", { name: "Criar como serviço em rascunho" }).check();
  await clickAndAssert(page, "/api/v1/agenda/tipos", "Criar tipo", 201);
  const row = page.getByTestId("lista-de-tipos").locator(":scope > li").filter({ hasText: "Atividade coletiva fictícia" });
  await row.getByRole("button", { name: "Configurar Atividade coletiva fictícia", exact: true }).click();
  const form = page.getByTestId("service-configuration"); await expect(form.getByText("Rascunho: novas reservas estão desativadas.", { exact: true })).toBeVisible();
  await form.getByLabel("Como reservar", { exact: true }).selectOption("collective_unlimited");
  await expect(form.getByLabel("Como reservar", { exact: true })).toHaveValue("collective_unlimited");
  await form.getByLabel("Exigir confirmação humana para este serviço", { exact: true }).uncheck();
  await form.getByRole("tab", { name: "Horários", exact: true }).click();
  await form.getByRole("button", { name: "Adicionar horário", exact: true }).click();
  await form.getByLabel("Dia da semana", { exact: true }).selectOption(weekday);
  await form.getByLabel("Capacidade deste horário", { exact: true }).selectOption("limited");
  await form.getByLabel("Limite deste horário", { exact: true }).fill("2");
  await form.getByRole("tab", { name: "Serviço", exact: true }).click();
  await form.getByLabel("Como reservar", { exact: true }).selectOption("collective_limited");
  await form.getByLabel("Capacidade padrão", { exact: true }).fill("5");
  await form.getByLabel("Como reservar", { exact: true }).selectOption("collective_unlimited");
  await form.getByRole("tab", { name: "Horários", exact: true }).click();
  await expect(form.getByLabel("Capacidade deste horário", { exact: true })).toHaveValue("limited");
  await expect(form.getByLabel("Limite deste horário", { exact: true })).toHaveValue("2");
  await form.getByLabel("Capacidade deste horário", { exact: true }).selectOption("inherit");
  await form.getByRole("tab", { name: "Serviço", exact: true }).click();
  await form.getByLabel("Ativar reservas deste serviço", { exact: true }).check();
  await expect(form.getByLabel("Como reservar", { exact: true })).toHaveValue("collective_unlimited");
  await clickAndAssert(page, "/api/v1/agenda/servicos", "Salvar programação");
  await form.getByRole("tab", { name: "Horários", exact: true }).click();
  await form.getByLabel("Data", { exact: true }).fill(day);
  await form.getByRole("tab", { name: "Horários", exact: true }).click();
  await clickAndAssert(page, "/api/v1/agenda/servicos", "Atualizar fontes e conferir");
  await expect(form.getByRole("list", { name: "Prévia dos horários" })).toContainText("Disponível");
  await page.screenshot({ path: info.outputPath("programacao-desktop.png"), fullPage: true });
  await form.getByRole("tab", { name: "Bloqueios", exact: true }).click();
  await form.locator('[name="block_start"]').fill(`${day}T14:00`); await form.locator('[name="block_end"]').fill(`${day}T14:40`);
  await form.locator('[name="block_reason"]').fill("Manutenção fictícia do serviço");
  await clickAndAssert(page, "/api/v1/agenda/servicos", "Conferir alcance do bloqueio");
  await expect(form.getByText(/Reservas existentes neste alcance: 0/)).toBeVisible();
  await clickAndAssert(page, "/api/v1/agenda/servicos", "Aplicar bloqueio no alcance acima");
  await expect(form.getByRole("status")).toContainText("Reservas existentes preservadas: 0");
  await form.getByRole("tab", { name: "Horários", exact: true }).click();
  await clickAndAssert(page, "/api/v1/agenda/servicos", "Atualizar fontes e conferir");
  await expect(form.getByRole("list", { name: "Prévia dos horários" })).toContainText("Bloqueado");
  await form.getByRole("tab", { name: "Bloqueios", exact: true }).click();
  await clickAndAssert(page, "/api/v1/agenda/servicos", "Retirar bloqueio");
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath("programacao-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(`/app/inbox?id=${f.conversation}`);
  await page.getByRole("button", { name: "Reservar serviço", exact: true }).click();
  const sheet = page.getByRole("dialog"); await sheet.getByLabel("Data", { exact: true }).fill(day);
  await sheet.getByRole("button", { name: "Consultar horários", exact: true }).click();
  await sheet.getByRole("button", { name: /14:00.*Sem limite automático/ }).click();
  await sheet.getByLabel("Pessoas atendidas (uma por linha)", { exact: true }).fill("Pessoa fictícia A\nPessoa fictícia B\nPessoa fictícia C");
  await clickAndAssert(page, "/api/v1/agenda/agendamentos", "Reservar o horário escolhido", 201);
  await expect(sheet.getByRole("region", { name: "Recibo da reserva" })).toHaveCount(3);
  await expect(sheet).toContainText("Não exigida para este serviço"); await expect(sheet).toContainText("Não comprovada pela reserva"); await expect(sheet).toContainText("Somente no CRM");
  await page.screenshot({ path: info.outputPath("reserva-conversa-desktop.png"), fullPage: true });
  const stored = await db.from("calendar_appointments").select("id,service_occurrence_id,status").eq("organization_id", f.org).eq("contact_id", f.contact);
  if (stored.error) throw stored.error; expect(stored.data).toHaveLength(3); expect(new Set(stored.data.map((r) => r.service_occurrence_id)).size).toBe(1);
  const messages = await db.from("messages").select("id", { count: "exact" }).eq("organization_id", f.org).eq("direction", "outbound");
  if (messages.error) throw messages.error; expect(messages.count).toBe(0);
  await page.goto("/app/agenda"); await page.getByText("Turmas e reservas coletivas", { exact: true }).click();
  await expect(page.getByText("Pessoa fictícia A", { exact: false })).toBeVisible();
});

test("Google compartilhado preserva identidade em retry, remarcação e cancelamento; edições incompatíveis viram conflito", async () => {
  const f = await fixture();
  const ownerEmail = `shared-${randomUUID()}@example.test`;
  const owner = await db.auth.admin.createUser({ email: ownerEmail, password, email_confirm: true });
  if (owner.error || !owner.data.user) throw owner.error;
  users.push(owner.data.user.id);
  await insert("user_organizations", { organization_id: f.org, user_id: owner.data.user.id, role: "agent", accepted_at: new Date().toISOString() });
  const connection = await insert("calendar_connections", { organization_id: f.org, user_id: owner.data.user.id, provider: "google_calendar", status: "healthy", account_email: ownerEmail });
  const calendar = await insert("calendar_connection_calendars", { organization_id: f.org, connection_id: connection, external_calendar_id: "shared-fictitious-calendar", name: "Compartilhada fictícia", access_role: "owner", available: true });
  const type = await insert("calendar_event_types", { organization_id: f.org, name: "Atividade fictícia", slug: `shared-${randomUUID()}`, duration_minutes: 40, minimum_notice_minutes: 0, booking_window_days: 90, requires_confirmation: false, service_enabled: true, booking_mode: "collective_unlimited", service_publication_mode: "service", destination_calendar_id: calendar });
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const start = `${day}T17:00:00Z`, next = `${day}T18:00:00Z`;
  for (const minute of [840, 900]) await insert("calendar_service_schedule", { organization_id: f.org, event_type_id: type, weekday: new Date(`${day}T12:00:00Z`).getUTCDay(), timing_kind: "fixed", start_minute: minute });
  const auth = createClient(credentials.url, credentials.anonKey, { auth: { persistSession: false } });
  const login = await auth.auth.signInWithPassword({ email: f.email, password }); if (login.error) throw login.error;
  const operation = randomUUID();
  const book = () => googleRpc(db, "fn_calendar_service_book", { p_org: f.org, p_actor: { type: "user", id: f.user }, p_input: { event_type_id: type, starts_at: start, contact_id: f.contact, conversation_id: f.conversation, operation_key: operation } }) as Promise<Record<string, unknown>>;
  const reservation = await book(); const id = String(reservation.id);
  expect(reservation.owner_user_id).toBeNull(); expect(reciboDoServico(reservation).google_publication).toBe("pending");
  const row = async () => { const r = await db.from("calendar_appointments").select("*").eq("organization_id", f.org).eq("id", id).single(); if (r.error) throw r.error; return r.data; };
  let remote: Record<string, unknown> | null = null, version = 0, loseFirstResponse = true;
  const requests: string[] = [];
  // O receptor controla só HTTP; toda identidade, lease, intenção e decisão é do núcleo real.
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? "GET"; requests.push(method);
    if (!path.includes("/events")) return new Response("{}", { status: 200 });
    if (method === "GET") return Response.json(remote ?? {}, { status: remote ? 200 : 404 });
    const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "POST") {
      if (remote) return Response.json({}, { status: 409 });
      remote = { ...body, etag: `"v${++version}"` };
      if (loseFirstResponse) { loseFirstResponse = false; return Response.json({}, { status: 503 }); }
    } else {
      if (!remote || new Headers(init?.headers).get("If-Match") !== remote.etag) return Response.json({}, { status: 412 });
      remote = { ...remote, ...body, ...(method === "DELETE" ? { status: "cancelled" } : {}), etag: `"v${++version}"` };
    }
    return Response.json(remote);
  };
  const run = () => reconcileAppointment(db, f.org, id, { token: "fictitious-test-only", transport });
  expect(await run()).toBe("failed"); expect(reciboDoServico(await row()).google_publication).toBe("failed");
  expect(await run()).toBe("processed"); let stored = await row();
  expect(reciboDoServico(stored).google_publication).toBe("synced"); expect(stored.google_connection_id).toBe(connection);
  const externalIdentity = stored.google_event_id;
  expect((await book()).id).toBe(id); await run(); expect(requests.filter(m => m === "POST")).toHaveLength(1);
  await googleRpc(auth, "fn_appointment_change", { p_org: f.org, p_id: id, p_revision: stored.revision, p_patch: { starts_at: next } });
  expect(await run()).toBe("processed"); stored = await row();
  expect(stored.google_event_id).toBe(externalIdentity); expect(reciboDoServico(stored).google_publication).toBe("synced");
  const event = remote as unknown as Record<string, unknown>;
  remote = { ...event, start: { dateTime: start, timeZone: "America/Sao_Paulo" }, end: { dateTime: `${day}T17:40:00Z`, timeZone: "America/Sao_Paulo" }, etag: `"v${++version}"` };
  expect(await run()).toBe("processed"); stored = await row();
  expect(Date.parse(stored.starts_at)).toBe(Date.parse(start)); expect(stored.google_conflict).toBeNull();
  remote = { ...remote, end: { dateTime: `${day}T18:00:00Z`, timeZone: "America/Sao_Paulo" }, etag: `"v${++version}"` };
  expect(await run()).toBe("processed"); stored = await row();
  expect(stored.google_conflict).toMatchObject({ reason: "overlap" }); expect(stored.google_sync_error).toBeNull();
  expect(Date.parse(stored.ends_at) - Date.parse(stored.starts_at)).toBe(40 * 60000);
  await googleRpc(auth, "fn_google_resolve", { p_org: f.org, p_id: id, p_revision: String(stored.revision), p_local_revision: String(stored.google_local_revision), p_etag: stored.google_etag, p_choice: "local" });
  await run(); stored = await row(); expect(reciboDoServico(stored).google_publication).toBe("synced");
  // Mesmo bloqueada para novas entradas, uma reserva existente pode ser cancelada no Google.
  await insert("calendar_service_blocks", { organization_id: f.org, scope_kind: "service", event_type_id: type, starts_at: start, ends_at: `${day}T17:40:00Z`, reason: "Bloqueio fictício", operation_key: randomUUID() });
  remote = { ...remote, status: "cancelled", etag: `"v${++version}"` };
  expect(await run()).toBe("processed"); stored = await row();
  expect(stored.status).toBe("cancelled"); expect(stored.google_event_id).toBe(externalIdentity);
  expect(requests.filter(m => m === "POST")).toHaveLength(1); expect(reciboDoServico(stored).communication).toBe("not_proven");
});


test("responsáveis da agenda usam nome ou e-mail, mantêm IDs e isolam membros ativos", async ({ page }) => {
  const f = await fixture(), other = await fixture();
  async function member(label: unknown, revoked = false) {
    const email = `identity-${randomUUID()}@example.test`;
    const r = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: label } });
    if (r.error || !r.data.user) throw r.error; const id = r.data.user.id; users.push(id);
    await insert("user_organizations", { organization_id: f.org, user_id: id, role: "agent", accepted_at: new Date().toISOString(), revoked_at: revoked ? new Date().toISOString() : null });
    return { id, email };
  }
  const named = await member("  Joana Fictícia  "), unnamed = await member(" \t "), revoked = await member("Revogada Fictícia", true);
  const type = await insert("calendar_event_types", { organization_id: f.org, name: "Serviço de identidade fictício", slug: "identity", duration_minutes: 40, service_enabled: true, is_active: false, default_owner_user_id: unnamed.id });
  await login(page, f.email);
  const response = await page.request.get(`/api/v1/agenda/pessoas?organization_id=${other.org}`);
  expect(response.status()).toBe(200);
  const body = await response.json(); const rows = body.data as Array<{ user_id: string; full_name: string | null; display_label: string }>;
  expect(rows.map((r) => r.user_id).sort()).toEqual([f.user, named.id, unnamed.id].sort());
  expect(rows.find((r) => r.user_id === named.id)).toEqual({ user_id: named.id, role: "agent", full_name: "Joana Fictícia", display_label: "Joana Fictícia" });
  expect(rows.find((r) => r.user_id === unnamed.id)?.display_label).toBe(unnamed.email);
  expect(JSON.stringify(body)).not.toContain(other.email); expect(JSON.stringify(body)).not.toContain(revoked.email);
  expect(JSON.stringify(body)).not.toContain(named.email);
  for (const row of rows) expect(Object.keys(row).sort()).toEqual(["user_id", "role", "full_name", "display_label"].sort());
  await page.goto("/app/settings/tenant/agenda");
  await page.getByRole("button", { name: "Novo tipo de agendamento", exact: true }).click();
  const owner = page.getByLabel("Quem atende (sem isto, não há horário para oferecer)");
  await expect(owner.locator("option", { hasText: "Joana Fictícia" })).toHaveAttribute("value", named.id);
  await expect(owner.locator("option", { hasText: unnamed.email })).toHaveAttribute("value", unnamed.id);
  await owner.selectOption(unnamed.id); await expect(owner).toHaveValue(unnamed.id);
  expect(await owner.locator("option").allTextContents()).not.toContain(other.email);
  await page.screenshot({ path: "evidence/agenda-responsaveis-seletor.png", fullPage: true });
  // Só leitura/rascunho: sair não salva o formulário nem muda o responsável do serviço.
  await page.goto("/app/settings/tenant/agenda");
  await page.getByRole("button", { name: "Configurar Serviço de identidade fictício", exact: true }).click();
  await page.getByText("Opções adicionais · 0 profissionais · 0 recursos", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Joana Fictícia", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: unnamed.email, exact: true })).toBeVisible();
  await page.screenshot({ path: "evidence/agenda-responsaveis-profissionais.png", fullPage: true });
  await page.goto("/app/agenda");
  await expect(page.getByRole("button", { name: `Ver só a agenda de ${unnamed.email}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ver só a agenda de Joana Fictícia", exact: true })).toBeVisible();
  await page.screenshot({ path: "evidence/agenda-responsaveis-agenda.png", fullPage: true });
  const unchanged = await db.from("calendar_event_types").select("default_owner_user_id, is_active").eq("id", type).single();
  expect(unchanged.error).toBeNull(); expect(unchanged.data).toEqual({ default_owner_user_id: unnamed.id, is_active: false });
  // Mesmas permissões da rota: agent lê; viewer continua recusado.
  for (const [role, status] of [["agent", 200], ["viewer", 403]] as const) {
    const change = await db.from("user_organizations").update({ role }).eq("organization_id", f.org).eq("user_id", f.user);
    expect(change.error).toBeNull(); expect((await page.request.get("/api/v1/agenda/pessoas")).status()).toBe(status);
  }
});
