import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const evidence = ".superpowers/evidence/comunidade-360";

test.use({ trace: "on" });
test.describe.configure({ timeout: 180_000 });

async function insert(table: string, value: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/);
}

async function drain(page: Page): Promise<{
  batch_size: number;
  outcomes: Record<string, number>;
  errors: string[];
}> {
  const secret = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!secret) throw new Error("cron_secret_ausente");
  const response = await page.request.post("/api/v1/cron/routing-worker", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    data: { batch_size: number; outcomes: Record<string, number>; errors: string[] };
  };
  return body.data;
}

async function routingEventCount(org: string, status?: string): Promise<number> {
  let query = db
    .from("event_log")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org)
    .eq("event_type", "conversation.routing_requested");
  if (status) query = query.eq("status", status);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/**
 * O cron de roteamento é GLOBAL: drena a fila da instalação inteira, e as
 * asserções abaixo contam o LOTE. Esta função RECUSAVA rodar quando existisse
 * item vencido de outra org — o que parecia proteger o teste e o tornava
 * IMPOSSÍVEL de passar: `trg_conversation_routing_requested` (migration 0040)
 * dispara em TODA conversa nova sem dono, e nenhum outro ponto da suíte drena
 * essa fila (`grep -rln "cron/routing-worker" tests/e2e/` devolve só este
 * arquivo). A fila só acumula; exigir que ela esteja vazia é exigir que
 * nenhuma outra spec tenha criado conversa.
 *
 * Medido nas duas pontas antes de trocar: a MESMA recusa com 152 specs antes
 * (run 34072172013, quando tudo era PARTE_2) e com 18 antes (run 34145244454,
 * PARTE_3). Vizinhanças opostas, desfecho idêntico — não é contaminação de
 * vizinha, é premissa falsa da guarda.
 *
 * Em vez de recusar, ADIAMOS o que não é nosso: `next_attempt_at` no futuro sai
 * do claim do worker (`lib/routing/worker.ts`) sem apagar linha nenhuma, e o
 * lote passa a ser só o desta org — que é exatamente o que as asserções medem.
 */
async function deferForeignRoutingDue(org: string): Promise<void> {
  const agora = new Date();
  const { error } = await db
    .from("event_log")
    .update({ next_attempt_at: new Date(agora.getTime() + 3_600_000).toISOString() })
    .eq("event_type", "conversation.routing_requested")
    .eq("status", "pending")
    .neq("organization_id", org)
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${agora.toISOString()}`);
  if (error) throw error;
}

async function createUser(name: string, password: string): Promise<{ id: string; email: string }> {
  const email = `routing-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (error || !data.user) throw error ?? new Error("auth_user_missing");
  return { id: data.user.id, email };
}

