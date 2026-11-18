/**
 * CONECTAR O WHATSAPP POR CÓDIGO DE PAREAMENTO, PELA TELA (#963, fatia A).
 *
 * Conectar o número é a primeira impressão do produto, e o código é o caminho
 * de quem não consegue apontar a câmera para a tela (o computador É o celular,
 * ou a câmera não lê). Os testes de componente e de rota provam cada peça; este
 * prova a jornada inteira num navegador real, contra o app de produção, o banco
 * do baseline e um WAHA falso que responde no endereço que o `.env.e2e` já usa.
 *
 * O WAHA falso guarda ESTADO: `stop` deixa a sessão STOPPED, `start` a leva a
 * SCAN_QR_CODE — o estado em que o pareamento é permitido. A rota de pareamento
 * recusa sessão em qualquer outro estado, então um falso que respondesse
 * SCAN_QR_CODE sempre esconderia justamente a guarda que importa.
 *
 * Organização e administrador próprios, apagados no fim: pedir código num canal
 * da organização compartilhada do CI deixaria rastro nas outras specs.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const EVIDENCIA = "evidence/pareamento-por-codigo";

test.use({ trace: "on" });
test.describe.configure({ timeout: 180_000 });

async function insert(table: string, value: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw error;
  return data.id as string;
}

test("o código aparece; expirar o QR sem parear libera a vaga e permite retomar", async ({ page }) => {
  const receiverUrl = new URL(process.env.WAHA_API_BASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "::1", "[::1]"]).toContain(receiverUrl.hostname);
  expect(receiverUrl.port).toBe("3999");

  const sessao = `pc-${randomUUID().slice(0, 8)}`;
  let estado = "STOPPED";
  const pedidosDeCodigo: { caminho: string; corpo: string }[] = [];
  const upstream = createServer((req, res) => {
    const url = req.url ?? "";
    const metodo = req.method ?? "";
    let corpo = "";
    req.on("data", (parte: Buffer) => (corpo += parte.toString("utf8")));
    req.on("end", () => {
      const json = (status: number, dado: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(dado));
      };
      const daSessao = `/api/sessions/${sessao}`;
      if (metodo === "GET" && url === daSessao) {
        return json(200, { name: sessao, status: estado, engine: { engine: "NOWEB" }, config: {}, me: null });
      }
      if (metodo === "POST" && url === "/api/sessions") return json(201, { name: sessao });
      if (metodo === "POST" && url === `${daSessao}/stop`) {
        estado = "STOPPED";
        return json(201, { name: sessao });
      }
      if (metodo === "POST" && url === `${daSessao}/start`) {
        estado = "SCAN_QR_CODE";
        return json(201, { name: sessao });
      }
      if (metodo === "POST" && url === `/api/${sessao}/auth/request-code`) {
        pedidosDeCodigo.push({ caminho: url, corpo });
        return json(201, { code: "abcd1234" });
      }
      // Imagem sintética: prova o proxy e a UI, sem parear um aparelho real.
      if (metodo === "GET" && url === `/api/${sessao}/auth/qr?format=image`) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));
        return;
      }
      if (metodo === "GET" && url === "/api/server/version") return json(200, { engine: "NOWEB" });
      return json(404, { statusCode: 404, error: "Not Found", message: "Not Found" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(Number(receiverUrl.port), receiverUrl.hostname, resolve);
  });

  const password = `Local-${randomUUID()}!`;
  const email = `pareamento-${randomUUID()}@invariant.test`;
  let userId = "";
  let org = "";
  try {
    const { data: criado, error: erroDoUsuario } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Dona do Pareamento" },
    });
    if (erroDoUsuario || !criado.user) throw erroDoUsuario ?? new Error("auth_user_missing");
    userId = criado.user.id;

    org = await insert("organizations", {
      slug: `pareamento-${randomUUID()}`,
      display_name: "Pareamento por código",
      legal_name: "Pareamento por código",
      onboarded_at: new Date().toISOString(),
      settings: {},
    });
    await insert("user_organizations", {
      organization_id: org,
      user_id: userId,
      role: "admin",
      accepted_at: new Date().toISOString(),
    });
    const canal = await insert("channel_sessions", {
      organization_id: org,
      waha_session_name: sessao,
      display_name: "Recepção",
      status: "STOPPED",
      webhook_secret_encrypted: "\\x00",
      metadata: { onboarding: true },
    });

    await page.goto("/login");
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/senha/i).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app(?:\/|$)/);

    await page.goto("/app/connections");
    await page.getByRole("button", { name: "Reconectar" }).first().click();

    const dialogo = page.getByRole("dialog");
    await expect(dialogo.getByRole("group", { name: "Forma de conectar" })).toBeVisible({
      timeout: 30_000,
    });
    await dialogo.getByRole("button", { name: "Conectar por código" }).click();
    await dialogo.getByLabel("Telefone com código do país e DDD").fill("+55 (11) 99999-1234");
    await dialogo.getByRole("button", { name: "Gerar código" }).click();

    await expect(dialogo.getByLabel("Código de pareamento")).toHaveText("ABCD-1234", {
      timeout: 30_000,
    });
    mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: `${EVIDENCIA}/codigo-na-tela.png`, fullPage: true });

    // O que saiu para o transporte: o telefone só com dígitos, na sessão DESTE
    // canal — e uma vez só (o clique não pode virar dois códigos, que se
    // invalidariam um ao outro no celular).
    expect(pedidosDeCodigo).toEqual([
      {
        caminho: `/api/${sessao}/auth/request-code`,
        corpo: JSON.stringify({ phoneNumber: "5511999991234" }),
      },
    ]);

    // O pedido deixa rastro: a auditoria é fire-and-forget, então espera.
    await expect
      .poll(
        async () => {
          const { count } = await db
            .from("api_audit_log")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", org)
            .eq("action", "channel.pairing_code_requested")
            .eq("resource_id", canal);
          return count ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBe(1);

    // Ninguém leu o código nem o QR. O evento entra pela rota real, não por
    // UPDATE da spec; arquivamento, contador e reativação passam pelo baseline.
    await dialogo.getByRole("button", { name: "QR Code", exact: true }).click();
    const imagem = dialogo.getByAltText("QR Code para conectar WhatsApp");
    await expect(imagem).toBeVisible();
    await expect.poll(() => imagem.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: `${EVIDENCIA}/qr-aberto-sem-parear.png`, fullPage: true });
    const leitura = await db.from("channel_sessions").select("webhook_path_token")
      .eq("organization_id", org).eq("id", canal).single();
    expect(leitura.error).toBeNull();
    estado = "FAILED";
    const expirou = await page.request.post(`/api/v1/webhooks/waha/${leitura.data!.webhook_path_token}`, {
      data: { event: "session.status", session: sessao, payload: { status: "FAILED" } },
    });
    expect(expirou.status(), await expirou.text()).toBe(200);
    const lerCanal = async () => {
      const r = await db.from("channel_sessions").select("id,status,phone_number,archived_at")
        .eq("organization_id", org).eq("id", canal).single();
      expect(r.error).toBeNull();
      return r.data;
    };
    await expect.poll(lerCanal).toMatchObject({ id: canal, status: "STOPPED", phone_number: null, archived_at: expect.any(String) });
    const ativos = await db.from("channel_sessions").select("id", { count: "exact", head: true })
      .eq("organization_id", org).is("archived_at", null);
    expect(ativos.error).toBeNull();
    expect(ativos.count).toBe(0);
    const reaberto = await page.request.get("/api/v1/onboarding/whatsapp/session");
    expect(reaberto.status()).toBe(200);
    expect((await reaberto.json()).data.status).toBe("NOT_STARTED");
    const listaAposExpirar = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/channel-sessions" && r.request().method() === "GET");
    await page.goto("/app/connections");
    expect((await listaAposExpirar).status()).toBe(200);
    await expect(page.getByText("Carregando conexões…", { exact: true })).toBeHidden();
    await expect(page.getByRole("main").getByText("Conecte seu primeiro número de WhatsApp para começar a atender.", { exact: true })).toBeVisible();
    await expect(page.getByText("Recepção", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${EVIDENCIA}/expiracao-nao-deixa-canal-caido.png`, fullPage: true });

    // Retoma pela API do assistente e confere a volta na tela. Não afirma que
    // o clique do assistente nem um pareamento físico foram exercitados aqui.
    const retomar = await page.request.post("/api/v1/onboarding/whatsapp/session", {
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(retomar.status(), await retomar.text()).toBe(200);
    expect((await retomar.json()).data.channel_session_id).toBe(canal);
    expect(await lerCanal()).toMatchObject({ id: canal, archived_at: null, status: "SCAN_QR_CODE" });
    const listaAposRetomar = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/channel-sessions" && r.request().method() === "GET");
    await page.reload();
    expect((await listaAposRetomar).status()).toBe(200);
    await expect(page.getByText("Carregando conexões…", { exact: true })).toBeHidden();
    // O banner também nomeia Recepção; a prova precisa encontrar o card no main.
    await expect(page.getByRole("main").getByText("Recepção", { exact: true })).toBeVisible();
    await page.screenshot({ path: `${EVIDENCIA}/mesmo-canal-retomado.png`, fullPage: true });
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (org) {
      await db.from("channel_sessions").delete().eq("organization_id", org);
      await db.from("user_organizations").delete().eq("organization_id", org);
      await db.from("organizations").delete().eq("id", org);
    }
    if (userId) await db.auth.admin.deleteUser(userId);
  }
});
