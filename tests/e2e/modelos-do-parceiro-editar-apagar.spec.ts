/**
 * MODELOS DO CANAL INTERMEDIADO: VER COMO NO WHATSAPP, EDITAR E APAGAR PELA TELA.
 *
 * Pedido de uma instalação real (25/09/2026): depois de um reajuste de preço, os
 * modelos aprovados tinham o preço velho no texto, e a tela só deixava criar —
 * editar ou apagar exigia ir à plataforma do provedor.
 *
 * Esta spec dirige a TELA como quem opera: sincroniza, abre um modelo e vê a
 * prévia no formato do WhatsApp, edita o texto partindo do aprovado, e apaga
 * com confirmação. Do outro lado há um DUBLÊ do provedor (servidor HTTP nesta
 * mesma spec) que registra o que chegou — é ele que prova que a edição e o
 * apagamento saíram, e com o quê.
 *
 * ⚠️ FORA DO CI (ver `FORA_DO_CI` em .github/workflows/e2e.yml): o servidor do
 * app precisa nascer apontado para o dublê, e isso é ambiente do `next start`,
 * não da spec. Roda local (receita inteira em
 * `.agents/skills/deskcomm-contribuir/references/receita-e2e-local.md`) com:
 *
 *   pnpm e2e:env && pnpm e2e:build
 *   ZERNIO_API_BASE_URL=http://127.0.0.1:3998 ZERNIO_ACCOUNT_ID=ACC-E2E-MODELOS \
 *   ZERNIO_API_KEY=duble pnpm exec playwright test tests/e2e/modelos-do-parceiro-editar-apagar.spec.ts
 *
 * O `next start` que o `playwright.config.ts` sobe herda essas três variáveis.
 *
 * Sem essas variáveis a spec se declara pulada, em vez de falhar por ambiente.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const PORTA = 3998;
const URL_DO_DUBLE = `http://127.0.0.1:${PORTA}`;
const CONTA = "ACC-E2E-MODELOS";
const TEM_DUBLE = process.env.ZERNIO_API_BASE_URL === URL_DO_DUBLE && process.env.ZERNIO_ACCOUNT_ID === CONTA;

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), ".superpowers/evidence/modelos-do-parceiro");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
  admin_totp?: { secret: string };
}

type Modelo = { name: string; language: string; status: string; category: string; components: unknown[] };
const NOME = "recordatorio_e2e_modelos";
const TEXTO_APROVADO = "Hola! Sale ₲125.000, con envío gratis. ¿Te lo reservamos?";
const TEXTO_NOVO = "Hola! Ahora sale ₲150.000, con envío gratis. ¿Te lo reservamos?";

const modelos = new Map<string, Modelo>();
const recebidos: { metodo: string; caminho: string; corpo: unknown }[] = [];
let servidor: http.Server | null = null;

function dubleDoProvedor(): http.Server {
  return http.createServer((req, res) => {
    let bruto = "";
    req.on("data", (c) => (bruto += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", URL_DO_DUBLE);
      const corpo = bruto ? JSON.parse(bruto) : null;
      recebidos.push({ metodo: req.method ?? "", caminho: url.pathname, corpo });
      const responde = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const nome = decodeURIComponent(url.pathname.replace(/^\/v1\/whatsapp\/templates\/?/, ""));
      if (req.method === "GET") return responde(200, { templates: [...modelos.values()] });
      if (req.method === "PATCH" && modelos.has(nome)) {
        const m = modelos.get(nome)!;
        const novo = { ...m, status: "PENDING", components: (corpo as { components: unknown[] }).components };
        modelos.set(nome, novo);
        return responde(200, { success: true, template: novo });
      }
      if (req.method === "DELETE" && modelos.has(nome)) {
        modelos.delete(nome);
        return responde(200, { success: true });
      }
      return responde(404, { success: false, error: "not found" });
    });
  });
}

async function loginComTotp(page: Page, email: string, senha: string, secret: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click({ timeout: 15_000 });
  await page.waitForURL(/\/login\/mfa/);
  if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);
  await page.locator('input[aria-label="Dígito 1"]').click({ timeout: 15_000 });
  await page.keyboard.type(generateTotp(secret), { delay: 40 });
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

test.describe("modelos do canal intermediado pela tela", () => {
  test.skip(!TEM_DUBLE, `precisa do dublê do provedor: ZERNIO_API_BASE_URL=${URL_DO_DUBLE} ZERNIO_ACCOUNT_ID=${CONTA}`);
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let creds: Creds;
  let sessaoId = "";

  test.beforeAll(async () => {
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    modelos.set(NOME, {
      name: NOME,
      language: "es",
      status: "APPROVED",
      category: "MARKETING",
      components: [
        { type: "BODY", text: TEXTO_APROVADO },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Sí, lo quiero" }, { type: "URL", text: "Ver", url: "https://loja.example/produto" }] },
      ],
    });
    servidor = dubleDoProvedor();
    await new Promise<void>((ok) => servidor!.listen(PORTA, "127.0.0.1", ok));
    const { data, error } = await admin
      .from("channel_sessions")
      .insert({
        organization_id: creds.org_id,
        provider: "zernio",
        zernio_account_id: CONTA,
        webhook_path_token: `e2e-modelos-${Date.now()}`,
        webhook_secret_encrypted: "\\x00",
        display_name: "Número E2E",
        phone_number: "+5511900000999",
        status: "WORKING",
      })
      .select("id")
      .single();
    if (error) throw new Error(`sessão do parceiro: ${error.message}`);
    sessaoId = (data as { id: string }).id;
  });

  test.afterAll(async () => {
    if (sessaoId) {
      await admin.from("meta_templates").delete().eq("channel_session_id", sessaoId);
      await admin.from("channel_sessions").delete().eq("id", sessaoId);
    }
    await new Promise<void>((ok) => (servidor ? servidor.close(() => ok()) : ok()));
  });

  test("⭐ ver como no WhatsApp, editar partindo do aprovado e apagar com confirmação", async ({ page }) => {
    await loginComTotp(page, creds.users.admin!.email, creds.password, creds.admin_totp!.secret);
    await page.goto("/app/connections?aba=parceiro&sub=templates");

    // 1. Sincroniza e abre o modelo: a prévia mostra o texto e os botões FORA do balão.
    await page.getByRole("button", { name: "Sincronizar", exact: true }).click();
    const linha = page.getByRole("button", { name: new RegExp(NOME) });
    await expect(linha).toBeVisible({ timeout: 30_000 });
    await linha.click();
    const aberto = page.locator(`[data-modelo-aberto="${NOME}"]`);
    const previa = aberto.locator("[data-previa-do-modelo]");
    await expect(previa).toContainText(TEXTO_APROVADO);
    await expect(previa).toContainText("Sí, lo quiero");
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "01-previa-como-no-whatsapp.png"), fullPage: true });

    // 2. Editar: o formulário nasce com o texto aprovado; nome travado.
    await aberto.getByRole("button", { name: "Editar" }).click();
    const form = page.locator('[data-formulario-do-modelo="editar"]');
    await expect(form).toBeVisible();
    await expect(form.getByLabel("Nome do modelo")).toBeDisabled();
    const corpo = form.getByLabel("Conteúdo");
    await expect(corpo).toHaveValue(TEXTO_APROVADO);
    await corpo.fill(TEXTO_NOVO);
    await expect(form.locator("[data-previa-do-modelo]")).toContainText("₲150.000");
    await page.screenshot({ path: path.join(EVIDENCIA, "02-editando.png"), fullPage: true });
    await form.getByRole("button", { name: "Salvar e enviar para revisão" }).click();
    await expect(form).toBeHidden({ timeout: 30_000 });

    const patch = recebidos.find((r) => r.metodo === "PATCH");
    expect(patch?.caminho, "a edição chegou ao provedor").toBe(`/v1/whatsapp/templates/${NOME}`);
    const enviado = JSON.stringify(patch?.corpo);
    expect(enviado, "com o texto novo").toContain("₲150.000");
    expect(enviado, "e sem perder o botão de link").toContain("https://loja.example/produto");
    await expect(page.getByRole("button", { name: new RegExp(NOME) })).toContainText("PENDING", { timeout: 30_000 });

    // 3. Apagar: pede confirmação, avisa que não volta, e some da lista.
    // Depois de editar o modelo segue ABERTO (a linha alterna): clicar de novo o fecharia.
    const painel = page.locator(`[data-modelo-aberto="${NOME}"]`);
    if (!(await painel.isVisible())) await page.getByRole("button", { name: new RegExp(NOME) }).click();
    await painel.getByRole("button", { name: "Apagar" }).click();
    const dialogo = page.getByRole("alertdialog");
    await expect(dialogo).toContainText("não dá para desfazer");
    await page.screenshot({ path: path.join(EVIDENCIA, "03-confirmar-apagar.png"), fullPage: true });
    await dialogo.getByRole("button", { name: "Apagar" }).click();
    await expect(dialogo).toBeHidden({ timeout: 30_000 });
    expect(recebidos.some((r) => r.metodo === "DELETE" && r.caminho === `/v1/whatsapp/templates/${NOME}`)).toBe(true);
    await expect(page.getByRole("button", { name: new RegExp(NOME) })).toHaveCount(0, { timeout: 30_000 });
    await page.screenshot({ path: path.join(EVIDENCIA, "04-apagado.png"), fullPage: true });
  });
});
