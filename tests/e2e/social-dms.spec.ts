import { execFileSync } from "node:child_process";
import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { metadataInicialDoCanal } from "../../lib/ai/elegibilidade/pre-go-live";

// Auth, RLS, assinatura e inbox reais. Credencial fictícia: nenhum envio externo.
test.use({ locale: "pt-BR" });
test("DM assinada chega ao inbox e respeita controle humano e janela", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(150_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname))
    throw new Error("Somente banco local");
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const suffix = randomUUID().slice(0, 8),
    orgName = `social-${suffix}`;
  const email = `social-${suffix}@example.test`,
    password = `E2e-${randomUUID()}!`;
  execFileSync("pnpm", ["exec", "tsx", "scripts/bootstrap-owner.ts"], {
    env: { ...process.env, OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_ORG_NAME: orgName },
    stdio: "pipe",
  });
  const org = (await db.from("organizations").select("id").eq("slug", orgName).single()).data!.id;
  expect(
    (
      await db
        .from("organizations")
        .update({ onboarded_at: new Date().toISOString() })
        .eq("id", org)
    ).error,
  ).toBeNull();
  const secret = `fixture-${randomUUID()}`;
  const seal = (text: string) => {
    const iv = randomBytes(12),
      cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(process.env.AI_CRED_AES_KEY!, "base64"),
        iv,
      );
    return {
      ciphertext: Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  };
  const connection = await db
    .from("social_connections")
    .insert({
      organization_id: org,
      account_id: orgName,
      credential: seal("fixture-no-live-credential"),
      webhook_secret: seal(secret),
      webhook_id: `fixture-${suffix}`,
    })
    .select("id,webhook_token")
    .single();
  expect(connection.error).toBeNull();
  const channelId = `ig-${suffix}`;
  const channel = await db
    .from("channel_sessions")
    .insert({
      organization_id: org,
      provider: "socios_hub",
      social_connection_id: connection.data!.id,
      social_channel_id: channelId,
      social_network: "instagram",
      display_name: "Instagram de validação",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
      metadata: metadataInicialDoCanal(),
    })
    .select("id")
    .single();
  expect(channel.error).toBeNull();
  const id = `event-${randomUUID()}`,
    timestamp = Math.floor(Date.now() / 1000).toString();
  const event = {
    id,
    event: "message.received",
    subaccount_id: orgName,
    channel_id: channelId,
    created_at: Number(timestamp),
    data: {
      message_id: `dm-${suffix}`,
      channel: "instagram",
      channel_id: channelId,
      conversation_id: `thread-${suffix}`,
      contact_id: `person-${suffix}`,
      from: { external_id: "00123456789012345678", name: "Pessoa da DM de teste" },
      type: "text",
      timestamp: Date.now(),
      content: { text: "DM assinada para validar o atendimento" },
    },
  };
  const raw = JSON.stringify(event);
  const headers = {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${raw}`).digest("base64")}`,
  };
  const endpoint = `/api/v1/webhooks/social/${connection.data!.webhook_token}`;
  expect(
    (
      await request.post(endpoint, {
        data: raw,
        headers: { ...headers, "webhook-signature": "v1,forged" },
      })
    ).status(),
  ).toBe(401);
  for (let i = 0; i < 2; i++)
    expect((await request.post(endpoint, { data: raw, headers })).ok()).toBe(true);
  const messages = await db
    .from("messages")
    .select("id,conversation_id")
    .eq("organization_id", org)
    .eq("external_id", `socios_hub:dm-${suffix}`);
  expect(messages.data).toHaveLength(1);
  const convId = messages.data![0]!.conversation_id;
  const read = async () =>
    (
      await db
        .from("conversations")
        .select("bot_silenced_until,provider_recipient_id")
        .eq("organization_id", org)
        .eq("id", convId)
        .single()
    ).data!;
  expect((await read()).provider_recipient_id).toBe("00123456789012345678");
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/);
  await page.goto("/app/connections?aba=sociais");
  await expect(page.getByRole("heading", { name: "Instagram e Facebook Messenger" })).toBeVisible();
  await expect(page.getByText("Instagram de validação", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Atendimento humano disponível. A IA está bloqueada neste canal."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Liberar IA neste canal" }).click();
  await expect
    .poll(
      async () =>
        (
          await db
            .from("channel_sessions")
            .select("metadata")
            .eq("organization_id", org)
            .eq("id", channel.data!.id)
            .single()
        ).data!.metadata.ai_gate,
    )
    .toBe("open");
  await page.getByRole("button", { name: "Bloquear IA neste canal" }).click();
  await expect
    .poll(
      async () =>
        (
          await db
            .from("channel_sessions")
            .select("metadata")
            .eq("organization_id", org)
            .eq("id", channel.data!.id)
            .single()
        ).data!.metadata.ai_gate,
    )
    .toBe("allowlist");
  await expect(
    page.getByText("Atendimento humano disponível. A IA está bloqueada neste canal."),
  ).toBeVisible();
  await expect(page.getByText("Acesso da IA atualizado.", { exact: true })).toHaveCount(0, {
    timeout: 10_000,
  });
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("social-connections.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("body").evaluate((el) => el.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("social-connections-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/app/inbox?id=${convId}`);
  await expect(
    page.getByText("DM assinada para validar o atendimento", { exact: true }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Assumir", exact: true }).click();
  await expect.poll(async () => (await read()).bot_silenced_until).toBe("infinity");
  await page.getByTestId("devolver-ao-automatico").click();
  await expect.poll(async () => (await read()).bot_silenced_until).toBeNull();
  expect(
    (
      await db
        .from("conversations")
        .update({ last_inbound_at: new Date(Date.now() - 25 * 3600_000).toISOString() })
        .eq("organization_id", org)
        .eq("id", convId)
    ).error,
  ).toBeNull();
  await page.reload();
  await expect(
    page.getByText(
      "Aguarde uma nova mensagem do cliente para responder. Este canal não oferece modelos fora da janela.",
    ),
  ).toBeVisible();
  const blocked = await page.request.post("/api/v1/messages", {
    data: { conversation_id: convId, type: "text", body: "Não deve sair da instalação" },
  });
  const result = await blocked.json();
  expect(result.data?.status).toBe("failed");
  expect(result.data?.error_message).toContain("janela de resposta fechou");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("social-inbox-mobile.png"), fullPage: true });
});
