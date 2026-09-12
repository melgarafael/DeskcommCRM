import { createSupabaseSilenceSweepDb } from "../../lib/followup/silence-sweep";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const evidence = ".superpowers/evidence/comunidade-360";
test.use({ trace: "on" });
async function insert(table: string, values: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(values).select("id").single();
  if (error) throw error;
  return data.id as string;
}
/**
 * ABRIR UMA CONVERSA PELO LINK DIRETO, E ESPERAR O REDIRECIONAMENTO TERMINAR.
 *
 * `/app/inbox/<id>` não é a URL final: a tela redireciona para
 * `/app/inbox?id=<id>` e só DEPOIS monta os painéis. Um `goto` seguido de
 * asserção começa a medir enquanto a navegação ainda está em curso — o painel
 * já existe no DOM, vazio, e o texto chega alguns instantes depois.
 *
 * Medido em 11/09/2026, com o CI saturado, em DOIS PRs diferentes e em
 * asserções diferentes do mesmo arquivo:
 *
 *   linha 142  getByTestId('inbox-demandas').getByText('Demanda vigente…')
 *              → "waiting for navigation to finish"
 *   linha 223  getByTestId('inbox-memoria') toContainText('Histórico encerrado')
 *              → "3 × locator resolved to <section …>" — existia e estava vazio
 *
 * Duas asserções distintas quebrando no mesmo ponto do fluxo não são duas
 * flakinesses: é o mesmo defeito de espera, e é a SEGUNDA vez que esta classe
 * morde este repositório.
 *
 * O conserto NÃO relaxa asserção nenhuma — nenhum timeout foi aumentado. Ele
 * apenas espera o que é determinístico (a URL final) antes de começar a medir.
 */
async function abrirConversa(page: Page, conversation: string): Promise<void> {
  await page.goto(`/app/inbox/${conversation}`);
  await page.waitForURL(new RegExp(`/app/inbox\\?id=${conversation}`));
}

