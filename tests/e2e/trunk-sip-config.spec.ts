import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

/**
 * TRUNK SIP — só admin escreve, manager só lê, e o bloco de pjsip.conf sai
 * certo depois de salvar.
 *
 * ## Por que dois papéis, não um
 *
 * A rota (`app/api/v1/voip/trunk/route.ts`) e a tela
 * (`app/app/settings/voip-trunk/_client.tsx`) concordam em dois eixos
 * diferentes: leitura exige `manager`+, escrita exige `admin`. Testar só com
 * admin não prova o primeiro eixo — um `canWrite` sempre `true` passaria do
 * mesmo jeito. `manager` é quem prova que os campos ficam desabilitados e o
 * botão Salvar não aparece, sem precisar de um segundo usuário sem conta
 * nenhuma (RLS/RBAC de leitura já é medido em `tests/invariants/rls-isolation.test.ts`).
 *
 * ## Por que o bloco de pjsip.conf é conferido por conteúdo, não por presença
 *
 * `blocoParaColar` só existe na janela entre salvar e a próxima navegação
 * (`ultimoSalvo`, não uma busca do servidor — a senha nunca volta cifrada
 * nem em claro). Um teste que só checasse "o `<pre>` apareceu" passaria com o
 * endpoint, o host ou a senha errados dentro dele — e é exatamente esse bloco
 * que o operador cola no Asterisk de verdade.
 *
 * ## O que esta spec NÃO prova
 *
 * Não aplica o bloco no Asterisk nem faz uma ligação de teste — isso depende
 * de um trunk SIP real e é medido à mão na VPS (mesmo limite do
 * `voz-desligada-por-padrao.spec.ts` pra chamada real).
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3031 pnpm exec playwright test tests/e2e/trunk-sip-config.spec.ts
 */
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "e2e-artifacts");
fs.mkdirSync(EVIDENCIA, { recursive: true });

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  admin_totp?: { factor_id: string; secret: string };
}

function loadCreds(): Creds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.admin;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

/** Admin do seed tem TOTP verified sempre — o login para em `/login/mfa`. */
async function entrarComoAdmin(page: Page): Promise<void> {
  const usuario = creds.users.admin;
  const segredo = creds.admin_totp?.secret;
  expect(usuario, ".e2e-creds.json sem o usuário `admin`").toBeTruthy();
  expect(segredo, "o seed não trouxe o segredo TOTP do admin — sem ele não há como entrar").toBeTruthy();

  await page.goto("/login");
  await page.locator("#email").fill(usuario!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/login\/mfa/);

  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    if (msUntilNextTotpWindow() < 3_000) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(segredo as string), { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 8_000 });
      return;
    } catch {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA do admin não passou em 2 tentativas de TOTP");
}

/** `manager` não tem TOTP — a tela de 2FA não é o assunto desta spec. */
async function entrarComoManager(page: Page): Promise<void> {
  const usuario = creds.users.manager;
  expect(usuario, ".e2e-creds.json sem o usuário `manager`").toBeTruthy();
  await page.goto("/login");
  await page.locator("#email").fill(usuario!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test.describe("trunk SIP — permissão e conteúdo do bloco pjsip.conf", () => {
  test("admin chega pela navegação, salva, e o bloco pra colar tem host/usuário/endpoint certos", async ({
    page,
  }) => {
    await entrarComoAdmin(page);

    // ── CHEGADA PELA NAVEGAÇÃO, não por goto (DoD 14) ──────────────────────
    await page.goto("/app/settings");
    const porta = page.locator('a[href="/app/settings/voip-trunk"]').first();
    await expect(porta, "não há porta para Trunk SIP em Configurações").toBeVisible();
    await porta.click();
    await page.waitForURL(/\/app\/settings\/voip-trunk/);

    // ── VALORES ÚNICOS por execução: reconhecíveis no bloco final ──────────
    const sufixo = Date.now().toString(36);
    const host = `sip-e2e-${sufixo}.invariant.test`;
    const usuario = `e2e-user-${sufixo}`;
    const senha = `e2e-senha-${sufixo}`;

    await page.locator("#host").fill(host);
    await page.locator("#username").fill(usuario);
    await page.locator("#password").fill(senha);
    await page.getByRole("button", { name: /^Salvar$/ }).click();

    // O bloco só aparece DEPOIS do POST responder — esperar o texto em vez de
    // um timeout fixo evita flake em CI mais lento.
    const bloco = page.locator("pre");
    await expect(bloco, "o bloco pra colar não apareceu depois de salvar").toBeVisible({ timeout: 10_000 });
    const texto = await bloco.innerText();

    expect(texto, "o bloco não referencia o host salvo em nenhuma linha").toContain(host);
    expect(texto, "o bloco não tem o usuário salvo (from_user=)").toContain(`from_user=${usuario}`);
    expect(texto, "o bloco não tem a senha salva (password=)").toContain(`password=${senha}`);
    expect(texto, "o bloco não declara um endpoint [nome]").toMatch(/^\[[^\]]+\]/);

    // ── QUALIDADE DE TELA ────────────────────────────────────────────────
    const corpo = (await page.locator("body").innerText()).trim();
    expect(corpo, "a tela mostra o que parece uma chave de tradução crua").not.toMatch(
      /\b[a-z]+(?:[._][a-z]+){2,}\b/,
    );
    expect(corpo).not.toMatch(/\{\{|\}\}|undefined|NaN|\[object Object\]/);

    const estouro = await page.evaluate(() => {
      const doc = document.documentElement;
      return { scroll: doc.scrollWidth, cliente: doc.clientWidth };
    });
    expect(
      estouro.scroll,
      `a página rola na horizontal (${estouro.scroll}px de conteúdo para ${estouro.cliente}px de tela)`,
    ).toBeLessThanOrEqual(estouro.cliente + 1);

    await page.screenshot({
      path: path.join(EVIDENCIA, "trunk-sip-admin-salvo.png"),
      fullPage: true,
    });
  });

  test("manager só lê: campos desabilitados e sem botão Salvar", async ({ page }) => {
    await entrarComoManager(page);

    // Direto por URL: o item de navegação é `minRole: admin`
    // (lib/navigation/catalogo.ts) — manager não tem porta pra chegar aqui
    // andando, mas a rota/tela continuam acessíveis (defesa em profundidade,
    // mesmo padrão de outras telas admin-write/manager-read do produto).
    await page.goto("/app/settings/voip-trunk");
    await expect(page.locator("#host")).toBeVisible();

    await expect(page.locator("#host")).toBeDisabled();
    await expect(page.locator("#username")).toBeDisabled();
    await expect(page.locator("#password")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /^Salvar$/ }),
      "manager viu o botão Salvar — a tela ofereceria uma escrita que a API rejeitaria (403)",
    ).toHaveCount(0);
  });
});
