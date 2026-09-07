import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const password = `Local-${randomUUID()}!`;
const users: { id: string; email: string; role: string }[] = [], orgs: string[] = [];
const conversations: string[] = [], leads: string[] = [], contacts: string[] = [];
let channel = "";
test.use({ trace: "on" });
async function insert(table: string, value: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw error;
  return data.id as string;
}
async function login(page: Page, role: string) {
  const user = users.find(u => u.role === role)!;
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(user.email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}
const row = (page: Page, title: string) => page.getByTestId("inbox-item").filter({ hasText: title });
async function central(page: Page) {
  await page.goto("/app/ai/inbox");
  await expect(row(page, "Conversa própria")).toBeVisible();
}
async function evidence(page: Page, info: TestInfo, name: string) {
  const directory = info.outputPath(name);
  mkdirSync(directory, { recursive: true });
  const measures = await page.getByTestId("inbox-item").evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, right: rect.right, left: rect.left, viewport: document.documentElement.clientWidth, visible: getComputedStyle(node).visibility };
  }));
  expect(measures.length).toBeGreaterThan(0);
  for (const m of measures) { expect(m.width).toBeGreaterThan(0); expect(m.left).toBeGreaterThanOrEqual(0); expect(m.right).toBeLessThanOrEqual(m.viewport + 1); expect(m.visible).toBe("visible"); }
  expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  writeFileSync(`${directory}/measures.json`, JSON.stringify(measures, null, 2));
  await page.screenshot({ path: `${directory}/loaded.png`, fullPage: true });
}
test.beforeAll(async () => {
  for (const role of ["agent", "other", "manager", "admin", "viewer"]) {
    const email = `avisos-${role}-${randomUUID()}@invariant.test`;
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error;
    users.push({ id: data.user.id, email, role });
  }
  for (const n of [0, 1]) {
    const org = await insert("organizations", { slug: `avisos-${randomUUID()}`, legal_name: `Avisos ${n}`, display_name: `Avisos ${n}`, onboarded_at: new Date().toISOString(), settings: { visibility_mode: "own_and_unassigned" } });
    orgs.push(org);
    if (n === 0) for (const u of users) {
      const { error } = await db.from("user_organizations").insert({ organization_id: org, user_id: u.id, role: u.role === "other" ? "agent" : u.role, accepted_at: new Date().toISOString(), ...(u.role === "agent" ? { interface_settings: { preset: "simplificada", destinos: ["/app/ai/inbox"] } } : {}) });
      if (error) throw error;
    }
    const session = await insert("channel_sessions", { organization_id: org, waha_session_name: `avisos-${randomUUID()}`, display_name: "Canal avisos", status: "STOPPED", webhook_secret_encrypted: "\\x00" });
    if (n === 0) channel = session;
    const pipeline = await insert("crm_pipelines", { organization_id: org, name: "Funil avisos", slug: `avisos-${randomUUID().slice(0, 8)}` });
    const stage = await insert("crm_stages", { organization_id: org, pipeline_id: pipeline, name: "Entrada", slug: "entrada", position: 1 });
    for (const i of n === 0 ? [0, 1, 2] : [3]) {
      const contact = await insert("contacts", { organization_id: org, display_name: `Cliente Avisos ${i}`, phone_number: `+551199990000${i}` }); contacts.push(contact);
      const owner = i === 0 ? users[0]!.id : i === 2 ? users[1]!.id : null;
      const conversation = await insert("conversations", { organization_id: org, contact_id: contact, channel_session_id: session, status: "open", assigned_to_user_id: owner }); conversations.push(conversation);
      leads.push(await insert("crm_leads", { organization_id: org, pipeline_id: pipeline, stage_id: stage, contact_id: contact, title: `Negócio Avisos ${i}`, owner_user_id: owner }));
      if (i === 0) await insert("messages", { organization_id: org, conversation_id: conversation, channel_session_id: session, contact_id: contact, direction: "inbound", type: "text", body: "Mensagem de contexto da Central", status: "received", sent_at: new Date().toISOString() });
    }
  }
  const titles = ["própria", "sem responsável", "outro atendente", "outra organização"];
  for (const [i, id] of conversations.entries()) await insert("agent_inbox_items", { organization_id: orgs[0], kind: "handoff", severity: "warn", title: `Conversa ${titles[i]}`, ref_kind: "conversation", ref_id: id });
  for (const [i, id] of leads.entries()) await insert("agent_inbox_items", { organization_id: orgs[0], kind: "other", severity: "warn", title: `Negócio ${titles[i]}`, ref_kind: "lead", ref_id: id });
  for (const [title, kind, ref_kind, ref_id] of [
    ["Contato para conferir", "handoff", "contact", contacts[0]],
    ["Referência removida", "handoff", "conversation", randomUUID()],
    ["Conexão para revisar", "qr_rescan", "channel_session", channel],
    ["Orçamento para revisar", "budget_warning", "ai_budget", orgs[0]],
    ["Modelo do canal mudou", "channel_template_review", null, null],
  ]) await insert("agent_inbox_items", { organization_id: orgs[0], kind, severity: "warn", title, ref_kind, ref_id });
});
test.afterAll(async () => {
  // As páginas/contextos de cada teste já foram fechados pelo runner.
  for (const id of orgs) { const result = await db.from("organizations").delete().eq("id", id); if (result.error) throw result.error; }
  for (const u of users) { const result = await db.auth.admin.deleteUser(u.id); if (result.error) throw result.error; }
});

