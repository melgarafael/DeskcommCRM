/**
 * O CHATGPT CONECTA AO MCP DO CRM POR OAUTH — a jornada inteira, pela tela.
 *
 * O ChatGPT (e outros clientes de MCP) só oferece OAuth ou "sem autenticação"
 * ao adicionar um servidor: não há onde colar o `dsk_`. Esta spec faz o papel
 * do aplicativo, com um receptor HTTP de verdade no lugar do
 * `redirect_uri`, e prova o que a pessoa vê e o que o aplicativo recebe:
 *
 *   1. Descoberta: o 401 do `/api/mcp` aponta os metadados (RFC 9728 → 8414).
 *   2. Registro dinâmico (RFC 7591).
 *   3. Sem sessão, o `authorize` leva ao login e VOLTA para o consentimento.
 *   4. A tela mostra o nome declarado, o host de volta e a empresa; Permitir
 *      devolve `code` + `state` + `iss` ao receptor.
 *   5. O código vira um `dsk_` que o `/api/mcp` aceita (tools/list responde).
 *   6. Renovação rotaciona: o token anterior morre, o novo vale (o refresh anterior, reapresentado, desliga a conexão).
 *   7. A conexão aparece em API Tokens como "(OAuth)"; Revogar ali derruba a
 *      renovação seguinte — a saída que a pessoa tem, pela tela.
 *   8. Cancelar devolve `access_denied`; "Somente ler" emite só `mcp:read`.
 *
 * Roda com os envs opcionais ausentes (sem Redis, sem WAHA): é o estado de uma
 * instalação recém-feita, e nada daqui depende deles.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, test, type Page } from "./helpers/test";

import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const EVIDENCIA = join(process.cwd(), "evidence", "mcp-oauth-chatgpt");

/** O receptor: o `redirect_uri` do "aplicativo". Guarda a última volta. */
let receptor: Server;
let redirectUri = "";
let ultimaVolta: URLSearchParams | null = null;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function registrar(nome: string): Promise<string> {
  const res = await fetch(`${APP_URL}/api/mcp/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: nome,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const corpo = (await res.json()) as { client_id: string; client_secret?: string };
  expect(corpo.client_id).toMatch(/^dcc_[A-Za-z0-9_-]{32}$/);
  expect(corpo.client_secret, "cliente público não recebe segredo").toBeUndefined();
  return corpo.client_id;
}

function urlDeAutorizacao(clientId: string, challenge: string, state: string, scope = "mcp:read mcp:write"): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope,
    resource: `${APP_URL}/api/mcp`,
  });
  return `${APP_URL}/api/mcp/oauth/authorize?${q.toString()}`;
}

async function token(campos: Record<string, string>): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const res = await fetch(`${APP_URL}/api/mcp/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(campos).toString(),
  });
  return { status: res.status, corpo: (await res.json()) as Record<string, unknown> };
}

/** `tools/list` no MCP com o bearer dado. Devolve o status e a contagem de ferramentas. */
async function listarFerramentas(bearer: string): Promise<{ status: number; ferramentas: number; desafio: string | null }> {
  const res = await fetch(`${APP_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const texto = await res.text();
  if (!res.ok) return { status: res.status, ferramentas: 0, desafio: res.headers.get("www-authenticate") };
  const linha = texto.split("\n").find((l) => l.startsWith("data:"));
  const json = JSON.parse(linha ? linha.slice(5).trim() : texto) as { result?: { tools?: unknown[] } };
  return { status: res.status, ferramentas: json.result?.tools?.length ?? 0, desafio: null };
}

/** Espera a tela de consentimento e devolve o cartão. */
async function telaDeConsentimento(page: Page) {
  await page.waitForURL(/\/oauth\/mcp\/consentir\?/, { timeout: 30_000 });
  const cartao = page.getByTestId("consentimento-mcp");
  await expect(cartao).toBeVisible();
  return cartao;
}

async function permitirEVoltar(page: Page): Promise<URLSearchParams> {
  ultimaVolta = null;
  await page.getByRole("button", { name: "Permitir", exact: true }).click();
  await page.waitForURL((u) => u.href.startsWith(redirectUri), { timeout: 30_000 });
  expect(ultimaVolta, "o receptor não recebeu a volta").not.toBeNull();
  return ultimaVolta!;
}

let creds: CredsE2E;

test.beforeAll(async () => {
  mkdirSync(EVIDENCIA, { recursive: true });
  creds = lerCreds();
  receptor = createServer((req, res) => {
    ultimaVolta = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Receptor</title><p id=ok>O aplicativo recebeu a volta.</p>");
  });
  await new Promise<void>((ok) => receptor.listen(0, "127.0.0.1", ok));
  redirectUri = `http://127.0.0.1:${(receptor.address() as AddressInfo).port}/callback`;
});

