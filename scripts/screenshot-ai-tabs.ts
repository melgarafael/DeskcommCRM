/**
 * Prova visual da aba de Credenciais (protocolo execução visível).
 * Loga como o admin do seed (com TOTP real) e fotografa as telas novas.
 * Uso: pnpm exec tsx scripts/screenshot-ai-tabs.ts <baseURL> <outDir>
 */
import { chromium } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [, , baseURL = "http://localhost:3210", outDir = "/tmp"] = process.argv;

function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret: string, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

async function main() {
  const creds = JSON.parse(readFileSync(".e2e-creds.json", "utf-8"));
  const email: string = creds.users.admin.email;
  const password: string = creds.password;
  const secret: string = creds.admin_totp.secret;

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(`${baseURL}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/login\/mfa/, { timeout: 20_000 });
  console.log("etapa: /login/mfa alcançado");
  // Input OTP com auto-submit no onComplete — digitar via teclado, não fill().
  await page.locator("input").first().click();
  await page.keyboard.type(totp(secret), { delay: 60 });
  await page.waitForURL(/\/(app|onboarding)\//, { timeout: 30_000 });
  console.log("etapa: autenticado em", page.url());

  await page.goto(`${baseURL}/app/ai/agents`);
  await page.getByRole("navigation", { name: "Seções de IA" }).waitFor({ timeout: 15_000 });
  await page.screenshot({ path: join(outDir, "ai-tabs-agents.png") });
  console.log("url agents:", page.url());

  await page.getByRole("link", { name: "Credenciais" }).click();
  await page.waitForURL(/\/app\/ai\/credentials/);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: join(outDir, "ai-tabs-credentials.png") });

  const addBtn = page.getByRole("button", { name: /credencial/i }).first();
  if (await addBtn.isVisible().catch(() => false)) {
    await addBtn.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, "ai-credentials-dialog.png") });
  }

  await browser.close();
  console.log("SCREENSHOTS_OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
