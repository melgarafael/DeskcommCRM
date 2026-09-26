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
const EVIDENCIA = ".superpowers/evidence/pareamento-por-codigo";

test.use({ trace: "on" });
test.describe.configure({ timeout: 180_000 });

async function insert(table: string, value: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw error;
  return data.id as string;
}

test("o administrador conecta o WhatsApp digitando o código no celular", async ({ page }) => {
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