test("fechar canal preserva demanda, desfecho explícito e nova entrada volta à fila", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const password = `Local-${randomUUID()}!`,
    email = `service-${randomUUID()}@invariant.test`;
  let org = "",
    user = "";
  const hits: string[] = [];
  const receiver = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `test-${randomUUID()}` }));
  });
  const receiverUrl = new URL(process.env.WAHA_API_BASE_URL!);
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(Number(receiverUrl.port), receiverUrl.hostname, resolve);
  });
  mkdirSync(evidence, { recursive: true });
  try {
    const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error;
    user = created.data.user.id;
    org = await insert("organizations", {
      display_name: "Atendimento local",
      legal_name: "Atendimento local",
      slug: `service-${randomUUID()}`,
      onboarded_at: new Date().toISOString(),
    });
    const membership = await db
      .from("user_organizations")
      .insert({
        organization_id: org,
        user_id: user,
        role: "admin",
        accepted_at: new Date().toISOString(),
      });
    if (membership.error) throw membership.error;
    const contact = await insert("contacts", {
      organization_id: org,
      display_name: "Cliente Encerramento",
      phone_number: "+5511999887666",
    });
    const channels = await Promise.all(
      [1, 2].map((i) =>
        insert("channel_sessions", {
          organization_id: org,
          waha_session_name: `service-${i}-${randomUUID()}`,
          display_name: `Canal ${i}`,
          status: "WORKING",
          webhook_secret_encrypted: "\\x00",
        }),
      ),
    );
    const conversations = await Promise.all(
      channels.map((session) =>
        insert("conversations", {
          organization_id: org,
          contact_id: contact,
          channel_session_id: session,
          status: "open",
        }),
      ),
    );
    const conversation = conversations[0]!;
    async function inbound(body: string) {
      const sentAt = new Date().toISOString();
      await insert("messages", {
        organization_id: org,
        contact_id: contact,
        conversation_id: conversation,
        channel_session_id: channels[0],
        direction: "inbound",
        type: "text",
        status: "received",
        sent_via: "ai",
        body,
        sent_at: sentAt,
      });
      const marked = await db.rpc("fn_mark_conversation_message", {
        p_conv: conversation,
        p_direction: "inbound",
        p_preview: body,
        p_at: sentAt,
      });
      if (marked.error) throw marked.error;
    }
    await inbound("Primeiro atendimento");
    const originalBoundary = await db.rpc("fn_service_boundary", { p_org: org, p_conversation: conversation });
    if (originalBoundary.error) throw originalBoundary.error;
    const initial = await db
      .from("conversations")
      .select("current_demanda_id")
      .eq("id", conversation)
      .single();
    if (initial.error) throw initial.error;
    const demand = initial.data.current_demanda_id;
    const link = await db
      .from("demanda_conversas")
      .insert({
        organization_id: org,
        conversation_id: conversations[1],
        demanda_id: demand,
        service_revision: 1,
      });
    if (link.error) throw link.error;
    await insert("lead_notes", {
      organization_id: org,
      contact_id: contact,
      headline: "Preferência de horário",
      body: "Prefere conversar pela manhã.",
    });
    await page.goto("/login");
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/senha/i).fill(password);
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/app(?:\/|$)/);
    await abrirConversa(page, conversation);
    const panel = page.getByTestId("inbox-demandas");
    await expect(panel.getByText("Demanda vigente neste canal")).toBeVisible();
    await expect(page.getByTestId("inbox-memoria")).toContainText("Preferência de horário");
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await db.from("conversations").select("status").eq("id", conversation).single()).data
            ?.status,
      )
      .toBe("closed");
    expect(
      (await db.from("demandas").select("fechada_em").eq("id", demand).single()).data?.fechada_em,
    ).toBeNull();
    expect(
      (await db.from("conversations").select("status").eq("id", conversations[1]).single()).data
        ?.status,
    ).toBe("open");
    await expect(
      panel.getByRole("button", { name: "Encerrar demanda", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `${evidence}/task4-conversa-fechada-demanda-aberta.png`,
      fullPage: true,
    });
    await panel.getByRole("button", { name: "Encerrar demanda", exact: true }).click();
    await panel.getByLabel("Desfecho da demanda").selectOption("resolvida");
    await panel.getByRole("button", { name: "Confirmar desfecho", exact: true }).click();
    await expect(panel).toContainText("Nenhuma demanda aberta.");
    await expect(page.getByTestId("inbox-memoria")).toContainText("Histórico encerrado");
    await inbound("Voltei para novo atendimento");
    await expect(panel.getByText("Demanda vigente neste canal")).toBeVisible();
    await page.goto("/app/inbox?filter=unassigned");
    await page.getByText("Voltei para novo atendimento", { exact: true }).first().click();
    await expect(
      page.getByTestId("inbox-demandas").getByText("Demanda vigente neste canal"),
    ).toBeVisible();
    const current = await db
      .from("conversations")
      .select("current_demanda_id,status")
      .eq("id", conversation)
      .single();
    expect(current.data?.current_demanda_id).not.toBe(demand);
    expect(current.data?.status).toBe("open");
    await page.getByRole("button", { name: "Assumir", exact: true }).click();
    await expect(page.getByRole("button", { name: "Liberar", exact: true })).toBeVisible();
    await expect(page.getByText("Sem responsável", { exact: true })).toHaveCount(0);
    await page
      .getByRole("textbox", { name: "Mensagem", exact: true })
      .fill("Olá, vamos cuidar deste novo atendimento.");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(() => hits.filter((url) => url.includes("sendText")).length).toBe(1);
    await expect(
      page.getByText("Olá, vamos cuidar deste novo atendimento.", { exact: true }).first(),
    ).toBeVisible();
    const box = await page.getByTestId("inbox-demandas").boundingBox();
    expect(box?.width).toBeGreaterThan(150);
    await page.screenshot({ path: `${evidence}/task4-reaberto-respondido.png`, fullPage: true });
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await db.from("conversations").select("status").eq("id", conversation).single()).data
            ?.status,
      )
      .toBe("closed");
    await insert("agent_cases", { organization_id: org, conversation_id: conversation,
      title: "Caso de atendimento anterior", summary: "Resposta pendente anterior", blocker: "Decisão humana",
      context_snapshot: { service_boundary: originalBoundary.data } });
    await page.goto("/app/ai/cases");
    await page.getByTestId("case-item").filter({ hasText: "Caso de atendimento anterior" }).click();
    await page.getByRole("radio", { name: /Não consigo — passar pra humano/ }).click();
    await page.getByPlaceholder("Escreva sua resposta para a IA...").fill("Resposta registrada após mudança do atendimento");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByText("Resposta registrada; não repassada porque o atendimento mudou. Revise a conversa.", { exact: true })).toBeVisible();
    expect(hits.filter((url) => url.includes("sendText"))).toHaveLength(1);
    await page.goto("/app/ai/inbox");
    await expect(page.getByRole("heading", { name: "Central de avisos" })).toBeVisible();
    await expect(page.getByTestId("inbox-item")).toContainText("Resposta registrada; atendimento mudou");
    await page.screenshot({ path: `${evidence}/task4-caso-obsoleto-aviso.png`, fullPage: true });
    await abrirConversa(page, conversation);
    await expect(page.getByTestId("inbox-memoria")).toContainText("Histórico encerrado");
    const language = await db.auth.admin.updateUserById(user, { user_metadata: { locale: "es" } });
    if (language.error) throw language.error;
    await page.reload();
    await expect(page.getByTestId("inbox-memoria")).toContainText("Historial cerrado — sin tareas pendientes");
    await expect(page.getByTestId("inbox-memoria")).toContainText("Resuelta");
    await page.screenshot({ path: `${evidence}/task4-historico-es.png`, fullPage: true });
    await page.getByRole("button", { name: "Reabrir", exact: true }).click();
    await expect.poll(async () => (await db.from("conversations").select("status").eq("organization_id",org).eq("id",conversation).single()).data?.status).toBe("open");
    await page.getByRole("button", { name: "Cerrar", exact: true }).click();
    await expect.poll(async () => (await db.from("conversations").select("status").eq("organization_id",org).eq("id",conversation).single()).data?.status).toBe("closed");
    expect(hits.filter((url) => url.includes("sendText"))).toHaveLength(1);

  } finally {
    await context.close().catch(() => undefined);
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    if (org) await db.from("organizations").delete().eq("id", org);
    if (user) await db.auth.admin.deleteUser(user);
  }
});


