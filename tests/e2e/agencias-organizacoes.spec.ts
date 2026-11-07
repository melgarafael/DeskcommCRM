import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { test, expect } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoDono } from "./helpers/login-admin";
import { afirmarDonoDoServidor } from "./utils/precondicao";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});

test("agência cria cliente, entra, volta e perde delegação quando desabilitada", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240000);
  const suffix = randomUUID().slice(0, 8);
  const email = `agencia-${suffix}@example.test`;
  const password = `Teste-${randomUUID()}!`;
  let agency = "";
  let actor = "";
  const operator = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const clientIds: string[] = [];
  try {
    await afirmarDonoDoServidor(lerCreds().users.dono!.email);
    const user = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (user.error || !user.data.user)
      throw new Error("Não foi possível criar operador sintético.");
    actor = user.data.user.id;
    const org = await db
      .from("organizations")
      .insert({
        slug: `agencia-${suffix}`,
        display_name: "Agência de teste",
        legal_name: "Agência de teste",
        onboarded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (org.error) throw org.error;
    agency = org.data.id;
    const member = await db
      .from("user_organizations")
      .insert({
        organization_id: agency,
        user_id: actor,
        role: "admin",
        accepted_at: new Date().toISOString(),
      });
    if (member.error) throw member.error;
    await loginComoDono(page, lerCreds());
    await page.goto(`/admin/tenants/${agency}`);
    await page.getByLabel("Permitir que esta agência administre organizações clientes").check();
    await page.getByLabel("Limite de organizações clientes").fill("1");
    await page.getByLabel("Incluir clientes no acordo comercial da agência").check();
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Configuração de agência salva." }),
    ).toBeVisible();

    const app = await operator.newPage();
    await app.goto("/login");
    await app.locator("#email").fill(email);
    await app.locator("#password").fill(password);
    await app.getByRole("button", { name: "Entrar", exact: true }).click();
    await app.waitForURL(/\/app(\/|$)/);
    await app.getByTestId("tenant-switcher").click();
    await app.getByRole("menuitem", { name: "Gerenciar organizações" }).click();
    await app.getByLabel("Nome", { exact: true }).fill("Cliente da agência");
    await app.getByLabel("Identificador", { exact: true }).fill(`cliente-${suffix}`);
    await app.getByRole("button", { name: "Criar organização cliente", exact: true }).click();
    await expect(
      app.getByRole("heading", { name: "Cliente da agência", exact: true }),
    ).toBeVisible();
    await expect(
      app.getByRole("button", { name: "Criar organização cliente", exact: true }),
    ).toBeDisabled();
    const links = await db
      .from("agencia_clientes")
      .select("organization_id")
      .eq("agencia_id", agency);
    if (links.error) throw links.error;
    clientIds.push(...links.data.map((r) => r.organization_id));
    expect(clientIds).toHaveLength(1);
    expect((await app.request.get("/api/v1/admin/tenants")).status()).toBe(403);
    await app.screenshot({ path: testInfo.outputPath("clientes.png"), fullPage: true });
    await app.getByRole("button", { name: "Abrir organização", exact: true }).click();
    await expect(app.getByRole("button", { name: "Voltar à agência", exact: true })).toBeEnabled();
    await app.screenshot({ path: testInfo.outputPath("delegacao.png"), fullPage: true });
    await app.getByRole("button", { name: "Voltar à agência", exact: true }).click();
    await expect(
      app.getByRole("heading", { name: "Organizações clientes", exact: true }),
    ).toBeVisible();
    await app.getByRole("button", { name: "Abrir organização", exact: true }).click();
    await expect(app.getByRole("button", { name: "Voltar à agência", exact: true })).toBeEnabled();

    await page.getByLabel("Permitir que esta agência administre organizações clientes").uncheck();
    const save = page.waitForResponse(
      (r) => r.url().endsWith(`/tenants/${agency}/agencia`) && r.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    expect((await save).status()).toBe(200);
    await app.reload();
    await app.waitForURL("**/support-ended");
    await app.getByRole("button", { name: "Voltar à agência", exact: true }).click();
    await app.waitForURL("**/app/settings");
    expect((await app.request.get("/api/v1/agencia/clientes")).status()).toBe(403);
    const permanent = await db
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", clientIds[0]!)
      .eq("user_id", actor);
    expect(permanent.error).toBeNull();
    expect(permanent.data).toEqual([]);
    await expect
      .poll(async () => {
        const audit = await db
          .from("api_audit_log")
          .select("actor_user_id, acting_as_platform_admin")
          .eq("organization_id", clientIds[0]!)
          .eq("action", "agency.session_started");
        if (audit.error) throw audit.error;
        return audit.data.some(
          (row) => row.actor_user_id === actor && row.acting_as_platform_admin === false,
        );
      })
      .toBe(true);
  } finally {
    await operator.close();
    await page.goto("about:blank");
    if (agency) {
      // Recupera também cliente criado antes de uma asserção falhar.
      const links = await db
        .from("agencia_clientes")
        .select("organization_id")
        .eq("agencia_id", agency);
      for (const row of links.data ?? [])
        if (!clientIds.includes(row.organization_id)) clientIds.push(row.organization_id);
      // O recibo é imutável para service_role. A limpeza do teste usa a conexão
      // PostgreSQL da bancada, sempre limitada aos UUIDs desta fixture.
      const cleanup = new pg.Client({ connectionString: credentials.dbUrl });
      await cleanup.connect();
      try {
        await cleanup.query("begin");
        await cleanup.query("delete from agencia_criacoes where organization_id=$1", [agency]);
        await cleanup.query("delete from agencia_sessoes where agencia_id=$1", [agency]);
        await cleanup.query("delete from agencia_clientes where agencia_id=$1", [agency]);
        await cleanup.query("delete from organizations where id=any($1::uuid[])", [[agency, ...clientIds]]);
        await cleanup.query("commit");
      } catch (error) {
        await cleanup.query("rollback");
        throw error;
      } finally { await cleanup.end(); }
    }
    if (actor) {
      const result = await db.auth.admin.deleteUser(actor);
      if (result.error) throw result.error;
    }
  }
});
