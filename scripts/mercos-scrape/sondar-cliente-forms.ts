/** Descobre como abrir Cadastrar/Alterar cliente (handlers reais). */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos", "auditoria");

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO, viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto("https://app.mercos.com/338282/clientes/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5000);

  const alvo = await page.evaluate(() => {
    const els = [...document.querySelectorAll("button, a")].filter((e) =>
      /cadastrar cliente|alterar/i.test((e.textContent || "").trim()),
    );
    return els.slice(0, 6).map((e) => ({
      tag: e.tagName,
      texto: (e.textContent || "").trim().slice(0, 40),
      href: (e as HTMLAnchorElement).href || null,
      onclick: e.getAttribute("ng-click") || e.getAttribute("ngClick") || null,
      classes: (e as HTMLElement).className?.toString?.()?.slice(0, 80) ?? "",
    }));
  });
  writeFileSync(join(SAIDA, "cli-alvos.json"), JSON.stringify(alvo, null, 2), "utf8");

  // Tenta o Cadastrar com force + espera modal/dialog.
  const btn = page.getByRole("button", { name: /cadastrar cliente/i }).first();
  await btn.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(5000);
  const modal = await page.evaluate(() => ({
    dialogs: document.querySelectorAll('[role="dialog"], .modal, .modal-dialog, [class*="overlay"]').length,
    inputs: document.querySelectorAll("input").length,
  }));
  writeFileSync(join(SAIDA, "cli-modal.json"), JSON.stringify(modal, null, 2), "utf8");
  await page.screenshot({ path: join(SAIDA, "cli-modal.png") });
  await browser.close();
  // eslint-disable-next-line no-console
  console.log("OK");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
