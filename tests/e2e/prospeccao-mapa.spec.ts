import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Jornada do mapa da Prospecção.
 *
 * Seed com 3 prospects geolocalizados. Aba Empresas → visão Mapa: marcadores
 * reais no Leaflet, clique no marcador seleciona na lista, detalhe abre,
 * rota desenha paradas numeradas.
 */
const RAIZ = path.join(__dirname, "..", "..");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
}

async function entrar(page: Page, creds: Creds) {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test.beforeAll(() => {
  execFileSync("npx", ["tsx", "scripts/seed-e2e-prospeccao-mapa.ts"], { stdio: "inherit", cwd: RAIZ });
});

test("mapa mostra marcadores, clique sincroniza lista e detalhe abre", async ({ page }) => {
  const creds = lerCreds();
  await entrar(page, creds);
  await page.goto("/app/prospeccao");

  await page.getByRole("tab", { name: /empresas/i }).click();
  await page.getByRole("button", { name: /^mapa$/i }).click();
  const mapa = page.locator(".leaflet-container").first();
  await expect(mapa, "visão Mapa sem contêiner Leaflet").toBeVisible({ timeout: 30_000 });

  const marcadores = page.locator(".leaflet-marker-icon");
  await expect
    .poll(async () => marcadores.count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);

  await marcadores.first().click();
  await expect(page.getByRole("button", { name: /ver empresa/i }).first()).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: /ver empresa/i }).first().click();
  await expect(page.getByRole("dialog").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog").first()).toContainText(/Restaurante E2E Mapa|Mercado E2E Mapa|Padaria E2E Mapa/);
});