test.afterAll(async () => {
  await new Promise<void>((ok) => receptor.close(() => ok()));
});

test.describe("OAuth do MCP: o aplicativo conecta sem colar token", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  test("descoberta: o 401 do /api/mcp leva aos metadados do recurso e do servidor", async () => {
    const semToken = await fetch(`${APP_URL}/api/mcp`, { method: "POST", body: "{}" });
    expect(semToken.status).toBe(401);
    const desafio = semToken.headers.get("www-authenticate") ?? "";
    const metadados = /resource_metadata="([^"]+)"/.exec(desafio)?.[1];
    expect(metadados, `WWW-Authenticate sem resource_metadata: ${desafio}`).toBe(
      `${APP_URL}/.well-known/oauth-protected-resource`,
    );

    const recurso = (await (await fetch(metadados!)).json()) as { resource: string; authorization_servers: string[] };
    expect(recurso.resource).toBe(`${APP_URL}/api/mcp`);
    expect(recurso.authorization_servers).toEqual([APP_URL]);

    const comCaminho = await fetch(`${APP_URL}/.well-known/oauth-protected-resource/api/mcp`);
    expect(comCaminho.status).toBe(200);

    const servidor = (await (
      await fetch(`${recurso.authorization_servers[0]}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(servidor.issuer).toBe(APP_URL);
    expect(servidor.code_challenge_methods_supported).toEqual(["S256"]);
    expect(servidor.registration_endpoint).toBe(`${APP_URL}/api/mcp/oauth/register`);
  });

  test("sem sessão: o authorize leva ao login e volta para o consentimento; Permitir entrega o código; o dsk_ abre o MCP; revogar na tela desliga", async ({
    page,
  }) => {
    const clientId = await registrar("ChatGPT (prova)");
    const { verifier, challenge } = pkce();
    const state = `st-${randomBytes(6).toString("hex")}`;

    // ── sem sessão: ponte → proxy → login com `next` ──────────────────────────
    await page.goto(urlDeAutorizacao(clientId, challenge, state));
    await page.waitForURL(/\/login\?next=/, { timeout: 30_000 });
    expect(decodeURIComponent(new URL(page.url()).searchParams.get("next") ?? "")).toContain("/oauth/mcp/consentir?");

    await page.locator("#email").fill(creds.users.admin!.email);
    await page.locator("#password").fill(creds.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/login\/mfa|\/oauth\/mcp\/consentir/, { timeout: 30_000 });
    if (/\/login\/mfa/.test(page.url())) {
      // Janela nova de TOTP: o mesmo código nunca é enviado duas vezes.
      await page.waitForTimeout(msUntilNextTotpWindow() + 500);
      const digito = page.locator('input[aria-label="Dígito 1"]');
      await digito.waitFor({ state: "visible", timeout: 15_000 });
      await digito.click();
      await page.keyboard.type(generateTotp(creds.admin_totp!.secret), { delay: 40 });
    }

    // ── a tela de consentimento ───────────────────────────────────────────────
    const cartao = await telaDeConsentimento(page);
    await expect(page.getByTestId("consentimento-nome")).toHaveText("ChatGPT (prova)");
    await expect(page.getByTestId("consentimento-host")).toContainText(new URL(redirectUri).host);
    await expect(cartao.getByRole("radio", { name: /Ler e alterar/ })).toBeChecked();
    // mcp:write libera ferramentas que ENVIAM ao cliente: a tela tem de dizer.
    await expect(page.getByTestId("consentimento-envio")).toContainText("enviar mensagens de WhatsApp e materiais");
    await expect(cartao.getByRole("radio", { name: /Somente ler/ })).not.toBeChecked();
    const caixa = await cartao.boundingBox();
    expect(caixa!.width, "o cartão cabe na tela").toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.screenshot({ path: join(EVIDENCIA, "01-consentimento.png"), fullPage: true });

    // ── Permitir: a volta ao aplicativo ───────────────────────────────────────
    const volta = await permitirEVoltar(page);
    expect(volta.get("state")).toBe(state);
    expect(volta.get("iss")).toBe(APP_URL);
    const codigo = volta.get("code")!;
    expect(codigo).toMatch(/^dco_/);
    await page.screenshot({ path: join(EVIDENCIA, "02-volta-ao-aplicativo.png") });

    // ── verifier errado não troca — e queima o código ─────────────────────────
    // (medido em outro código, mais abaixo; aqui o caminho feliz)
    const emitido = await token({
      grant_type: "authorization_code",
      code: codigo,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      resource: `${APP_URL}/api/mcp`,
    });
    expect(emitido.status, JSON.stringify(emitido.corpo)).toBe(200);
    expect(emitido.corpo.token_type).toBe("Bearer");
    expect(emitido.corpo.scope).toBe("mcp:read mcp:write");
    const acesso = emitido.corpo.access_token as string;
    const refresh = emitido.corpo.refresh_token as string;
    expect(acesso).toMatch(/^dsk_[0-9a-f]{8}_/);

    // ── o dsk_ emitido abre o MCP, pelo caminho de sempre ─────────────────────
    const lista = await listarFerramentas(acesso);
    expect(lista.status).toBe(200);
    expect(lista.ferramentas, "tools/list devolveu ferramentas").toBeGreaterThan(5);

    // ── renovação com rotação ─────────────────────────────────────────────────
    const renovado = await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(renovado.status, JSON.stringify(renovado.corpo)).toBe(200);
    const acesso2 = renovado.corpo.access_token as string;
    const refresh2 = renovado.corpo.refresh_token as string;
    expect(acesso2).not.toBe(acesso);
    const velho = await listarFerramentas(acesso);
    expect(velho.status, "o access token anterior morre na rotação").toBe(401);
    expect(velho.desafio).toContain('error="invalid_token"');
    expect((await listarFerramentas(acesso2)).status).toBe(200);
    // (Reapresentar o refresh anterior desliga a conexão — medido no banco em
    // tests/invariants/mcp-oauth-servidor.test.ts; aqui a conexão segue viva
    // para a prova da tela.)

    // ── a conexão aparece na tela, e revogar ali a desliga ────────────────────
    await page.goto("/app/settings/api-tokens");
    await expect(page.getByTestId("mcp-oauth-instrucao")).toContainText(`${APP_URL}/api/mcp`);
    const linha = page.getByRole("row", { name: /ChatGPT \(prova\) \(OAuth\)/ }).first();
    await expect(linha).toBeVisible({ timeout: 20_000 });
    await expect(linha).toContainText("mcp:write");
    await expect(linha).toContainText("Ativo");
    await page.screenshot({ path: join(EVIDENCIA, "03-conexao-em-api-tokens.png"), fullPage: true });
    await linha.getByRole("button", { name: "Revogar" }).click();
    await expect(linha).toContainText("Revogado", { timeout: 20_000 });
    await page.screenshot({ path: join(EVIDENCIA, "04-conexao-revogada.png"), fullPage: true });

    expect((await listarFerramentas(acesso2)).status, "token revogado na tela não abre o MCP").toBe(401);
    const depois = await token({ grant_type: "refresh_token", refresh_token: refresh2, client_id: clientId });
    expect(depois.status).toBe(400);
    expect(depois.corpo.error, "revogar na tela derruba a renovação").toBe("invalid_grant");
  });

  test("Cancelar devolve access_denied; verifier errado não troca; Somente ler emite só mcp:read", async ({ page }) => {
    await loginComoAdmin(page, creds);
    const clientId = await registrar("Outro app (prova)");

    // ── Cancelar ──────────────────────────────────────────────────────────────
    const a = pkce();
    await page.goto(urlDeAutorizacao(clientId, a.challenge, "st-negar"));
    await telaDeConsentimento(page);
    ultimaVolta = null;
    await page.getByRole("button", { name: "Cancelar", exact: true }).click();
    await page.waitForURL((u) => u.href.startsWith(redirectUri), { timeout: 30_000 });
    expect(ultimaVolta!.get("error")).toBe("access_denied");
    expect(ultimaVolta!.get("state")).toBe("st-negar");
    expect(ultimaVolta!.has("code")).toBe(false);

    // ── Somente ler, com verifier errado antes ────────────────────────────────
    const b = pkce();
    await page.goto(urlDeAutorizacao(clientId, b.challenge, "st-ler"));
    const cartao = await telaDeConsentimento(page);
    await cartao.getByRole("radio", { name: /Somente ler/ }).check();
    await page.screenshot({ path: join(EVIDENCIA, "05-consentimento-somente-ler.png"), fullPage: true });
    const volta = await permitirEVoltar(page);
    const codigo = volta.get("code")!;

    const errado = await token({
      grant_type: "authorization_code",
      code: codigo,
      redirect_uri: redirectUri,
      code_verifier: pkce().verifier,
      client_id: clientId,
    });
    expect(errado.status).toBe(400);
    expect(errado.corpo.error).toBe("invalid_grant");
    const queimado = await token({
      grant_type: "authorization_code",
      code: codigo,
      redirect_uri: redirectUri,
      code_verifier: b.verifier,
      client_id: clientId,
    });
    expect(queimado.corpo.error, "código queimado pela tentativa com verifier errado").toBe("invalid_grant");

    const c = pkce();
    await page.goto(urlDeAutorizacao(clientId, c.challenge, "st-ler-2"));
    const cartao2 = await telaDeConsentimento(page);
    await cartao2.getByRole("radio", { name: /Somente ler/ }).check();
    const volta2 = await permitirEVoltar(page);
    const leitura = await token({
      grant_type: "authorization_code",
      code: volta2.get("code")!,
      redirect_uri: redirectUri,
      code_verifier: c.verifier,
      client_id: clientId,
    });
    expect(leitura.status, JSON.stringify(leitura.corpo)).toBe(200);
    expect(leitura.corpo.scope).toBe("mcp:read");

    // Revogação pelo próprio aplicativo (RFC 7009): limpa a conexão da prova.
    const rev = await fetch(`${APP_URL}/api/mcp/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: leitura.corpo.refresh_token as string, client_id: clientId }).toString(),
    });
    expect(rev.status).toBe(200);
    expect((await listarFerramentas(leitura.corpo.access_token as string)).status).toBe(401);
  });

  test("redirect_uri que o aplicativo não registrou: página de erro, sem redirecionar", async ({ page }) => {
    const clientId = await registrar("App do redirect (prova)");
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/cb",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    const resp = await page.goto(`${APP_URL}/api/mcp/oauth/authorize?${q.toString()}`);
    expect(resp!.status()).toBe(400);
    expect(page.url()).toContain("/api/mcp/oauth/authorize");
    await expect(page.getByRole("heading", { name: "Não foi possível continuar a conexão" })).toBeVisible();
    await page.screenshot({ path: join(EVIDENCIA, "06-redirect-nao-registrado.png") });
  });
});
