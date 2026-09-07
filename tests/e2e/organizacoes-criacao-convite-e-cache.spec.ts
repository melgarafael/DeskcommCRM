import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const password = `Local-${randomUUID()}!`;
async function insert(table: string, value: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id as string;
}
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
}
async function conversation(org: string, name: string) {
  const contact = await insert("contacts", { organization_id: org, name, display_name: name });
  const session = await insert("channel_sessions", { organization_id: org,
    waha_session_name: `local-${randomUUID()}`, display_name: name, status: "STOPPED",
    webhook_secret_encrypted: "\\x00" });
  await insert("conversations", { organization_id: org, contact_id: contact,
    channel_session_id: session, status: "open", last_message_at: new Date().toISOString(),
    last_message_preview: `Mensagem de ${name}` });
}

test("org única oferece criação, responsável aceita e A→B→A não mistura inbox", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().slice(0, 8);
  const ownerEmail = `owner-${suffix}@invariant.test`;
  const guestEmail = `guest-${suffix}@invariant.test`;
  const users: string[] = [];
  const orgs: string[] = [];
  let guestContext;
  try {
    for (const email of [ownerEmail, guestEmail]) {
      const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) throw error ?? new Error("user missing");
      users.push(data.user.id);
    }
    const orgA = await insert("organizations", { display_name: `Empresa A ${suffix}`, legal_name: `Empresa A ${suffix}`, slug: `a-${suffix}`, onboarded_at: new Date().toISOString() });
    orgs.push(orgA);
    for (const user of users) await insert("user_organizations", { organization_id: orgA, user_id: user, role: "admin", accepted_at: new Date().toISOString() });
    const pa = await db.from("platform_admins").insert({ user_id: users[0], granted_by: users[0], scope: "full", mfa_required: false, reason: "Local E2E fixture" });
    if (pa.error) throw pa.error;
    const forgedTarget = await insert("organizations", { display_name: `Alvo ${suffix}`, legal_name: "Alvo", slug: `alvo-${suffix}` });
    orgs.push(forgedTarget);
    await conversation(orgA, `Cliente A ${suffix}`);
    await login(page, ownerEmail);
    await page.getByTestId("tenant-switcher").click();
    await page.getByRole("menuitem", { name: "Gerenciar organizações" }).click();
    await page.getByRole("link", { name: /Novo tenant/i }).click();
    await page.getByLabel("Nome de exibição").fill(`Empresa B ${suffix}`);
    await page.getByLabel("E-mail do responsável").fill(guestEmail);
    // O servidor confirma, mas todas as respostas da primeira tentativa se perdem.
    let loseResponse = true;
    const lost: Array<{ id: string; owner_invitation: { accept_url: string } }> = [];
    const keys: string[] = [];
    await page.route("**/api/v1/admin/tenants", async route => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]!);
      if (keys.length === 1) {
        // Simula recibo legado adulterado antes da 0219: mesmo ator, chave e hash.
        const forged = await db.from("idempotency_keys").insert({ organization_id: orgA,
          key: keys[0], endpoint: `/api/v1/admin/tenants:${users[0]}`,
          request_hash: `\\x${createHash("sha256").update(route.request().postData()!).digest("hex")}`,
          status_code: 201, response_body: { id: forgedTarget, slug: `alvo-${suffix}`,
            display_name: "Alvo", invite_id: randomUUID(), issued_at: 9999999999 } });
        if (forged.error) throw forged.error;
      }
      if (!loseResponse) return route.continue();
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      const data = (await committed.json()).data;
      lost.push(data);
      if (!orgs.includes(data.id)) orgs.push(data.id);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "Criar organização", exact: true }).click();
    await expect.poll(() => lost.length).toBe(3);
    await expect(page.getByRole("button", { name: "Criar organização", exact: true })).toBeEnabled();
    loseResponse = false;
    const response = page.waitForResponse(r => r.url().endsWith("/api/v1/admin/tenants") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Criar organização", exact: true }).click();
    const created = (await (await response).json()).data;
    expect(created.id).toBeTruthy();
    const orgB = created.id as string;
    expect(created.id).toBe(lost[0]!.id);
    expect(created.owner_invitation.accept_url).toBe(lost[0]!.owner_invitation.accept_url);
    expect(lost.every(item => item.id === orgB)).toBe(true);
    expect(new Set(keys).size).toBe(1);
    await page.unroute("**/api/v1/admin/tenants");
    const duplicateCheck = await db.from("organizations").select("id").eq("slug", created.slug);
    expect(duplicateCheck.error).toBeNull();
    expect(duplicateCheck.data).toEqual([{ id: orgB }]);
    await expect(page.getByText("Organização criada", { exact: true })).toBeVisible();
    const link = await page.getByLabel("Link do convite").inputValue();
    const tokenBody = new URL(link).pathname.split("/").at(-1)!.split(".")[0]!;
    expect(JSON.parse(Buffer.from(tokenBody, "base64url").toString()).organization_id).toBe(orgB);
    expect(orgB).not.toBe(forgedTarget);
    expect(created.owner_invitation.email_dispatched).toBe(false);
    await expect(page.getByText(/Copie o link e compartilhe/)).toBeVisible();
    await expect(page.getByText(/Válido até/)).toBeVisible();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copiar convite", exact: true }).click();
    await expect(page.getByText("Link copiado", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    mkdirSync(".superpowers/evidence/comunidade-360", { recursive: true });
    await page.screenshot({ path: ".superpowers/evidence/comunidade-360/criacao-convite.png" });
    // Precondição do teste de cache: o wizard é coberto pela spec de retorno.
    const update = await db.from("organizations").update({ onboarded_at: new Date().toISOString() }).eq("id", orgB);
    if (update.error) throw update.error;
    await conversation(orgB, `Cliente B ${suffix}`);
    await page.getByRole("link", { name: "Voltar ao aplicativo" }).click();
    await page.waitForURL("**/app/inbox", { waitUntil: "load" });
    await expect(page.locator("[data-conversation-id]").getByText(`Cliente A ${suffix}`, { exact: true })).toBeVisible();
    const cookieBeforeFailure = (await page.context().cookies()).find(cookie => cookie.name === "active_org")?.value;
    await page.route("**/app/**", async route => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) return route.abort("failed");
      return route.continue();
    });
    await page.getByTestId("tenant-switcher").click();
    await page.getByTestId(`tenant-switcher-item-${orgB}`).click({ noWaitAfter: true });
    await expect(page.getByText("Não foi possível trocar de organização. Seu acesso pode ter mudado. Tente novamente.")).toBeVisible();
    await expect(page.getByTestId("organization-transition")).toHaveCount(0);
    await expect(page.getByTestId("tenant-switcher")).toContainText(`Empresa A ${suffix}`);
    await expect(page.locator("[data-conversation-id]").getByText(`Cliente A ${suffix}`, { exact: true })).toBeVisible();
    expect((await page.context().cookies()).find(cookie => cookie.name === "active_org")?.value).toBe(cookieBeforeFailure);
    await page.screenshot({ path: ".superpowers/evidence/comunidade-360/troca-falhou-contexto-preservado.png" });
    await page.unroute("**/app/**");
    for (const [target, own, foreign] of [[orgB, "B", "A"], [orgA, "A", "B"]]) {
      await page.evaluate(() => { (window as unknown as Record<string, unknown>).__oldDocument = true; });
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      await page.route("**/app/**", async route => {
        if (route.request().method() === "POST" && route.request().headers()["next-action"]) await held;
        await route.continue();
      });
      await page.getByTestId("tenant-switcher").click();
      const navigation = page.waitForNavigation({ waitUntil: "load" });
      await page.getByTestId(`tenant-switcher-item-${target}`).click({ noWaitAfter: true });
      try {
        const guard = page.getByTestId("organization-transition");
        await expect(guard).toBeVisible();
        expect(await guard.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width >= innerWidth && rect.height >= innerHeight && style.position === "fixed" && style.backgroundColor !== "rgba(0, 0, 0, 0)";
        })).toBe(true);
        await page.screenshot({ path: `.superpowers/evidence/comunidade-360/transicao-para-${own}.png` });
      } finally { release(); }
      await navigation;
      await page.waitForURL("**/app/inbox", { waitUntil: "load" });
      await page.unroute("**/app/**");
      await expect(page.getByTestId("tenant-switcher")).toContainText(`Empresa ${own} ${suffix}`);
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__oldDocument)).toBeUndefined();
      await expect(page.locator("[data-conversation-id]").getByText(`Cliente ${own} ${suffix}`, { exact: true })).toBeVisible();
      await expect(page.locator("[data-conversation-id]").getByText(`Cliente ${foreign} ${suffix}`, { exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: ".superpowers/evidence/comunidade-360/inbox-volta-a.png" });
    guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await login(guest, guestEmail);
    // Usuário comum não ganha porta de administração de plataforma.
    await expect(guest.getByTestId("tenant-switcher")).toHaveCount(0);
    await guest.goto(new URL(link).pathname);
    await guest.getByRole("button", { name: "Aceitar convite", exact: true }).click();
    await expect(guest.getByTestId("tenant-switcher")).toContainText(`Empresa B ${suffix}`);
    await expect(guest.locator("[data-conversation-id]").getByText(`Cliente B ${suffix}`, { exact: true })).toBeVisible();
    const membership = await db.from("user_organizations").select("invited_by,role").eq("organization_id", orgB).eq("user_id", users[1]).single();
    expect(membership.data).toEqual({ invited_by: users[0], role: "admin" });
    await guest.screenshot({ path: ".superpowers/evidence/comunidade-360/aceite-na-org-b.png" });
  } finally {
    await guestContext?.close();
    for (const org of orgs) await db.from("organizations").delete().eq("id", org);
    for (const user of users) await db.auth.admin.deleteUser(user);
  }
});