test("configura responsáveis por canal e o cron distribui sem misturar números", async ({
  browser,
}) => {
  const password = `Local-${randomUUID()}!`;
  const users: Array<{ id: string; email: string }> = [];
  let org = "";
  let context: BrowserContext | undefined;
  const receiverHits: string[] = [];
  const receiverUrl = new URL(process.env.WAHA_API_BASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "::1", "[::1]"]).toContain(receiverUrl.hostname);
  expect(receiverUrl.port).toBe("3999");
  const receiver = createServer((req, res) => {
    receiverHits.push(`${req.method ?? ""} ${req.url ?? ""}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "STOPPED" }));
  });
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(Number(receiverUrl.port), receiverUrl.hostname, resolve);
  });

  try {
    const manager = await createUser("Gestora Roteamento", password);
    const ana = await createUser("Ana Canal Norte", password);
    const bruno = await createUser("Bruno Canal Sul", password);
    users.push(manager, ana, bruno);

    org = await insert("organizations", {
      slug: `routing-${randomUUID()}`,
      display_name: "Roteamento por canal local",
      legal_name: "Roteamento por canal local",
      onboarded_at: new Date().toISOString(),
      settings: {
        routing: { mode: "round_robin", max_retries: 0, backoff_seconds: 1 },
        visibility_mode: "all",
      },
    });
    for (const [user, role] of [
      [manager, "manager"],
      [ana, "agent"],
      [bruno, "agent"],
    ] as const) {
      await insert("user_organizations", {
        organization_id: org,
        user_id: user.id,
        role,
        accepted_at: new Date().toISOString(),
      });
    }
    for (const [user, capacity] of [
      [ana, 1],
      [bruno, 5],
    ] as const) {
      const { error } = await db.from("attendant_availability").insert({
        organization_id: org,
        user_id: user.id,
        is_available: true,
        capacity,
        schedule: {},
      });
      if (error) throw error;
    }

    const north = await insert("channel_sessions", {
      organization_id: org,
      waha_session_name: `routing-north-${randomUUID()}`,
      display_name: "Canal Norte",
      status: "STOPPED",
      webhook_secret_encrypted: "\\x00",
    });
    const south = await insert("channel_sessions", {
      organization_id: org,
      waha_session_name: `routing-south-${randomUUID()}`,
      display_name: "Canal Sul",
      status: "STOPPED",
      webhook_secret_encrypted: "\\x00",
    });

    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page, manager.email, password);
    await page.goto("/app/settings/atendimento");
    await expect(page.getByRole("heading", { name: "Distribuição de atendimento" })).toBeVisible();

    const northGroup = page.getByRole("group", { name: "Canal Norte" });
    const southGroup = page.getByRole("group", { name: "Canal Sul" });
    await expect(northGroup.getByTestId("channel-routing-state")).toHaveText(
      "Usa todos os atendentes elegíveis da organização.",
    );
    await northGroup.getByLabel("Ana Canal Norte", { exact: true }).check();
    await northGroup.getByRole("button", { name: "Salvar responsáveis" }).click();
    await expect(northGroup.getByTestId("channel-routing-state")).toHaveText(
      "Somente as pessoas selecionadas recebem este número.",
    );

    await southGroup.getByRole("button", { name: "Salvar responsáveis" }).click();
    await expect(southGroup.getByTestId("channel-routing-state")).toHaveText(
      "Ninguém configurado — as conversas ficarão na fila.",
    );

    mkdirSync(evidence, { recursive: true });
    await page.screenshot({
      path: `${evidence}/task10-routing-policies-desktop.png`,
      fullPage: true,
    });
    const desktop = {
      viewport: page.viewportSize(),
      document: await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
      north: await northGroup.boundingBox(),
      south: await southGroup.boundingBox(),
    };
    expect(desktop.document.scrollWidth).toBeLessThanOrEqual(desktop.document.clientWidth);

    await page.setViewportSize({ width: 390, height: 844 });
    await southGroup.scrollIntoViewIfNeeded();
    await expect(southGroup).toBeVisible();
    await page.screenshot({
      path: `${evidence}/task10-routing-empty-mobile.png`,
      fullPage: true,
    });
    const mobile = {
      viewport: page.viewportSize(),
      document: await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
      south: await southGroup.boundingBox(),
    };
    expect(mobile.document.scrollWidth).toBeLessThanOrEqual(mobile.document.clientWidth);
    writeFileSync(
      `${evidence}/task10-routing-medidas.json`,
      `${JSON.stringify({ desktop, mobile }, null, 2)}\n`,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });

    async function conversation(
      channel: string,
      contactName: string,
      phone: string,
    ): Promise<string> {
      const contact = await insert("contacts", {
        organization_id: org,
        name: contactName,
        display_name: contactName,
        phone_number: phone,
        force_human: true,
      });
      const id = await insert("conversations", {
        organization_id: org,
        contact_id: contact,
        channel_session_id: channel,
        status: "open",
        bot_silenced_until: "infinity",
      });
      await insert("messages", {
        organization_id: org,
        contact_id: contact,
        conversation_id: id,
        channel_session_id: channel,
        direction: "inbound",
        type: "text",
        status: "received",
        sent_via: "ai",
        body: `Mensagem de ${contactName}`,
        sent_at: new Date().toISOString(),
      });
      return id;
    }

    const northConversation = await conversation(north, "Cliente Canal Norte", "+5511999000011");
    const southConversation = await conversation(south, "Cliente Canal Sul", "+5511999000022");
    await expect.poll(() => routingEventCount(org)).toBe(2);
    await deferForeignRoutingDue(org);

    const firstDrain = await drain(page);
    expect(firstDrain.errors).toEqual([]);
    expect(firstDrain.batch_size).toBe(2);
    expect(firstDrain.outcomes.assigned).toBe(1);
    expect(firstDrain.outcomes.requeued_no_eligible).toBe(1);

    const northAssigned = await db
      .from("conversations")
      .select("assigned_to_user_id")
      .eq("organization_id", org)
      .eq("id", northConversation)
      .single();
    if (northAssigned.error) throw northAssigned.error;
    expect(northAssigned.data.assigned_to_user_id).toBe(ana.id);
    const southWaiting = await db
      .from("conversations")
      .select("assigned_to_user_id")
      .eq("organization_id", org)
      .eq("id", southConversation)
      .single();
    if (southWaiting.error) throw southWaiting.error;
    expect(southWaiting.data.assigned_to_user_id).toBeNull();

    await page.goto("/app/ai/inbox");
    const notice = page
      .getByTestId("inbox-item")
      .filter({ hasText: "Conversa aguardando responsável" });
    await expect(notice).toContainText("Confira os responsáveis do canal");
    await page.screenshot({
      path: `${evidence}/task10-routing-notice-desktop.png`,
      fullPage: true,
    });
    await notice.getByRole("link", { name: "Abrir conversa" }).click();
    await expect(page).toHaveURL(new RegExp(`/app/inbox/${southConversation}$`));
    await expect(
      page.getByText("Mensagem de Cliente Canal Sul", { exact: true }).first(),
    ).toBeVisible();

    await page.goto("/app/settings/atendimento");
    const resetSouth = page.getByRole("group", { name: "Canal Sul" });
    await resetSouth.getByRole("button", { name: "Voltar ao padrão da organização" }).click();
    await expect(resetSouth.getByTestId("channel-routing-state")).toHaveText(
      "Usa todos os atendentes elegíveis da organização.",
    );
    await expect.poll(() => routingEventCount(org, "pending")).toBe(1);
    await deferForeignRoutingDue(org);

    const secondDrain = await drain(page);
    expect(secondDrain.errors).toEqual([]);
    expect(secondDrain.batch_size).toBe(1);
    expect(secondDrain.outcomes.assigned).toBe(1);
    const southAssigned = await db
      .from("conversations")
      .select("assigned_to_user_id")
      .eq("organization_id", org)
      .eq("id", southConversation)
      .single();
    if (southAssigned.error) throw southAssigned.error;
    expect(southAssigned.data.assigned_to_user_id).toBe(bruno.id);

    await page.goto("/app/ai/inbox");
    await expect(notice).toHaveCount(0);
    await page.getByRole("tab", { name: "Resolvidos", exact: true }).click();
    await expect(notice).toBeVisible();
    await page.screenshot({
      path: `${evidence}/task10-routing-reset-resolved.png`,
      fullPage: true,
    });

    expect(receiverHits.some((hit) => hit.includes("sendText"))).toBe(false);
  } finally {
    await context?.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    if (org) {
      const cleanup = await db.from("organizations").delete().eq("id", org);
      if (cleanup.error) throw cleanup.error;
    }
    for (const user of users) {
      const cleanup = await db.auth.admin.deleteUser(user.id);
      if (cleanup.error) throw cleanup.error;
    }
  }
});
