/**
 * CONVITE NÃO CAI NO ONBOARDING DA EMPRESA (#5127), medido no browser.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `app/app/layout.tsx` mandava para `/onboarding` TODA pessoa de uma organização
 * com `onboarded_at` vazio. Numa instalação nova, o dono convida alguém como
 * `agent` antes de terminar a configuração; a pessoa aceita o convite e cai no
 * `/onboarding/welcome` — o assistente que configura a empresa, que não é dela.
 *
 * ─── O que esta spec mede ───────────────────────────────────────────────────
 *
 * A jornada que o issue pede: dono sem onboarding concluído → convite → aceite →
 * a casca do CRM aparece e a URL final NÃO é `/onboarding/*`; o dono semeado
 * segue indo ao `/onboarding`. O dono é semeado aqui (org sem
 * `onboarded_at`, vínculo de admin sem `invited_by`), o convite sai pela rota
 * real (`POST /api/v1/team/invite`) e o aceite é o botão real da tela.
 *
 * O caso do painel de plataforma (dono convidado como admin, sem outro admin
 * que não tenha entrado por convite) fica no teste de unidade do layout, onde
 * dá para montar o estado do vínculo provisório sem dirigir a tela inteira.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import { esperarARevelacaoNasCargas, test, expect, type BrowserContext, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;

async function insert(table: string, value: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id as string;
}

async function criarUsuario(email: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("usuário não criado");
  return data.user.id;
}

async function entrar(page: Page, email: string, next?: string): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  // O dono de empresa sem onboarding cai no wizard; o convidado é levado ao
  // convite pelo `next`. As duas saídas são válidas para esta jornada.
  await page.waitForURL(/\/app(\/|$)|\/onboarding|\/team\/accept-invite\//, { timeout: 60_000 });
}

test("quem aceita convite de uma empresa ainda em configuração cai no CRM, não no onboarding", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().slice(0, 8);
  const donoEmail = `dono-${suffix}@invariant.test`;
  const convidadoEmail = `convidado-${suffix}@invariant.test`;
  const usuarios: string[] = [];
  const organizacoes: string[] = [];
  let contextoDoConvidado: BrowserContext | undefined;

  try {
    usuarios.push(await criarUsuario(donoEmail));
    usuarios.push(await criarUsuario(convidadoEmail));
    const [donoId, convidadoId] = usuarios as [string, string];

    // Instalação fresca: a empresa nasce SEM `onboarded_at` e o dono entra como
    // admin sem convite — o mesmo estado que `bootstrap-owner` deixa.
    const orgId = await insert("organizations", {
      display_name: `Empresa ${suffix}`,
      legal_name: `Empresa ${suffix} LTDA`,
      slug: `convite-${suffix}`,
      created_by: donoId,
    });
    organizacoes.push(orgId);
    await insert("user_organizations", {
      organization_id: orgId,
      user_id: donoId,
      role: "admin",
      accepted_at: new Date().toISOString(),
    });

    // O dono convida pela rota real e recebe o link do convite. Antes, a
    // guarda do outro lado: o dono semeado (sem `invited_by`) continua indo ao
    // assistente — a regra nova não tirou o wizard de quem vai terminá-lo.
    await entrar(page, donoEmail);
    await page.goto("/app");
    await expect(page, "o dono da empresa em configuração deixou de ir ao onboarding").toHaveURL(
      /\/onboarding(\/|$)/,
      { timeout: 60_000 },
    );
    const resposta = await page.request.post("/api/v1/team/invite", {
      data: { invitations: [{ email: convidadoEmail, role: "agent" }] },
    });
    expect(resposta.status(), await resposta.text()).toBe(201);
    const corpo = (await resposta.json()) as {
      data: { sent: Array<{ email: string; accept_url: string }>; failed: Array<{ email: string; reason: string }> };
    };
    expect(corpo.data.failed, JSON.stringify(corpo.data.failed)).toEqual([]);
    const acceptUrl = corpo.data.sent[0]?.accept_url ?? "";
    expect(acceptUrl, "a rota do convite não devolveu o link de aceite").toContain("/team/accept-invite/");

    // O convidado entra na própria conta e aceita pelo botão da tela.
    contextoDoConvidado = await browser.newContext();
    contextoDoConvidado.on("page", esperarARevelacaoNasCargas);
    const convidado = await contextoDoConvidado.newPage();
    await entrar(convidado, convidadoEmail, new URL(acceptUrl).pathname);
    await expect(convidado).toHaveURL(/\/team\/accept-invite\//, { timeout: 60_000 });
    await convidado.getByRole("button", { name: "Aceitar convite", exact: true }).click();

    // ── o que o issue pede: o destino final não é o onboarding ────────────
    // Espera a casca do CRM aparecer antes de olhar o caminho: só sair da tela
    // de aceite pegava o `/app` de passagem, antes do layout mandar ao wizard.
    await expect(
      convidado.locator('[data-casca="raiz"]'),
      "o convidado não chegou à casca do CRM",
    ).toBeVisible({ timeout: 60_000 });
    expect(
      new URL(convidado.url()).pathname,
      "o convidado foi mandado para o onboarding da empresa que não é dele",
    ).not.toMatch(/^\/onboarding(\/|$)/);

    // E entrou mesmo: o vínculo existe, com o convidador gravado.
    const { data: vinculo, error: erroDoVinculo } = await db
      .from("user_organizations")
      .select("role, invited_by")
      .eq("organization_id", orgId)
      .eq("user_id", convidadoId)
      .single();
    expect(erroDoVinculo).toBeNull();
    expect(vinculo).toEqual({ role: "agent", invited_by: donoId });
  } finally {
    await contextoDoConvidado?.close();
    for (const org of organizacoes) await db.from("organizations").delete().eq("id", org);
    for (const usuario of usuarios) await db.auth.admin.deleteUser(usuario);
  }
});