test("silêncio consulta proveniência real pelo PostgREST: legado e reabertura não viram nova autorização", async () => {
  const org = await insert("organizations", { slug: `silence-${randomUUID()}`, display_name: "Silêncio local", legal_name: "Silêncio local" });
  try {
    const contact = await insert("contacts", { organization_id: org, name: "Silêncio", phone_number: "+5511988776554" });
    const session = await insert("channel_sessions", { organization_id: org, waha_session_name: randomUUID(), status: "WORKING", webhook_secret_encrypted: "\\x00" });
    const conversation = await insert("conversations", { organization_id: org, contact_id: contact, channel_session_id: session, status: "open" });
    const rpc = async (name: string, args: Record<string, unknown>) => { const result = await db.rpc(name, args); if (result.error) throw result.error; return result.data; };
    const inbound = async (at: string) => {
      const id = await insert("messages", { organization_id: org, contact_id: contact, conversation_id: conversation, channel_session_id: session, type: "text", direction: "inbound", status: "received", sent_via: "ai", sent_at: at, body: "Mensagem" });
      await rpc("fn_mark_conversation_message", { p_conv: conversation, p_direction: "inbound", p_preview: "Mensagem", p_at: at });
      return id;
    };
    const old = await inbound(new Date(Date.now() - 600_000).toISOString());
    const sweep = createSupabaseSilenceSweepDb(db);
    const cutoff = new Date(Date.now() + 1000).toISOString();
    expect(await sweep.loadSilentContactIds(org, cutoff, [])).toEqual([contact]);
    const legacy = await db.from("messages").update({ service_revision: null, demanda_id: null, demanda_revision: null }).eq("organization_id", org).eq("id", old);
    if (legacy.error) throw legacy.error;
    expect(await sweep.loadSilentContactIds(org, cutoff, [])).toEqual([]);
    await rpc("fn_service_status", { p_org: org, p_conversation: conversation, p_status: "closed" });
    await rpc("fn_service_begin", { p_org: org, p_contact: contact, p_session: session });
    expect(await sweep.loadSilentContactIds(org, cutoff, [])).toEqual([]);
    await inbound(new Date().toISOString());
    expect(await sweep.loadSilentContactIds(org, new Date(Date.now() + 1000).toISOString(), [])).toEqual([contact]);
    await rpc("fn_service_status", { p_org: org, p_conversation: conversation, p_status: "closed" });
    await rpc("fn_service_begin", { p_org: org, p_contact: contact, p_session: session });
    expect(await sweep.loadSilentContactIds(org, new Date(Date.now() + 1000).toISOString(), [])).toEqual([]);
  } finally { await db.from("organizations").delete().eq("id", org); }
});
