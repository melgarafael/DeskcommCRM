/**
 * JORNADA WAHA — a foto do "antes" do seam de canais (Task 0 do plano
 * `docs/superpowers/plans/2026-07-27-canais-seam-fases-0-2.md`).
 *
 * Não é teste de regressão: é INSTRUMENTO DE MEDIÇÃO. Ela vive a jornada pela
 * tela, com conta real, e grava um screenshot por parada. As Tasks 1, 4, 5 e 7
 * re-rodam este mesmo arquivo apontando `CANAIS_EVIDENCE_DIR` para outra pasta e
 * comparam com a baseline — por isso NADA aqui pode depender de estado que a
 * própria jornada não estabelece.
 *
 * Rodar:
 *   CANAIS_EVIDENCE_DIR=evidence/canais/baseline \
 *   pnpm exec playwright test --config tests/journeys/playwright.config.ts
 *
 * Pré-requisitos (o app NÃO é subido por este config):
 *   - `next build` + `next start --port 3002` já no ar;
 *   - `.e2e-creds.json` do seed-e2e-credentials + seed-e2e-radar rodados.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { lerCreds, loginAdmin } from "./_login";

// As demais jornadas herdam a sessão do `auth.setup.ts`. ESTA prova o login pela
// tela, então precisa começar deslogada — herdar a sessão faria o teste passar
// sem nunca exercitar o que ele afirma cobrir.
test.use({ storageState: { cookies: [], origins: [] } });


const EVIDENCE = path.join(
  process.cwd(),
  process.env.CANAIS_EVIDENCE_DIR ?? "evidence/canais/baseline",
);
fs.mkdirSync(EVIDENCE, { recursive: true });


const creds = lerCreds();

/** .env.local lido na mão — os specs rodam fora do runtime do Next. */
function envLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/**
 * A jornada mede o DIA A DIA (inbox, envio, radar), não o wizard — e com
 * `organizations.onboarded_at` nulo TODO `/app/*` devolve o usuário ao
 * onboarding. Marcar a org como onboardada é a pré-condição do instrumento, não
 * um atalho no que ele mede: o onboarding tem spec própria
 * (`tests/e2e/vps-fresh-onboarding.spec.ts`), e os specs do repo derrubam esse
 * campo entre execuções.
 */
test.beforeAll(async () => {
  const env = envLocal();
  const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { error } = await svc
    .from("organizations")
    .update({ onboarded_at: new Date().toISOString() } as never)
    .eq("id", creds.org_id)
    .is("onboarded_at", null);
  if (error) throw new Error(`não consegui marcar a org como onboardada: ${error.message}`);
});

/** Screenshot numerado — o nome É o índice da parada da jornada. */
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(EVIDENCE, name), fullPage: true });
}


/**
 * O admin da org de e2e é o DONO — com `organizations.onboarded_at` nulo, todo
 * `/app/*` o devolve ao wizard. Quem vive o dia a dia do inbox é o manager (sem
 * MFA), exatamente como os specs de inbox/radar do repo já fazem.
 */
async function loginManager(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("jornada WAHA — baseline do seam de canais", () => {
  test("1-2: login e a tela de conectar WhatsApp", async ({ page }) => {
    await loginAdmin(page);
    // O screenshot logo após o MFA pega a tela EM BRANCO no meio da navegação.
    // `networkidle` NÃO serve aqui: o app tem polling e realtime, a rede nunca
    // fica ociosa — o sinal honesto é o primeiro heading renderizar.
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await shot(page, "01-login.png");

    // Com a org já onboardada, o wizard `/onboarding/connect-whatsapp` devolve
    // para `/app` — a superfície viva de conectar número é a de Conexões.
    await page.goto("/app/connections");
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
    // O QR só nasce com WAHA no ar E sessão em SCAN_QR_CODE; sem isso a tela
    // mostra o estado real da sessão. Os DOIS são baseline legítimo — o que não
    // pode mudar entre as tasks é QUAL deles aparece.
    await page.waitForTimeout(5_000);
    await shot(page, "02-qr.png");
  });

  test("3-5: inbox, envio de texto e envio de áudio", async ({ page }) => {
    await loginManager(page);
    await page.goto("/app/inbox");
    await expect(page.getByRole("tab", { name: /Todas/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: /Todas/ }).click();

    // A conversa do seed do radar é a única garantida em banco fresco.
    const conversa = page.getByText(/Cliente Radar E2E/i).first();
    await expect(conversa).toBeVisible({ timeout: 30_000 });
    await conversa.click();
    await expect(page.getByLabel("Mensagem")).toBeVisible({ timeout: 30_000 });
    await shot(page, "03-inbox.png");

    const texto = `baseline canais ${new Date().toISOString().slice(11, 19)}`;
    await page.getByLabel("Mensagem").fill(texto);
    // `exact: true` não é zelo: sem ele, `name` casa por SUBSTRING e o card da
    // lista de conversas — cujo preview mostra o texto da última mensagem —
    // entra no match quando essa mensagem por acaso contém "enviar". O seletor
    // frouxo funcionava só enquanto nenhum dado tinha casado por acaso.
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    // O que se mede é a mensagem APARECER na timeline com o estado que o
    // sistema lhe deu (enviada, falha, pendente) — não que ela chegue ao celular.
    await expect(page.getByText(texto)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3_000);
    await shot(page, "04-texto-enviado.png");

    // Áudio: mic falso do Chromium (flags no config). Grava ~2s e envia.
    await page.getByRole("button", { name: "Gravar áudio" }).click();
    await page.waitForTimeout(2_500);
    await page.getByRole("button", { name: "Enviar áudio" }).click();
    await page.waitForTimeout(6_000);
    await shot(page, "05-audio-enviado.png");
  });

  test("6-7: lembrete (follow-up) e Radar de Risco", async ({ page }) => {
    await loginManager(page);
    await page.goto("/app/inbox");
    await page.getByRole("tab", { name: /Todas/ }).click();
    await page.getByText(/Cliente Radar E2E/i).first().click();
    await expect(page.getByLabel("Mensagem")).toBeVisible({ timeout: 30_000 });

    const lembrar = page.getByRole("button", { name: /Lembrar|Lembrete ativo/ });
    await expect(lembrar).toBeVisible({ timeout: 30_000 });
    await lembrar.click();
    const opcao = page.getByRole("menuitem").first();
    await expect(opcao).toBeVisible({ timeout: 15_000 });
    await opcao.click();
    await page.waitForTimeout(3_000);
    await shot(page, "06-followup.png");

    await page.goto("/app/radar");
    await expect(page.getByRole("heading", { name: /radar/i }).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(3_000);
    await shot(page, "07-radar.png");
  });
});
