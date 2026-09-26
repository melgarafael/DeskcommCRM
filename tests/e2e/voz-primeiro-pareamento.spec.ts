/**
 * Primeiro pareamento: navegador real, banco do baseline e servidor HTTP que
 * exige Bearer. O QR é sintético; este teste não vincula aparelho nem liga.
 * Uma segunda instância do app habilita voz só nesta jornada, preservando o
 * ambiente sem voz de voz-desligada-por-padrao.spec.ts.
 *
 * O upstream falso imita o WaCalls de verdade no ponto que importa: o
 * `POST /api/sessions` anuncia a sessão (`session-list`, com `name`) e emite o
 * primeiro QR ANTES de responder o id — é exatamente a janela em que a versão
 * anterior perdia o QR, e o motivo de o relay reconhecer a sessão pelo nome.
 * `POST /api/sessions/{sid}/pair` responde 405 de propósito: chamá-lo é o
 * defeito que deixava o discador preso a um cliente morto (ver
 * `lib/wacalls/client.ts`), e um pareamento que passe por ele tem de falhar aqui.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

test("a primeira sessão mostra o QR depois de aceitar e ligar a voz", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  expect(new URL(supabaseUrl).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  const db = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const id = randomUUID();
  const email = `voz-${id}@example.test`;
  const password = `Teste!${randomUUID()}`;
  const token = randomUUID();
  const sessao = randomUUID();
  const ordem: string[] = [];
  const ouvintes = new Set<ServerResponse>();
  let criadas = 0;
  let recusadas = 0;
  let processo: ChildProcess | undefined;
  let userId: string | undefined;

  const upstream = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      recusadas += 1;
      res.writeHead(401).end();
      return;
    }
    if (req.url === "/api/events") {
      ordem.push("eventos");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": conectado\n\n");
      ouvintes.add(res);
      req.on("close", () => ouvintes.delete(res));
      return;
    }
    if (req.method === "GET" && req.url === "/api/sessions") {
      // A rota lê o estado do WaCalls antes de apagar ou criar qualquer coisa.
      ordem.push("listar");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/sessions") {
      criadas += 1;
      ordem.push("criar");
      for (const ouvinte of ouvintes) {
        ouvinte.write(
          `data: ${JSON.stringify({
            type: "session-list",
            sessions: [{ id: sessao, name: `org_${id}`, jid: "", state: "qr", paired: false }],
          })}\n\n`,
        );
        ouvinte.write(
          `data: ${JSON.stringify({
            type: "auth-state",
            sessionId: sessao,
            qr: "qr-sintetico-do-e2e",
            paired: false,
          })}\n\n`,
        );
      }
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: sessao }));
      return;
    }
    if (req.method === "POST" && req.url === `/api/sessions/${sessao}/pair`) {
      ordem.push("parear");
      res.writeHead(405).end();
      return;
    }
    res.writeHead(404).end();
  });

  try {
    const org = await db.from("organizations").insert({
      id,
      slug: `voz-${id}`,
      display_name: "Empresa de teste de voz",
      legal_name: "Empresa de teste de voz",
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      onboarded_at: new Date().toISOString(),
    });
    expect(org.error).toBeNull();
    const usuario = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Administrador de teste" },
    });
    expect(usuario.error).toBeNull();
    userId = usuario.data.user!.id;
    const vinculo = await db.from("user_organizations").insert({
      user_id: userId,
      organization_id: id,
      role: "admin",
      accepted_at: new Date().toISOString(),
    });
    expect(vinculo.error).toBeNull();

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const reserva = createServer();
    await new Promise<void>((resolve) => reserva.listen(0, "127.0.0.1", resolve));
    const porta = (reserva.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reserva.close(() => resolve()));
    const url = `http://127.0.0.1:${porta}`;
    processo = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(porta),
      ],
      {
        env: {
          ...process.env,
          NEXT_PUBLIC_APP_URL: url,
          WACALLS_API_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
          WACALLS_API_TOKEN: token,
        },
        stdio: "ignore",
      },
    );
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`${url}/login`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 45_000 },
      )
      .toBe(200);

    await page.goto(`${url}/login`);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: /^entrar$/i }).click();
    await page.waitForURL(/\/app(?:\/|$)/);
    await page.goto(`${url}/app/settings/security`);
    const painel = page.getByTestId("painel-voz");
    await expect(painel.getByRole("button", { name: "Ligar chamada de voz" })).toBeDisabled();
    await painel.getByRole("checkbox").check();
    await painel.getByRole("button", { name: "Ligar chamada de voz" }).click();
    await expect(
      painel.getByText("Ligada. Sua equipe pode ligar e receber chamadas pelo número conectado."),
    ).toBeVisible({ timeout: 20_000 });

    await page.goto(`${url}/app/connections?aba=voz`);
    await expect(page.getByText("A chamada de voz não está configurada.")).toHaveCount(0);
    await page.getByRole("button", { name: "Parear chamada de voz" }).click();
    const qr = page.getByAltText("QR Code para parear chamada de voz");
    await expect(qr).toBeVisible({ timeout: 15_000 });
    expect(await qr.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(criadas).toBe(1);
    expect(recusadas).toBe(0);
    expect(ordem).toEqual(["eventos", "listar", "criar"]);
    const canal = await db
      .from("channel_sessions")
      .select("organization_id, provider, wacalls_session_id")
      .eq("organization_id", id)
      .eq("provider", "wacalls")
      .single();
    expect(canal.error).toBeNull();
    expect(canal.data?.wacalls_session_id).toBe(sessao);
    await page.screenshot({ path: testInfo.outputPath("primeiro-pareamento.png"), fullPage: true });
  } finally {
    for (const res of ouvintes) res.end();
    if (processo && processo.exitCode === null) {
      processo.kill("SIGTERM");
      await new Promise<void>((resolve) => processo!.once("exit", () => resolve()));
    }
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await db.from("organizations").delete().eq("id", id);
    if (userId) await db.auth.admin.deleteUser(userId);
  }
});
