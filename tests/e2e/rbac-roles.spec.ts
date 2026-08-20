/**
 * G2-04 — E2E da matriz role×recurso (spec 13 §4) com usuários seed reais.
 *
 * Papéis: agent vê a informação MCP em /app/settings/api-tokens, mas continua
 * bloqueado em billing; admin (com MFA TOTP — secret conhecido do seed) acessa
 * a gestão de tokens e billing; agent vê inbox
 * e kanban; viewer não consegue enviar mensagem (403 server-side).
 *
 * Pré-requisito: `npx tsx scripts/seed-e2e-credentials.ts` (o spec roda o seed
 * sozinho se .e2e-creds.json estiver ausente/incompleto).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { afirmarAdminDeTenantPuro } from "./utils/precondicao";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  admin_totp?: { factor_id: string; secret: string };
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

function loadCreds(): E2ECreds {
  const needsSeed = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
    return !c.users?.viewer || !c.admin_totp?.secret;
  };
  if (needsSeed()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

const creds = loadCreds();

// ── Precondição de identidade ────────────────────────────────────────────────
// Esta spec é a matriz de PAPEL do tenant, e é onde um escape de plataforma
// faria mais estrago: uma regressão de RBAC ficaria invisível na spec que existe
// para pegá-la.
//
// ⚠️ MEDIDO antes de afirmar: as duas telas do caso do admin
  // (`app/app/settings/api-tokens/page.tsx` e `.../billing/page.tsx:20`)

// gateiam em `ROLE_RANK[activeOrg.role] < ROLE_RANK.admin` **sem** escape de
// `is_platform_admin`, e `requireRole` só bypassa com `allowPlatformAdmin: true`
// explícito. Hoje a promoção NÃO muda o desfecho deste arquivo. A precondição
// fica porque é aqui que a próxima asserção de papel vai nascer.
test.beforeAll(async () => {
  await afirmarAdminDeTenantPuro(creds.users.admin!.email);
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function loginWithTotp(page: Page, email: string, secret: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/login\/mfa/);

  // Até 2 tentativas: um código pode expirar na borda da janela de 30s.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (msUntilNextTotpWindow() < 3_000) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
    const code = generateTotp(secret);
    const firstDigit = page.locator('input[aria-label="Dígito 1"]');
    await firstDigit.click();
    await page.keyboard.type(code, { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 8_000 });
      return;
    } catch {
      // código rejeitado — espera a próxima janela e tenta de novo
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA challenge failed after 2 TOTP attempts");
}

async function expectNoBlockingA11y(page: Page, excludeSelector?: string): Promise<void> {
  let builder = new AxeBuilder({ page });
  if (excludeSelector) builder = builder.exclude(excludeSelector);
  const results = await builder.analyze();
  const blocking = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test.describe("rbac role matrix (spec 13 §4)", () => {
  test("agent vê conexão MCP, mas continua bloqueado em billing", async ({ page }) => {
    await login(page, creds.users.agent!.email);

    await page.goto("/app/settings/api-tokens");
    await expect(page.getByRole("heading", { name: "Conexão MCP" })).toBeVisible();
    await expect(page.getByText("Conectar um agente ao CRM via MCP")).toBeVisible();
    await expect(page.getByRole("button", { name: "Criar token" })).toHaveCount(0);

    await page.goto("/app/settings/billing");
    await page.waitForURL(/\/403/);
    await expect(page.getByRole("heading", { name: /403 — Sem permissão/ })).toBeVisible();

    await expectNoBlockingA11y(page);
  });

  test("admin acessa api-tokens e billing (login com MFA TOTP)", async ({ page }) => {
    expect(creds.admin_totp?.secret, "seed deve gravar admin_totp em .e2e-creds.json").toBeTruthy();
    await loginWithTotp(page, creds.users.admin!.email, creds.admin_totp!.secret);

    await page.goto("/app/settings/api-tokens");
    await expect(page.getByRole("heading", { name: "API Tokens" })).toBeVisible();
    await expectNoBlockingA11y(page);

    await page.goto("/app/settings/billing");
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
    await expectNoBlockingA11y(page);
  });

  test("agent vê inbox e kanban", async ({ page }) => {
    await login(page, creds.users.agent!.email);

    await page.goto("/app/inbox");
    await expect(page.getByText("Selecione uma conversa", { exact: true })).toBeVisible();
    // Baseline pré-G2-04: as abas Radix de InboxFilters apontam aria-controls
    // para painel não renderizado (aria-valid-attr-value, defeito pré-existente
    // fora do escopo desta feature). Excluímos só o tablist; o resto da tela
    // segue coberto por todas as regras — sem regressão é o critério.
    await expectNoBlockingA11y(page, '[role="tablist"]');

    await page.goto("/app/kanban");
    await expect(page.getByRole("heading", { name: "Funis" })).toBeVisible();
    await expectNoBlockingA11y(page);
  });

  test("viewer não consegue enviar mensagem (403 no POST /api/v1/messages)", async ({ page }) => {
    await login(page, creds.users.viewer!.email);

    // Enforcement server-side (G2-01): requireRole("agent") roda antes de
    // qualquer validação de recurso — viewer recebe 403 forbidden_role.
    const res = await page.request.post("/api/v1/messages", {
      data: {
        conversation_id: "00000000-0000-4000-8000-000000000000",
        body: "mensagem de teste e2e",
        type: "text",
      },
    });
    expect(res.status()).toBe(403);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("forbidden_role");
  });
});
