import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page, type TestInfo, type Locator } from "@playwright/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { createApprovedReplyHandler } from "../../lib/agent-engine/agent/approved-reply";
import { seedPlatformPlaybook } from "../../lib/agent-engine/agent/playbook-seed";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;
const orgs: string[] = [],
  users: string[] = [];
test.use({ trace: "on", timezoneId: "America/Sao_Paulo", viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 180_000 });
async function insert(table: string, value: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw error;
  return data.id as string;
}
async function fixture(pool: pg.Pool) {
  expect(["127.0.0.1", "localhost"]).toContain(new URL(credentials.dbUrl).hostname);
  expect(process.env.INTERNAL_AGENT_RUN_STUB).toBe("true");
  // O QA não sobe o worker: reproduzir seu bootstrap idempotente, sem mover ponteiro existente.
  await seedPlatformPlaybook(pool);
  const email = `autonomia-ui-${randomUUID()}@invariant.test`;
  const result = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (result.error || !result.data.user) throw result.error;
  const user = result.data.user.id;
  users.push(user);
  const org = await insert("organizations", {
    slug: `autonomia-ui-${randomUUID()}`,
    display_name: "Autonomia local",
    legal_name: "Autonomia local",
    onboarded_at: new Date().toISOString(),
  });
  orgs.push(org);
  await insert("user_organizations", {
    organization_id: org,
    user_id: user,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  const sessionName = randomUUID();
  const channel = await insert("channel_sessions", {
    organization_id: org,
    waha_session_name: sessionName,
    display_name: "Revisão local",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
    metadata: { ai_gate: "allowlist" },
  });
  const knobs = await db
    .from("channel_knobs")
    .insert({
      organization_id: org,
      channel_session_id: channel,
      throttle_ms: 0,
      jitter_max_ms: 0,
      window_start_hour: 0,
      window_end_hour: 24,
    });
  if (knobs.error) throw knobs.error;
  const contact = await insert("contacts", {
    organization_id: org,
    name: "Maria Revisão",
    display_name: "Maria Revisão",
    phone_number: "+15551234567",
    force_human: true,
  });
  const conversation = await insert("conversations", {
    organization_id: org,
    contact_id: contact,
    channel_session_id: channel,
    status: "open",
    assignee_kind: "user",
    assigned_to_user_id: user,
    bot_silenced_until: "infinity",
  });
  const agent = await insert("ai_agents", {
    organization_id: org,
    name: "Assistente para revisão",
    system_prompt: "Ajude com informações confirmadas.",
    operation_mode: "assisted",
  });
  const version = await insert("ai_agent_versions", {
    organization_id: org,
    agent_id: agent,
    version_number: 1,
    system_prompt: "Ajude com informações confirmadas.",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    channel_session_id: channel,
    status: "published",
  });
  const source = await insert("ai_knowledge_sources", {
    organization_id: org,
    agent_id: agent,
    source_type: "faq",
    name: "Atendimento",
    status: "ready",
  });
  const knowledge = await insert("ai_knowledge_versions", {
    organization_id: org,
    agent_id: agent,
    version_number: 1,
    is_active: true,
  });
  const chunk = randomUUID();
  await pool.query(
    "insert into ai_chunks(id,organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding,metadata) values($1::uuid,$2,$3,$4,0,'Informações de atendimento disponíveis com confirmação humana.',$1::text,12,array_fill(0.1::real,array[1536])::vector,'{}')",
    [chunk, org, source, knowledge],
  );
  await pool.query(
    "update ai_agents set published_version_id=$1,active_kb_version_id=$2 where organization_id=$3 and id=$4",
    [version, knowledge, org, agent],
  );
  await pool.query(
    "update conversations set active_ai_agent_id=$1 where organization_id=$2 and id=$3",
    [agent, org, conversation],
  );
  const f = { org, user, email, channel, sessionName, contact, conversation, agent, version };
  await inbound(f, "Quero informações do atendimento");
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function inbound(
  f: Pick<Fixture, "org" | "contact" | "conversation" | "channel">,
  body: string,
) {
  const at = new Date().toISOString();
  await insert("messages", {
    organization_id: f.org,
    contact_id: f.contact,
    conversation_id: f.conversation,
    channel_session_id: f.channel,
    direction: "inbound",
    type: "text",
    status: "received",
    external_id: randomUUID(),
    body,
    sent_at: at,
  });
  const r = await db.rpc("fn_mark_conversation_message", {
    p_conv: f.conversation,
    p_direction: "inbound",
    p_preview: body,
    p_at: at,
  });
  if (r.error) throw r.error;
}
async function login(page: Page, f: Fixture) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(f.email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}
async function capture(page: Page, target: Locator, info: TestInfo, name: string) {
  await target.scrollIntoViewIfNeeded();
  const dir = info.outputPath(name);
  mkdirSync(dir, { recursive: true });
  const measured = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      width: r.width,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      viewport: document.documentElement.clientWidth,
      visibility: getComputedStyle(el).visibility,
    };
  });
  expect(measured.left).toBeGreaterThanOrEqual(0);
  expect(measured.right).toBeLessThanOrEqual(measured.viewport + 1);
  expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth + 1);
  expect(measured.visibility).toBe("visible");
  writeFileSync(`${dir}/measures.json`, JSON.stringify(measured, null, 2));
  await page.screenshot({ path: `${dir}/loaded.png`, fullPage: true });
}
async function receiver() {
  const bodies: Record<string, unknown>[] = [];
  const target = new URL(process.env.WAHA_API_BASE_URL!);
  expect(["127.0.0.1", "localhost"]).toContain(target.hostname);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += String(part);
    bodies.push(JSON.parse(raw));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: randomUUID() }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(target.port), target.hostname, resolve);
  });
  return {
    bodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const panel = (page: Page) => page.locator('section[aria-label="Assistência do agente"]');
async function generate(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/draft-reply") && r.request().method() === "POST",
  );
  await panel(page).getByRole("button", { name: "Sugerir resposta", exact: true }).click();
  const r = await response;
  expect(r.status(), await r.text()).toBe(200);
  await expect(panel(page).getByText("Sugestão para revisar", { exact: true })).toBeVisible();
  return (await r.json()).data.draft_id as string;
}
async function deliver(f: Fixture, draft: string, pool: pg.Pool) {
  const { rows } = await pool.query(
    "update job_queue j set status='running',locked_by='autonomia-browser',locked_at=clock_timestamp(),attempts=attempts+1 from ai_reply_drafts d where d.organization_id=$1 and d.id=$2 and j.organization_id=d.organization_id and j.id=d.send_job_id and j.status='pending' returning j.*,j.locked_at::text claim_acquired_at",
    [f.org, draft],
  );
  expect(rows).toHaveLength(1);
  // Only acquisition is fixture-controlled; the canonical consumer, ledger and HTTP execute.
  await createApprovedReplyHandler({
    crmCfg: { supabase: db },
    log: { info() {}, warn() {}, error() {} },
    sleep: async () => {},
  })(rows[0], pool);
  expect(
    (
      await pool.query("select status from ai_reply_drafts where organization_id=$1 and id=$2", [
        f.org,
        draft,
      ])
    ).rows[0].status,
  ).toBe("sent");
  return rows[0].id as string;
}
test.afterAll(async () => {
  for (const org of orgs) {
    const r = await db.from("organizations").delete().eq("id", org);
    if (r.error) throw r.error;
  }
  for (const user of users) {
    const r = await db.auth.admin.deleteUser(user);
    if (r.error) throw r.error;
  }
});
test("testa sem enviar, pausa preserva publicação e duas aprovações entregam texto revisado sem silenciar assistência", async ({
  page,
}, info) => {
  const pool = new pg.Pool({ connectionString: credentials.dbUrl, max: 5 }),
    channel = await receiver();
  try {
    const f = await fixture(pool);
    await login(page, f);
    await page.goto(`/app/ai/agents/${f.agent}`);
    await page.getByRole("tab", { name: "Teste", exact: true }).click();
    await page.getByLabel("Mensagem do cliente (sample)").fill("Quais informações vocês oferecem?");
    await page.getByLabel("Nome (opcional)").fill("Maria do cenário");
    await page.getByLabel("Telefone (opcional)").fill("+15551234567");
    const count = async () =>
      (
        await pool.query(
          "select (select count(*) from messages where organization_id=$1) messages,(select count(*) from job_queue where organization_id=$1) jobs,(select count(*) from lead_notes where organization_id=$1) notes,(select count(*) from lead_checkpoints where organization_id=$1) checkpoints",
          [f.org],
        )
      ).rows[0];
    const before = await count();
    const tested = page.waitForResponse(
      (r) => r.url().endsWith(`/versions/${f.version}/test`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Executar teste", exact: true }).click();
    const response = await tested;
    expect(response.status(), await response.text()).toBe(200);
    const preview = (await response.json()).data;
    expect(preview.candidates.length).toBeGreaterThan(0);
    expect(JSON.parse(response.request().postData()!).sample_contact.name).toBe("Maria do cenário");
    await expect(
      page.getByText(
        "Mesmo motor e conhecimento do agente; nenhuma alteração é aplicada ao cliente.",
      ),
    ).toBeVisible();
    expect(await count()).toEqual(before);
    expect(channel.bodies).toHaveLength(0);
    await capture(page, page.getByRole("tabpanel"), info, "sandbox-desktop");
    await page.getByRole("button", { name: "Pausar automático", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Retomar automático", exact: true }),
    ).toBeVisible();
    expect(
      (
        await pool.query(
          "select published_version_id,paused_at from ai_agents where organization_id=$1 and id=$2",
          [f.org, f.agent],
        )
      ).rows[0],
    ).toMatchObject({ published_version_id: f.version, paused_at: expect.any(Date) });
    await page.goto(`/app/inbox/${f.conversation}`);
    const first = await generate(page);
    expect(channel.bodies).toHaveLength(0);
    await panel(page)
      .getByLabel("Resposta sugerida")
      .fill("Maria, confirmei as informações e posso ajudar por aqui.");
    await panel(page)
      .getByLabel("Feedback para a próxima sugestão")
      .fill("Usar linguagem curta e clara.");
    await capture(page, panel(page), info, "revisao-desktop");
    const approved = page.waitForResponse(
      (r) => r.url().endsWith(`/ai/replies/${first}`) && r.request().method() === "POST",
    );
    await panel(page).getByRole("button", { name: "Aprovar e enviar" }).click();
    expect((await approved).status()).toBe(200);
    const firstJob = await deliver(f, first, pool);
    expect(channel.bodies).toHaveLength(1);
    expect(channel.bodies[0]).toMatchObject({
      session: f.sessionName,
      chatId: "15551234567@c.us",
      text: "Maria, confirmei as informações e posso ajudar por aqui.",
    });
    await expect(panel(page).getByText("Resposta aprovada enviada", { exact: true })).toBeVisible();
    await inbound(f, "Obrigada, pode continuar");
    const second = await generate(page);
    await panel(page)
      .getByLabel("Resposta sugerida")
      .fill("Claro, Maria. Qual informação você precisa agora?");
    const approvedAgain = page.waitForResponse(
      (r) => r.url().endsWith(`/ai/replies/${second}`) && r.request().method() === "POST",
    );
    await panel(page).getByRole("button", { name: "Aprovar e enviar" }).click();
    expect((await approvedAgain).status()).toBe(200);
    expect(await deliver(f, second, pool)).not.toBe(firstJob);
    expect(channel.bodies).toHaveLength(2);
    expect(
      (
        await pool.query(
          "select bot_silenced_until::text,assigned_to_user_id from conversations where organization_id=$1 and id=$2",
          [f.org, f.conversation],
        )
      ).rows[0],
    ).toEqual({ bot_silenced_until: "infinity", assigned_to_user_id: f.user });
    expect(
      (
        await pool.query(
          "select force_human,ai_authorized_at from contacts where organization_id=$1 and id=$2",
          [f.org, f.contact],
        )
      ).rows[0],
    ).toEqual({ force_human: true, ai_authorized_at: null });
    // Uma nova entrada cria outra candidata; repetir no mesmo contexto devolve o recibo já enviado.
    await inbound(f, "Tenho mais uma pergunta sobre o atendimento");
    const third = await generate(page);
    expect(third).not.toBe(second);
    await inbound(f, "O assunto mudou");
    await expect(
      panel(page).getByText("Sugestão obsoleta: a conversa mudou", { exact: true }),
    ).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Aprovar e enviar" })).toHaveCount(0);
    await expect(panel(page).getByText("Resposta aprovada. Acompanhe o envio aqui.", { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, panel(page), info, "obsoleta-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/app/ai/agents/${f.agent}`);
    await page.getByLabel("Modo de operação").selectOption("automatic");
    await expect(page.getByLabel("Modo de operação")).toHaveValue("automatic");
    await page.getByRole("button", { name: "Retomar automático", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Pausar automático", exact: true }),
    ).toBeVisible();
    expect(
      (
        await pool.query(
          "select published_version_id,paused_at,operation_mode from ai_agents where organization_id=$1 and id=$2",
          [f.org, f.agent],
        )
      ).rows[0],
    ).toEqual({ published_version_id: f.version, paused_at: null, operation_mode: "automatic" });
    await capture(
      page,
      page.locator('section[aria-label="Operação do agente"]'),
      info,
      "automatico-desktop",
    );
    expect(channel.bodies).toHaveLength(2);
  } finally {
    await page.close();
    await channel.close();
    await pool.end();
  }
});
