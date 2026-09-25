/**
 * A VERIFICAÇÃO EM DUAS ETAPAS DEIXOU DE SER OBRIGATÓRIA — e a regra tem que
 * valer nos DOIS sentidos.
 *
 * O gate era `isPlatformAdmin || role === "admin"`, sem opção, e o `install.sh`
 * cria o dono da instalação como platform admin. Medido percorrendo o wizard: o
 * botão "Começar a usar" entregava o dono num bloqueador de tela cheia pedindo
 * um aplicativo autenticador — um sétimo passo que a barra de progresso nunca
 * anunciou, na hora em que ele finalmente ia ver o produto funcionando.
 *
 * ⚠️ ORGANIZAÇÃO PRÓPRIA, e aqui isso não é preferência: o caso do meio LIGA a
 * exigência. Fazer isso na organização compartilhada do seed deixaria todas as
 * specs seguintes presas no bloqueador.
 */
import { randomUUID } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const SENHA = "MfaOpcional!2026#Deskcomm";
const email = `mfa-${randomUUID().slice(0, 8)}@qa.local`;

let userId = "";
let orgId = "";

test.beforeAll(async () => {
  const { data: criado, error } = await svc.auth.admin.createUser({
    email,
    password: SENHA,
    email_confirm: true,
  });
  if (error || !criado.user) throw error ?? new Error("sem usuário");
  userId = criado.user.id;

  const { data: org, error: e2 } = await svc
    .from("organizations")
    .insert({
      slug: `mfa-opcional-${randomUUID().slice(0, 8)}`,
      display_name: "Empresa Sem MFA",
      legal_name: "Empresa Sem MFA",
      status: "active",
      created_by: userId,
      // Já onboardada: o que se mede aqui é a entrada no app, não o wizard.
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
});

test.afterAll(async () => {
  if (orgId) await svc.from("user_organizations").delete().eq("organization_id", orgId);
  if (orgId) {
    await svc.from("crm_stages").delete().eq("organization_id", orgId);
    await svc.from("crm_pipelines").delete().eq("organization_id", orgId);
    await svc.from("organizations").delete().eq("id", orgId);
  }
  if (userId) await svc.auth.admin.deleteUser(userId);
});

async function entrar(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(SENHA);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

/** O bloqueador de tela cheia, pelo texto que só ele mostra. */
const BLOQUEADOR = /Configure a verificação em duas etapas/i;

test.describe.configure({ mode: "serial", timeout: 90_000 });

test.describe("a verificação em duas etapas é escolha, não imposição", () => {
  test("admin entra no sistema sem ser parado", async ({ page }) => {
    await entrar(page);
    await page.waitForURL(/\/app\//, { timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText(BLOQUEADOR);
  });

  test("e a tela de Segurança oferece LIGAR — antes isso era inalcançável", async ({ page }) => {
    // O único ponto de cadastro do produto era o próprio bloqueador. Sem um
    // botão aqui, tornar o cadastro opcional deixaria a verificação
    // impossível de ativar para quem quisesse usá-la — a tela dizia "Faça login
    // novamente para iniciar o enrolamento", que com o gate desligado nunca
    // aconteceria.
    await entrar(page);
    await page.waitForURL(/\/app\//, { timeout: 30_000 });
    await page.goto("/app/settings/security");

    await expect(page.getByText("Desativada")).toBeVisible();
    await page.getByRole("button", { name: /^ativar$/i }).click();

    await expect(page.getByRole("heading", { name: BLOQUEADOR })).toBeVisible();
    // E o texto reconhece que a pessoa está ESCOLHENDO. O mesmo modal serve ao
    // bloqueador, onde "esta empresa exige" é verdade; aqui seria mentira.
    await expect(page.locator("#mfa-title").locator("..")).toContainText(
      /a cada login, além da senha/i,
    );
  });

  test("o admin pode EXIGIR da equipe — e a exigência pega de verdade", async ({ page }) => {
    await entrar(page);
    await page.waitForURL(/\/app\//, { timeout: 30_000 });
    await page.goto("/app/settings/security");

    await page.locator('input[type="checkbox"]').click();
    await page.waitForLoadState("networkidle");

    // A escrita é por service role com a organização resolvida da sessão: a
    // única policy de escrita em `organizations` é a de platform admin, então
    // pelo client de sessão o UPDATE casaria ZERO linhas e devolveria sucesso —
    // a tela diria "salvo" sobre nada.
    const { data: org } = await svc
      .from("organizations")
      .select("settings")
      .eq("id", orgId)
      .maybeSingle();
    const settings = org?.settings as { security?: { mfa_required?: boolean } } | null;
    expect(settings?.security?.mfa_required).toBe(true);

    // E agora o bloqueador aparece — o mesmo que não aparecia no primeiro caso.
    await page.goto("/app/inbox");
    await expect(page.locator("body")).toContainText(BLOQUEADOR);
  });

  test("desligar a exigência devolve o acesso", async ({ page }) => {
    // Sem este caminho de volta, ligar a regra seria uma porta sem maçaneta: o
    // admin fica preso no bloqueador e a tela que desliga está atrás dele.
    await svc
      .from("organizations")
      .update({ settings: { security: { mfa_required: false } } })
      .eq("id", orgId);

    await entrar(page);
    await page.waitForURL(/\/app\//, { timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText(BLOQUEADOR);
  });
});
