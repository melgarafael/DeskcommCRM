/**
 * Número sem conta: aviso pela tela ANTES de abrir; no envio, failed permanente.
 * Supabase real do baseline; transporte HTTP simulado local, sem WhatsApp real.
 * A mesma sessão usada pela UI responde false, true ou 503; somente false bloqueia.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { test, expect } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
const credentials = credenciaisSupabaseDeTeste();
if (!/^http:\/\/(127\.0\.0\.1|localhost):/u.test(credentials.url))
  throw Error("Esta prova exige banco local descartável");
if (process.env.WAHA_API_BASE_URL !== "http://127.0.0.1:3999")
  throw Error("A prova exige o transporte simulado local na porta 3999 do ambiente E2E");
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const suffix = randomUUID().slice(0, 8),
  password = `Fixture-${randomUUID()}!`;
const email = `numero-sem-conta-${suffix}@invariant.test`;
let org = "",
  user = "",
  session = "",
  contact = "",
  server: Server;
let sends = 0,
  checks = 0;
async function insert(table: string, values: Record<string, unknown>) {
  const r = await db.from(table).insert(values).select("id").single();
  if (r.error) throw r.error;
  return String(r.data.id);
}
test.describe("número sem WhatsApp não some em um tique", () => {
  test.describe.configure({ timeout: 180000 });
  test.beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1:3999");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/contacts/check-exists") {
        checks++;
        const phone = url.searchParams.get("phone");
        if (phone === "12025550124") {
          res.statusCode = 503;
          res.end("{}");
          return;
        }
        res.end(JSON.stringify({ numberExists: phone !== "12025550123", chatId: phone + "@c.us" }));
        return;
      }
      if (url.pathname.startsWith("/api/send") && !url.pathname.includes("Seen")) {
        sends++;
        res.end(JSON.stringify({ id: "fixture-" + randomUUID() }));
        return;
      }
      if (url.pathname.startsWith("/api/sessions")) {
        res.end(JSON.stringify({ status: "WORKING" }));
        return;
      }
      res.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(3999, "127.0.0.1", resolve);
    });
    const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (auth.error || !auth.data.user) throw auth.error;
    user = auth.data.user.id;
    org = await insert("organizations", {
      slug: "numero-sem-conta-" + suffix,
      legal_name: "Empresa de teste",
      display_name: "Empresa de teste",
      onboarded_at: new Date().toISOString(),
    });
    const member = await db
      .from("user_organizations")
      .insert({
        organization_id: org,
        user_id: user,
        role: "admin",
        accepted_at: new Date().toISOString(),
      });
    if (member.error) throw member.error;
    session = await insert("channel_sessions", {
      organization_id: org,
      waha_session_name: "numero-fixture-" + suffix,
      display_name: "Canal de teste",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    contact = await insert("contacts", {
      organization_id: org,
      name: "Contato sem conta",
      phone_number: "+12025550123",
    });
  });
  test.afterAll(async () => {
    if (org) {
      const r = await db.from("organizations").delete().eq("id", org);
      if (r.error) throw r.error;
    }
    if (user) await db.auth.admin.deleteUser(user);
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  test("a tela avisa, a conversa não nasce e a proteção também vale para o envio", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/senha/i).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app(?:\/|$)/);
    await page.goto("/app/inbox");
    await page.getByRole("button", { name: "Iniciar conversa", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Para quem", { exact: true }).fill("+12025550123");
    await dialog.getByRole("button", { name: "Criar conversa", exact: true }).click();
    await expect(page.getByText("Este número não tem WhatsApp.", { exact: true })).toBeVisible();
    mkdirSync("evidence/numero-sem-whatsapp", { recursive: true });
    await page.screenshot({
      path: "evidence/numero-sem-whatsapp/aviso-antes-de-abrir.png",
      fullPage: true,
    });
    const noConversation = await db
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("contact_id", contact);
    expect(noConversation.error).toBeNull();
    expect(noConversation.count).toBe(0);
    expect(sends).toBe(0);
    const refusedByPhone = await page.request.post("/api/v1/messages", {
      data: { phone_number: "+12025550123", type: "text", body: "Teste pela porta de telefone" },
    });
    expect(refusedByPhone.status()).toBe(422);
    expect((await refusedByPhone.json()).error).toMatchObject({
      code: "numero_sem_whatsapp",
      message: "Este número não tem WhatsApp.",
    });
    expect(sends).toBe(0);
    await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
    // Conversa legada: não passou pela abertura nova. O envio precisa proteger também este caminho.
    const conversation = await insert("conversations", {
      organization_id: org,
      contact_id: contact,
      channel_session_id: session,
      status: "open",
      assigned_to_user_id: user,
    });
    const failed = await page.request.post("/api/v1/messages", {
      data: { conversation_id: conversation, type: "text", body: "Teste de recusa definitiva" },
    });
    expect(failed.ok()).toBe(true);
    const message = (await failed.json()).data;
    expect(message).toMatchObject({
      status: "failed",
      error_code: "numero_sem_whatsapp",
      metadata: { falha_de_envio: { natureza: "permanente" } },
    });
    expect(sends).toBe(0);
    await page.goto("/app/inbox?id=" + conversation);
    await expect(page.getByText("Este número não tem WhatsApp.", { exact: true })).toBeVisible();
    await page.screenshot({
      path: "evidence/numero-sem-whatsapp/falha-visivel-no-envio.png",
      fullPage: true,
    });
    // 503 do check não prova ausência. O canal simulado aceita o envio, sem rede externa.
    const opened = await page.request.post("/api/v1/conversations/open-with-contact", {
      data: {
        channel_session_id: session,
        phone_number: "+12025550124",
        name: "Consulta inconclusiva",
      },
    });
    expect(opened.ok()).toBe(true);
    const id = (await opened.json()).data.conversation_id;
    const sent = await page.request.post("/api/v1/messages", {
      data: { conversation_id: id, type: "text", body: "Teste sem confirmação de cadastro" },
    });
    expect(sent.ok()).toBe(true);
    expect((await sent.json()).data.status).toBe("sent");
    expect(sends).toBe(1);
    const positive = await page.request.post("/api/v1/conversations/open-with-contact", {
      data: { channel_session_id: session, phone_number: "+12025550125", name: "Conta confirmada" },
    });
    expect(positive.ok()).toBe(true);
    expect(checks).toBeGreaterThan(0);
  });
});
