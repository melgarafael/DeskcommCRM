import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { expect, test } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

// O segundo login pode aguardar uma janela TOTP inteira antes de testar a tela.
test.describe.configure({ timeout: 60_000 });

const { url, serviceRole } = credenciaisSupabaseDeTeste();
const admin = createClient<Database>(url, serviceRole, { auth: { persistSession: false } });

test("conversões: instalação sem credenciais explica a ausência e permite reprocessar uma pendência", async ({
  page,
}, testInfo) => {
  const creds = await loginComoAdmin(page, lerCreds());
  const { data: users, error: usersError } = await admin.auth.admin.listUsers();
  if (usersError) throw usersError;
  const user = users.users.find((u) => u.email === creds.users.admin!.email);
  if (!user) throw new Error("Admin de teste ausente");
  const { data: membro, error: membroError } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();
  if (membroError) throw membroError;
  const org = membro.organization_id;
  const pipeline = randomUUID(),
    stage = randomUUID(),
    lead = randomUUID();
  const titulo = `Venda teste ${lead}`;
  try {
    const { error: p } = await admin.from("crm_pipelines").insert({
      id: pipeline,
      organization_id: org,
      name: "Conversões teste",
      slug: `conversoes-${pipeline.slice(0, 8)}`,
    });
    if (p) throw p;
    const { error: s } = await admin.from("crm_stages").insert({
      id: stage,
      organization_id: org,
      pipeline_id: pipeline,
      name: "Ganho",
      slug: "ganho",
      position: 1,
      is_won: true,
    });
    if (s) throw s;
    const { error: l } = await admin.from("crm_leads").insert({
      id: lead,
      organization_id: org,
      pipeline_id: pipeline,
      stage_id: stage,
      title: titulo,
      status: "won",
      closed_at: new Date().toISOString(),
      value_cents: 15000,
      currency: "BRL",
    });
    if (l) throw l;
    const { error: d } = await admin.from("ad_conversion_dispatches").insert({
      organization_id: org,
      lead_id: lead,
      platform: "google_ads",
      event_name: "Purchase",
      status: "error",
      reason: "sem_conexao",
      value_cents: 15000,
    });
    if (d) throw d;
    await page.goto("/app/settings/conversoes");
    await expect(page.getByRole("heading", { name: "Conversões", exact: true })).toBeVisible();
    await expect(page.getByTestId("google-ads-nao-configurado")).toBeVisible();
    await expect(page.getByText(/Aceite da API não confirma atribuição/)).toBeVisible();
    const linha = page.getByRole("row").filter({ hasText: titulo });
    await expect(linha.getByRole("cell", { name: "Google Ads", exact: true })).toBeVisible();
    const resposta = page.waitForResponse(
      (r) => r.url().endsWith(`/leads/${lead}/conversion/retry`) && r.request().method() === "POST",
    );
    await linha.getByRole("button", { name: "Verificar ou tentar novamente", exact: true }).click();
    expect((await resposta).status()).toBe(200);
    await expect(
      page.getByText("Reprocessamento agendado. Acompanhe o resultado nesta tela.").first(),
    ).toBeVisible();
    const { data: eventos, error: e } = await admin
      .from("event_log")
      .select("id")
      .eq("organization_id", org)
      .eq("entity_id", lead)
      .eq("event_type", "ad_conversion.retry_requested");
    if (e) throw e;
    expect(eventos).toHaveLength(1);
    await page.screenshot({
      path: testInfo.outputPath("conversoes-reprocessamento.png"),
      fullPage: true,
    });
  } finally {
    await admin.from("event_log").delete().eq("organization_id", org).eq("entity_id", lead);
    await admin.from("crm_leads").delete().eq("organization_id", org).eq("id", lead);
    await admin.from("crm_stages").delete().eq("organization_id", org).eq("id", stage);
    await admin.from("crm_pipelines").delete().eq("organization_id", org).eq("id", pipeline);
  }
});

