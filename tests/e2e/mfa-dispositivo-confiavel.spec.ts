/**
 * "CONFIAR NESTE DISPOSITIVO" — pelo caminho de quem usa.
 *
 * 1. Entra com senha, a tela pede o código; marca "Confiar neste dispositivo
 *    por 30 dias" e digita o código.
 * 2. A sessão acaba (cookies de sessão apagados — o navegador fica com o de
 *    confiança, como fica quando a pessoa fecha a aba e volta outro dia). Entra
 *    de novo com senha e vai DIRETO ao sistema, e uma rota que cobra o segundo
 *    fator responde 200 — prova de que o BANCO aceitou a sessão, não só a tela.
 * 3. Em Segurança o dispositivo aparece; "Esquecer todos os dispositivos" e a
 *    próxima entrada volta a pedir o código.
 *
 * Usuário e organização PRÓPRIOS, com fator cadastrado aqui: o admin semeado é
 * compartilhado com outras specs.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { test, expect, type Page } from "./helpers/test";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const svc = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const SENHA = "Confiavel!2026#Deskcomm";
const email = `confiavel-${randomUUID().slice(0, 8)}@qa.local`;
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "mfa-dispositivo-confiavel");
const COOKIE = "mfa_dispositivo_confiavel";

let userId = "";
let orgId = "";
let segredo = "";

test.beforeAll(async () => {
  const { data: criado, error } = await svc.auth.admin.createUser({ email, password: SENHA, email_confirm: true });
  if (error || !criado.user) throw error ?? new Error("sem usuário");
  userId = criado.user.id;

  const { data: org, error: e2 } = await svc
    .from("organizations")
    .insert({
      slug: `confiavel-${randomUUID().slice(0, 8)}`,
      display_name: "Empresa Confiável",
      legal_name: "Empresa Confiável",
      status: "active",
      created_by: userId,
      onboarded_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (e2 || !org) throw e2 ?? new Error("sem org");
  orgId = org.id as string;
  await svc.from("user_organizations").insert({
    organization_id: orgId,
    user_id: userId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });

  const anon = createClient(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: e3 } = await anon.auth.signInWithPassword({ email, password: SENHA });
  if (e3) throw e3;
  const { data: fator, error: e4 } = await anon.auth.mfa.enroll({ factorType: "totp", friendlyName: "e2e" });
  if (e4 || !fator) throw e4 ?? new Error("sem fator");
  segredo = fator.totp.secret;
  const { error: e5 } = await anon.auth.mfa.challengeAndVerify({ factorId: fator.id, code: generateTotp(segredo) });
  if (e5) throw e5;
  await anon.auth.signOut();
});

test.afterAll(async () => {
  if (orgId) {
    await svc.from("user_organizations").delete().eq("organization_id", orgId);
    await svc.from("crm_stages").delete().eq("organization_id", orgId);
    await svc.from("crm_pipelines").delete().eq("organization_id", orgId);
    await svc.from("organizations").delete().eq("id", orgId);
  }
  if (userId) await svc.auth.admin.deleteUser(userId);
});

async function entrarComSenha(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(SENHA);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

/** Fecha a sessão sem tocar no cookie de confiança — o navegador "volta outro dia". */
async function sessaoAcabou(page: Page): Promise<void> {
  const confianca = (await page.context().cookies()).filter((c) => c.name === COOKIE);
  await page.context().clearCookies();
  await page.context().addCookies(confianca);
}

async function digitarCodigo(page: Page): Promise<void> {
  if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 300);
  await page.locator('input[aria-label="Dígito 1"]').click();
  await page.keyboard.type(generateTotp(segredo), { delay: 40 });
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test("marcar 'confiar', sair e voltar: entra sem o código, e o banco aceita a sessão", async ({ page }) => {
  await entrarComSenha(page);
  await page.waitForURL(/\/login\/mfa/, { timeout: 30_000 });
  await page.getByLabel("Confiar neste dispositivo por 30 dias").check();
  await page.screenshot({ path: path.join(EVIDENCIA, "1-codigo-com-confiar.png") });
  await digitarCodigo(page);
  await page.waitForURL(/\/app\//, { timeout: 30_000 });

  const confianca = (await page.context().cookies()).find((c) => c.name === COOKIE);
  expect(confianca?.httpOnly).toBe(true);

  await sessaoAcabou(page);
  await entrarComSenha(page);
  await page.waitForURL(/\/app\//, { timeout: 30_000 });
  expect(page.url()).not.toContain("/login/mfa");
  await page.screenshot({ path: path.join(EVIDENCIA, "2-entrou-sem-codigo.png") });

  // Rota que cobra o segundo fator: `mfaEmDivida` pergunta a
  // `fn_session_mfa_proven`, então o 200 é o BANCO aceitando a sessão aal1.
  // Sem a confiança reconhecida, é 403 `mfa_required`.
  const r = await page.request.get("/api/v1/tags/vocabulario");
  expect(r.status(), JSON.stringify(await r.json())).toBe(200);
});

test("Segurança mostra o dispositivo; esquecer faz o código voltar", async ({ page }) => {
  await entrarComSenha(page);
  await page.waitForURL(/\/login\/mfa/, { timeout: 30_000 });
  await page.getByLabel("Confiar neste dispositivo por 30 dias").check();
  await digitarCodigo(page);
  await page.waitForURL(/\/app\//, { timeout: 30_000 });

  await page.goto("/app/settings/security");
  await expect(page.getByRole("heading", { name: "Dispositivos confiáveis" })).toBeVisible();
  await expect(page.getByText(/Confiável até/).first()).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "3-seguranca-lista.png"), fullPage: true });
  await page.getByRole("button", { name: "Esquecer todos os dispositivos" }).click();
  await expect(page.getByText("Nenhum dispositivo confiável.")).toBeVisible();

  await sessaoAcabou(page);
  await entrarComSenha(page);
  await page.waitForURL(/\/login\/mfa/, { timeout: 30_000 });
  await page.screenshot({ path: path.join(EVIDENCIA, "4-esquecido-pede-codigo.png") });
});
