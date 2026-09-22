/**
 * ⚠️ NÃO EXECUTE — login automático SUSPENSO.
 *
 * A conta agora exige reCAPTCHA e tem limite de tentativas. Cada execução
 * deste script gasta 1 tentativa e pode BLOQUEAR a conta. Mantido no repo
 * apenas como referência; o fluxo oficial passou a ser o login MANUAL:
 * `scripts/mercos-scrape/capturar-sessao-manual.ts` (você resolve o
 * captcha no navegador e o script só SALVA a sessão — zero tentativas).
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const URL_LOGIN = "https://app.mercos.com/";
const SESSAO = join(process.cwd(), ".auth", "mercos.json");

async function main(): Promise<void> {
  const email = process.env.MERCOS_EMAIL?.trim();
  const senha = process.env.MERCOS_PASSWORD ?? "";
  if (!email || !senha) {
    throw new Error("Defina MERCOS_EMAIL e MERCOS_PASSWORD no ambiente (nunca no código).");
  }
  const headless = (process.env.MERCOS_HEADLESS ?? "true") !== "false";

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  const tmp = process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const falhou = async (etapa: string, e: unknown): Promise<never> => {
    try {
      await page.screenshot({ path: join(tmp, "mercos-login-fail.png") });
      writeFileSync(join(tmp, "mercos-login-fail.html"), await page.content(), "utf8");
      writeFileSync(join(tmp, "mercos-login-fail-url.txt"), `${etapa}\n${page.url()}`, "utf8");
    } catch {
      /* diagnóstico é best-effort */
    }
    await browser.close();
    throw new Error(
      `Login Mercos falhou em: ${etapa}. Veja %TEMP%/mercos-login-fail.png + .html. Detalhe: ${e instanceof Error ? e.message : String(e)}`,
    );
  };

  try {
    await page.goto(URL_LOGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000); // SPA hidrata o form depois do HTML

    // Campo e-mail: tenta label, depois type=email, depois placeholder/name genéricos.
    const emailLoc = page
      .getByLabel(/e-?mail/i)
      .or(page.locator('input[type="email"]'))
      .or(page.locator('input[placeholder*="mail" i], input[name*="mail" i], input[name*="login" i], input[type="text"]'))
      .first();
    try {
      await emailLoc.waitFor({ timeout: 30_000 });
      await emailLoc.fill(email);
    } catch (e) {
      await falhou("preencher e-mail (seletor não achou o campo)", e);
    }

    try {
      const senhaLoc = page.locator('input[type="password"]').first();
      await senhaLoc.waitFor({ timeout: 30_000 });
      await senhaLoc.fill(senha);
    } catch (e) {
      await falhou("preencher senha", e);
    }

    try {
      const entrar = page.getByRole("button", { name: /entrar/i }).or(page.locator('button[type="submit"]')).first();
      await entrar.waitFor({ timeout: 30_000 });
      await entrar.click();
    } catch (e) {
      await falhou("clicar ENTRAR", e);
    }

    // Pós-login: SPA do Mercos — menu lateral com "Indicadores" prova que entrou.
    try {
      await page
        .getByText(/indicadores/i)
        .first()
        .waitFor({ timeout: 60_000 });
    } catch (e) {
      // Superfície: mensagem de erro de credencial renderizada na própria tela.
      const texto = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => "");
      if (/inválid|incorret|não encontramos|expirad|bloquead|muitas tentativas/i.test(texto)) {
        await falhou(`credenciais recusadas pelo Mercos. Trecho da tela: ${texto.slice(0, 300)}`, e);
      }
      await falhou("aguardar 'Indicadores' pós-login (sessão não entrou — veja o screenshot)", e);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Login Mercos falhou em:")) throw e;
    await falhou("etapa inesperada", e);
  }

  mkdirSync(dirname(SESSAO), { recursive: true });
  await context.storageState({ path: SESSAO });
  // Screenshot de conferência vai para o Temp do SO, nunca para o repo (evita vazar dado real).
  await page.screenshot({ path: join(tmp, "mercos-login-ok.png") });
  writeFileSync(join(tmp, "mercos-login-url.txt"), page.url(), "utf8");

  await browser.close();
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
