/**
 * O MOLDE DE IA DAS EMPRESAS NOVAS — a jornada inteira, pela tela (migration 9096).
 *
 * ═══ O QUE ESTA SPEC PROVA ═══
 *
 * O dono do servidor, como um leigo faria:
 *
 *  1. abre Recursos opcionais e vê que, sem molde, cada empresa nasce com o
 *     padrão do produto;
 *  2. escolhe uma empresa como molde e a tela diz o que vai ser copiado —
 *     quantas funções, quais modelos e o que fica de fora (o endereço próprio);
 *  3. cria uma empresa em Painel › Empresas › Nova, e o formulário avisa que
 *     ela vai nascer com a IA do molde;
 *  4. a página da empresa nova diz "IA copiada do molde", lida da auditoria;
 *  5. entra na empresa nova e, em Agente de IA › Provedores, vê os modelos do
 *     molde nas funções copiadas e o padrão do molde nas que herdam — e a
 *     função com endereço próprio NÃO veio.
 *
 * ═══ O QUE ESTA SPEC NÃO PROVA ═══
 *
 *  - Os outros caminhos de criação (cadastro, RPC direta, bootstrap) e as
 *    exclusões (assinatura, Jev, Google…): são do gatilho, e quem os mede
 *    contra o Postgres é `tests/invariants/molde-de-ia-empresas-novas.test.ts`.
 *  - Que a chamada de IA da empresa nova sai com a chave da instalação: o
 *    painel mostra o modelo e a origem, não faz chamada paga.
 *
 * Semeia o próprio dono (platform admin sem MFA), o molde e as funções pelo
 * service role, e apaga tudo no fim — inclusive o molde da instalação, que é
 * singleton: deixá-lo escolhido faria toda empresa criada pelas specs seguintes
 * da mesma parte nascer com a IA deste molde.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const { url, serviceRole } = credenciaisSupabaseDeTeste();
const db = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });

const EVIDENCIA = path.join(process.cwd(), "evidence", "molde-ia-empresas-nuevas");
const SUFIXO = Date.now().toString(36);
const SENHA = `Senha-e2e-${SUFIXO}!`;
const EMAIL = `dono-molde-${SUFIXO}@exemplo.test`;
const NOME_DO_MOLDE = `Molde E2E ${SUFIXO}`;
const NOME_DA_NOVA = `Nova do Molde ${SUFIXO}`;

let donoId = "";
let moldeId = "";
let novaId = "";

async function foto(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const { data: u, error: ue } = await db.auth.admin.createUser({
    email: EMAIL,
    password: SENHA,
    email_confirm: true,
    user_metadata: { full_name: "Dono do molde" },
  });
  if (ue || !u.user) throw new Error(`createUser: ${ue?.message}`);
  donoId = u.user.id;

  const { data: org, error: oe } = await db
    .from("organizations")
    .insert({
      slug: `e2e-molde-${SUFIXO}`,
      legal_name: `${NOME_DO_MOLDE} LTDA`,
      display_name: NOME_DO_MOLDE,
      onboarded_at: new Date().toISOString(),
      settings: { llm: { provider: "openai", default_model: "gpt-5-mini" } },
    })
    .select("id")
    .single();
  if (oe || !org) throw new Error(`organizations: ${oe?.message}`);
  moldeId = org.id as string;

  const vinculo = await db
    .from("user_organizations")
    .insert({ user_id: donoId, organization_id: moldeId, role: "admin", accepted_at: new Date().toISOString() });
  if (vinculo.error) throw new Error(`user_organizations: ${vinculo.error.message}`);

  // Dono do servidor sem fator: a política de MFA deste produto é opcional, e o
  // caminho que a spec mede é o do molde, não o do segundo fator.
  const pa = await db
    .from("platform_admins")
    .insert({ user_id: donoId, granted_by: donoId, scope: "full", mfa_required: false, reason: "fixture e2e do molde de IA" });
  if (pa.error) throw new Error(`platform_admins: ${pa.error.message}`);

  // A configuração de IA do molde: duas funções copiáveis e uma com endereço
  // próprio, que tem de ficar de fora.
  const funcoes = await db.from("ai_purpose_bindings").insert([
    { organization_id: moldeId, purpose: "stage_classifier", provider: "anthropic", model_id: "claude-haiku-4-5" },
    { organization_id: moldeId, purpose: "compaction", provider: "openai", model_id: "gpt-5-mini" },
    {
      organization_id: moldeId,
      purpose: "checkpoint",
      provider: "openai",
      model_id: "gpt-do-gateway",
      base_url: "https://gw.exemplo.test/v1",
    },
  ]);
  if (funcoes.error) throw new Error(`ai_purpose_bindings: ${funcoes.error.message}`);

  // Ponto de partida conhecido: a instalação sem molde.
  await db.from("platform_settings").upsert({ id: 1, molde_de_ia_org_id: null }, { onConflict: "id" });
});

test.afterAll(async () => {
  // O molde é da INSTALAÇÃO: sem esta linha, as próximas specs da parte criariam
  // empresas com a IA deste molde.
  await db.from("platform_settings").update({ molde_de_ia_org_id: null }).eq("id", 1);
  for (const id of [novaId, moldeId]) if (id) await db.from("organizations").delete().eq("id", id);
  if (donoId) {
    await db.from("platform_admins").delete().eq("user_id", donoId);
    await db.auth.admin.deleteUser(donoId).catch(() => undefined);
  }
});

test("escolher o molde, criar a empresa e ver a IA copiada — pela tela", async ({ page }) => {
  test.setTimeout(240_000);

  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(SENHA);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });

  // ── 1. Sem molde: a tela diz que nada é copiado ─────────────────────────
  await page.goto("/admin/sistema");
  const cartao = page.getByTestId("molde-de-ia");
  await expect(cartao.getByText("IA das empresas novas", { exact: true })).toBeVisible();
  await expect(page.getByTestId("resumo-do-molde")).toContainText(
    "Cada empresa nova começa com o modelo padrão do produto",
  );
  await cartao.scrollIntoViewIfNeeded();
  await foto(page, "01-sem-molde");

  // ── 2. Escolher o molde: a tela diz o que vai ser copiado ───────────────
  await page.getByRole("combobox", { name: "IA das empresas novas" }).click();
  await page.getByRole("option", { name: NOME_DO_MOLDE, exact: true }).click();
  const resumo = page.getByTestId("resumo-do-molde");
  await expect(resumo).toContainText("A próxima empresa vai nascer com 2 funções de IA configuradas:");
  await expect(page.getByTestId("modelos-do-molde")).toContainText("claude-haiku-4-5");
  await expect(page.getByTestId("modelos-do-molde")).toContainText("gpt-5-mini");
  await expect(page.getByTestId("modelos-do-molde")).not.toContainText("gpt-do-gateway");
  await expect(page.getByTestId("padrao-do-molde")).toContainText("gpt-5-mini");
  await expect(page.getByTestId("deixadas-do-molde")).toContainText("1 função desta empresa fica de fora");
  await foto(page, "02-molde-escolhido");

  // A escolha ficou gravada — é dela que o gatilho lê.
  await expect
    .poll(async () => (await db.from("platform_settings").select("molde_de_ia_org_id").eq("id", 1).single()).data)
    .toEqual({ molde_de_ia_org_id: moldeId });

  // Recarregar mostra a escolha salva, não o estado do componente.
  await page.reload();
  await expect(page.getByRole("combobox", { name: "IA das empresas novas" })).toContainText(NOME_DO_MOLDE);

  // ── 3. Criar a empresa: o formulário avisa de onde vem a IA ─────────────
  await page.goto("/admin/tenants/new");
  await expect(page.getByTestId("aviso-molde-de-ia")).toContainText(NOME_DO_MOLDE);
  await page.getByLabel("Nome de exibição").fill(NOME_DA_NOVA);
  await page.getByLabel("E-mail do responsável").fill(EMAIL);
  const resposta = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/admin/tenants") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Criar organização", exact: true }).click();
  const criada = await resposta;
  expect(criada.status()).toBe(201);
  novaId = ((await criada.json()) as { data: { id: string } }).data.id;
  await expect(page.getByText("Organização criada", { exact: true })).toBeVisible();
  await foto(page, "03-empresa-criada");

  // ── 4. A página da empresa nova diz que a IA veio do molde ──────────────
  await page.getByRole("link", { name: "Ver organização" }).click();
  await page.waitForURL(`**/admin/tenants/${novaId}`, { timeout: 30_000 });
  const ia = page.getByTestId("ia-do-molde");
  await expect(ia).toContainText(`Esta empresa nasceu com a IA de ${NOME_DO_MOLDE}.`);
  await expect(ia).toContainText("2 funções de IA copiadas");
  await expect(ia).toContainText("gpt-5-mini");
  await foto(page, "04-pagina-da-empresa");

  // ── 5. Dentro da empresa nova, em Agente de IA › Provedores ─────────────
  // O assistente de primeira configuração é de outra spec; aqui a empresa já
  // está configurada para o painel abrir direto.
  const pronto = await db.from("organizations").update({ onboarded_at: new Date().toISOString() }).eq("id", novaId);
  if (pronto.error) throw new Error(`onboarded_at: ${pronto.error.message}`);
  await page.goto("/app");
  await page.getByTestId("tenant-switcher").click();
  await page.getByTestId(`tenant-switcher-item-${novaId}`).click();
  // A troca é uma server action: `/app` já redireciona para o inbox, então
  // esperar a URL não separa "a troca aconteceu" de "a troca foi atirada" — e
  // o painel abria ainda no molde. Espera-se o seletor terminar e mostrar a
  // empresa nova, como em `aba-e-cookie-divergentes.spec.ts`.
  const seletor = page.getByTestId("tenant-switcher");
  await expect(seletor, "a troca para a empresa nova não terminou").toBeEnabled({ timeout: 60_000 });
  await expect(seletor, "a troca para a empresa nova não pegou").toContainText(NOME_DA_NOVA, { timeout: 20_000 });

  await page.goto("/app/ai/providers");
  await page.waitForSelector('[data-testid="painel-de-provedores"]', { timeout: 30_000 });

  await page.getByTestId("avancado-entender").click();
  await expect(page.getByTestId("ponto-stage_classifier")).toContainText("claude-haiku-4-5");

  await page.getByTestId("avancado-lembrar").click();
  await expect(page.getByTestId("ponto-compaction")).toContainText("gpt-5-mini");
  // A função com endereço próprio NÃO veio: o ponto herda o padrão — que é o do molde.
  await expect(page.getByTestId("ponto-checkpoint")).not.toContainText("gpt-do-gateway");
  await expect(page.getByTestId("ponto-checkpoint")).toContainText("gpt-5-mini");
  await page.getByTestId("ponto-compaction").scrollIntoViewIfNeeded();
  await foto(page, "05-provedores-da-empresa-nova");

  // O banco confirma o que a tela mostrou: duas funções, nenhuma com a chave do molde.
  const { data: copiadas } = await db
    .from("ai_purpose_bindings")
    .select("purpose, provider, model_id, credential_id, base_url")
    .eq("organization_id", novaId)
    .order("purpose");
  expect(copiadas).toEqual([
    { purpose: "compaction", provider: "openai", model_id: "gpt-5-mini", credential_id: null, base_url: null },
    {
      purpose: "stage_classifier",
      provider: "anthropic",
      model_id: "claude-haiku-4-5",
      credential_id: null,
      base_url: null,
    },
  ]);
});
