/** Recon do cadastro/detalhe de cliente no Mercos (fotos + campos). */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos", "auditoria");

async function main(): Promise<void> {
  mkdirSync(SAIDA, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO, viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  // 1. Lista + modal Cadastrar cliente.
  await page.goto("https://app.mercos.com/338282/clientes/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5000);
  const cadastrar = page.getByRole("button", { name: /cadastrar cliente/i }).first();
  if ((await cadastrar.count()) > 0) {
    await cadastrar.click().catch(() => undefined);
    await page.waitForTimeout(4000);
  }
  const modal = await page.evaluate(() => {
    const corpo = document.body.innerText;
    const abas = [...new Set(
      [...document.querySelectorAll("[role='tab'], button")]
        .map((e) => (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50))
        .filter((t) => t && /física|jurídica|cpf|cnpj|pessoa|cliente|endereço|contato|fiscal/i.test(t)),
    )].slice(0, 30);
    const campos = [...document.querySelectorAll("input, select, textarea")]
      .map((i) => {
        const e = i as HTMLInputElement;
        const label = e.placeholder || e.getAttribute("aria-label") || e.name || e.id;
        return `${e.tagName.toLowerCase()}[${e.type || ""}]=${(label || "").slice(0, 60)}`;
      })
      .slice(0, 80);
    return { url: location.href, abas, campos, trecho: corpo.slice(0, 3000) };
  });
  writeFileSync(join(SAIDA, "cli-cadastrar.json"), JSON.stringify(modal, null, 2), "utf8");
  await page.screenshot({ path: join(SAIDA, "cli-cadastrar.png") });

  // 2. Fecha modal, abre o Alterar do primeiro cliente.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(2000);
  const alterar = page.getByRole("link", { name: /alterar/i }).or(page.getByRole("button", { name: /alterar/i })).first();
  const href = await alterar.evaluate((a) => (a as HTMLAnchorElement).href || "").catch(() => "");
  if (href) {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else if ((await alterar.count()) > 0) {
    await alterar.click().catch(() => undefined);
  }
  await page.waitForTimeout(6000);
  const detalhe = await page.evaluate(() => {
    const abas = [...new Set(
      [...document.querySelectorAll("[role='tab'], nav a, h1, h2")]
        .map((e) => (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60))
        .filter(Boolean),
    )].slice(0, 40);
    const campos = [...document.querySelectorAll("input, select, textarea")]
      .map((i) => {
        const e = i as HTMLInputElement;
        const label = e.placeholder || e.getAttribute("aria-label") || e.name || e.id;
        return `${e.tagName.toLowerCase()}[${e.type || ""}]=${(label || "").slice(0, 60)}:${(e.value || "").slice(0, 40)}`;
      })
      .slice(0, 120);
    const secoes = [...document.querySelectorAll("h1,h2,h3,legend,fieldset")]
      .map((e) => (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80))
      .filter(Boolean)
      .slice(0, 40);
    return { url: location.href, abas, secoes, campos };
  });
  writeFileSync(join(SAIDA, "cli-detalhe.json"), JSON.stringify(detalhe, null, 2), "utf8");
  await page.screenshot({ path: join(SAIDA, "cli-detalhe.png"), fullPage: true });

  // 3. Edição de produto (olho/alterar na grade).
  await page.goto("https://app.mercos.com/industria/338282/produtos/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5000);
  const olho = page.locator("table tbody tr").first().locator("a, button").first();
  if ((await olho.count()) > 0) {
    await olho.click().catch(() => undefined);
    await page.waitForTimeout(6000);
  }
  const prod = await page.evaluate(() => {
    const secoes = [...document.querySelectorAll("h1,h2,h3,legend,fieldset")]
      .map((e) => (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80))
      .filter(Boolean)
      .slice(0, 40);
    const campos = [...document.querySelectorAll("input, select, textarea")]
      .map((i) => {
        const e = i as HTMLInputElement;
        const label = e.placeholder || e.getAttribute("aria-label") || e.name || e.id;
        return `${e.tagName.toLowerCase()}[${e.type || ""}]=${(label || "").slice(0, 60)}:${(e.value || "").slice(0, 40)}`;
      })
      .slice(0, 120);
    const botoes = [...new Set(
      [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50)).filter(Boolean),
    )].slice(0, 30);
    return { url: location.href, secoes, campos, botoes };
  });
  writeFileSync(join(SAIDA, "prod-editar.json"), JSON.stringify(prod, null, 2), "utf8");
  await page.screenshot({ path: join(SAIDA, "prod-editar.png"), fullPage: true });
  await browser.close();
  // eslint-disable-next-line no-console
  console.log("OK");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