test("captura Google: configure pela tela, recarregue e leve wbraid ao link do WhatsApp", async ({
  page,
}, testInfo) => {
  const creds = await loginComoAdmin(page, lerCreds());
  const { data: users, error: usersError } = await admin.auth.admin.listUsers();
  if (usersError) throw usersError;
  const user = users.users.find((u) => u.email === creds.users.admin!.email);
  if (!user) throw new Error("Admin de teste ausente");
  const { data: membro, error: membroError } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();
  if (membroError) throw membroError;
  const org = membro.organization_id;
  // As tabelas de captura são server-only; o browser opera pela action real.
  const db = admin;
  const { data: anterior, error: erroAnterior } = await db
    .from("google_ads_landing_pages")
    .select("*")
    .eq("organization_id", org)
    .maybeSingle();
  if (erroAnterior) throw erroAnterior;
  const click = `teste-${randomUUID()}`;
  let site: ReturnType<typeof createServer> | undefined;
  try {
    await page.goto("/app/settings/conversoes");
    const form = page.getByTestId("captura-google");
    await form.getByLabel("Para qual WhatsApp mandar", { exact: true }).fill("+5511999999999");
    await form
      .getByLabel("Texto que a pessoa vai enviar", { exact: true })
      .fill("Olá! Teste de origem. [ref:{token}]");
    const ligado = form.getByRole("switch", { name: "Endereço de captura ligado", exact: true });
    if ((await ligado.getAttribute("aria-checked")) !== "true") await ligado.click();
    await form.getByRole("button", { name: "Salvar endereço de captura", exact: true }).click();
    await expect(page.getByText("Endereço de captura salvo.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(form.getByLabel("Para qual WhatsApp mandar", { exact: true })).toHaveValue(
      "+5511999999999",
    );
    const link = (await form.locator("code").innerText()).trim();
    expect(new URL(link).origin).toBe(new URL(page.url()).origin);
    await page.screenshot({
      path: testInfo.outputPath("conversoes-captura-google.png"),
      fullPage: true,
    });
    // O Playwright só chama o handler para a PRIMEIRA URL de uma cadeia de
    // redirect: um route em wa.me não pega o salto do 302 e o navegador ia ao
    // WhatsApp real. Intercepta o endereço de captura, executa o endpoint de
    // verdade sem seguir o redirect e lê o destino pelo Location.
    let destino = "";
    await page.route(
      (url) => url.href.startsWith(`${link}?`),
      async (route) => {
        const resposta = await route.fetch({ maxRedirects: 0 });
        destino = resposta.headers()["location"] ?? "";
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<h1>Destino WhatsApp de teste</h1>",
        });
      },
    );
    // Cinto: nenhuma execução do CI abre o WhatsApp real.
    await page.context().route("https://wa.me/**", (route) => route.abort());
    const snippet = await page.getByTestId("script-do-site").locator("code").innerText();
    // Um documento criado só com route.fulfill não tem endereço de rede real:
    // o Chromium pode impedir que ele carregue o script no loopback do app.
    // Duas origens HTTP reais exercitam a instalação externa sem dispensar CORS.
    site = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head>${snippet}</head><body><h1>Site de teste</h1><a href="/produto">Ver produto</a><a id="whatsapp" href="https://wa.me/5511999999999">WhatsApp</a></body></html>`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      site!.once("error", reject);
      site!.listen(0, "127.0.0.1", resolve);
    });
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Site de teste sem porta");
    const asset = page.waitForResponse(
      (response) => response.url() === new URL("/rastreio/v1.js", link).href,
    );
    await page.goto(`http://127.0.0.1:${address.port}/?wbraid=${click}&email=nao-capturar`);
    expect((await asset).status()).toBe(200);
    await expect(page.locator("#whatsapp")).toHaveAttribute("href", `${link}?wbraid=${click}`);
    await page.getByRole("link", { name: "Ver produto", exact: true }).click();
    await expect(page.locator("#whatsapp")).toHaveAttribute("href", `${link}?wbraid=${click}`);
    await page.screenshot({
      path: testInfo.outputPath("script-site-origem-preservada.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "WhatsApp", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Destino WhatsApp de teste", exact: true }),
    ).toBeVisible();
    expect(destino.startsWith("https://wa.me/5511999999999?")).toBe(true);
    const texto = new URL(destino).searchParams.get("text");
    const token = texto?.match(/\[ref:([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6})\]/)?.[1];
    expect(token).toBeTruthy();
    const { data: ref, error } = await db
      .from("google_ads_click_refs")
      .select("gclid,wbraid")
      .eq("organization_id", org)
      .eq("token", token!)
      .single();
    if (error) throw error;
    expect(ref).toEqual({ gclid: null, wbraid: click });
  } finally {
    if (site?.listening) {
      await new Promise<void>((resolve, reject) =>
        site!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await db.from("google_ads_click_refs").delete().eq("organization_id", org).eq("wbraid", click);
    if (anterior) await db.from("google_ads_landing_pages").upsert(anterior);
    else await db.from("google_ads_landing_pages").delete().eq("organization_id", org);
  }
});
