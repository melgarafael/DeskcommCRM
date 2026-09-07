import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;
const evidence = ".superpowers/evidence/comunidade-360";
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Navegação principal" });
async function customize(page: Page, email: string, only?: string) {
  await page.getByRole("button", { name: `Interface de ${email}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Perfil de interface").selectOption("simplificada");
  if (only) {
    await dialog.getByText("Personalizar áreas visíveis", { exact: false }).click();
    for (const checkbox of await dialog.getByRole("checkbox").all())
      if (await checkbox.isChecked()) await checkbox.uncheck();
    await dialog.getByRole("checkbox", { name: only, exact: true }).check();
  }
  await dialog.getByRole("button", { name: "Salvar interface" }).click();
  await expect(dialog).toHaveCount(0);
}
test("interface por membro atualiza ao vivo, preserva formulário e convite aplica seleção", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().slice(0, 8);
  const emails = ["admin", "agent1", "agent2", "guest"].map(
    (name) => `${name}-${suffix}@invariant.test`,
  );
  const users: string[] = [];
  const orgs: string[] = [];
  const memberContext = await browser.newContext();
  const otherContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    for (const email of emails) {
      const { data, error } = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error || !data.user) throw error;
      users.push(data.user.id);
    }
    for (const label of ["A", "B"]) {
      const { data, error } = await db
        .from("organizations")
        .insert({
          slug: `interface-${label.toLowerCase()}-${suffix}`,
          display_name: `Interface ${label}`,
          legal_name: `Interface ${label}`,
          onboarded_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error) throw error;
      orgs.push(data.id);
    }
    const membership = await db
      .from("user_organizations")
      .insert(
        users.map((user_id, i) => ({
          user_id,
          organization_id: i === 3 ? orgs[1] : orgs[0],
          role: i === 0 ? "admin" : "agent",
          accepted_at: new Date().toISOString(),
        })),
      );
    if (membership.error) throw membership.error;
    const member = await memberContext.newPage();
    const other = await otherContext.newPage();
    const guest = await guestContext.newPage();
    const realtime: string[] = [];
    member.on("websocket", (ws) =>
      ws.on("framereceived", (event) => {
        const payload = event.payload.toString();
        if (payload.includes('"table":"user_organizations"')) realtime.push(payload);
      }),
    );
    await login(page, emails[0]!);
    await page.goto("/app/team");
    await login(member, emails[1]!);
    await member.goto("/app/settings/profile");
    await member.getByLabel("Nome completo").fill("Rascunho não salvo");
    await login(other, emails[2]!);
    await expect(nav(member).getByRole("link", { name: "Radar", exact: true })).toBeVisible();
    const framesBefore = realtime.length;
    await customize(page, emails[1]!);
    // Evento real precisa chegar; polling não pode aprovar a observação em tempo real.
    await expect.poll(() => realtime.length, { timeout: 15_000 }).toBeGreaterThan(framesBefore);
    await expect(nav(member).getByRole("link", { name: "Radar", exact: true })).toHaveCount(0);
    await expect(nav(other).getByRole("link", { name: "Radar", exact: true })).toBeVisible();
    await expect(member.getByLabel("Nome completo")).toHaveValue("Rascunho não salvo");
    expect(member.url()).toContain("/app/settings/profile");
    await expect(member.getByTestId("alerts-bell")).toHaveCount(0);
    expect((await member.request.get("/api/v1/team")).status()).toBe(403);
    expect(
      (
        await member.request.patch(`/api/v1/team/${users[1]}/interface`, {
          data: { interface_settings: { preset: "completa" } },
        })
      ).status(),
    ).toBe(403);
    // Área oculta autorizada continua disponível diretamente.
    await member.goto("/app/radar");
    await expect(member.getByRole("heading", { name: /Radar/ }).first()).toBeVisible();
    await member.goto("/app/settings/profile");
    await customize(page, emails[1]!, "Produtos");
    await expect(nav(member).getByRole("link", { name: "Inbox", exact: true })).toHaveCount(0);
    await member.goto("/app");
    await member.waitForURL("**/app/products");
    await nav(member).getByRole("link", { name: "Ver tudo em CRM" }).click();
    await expect(member.getByRole("link", { name: /Produtos/ }).last()).toBeVisible();
    await expect(member.getByRole("link", { name: /Contatos/ })).toHaveCount(0);
    await member.keyboard.press("ControlOrMeta+k");
    await expect(member.getByRole("option").filter({ hasText: "Produtos" })).toBeVisible();
    await expect(member.getByRole("option").filter({ hasText: "Inbox" })).toHaveCount(0);
    await member.keyboard.press("Escape");
    mkdirSync(evidence, { recursive: true });
    await member.screenshot({ path: `${evidence}/interface-hub-only.png` });
    await member.setViewportSize({ width: 390, height: 844 });
    await member.getByRole("button", { name: "Abrir navegação" }).click();
    await expect(member.getByRole("link", { name: "Ver tudo em CRM" }).last()).toBeVisible();
    expect(
      await member.evaluate(
        () => document.body.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await member.screenshot({ path: `${evidence}/interface-mobile.png` });
    // Convite pela tela, sem serviço de e-mail e com configuração anterior ao aceite.
    await page.goto("/app/team/invite");
    await page.getByLabel("Emails").fill(emails[3]!);
    await page.getByLabel("Perfil de interface").selectOption("simplificada");
    await page.getByText("Personalizar áreas visíveis", { exact: false }).click();
    for (const checkbox of await page.getByRole("checkbox").all())
      if (await checkbox.isChecked()) await checkbox.uncheck();
    await page.getByRole("checkbox", { name: "Tarefas", exact: true }).check();
    await page.getByRole("button", { name: "Enviar convites" }).click();
    const link = await page.locator("code").innerText();
    expect(link).toContain("/team/accept-invite/");
    await login(guest, emails[3]!);
    await guest.goto(link);
    await guest.getByRole("button", { name: /aceitar/i }).click();
    await guest.waitForURL("**/app/tasks");
    await expect(nav(guest).getByRole("link", { name: "Inbox", exact: true })).toHaveCount(0);
    await expect(nav(guest).getByRole("link", { name: "Tarefas", exact: true })).toBeVisible();
    await expect(guest.getByRole("heading", { name: "Tarefas", exact: true })).toBeVisible();
    await expect(guest.getByText("Nenhuma tarefa por aqui", { exact: true })).toBeVisible();
    await expect(guest.locator("[aria-busy=true]")).toHaveCount(0);
    await guest.screenshot({ path: `${evidence}/interface-convite-aceito.png` });
    const persisted = await db
      .from("user_organizations")
      .select("interface_settings")
      .eq("organization_id", orgs[0])
      .eq("user_id", users[3])
      .single();
    expect(persisted.data?.interface_settings).toEqual({
      preset: "simplificada",
      destinos: ["/app/tasks"],
    });
    await page.goto("/app/team");
    await customize(page, emails[3]!, "Produtos");
    await guest.goto(link);
    await guest.getByRole("button", { name: /aceitar/i }).click();
    await guest.waitForURL("**/app/products");
    // A coluna também descreve a seleção para quem só pode consultar a equipe.
    await customize(page, emails[2]!, "Produtos");
    await page.getByRole("combobox", { name: `Papel de ${emails[2]}` }).click();
    await page.getByRole("option", { name: "manager", exact: true }).click();
    await expect(page.getByText("Papel atualizado.", { exact: true })).toBeVisible();
    await other.goto("/app/team");
    await expect(other.getByRole("row").filter({ hasText: emails[2] }).getByText("Personalizada", { exact: true })).toBeVisible();
  } finally {
    await memberContext.close();
    await otherContext.close();
    await guestContext.close();
    for (const id of orgs) await db.from("organizations").delete().eq("id", id);
    for (const id of users) await db.auth.admin.deleteUser(id);
  }
});
