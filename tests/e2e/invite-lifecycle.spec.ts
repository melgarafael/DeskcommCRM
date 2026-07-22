/**
 * E2E do ciclo de vida do CONVITE, ponta a ponta + adversarial (Playwright).
 *
 * Cobre o que a pergunta do dono pediu — convidar → aceitar → entrar → ver só o
 * permitido → agir dentro da permissão — e stressa os cantos:
 *   1. Ciclo feliz: admin convida → convidado loga e aceita → vira membership agent → cai no inbox
 *   2. Escopo pós-aceite: o agent vê inbox/kanban, é bloqueado (403) em billing/api-tokens
 *   3. Permissão pós-aceite: o agent NÃO consegue convidar (invite é admin-only → 403)
 *   4. Reuso do token: aceitar o MESMO token 2x é idempotente (sem membership duplicada)
 *   5. already_member: reconvidar quem já é membro → failed:[{reason: already_member}]
 *   6. Token expirado → "Convite inválido ou expirado"
 *   7. Token adulterado (HMAC quebrado) → idem
 *   8. Email não corresponde: logado com OUTRA conta → "Email não corresponde"
 *   9. Não autenticado → CTA "Fazer login", não o formulário de aceite
 *
 * Pré-req: npx tsx scripts/seed-e2e-invite.ts (o spec roda sozinho se faltar).
 * Contra o Supabase do env (local recomendado — precisa das migrations de RLS
 * 0035/0036/0042/0044 pro escopo do agent ser real).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { signInviteToken } from "../../lib/auth/invite-token";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

// ---- creds do seed base (.e2e-creds.json) + do convite (.e2e-invite.json) ----
interface BaseCreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  admin_totp?: { factor_id: string; secret: string };
}
interface InviteCreds {
  org_id: string;
  invitee_email: string;
  invitee_id: string;
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const INVITE_PATH = path.join(process.cwd(), ".e2e-invite.json");

function load(): { base: BaseCreds; inv: InviteCreds } {
  if (!fs.existsSync(INVITE_PATH) || !fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-invite.ts"], { stdio: "inherit" });
  }
  return {
    base: JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as BaseCreds,
    inv: JSON.parse(fs.readFileSync(INVITE_PATH, "utf8")) as InviteCreds,
  };
}

const { base, inv } = load();

// service-role client (mesmo env do dev) — pra provar estado no banco e resetar
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function membershipCount(): Promise<number> {
  const { count } = await svc
    .from("user_organizations")
    .select("id", { count: "exact", head: true })
    .eq("user_id", inv.invitee_id)
    .eq("organization_id", inv.org_id)
    .is("revoked_at", null);
  return count ?? 0;
}

async function membershipRole(): Promise<string | null> {
  const { data } = await svc
    .from("user_organizations")
    .select("role")
    .eq("user_id", inv.invitee_id)
    .eq("organization_id", inv.org_id)
    .is("revoked_at", null)
    .maybeSingle();
  return (data as { role: string } | null)?.role ?? null;
}

async function resetInvitee(): Promise<void> {
  await svc.from("user_organizations").delete().eq("user_id", inv.invitee_id).eq("organization_id", inv.org_id);
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(base.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function loginAdminTotp(page: Page): Promise<void> {
  const secret = base.admin_totp!.secret;
  await page.goto("/login");
  await page.locator("#email").fill(base.users.admin!.email);
  await page.locator("#password").fill(base.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/login\/mfa/);
  for (let attempt = 0; attempt < 3; attempt++) {
    // não digitar em cima da virada da janela TOTP (o código expiraria no envio)
    if (msUntilNextTotpWindow() < 4_000) await page.waitForTimeout(msUntilNextTotpWindow() + 300);
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(secret), { delay: 40 });
    try {
      // 1ª compilação de /app no dev pode ser lenta → timeout generoso
      await page.waitForURL(/\/app\//, { timeout: 30_000 });
      return;
    } catch {
      if (/\/app\//.test(page.url())) return; // navegou; só passou do timeout
      if (!/\/login\/mfa/.test(page.url())) throw new Error(`MFA em estado inesperado: ${page.url()}`);
      await page.waitForTimeout(msUntilNextTotpWindow() + 300); // código recusado → nova janela
    }
  }
  throw new Error("admin MFA falhou após 3 tentativas");
}

// admin convida o convidado como agent → devolve o accept_url (token stateless)
async function issueInvite(page: Page, email: string, role: string): Promise<{ acceptUrl: string; failed: Array<{ email: string; reason: string }> }> {
  const res = await page.request.post("/api/v1/team/invite", {
    data: { invitations: [{ email, role }] },
  });
  expect(res.status(), await res.text()).toBe(201);
  const json = (await res.json()) as { data: { sent: Array<{ email: string; accept_url: string }>; failed: Array<{ email: string; reason: string }> } };
  return { acceptUrl: json.data.sent[0]?.accept_url ?? "", failed: json.data.failed };
}

function tokenOf(acceptUrl: string): string {
  return acceptUrl.split("/team/accept-invite/")[1] ?? "";
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe("ciclo de vida do convite (ponta a ponta + adversarial)", () => {
  test.beforeAll(async ({ browser }) => {
    // Dev (webpack) compila cada rota na 1ª visita — 40-80s cada. Aquecemos TODAS
    // as rotas que a suíte toca aqui (orçamento grande, uma vez); com o dev
    // persistente, os testes depois rodam rápido.
    test.setTimeout(600_000);
    await resetInvitee(); // convidado começa SEM acesso

    // (a) telas autenticadas de /app + endpoints — como agent (membro, sem MFA)
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/login");
    await page.locator("#email").fill(base.users.agent!.email);
    await page.locator("#password").fill(base.password);
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/app\//, { timeout: 150_000 }).catch(() => {});
    for (const r of ["/app/inbox", "/app/kanban", "/app/contacts", "/app/settings/billing", "/app/settings/api-tokens"]) {
      await page.goto(r).catch(() => {});
    }
    // compila o endpoint de convite (agent → 403, mas compila a rota)
    await page.request
      .post("/api/v1/team/invite", { data: { invitations: [{ email: "warm@deskcomm.test", role: "agent" }] } })
      .catch(() => {});
    // compila a tela de aceite (token dummy → inválido, mas compila a página)
    await page.goto("/team/accept-invite/warmup").catch(() => {});
    await ctx.close();

    // (b) /login/mfa — login de senha do admin, sem completar o TOTP
    const mctx = await browser.newContext();
    const mp = await mctx.newPage();
    await mp.goto("/login");
    await mp.locator("#email").fill(base.users.admin!.email);
    await mp.locator("#password").fill(base.password);
    await mp.getByRole("button", { name: /entrar/i }).click();
    await mp.waitForURL(/\/login\/mfa/, { timeout: 150_000 }).catch(() => {});
    await mctx.close();
  });

  test("1. ciclo feliz: convidar → aceitar → vira agent → cai no inbox", async ({ browser }) => {
    // admin convida
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await loginAdminTotp(adminPage);
    const { acceptUrl, failed } = await issueInvite(adminPage, inv.invitee_email, "agent");
    expect(failed).toEqual([]);
    expect(acceptUrl).toContain("/team/accept-invite/");
    await adminCtx.close();

    // antes do aceite: convidado NÃO tem acesso
    expect(await membershipCount()).toBe(0);

    // convidado loga e aceita
    const inviteeCtx = await browser.newContext();
    const page = await inviteeCtx.newPage();
    await page.goto("/login");
    await page.locator("#email").fill(inv.invitee_email);
    await page.locator("#password").fill(base.password);
    await page.getByRole("button", { name: /entrar/i }).click();
    // Sem membership ainda: o login não cai em /app. Esperamos a SESSÃO (cookie)
    // se firmar antes de ir ao accept_url — senão a página cai no estado não-logado.
    await expect
      .poll(async () => (await inviteeCtx.cookies()).some((c) => c.name.startsWith("sb-deskcomm-auth")), {
        timeout: 40_000, // 1º login no dev (webpack) compila signInWithPassword — pode levar ~16s
      })
      .toBe(true);
    // Vamos direto ao accept_url (fluxo real do link do email).
    await page.goto(tokenPath(acceptUrl));
    await expect(page.getByRole("heading", { name: /Aceitar convite/i })).toBeVisible();
    await page.getByRole("button", { name: /Aceitar convite/i }).click();
    await page.waitForURL(/\/app\/inbox/);

    // depois do aceite: membership agent criada
    expect(await membershipCount()).toBe(1);
    expect(await membershipRole()).toBe("agent");
    await inviteeCtx.close();
  });

  test("2. escopo pós-aceite: agent vê inbox/kanban, bloqueado em billing/api-tokens", async ({ page }) => {
    await login(page, inv.invitee_email);

    await page.goto("/app/settings/billing");
    await page.waitForURL(/\/403/);
    await expect(page.getByRole("heading", { name: /403/ })).toBeVisible();

    await page.goto("/app/settings/api-tokens");
    await page.waitForURL(/\/403/);

    await page.goto("/app/inbox");
    await expect(page.getByText("Selecione uma conversa", { exact: true })).toBeVisible();

    await page.goto("/app/kanban");
    await expect(page.getByRole("heading", { name: "Pipelines" })).toBeVisible();
  });

  test("3. permissão pós-aceite: agent NÃO consegue convidar (403)", async ({ page }) => {
    await login(page, inv.invitee_email);
    const res = await page.request.post("/api/v1/team/invite", {
      data: { invitations: [{ email: "outro.invite@deskcomm.test", role: "agent" }] },
    });
    expect(res.status()).toBe(403);
  });

  test("4. reuso do token: aceitar 2x é idempotente (sem membership duplicada)", async ({ browser }) => {
    // Token válido mintado direto: o convidado já é membro (testes anteriores), então
    // reconvidá-lo seria — corretamente — barrado por already_member. Aqui testamos só
    // a IDEMPOTÊNCIA do aceite em si (aceitar o mesmo token 2x não duplica membership).
    const token = signInviteToken({
      invite_id: randomUUID(),
      email: inv.invitee_email,
      organization_id: inv.org_id,
      role: "agent",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, inv.invitee_email); // já é membro → cai no /app
    // 1º aceite (reaplica)
    await page.goto(`/team/accept-invite/${token}`);
    await page.getByRole("button", { name: /Aceitar convite/i }).click();
    await page.waitForURL(/\/app\/inbox/);
    // 2º aceite do MESMO token
    await page.goto(`/team/accept-invite/${token}`);
    await page.getByRole("button", { name: /Aceitar convite/i }).click();
    await page.waitForURL(/\/app\/inbox/);
    // sem duplicar membership
    expect(await membershipCount()).toBe(1);
    await ctx.close();
  });

  test("5. already_member: reconvidar quem já é membro → failed already_member", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAdminTotp(page);
    const { failed } = await issueInvite(page, inv.invitee_email, "agent");
    expect(failed.some((f) => f.email === inv.invitee_email && f.reason === "already_member")).toBe(true);
    await ctx.close();
  });

  test("6. token expirado → convite inválido ou expirado", async ({ page }) => {
    const expired = signInviteToken({
      invite_id: randomUUID(),
      email: inv.invitee_email,
      organization_id: inv.org_id,
      role: "agent",
      exp: Math.floor(Date.now() / 1000) - 60, // 1min no passado
    });
    await page.goto(`/team/accept-invite/${expired}`);
    await expect(page.getByRole("heading", { name: /inválido ou expirado/i })).toBeVisible();
  });

  test("7. token adulterado (HMAC quebrado) → inválido", async ({ page }) => {
    const valid = signInviteToken({
      invite_id: randomUUID(),
      email: inv.invitee_email,
      organization_id: inv.org_id,
      role: "agent",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    // vira a assinatura: troca o último char por outro
    const flipped = valid.slice(0, -1) + (valid.slice(-1) === "A" ? "B" : "A");
    await page.goto(`/team/accept-invite/${flipped}`);
    await expect(page.getByRole("heading", { name: /inválido ou expirado/i })).toBeVisible();
  });

  test("8. email não corresponde: logado com outra conta → mismatch", async ({ page }) => {
    const valid = signInviteToken({
      invite_id: randomUUID(),
      email: inv.invitee_email, // convite pro convidado
      organization_id: inv.org_id,
      role: "agent",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    // mas logamos como o AGENT do seed base (email diferente)
    await login(page, base.users.agent!.email);
    await page.goto(`/team/accept-invite/${valid}`);
    await expect(page.getByRole("heading", { name: /não corresponde/i })).toBeVisible();
  });

  test("9. não autenticado → CTA de login, não o formulário de aceite", async ({ page }) => {
    const valid = signInviteToken({
      invite_id: randomUUID(),
      email: inv.invitee_email,
      organization_id: inv.org_id,
      role: "agent",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    await page.goto(`/team/accept-invite/${valid}`);
    await expect(page.getByRole("heading", { name: /Você foi convidado/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Fazer login/i })).toBeVisible();
  });
});

// helper: extrai só o path (relativo) do accept_url absoluto pro page.goto
function tokenPath(acceptUrl: string): string {
  const t = tokenOf(acceptUrl);
  return `/team/accept-invite/${t}`;
}