test("agent abre contexto, volta ainda aberto, resolve e reabre; RLS e menu oculto", async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "agent"); await central(page);
  const navigation = page.getByRole("navigation", { name: "Navegação principal" });
  await expect(navigation.getByRole("link", { name: "Inbox", exact: true })).toHaveCount(0);
  for (const prefix of ["Conversa", "Negócio"]) {
    await expect(row(page, `${prefix} própria`).getByRole("link")).toBeVisible();
    await expect(row(page, `${prefix} sem responsável`).getByRole("link")).toBeVisible();
    for (const suffix of ["outro atendente", "outra organização"]) await expect(row(page, `${prefix} ${suffix}`).getByRole("link")).toHaveCount(0);
  }
  await expect(row(page, "Referência removida").getByRole("link")).toHaveCount(0);
  await expect(row(page, "Conexão para revisar")).toContainText("Peça a quem administra");
  const patches: string[] = [];
  page.on("request", req => { if (req.method() === "PATCH" && req.url().includes("/ai/inbox/")) patches.push(req.url()); });
  await evidence(page, info, "desktop");
  await row(page, "Conversa própria").getByRole("link", { name: "Abrir conversa" }).click();
  await expect(page).toHaveURL(new RegExp(`id=${conversations[0]}`));
  await expect(page.getByText("Mensagem de contexto da Central", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("Mensagem de contexto da Central", { exact: true }).first()).toBeVisible();
  await page.goBack();
  await expect(row(page, "Conversa própria")).toBeVisible(); expect(patches).toHaveLength(0);
  await row(page, "Conversa própria").getByRole("button", { name: "Marcar resolvido" }).click();
  await expect(row(page, "Conversa própria")).toHaveCount(0);
  await page.getByRole("tab", { name: "Resolvidos", exact: true }).click();
  await expect(row(page, "Conversa própria").getByRole("link")).toBeVisible();
  await row(page, "Conversa própria").getByRole("button", { name: "Reabrir" }).click();
  await expect(row(page, "Conversa própria")).toHaveCount(0);
  await page.getByRole("tab", { name: /^Abertos/ }).click();
  await expect(row(page, "Conversa própria")).toBeVisible(); expect(patches).toHaveLength(2);
  await row(page, "Contato para conferir").getByRole("link", { name: "Ver contato" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/contacts/${contacts[0]}`));
  await expect(page.getByText("Cliente Avisos 0", { exact: true }).first()).toBeVisible();
  await page.goBack(); await expect(row(page, "Contato para conferir")).toBeVisible();
  await row(page, "Negócio própria").getByRole("link", { name: "Abrir negócio" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/pipelines/[^?]+\\?lead=${leads[0]}`));
  await expect(page.getByRole("dialog").getByText("Negócio Avisos 0", { exact: true }).first()).toBeVisible();
  await page.goBack(); await expect(row(page, "Negócio própria")).toBeVisible();
  // Mudança de política vem do banco, sem implementar cópia no catálogo.
  const changed = await db.from("organizations").update({ settings: { visibility_mode: "own" } }).eq("id", orgs[0]); if (changed.error) throw changed.error;
  await page.reload();
  for (const prefix of ["Conversa", "Negócio"]) {
    await expect(row(page, `${prefix} própria`).getByRole("link")).toBeVisible();
    for (const suffix of ["sem responsável", "outro atendente", "outra organização"]) await expect(row(page, `${prefix} ${suffix}`).getByRole("link")).toHaveCount(0);
  }
  const idioma = await db.auth.admin.updateUserById(users[0]!.id, { user_metadata: { locale: "es" } });
  if (idioma.error) throw idioma.error;
  await page.reload();
  await expect(row(page, "Conversa própria").getByRole("link", { name: "Abrir conversación" })).toBeVisible();
  await expect(row(page, "Referência removida")).toContainText("Este contexto no está disponible para ti");
  await page.setViewportSize({ width: 390, height: 844 });
  await evidence(page, info, "mobile");
});

for (const role of ["manager", "admin"]) test(`${role}: destinos conforme papel efetivo`, async ({ page }) => {
  test.setTimeout(120_000); await login(page, role); await central(page);
  await expect(row(page, "Conversa outro atendente").getByRole("link")).toBeVisible();
  await expect(row(page, "Conversa outra organização").getByRole("link")).toHaveCount(0);
  await row(page, "Orçamento para revisar").getByRole("link", { name: "Abrir uso de IA" }).click();
  await expect(page).toHaveURL(/\/app\/ai\/usage/);
  await expect(page.getByRole("heading", { name: /Uso de IA|Uso e custos/i }).first()).toBeVisible();
  await page.goBack(); await expect(row(page, "Conexão para revisar")).toBeVisible();
  if (role === "manager") {
    await expect(row(page, "Conexão para revisar").getByRole("link")).toHaveCount(0);
    await expect(row(page, "Modelo do canal mudou").getByRole("link")).toHaveCount(0);
  } else {
    await row(page, "Conexão para revisar").getByRole("link").click();
    await expect(page).toHaveURL(/\/app\/connections/);
    await expect(page.getByRole("heading", { name: /Conexões/ }).first()).toBeVisible();
    await page.goBack();
    await row(page, "Modelo do canal mudou").getByRole("link").click();
    await expect(page).toHaveURL(/aba=parceiro&sub=templates/);
    await expect(page.getByRole("heading", { name: /Conexões/ }).first()).toBeVisible();
  }
});
test("viewer continua sem acesso à API Central e bearer não autentica", async ({ page, playwright }) => {
  await login(page, "viewer");
  expect((await page.request.get("/api/v1/ai/inbox")).status()).toBe(403);
  const anonymous = await playwright.request.newContext();
  try { expect((await anonymous.get(`${new URL(page.url()).origin}/api/v1/ai/inbox`, { headers: { Authorization: "Bearer dsk_fake" } })).status()).toBe(401); }
  finally { await anonymous.dispose(); }
});
