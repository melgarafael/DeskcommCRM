/**
 * A ETAPA QUE AVISA A EQUIPE NA CENTRAL, provada pela tela (migration 0440).
 *
 * Na ordem em que o dono de uma loja que vende pelo WhatsApp faria: em
 * Configurações › Funis › Etapas ele liga «Avisar a equipe na Central quando um
 * negócio entrar aqui» na etapa do pedido confirmado; um negócio entra nela; e
 * a Central mostra o aviso com o botão «Abrir negócio», que leva ao negócio.
 * Sem o nome nem o telefone do cliente no texto. E a etapa vizinha, sem a
 * marca, não avisa nada.
 *
 * ⚠️ O QUE É REAL AQUI. O produtor (`lib/leads/aviso-de-etapa.handler.ts`) é
 * event-driven: a rota de movimento emite `lead.stage_changed` no `event_log` e
 * o dreno consome. Em produção esse dreno é um cron de um minuto; a spec chama
 * a MESMA rota (`/api/v1/cron/event-log-drain`) com o segredo interno, em vez
 * de esperar o relógio (o mesmo desenho de `gatilho-de-etapa.spec.ts`).
 *
 * ⚠️ O QUE É SETUP, e por que não é pela tela: organização, usuário, funil,
 * contato e negócio são o cenário, criados pela service role no Supabase local.
 * O movimento do card usa a rota do quadro com a sessão do próprio usuário —
 * arrastar o card já tem spec própria. O que esta spec dirige pela tela é o
 * que a mudança entregou: a chave da etapa e o aviso que ela produz.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { test, expect, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const SEGREDO_DO_DRENO = process.env.INTERNAL_SECRET ?? "e2e-placeholder-nao-e-segredo";

// `evidence/` é VERSIONADO: evidência citada que não entra no repo é evidência
// que ninguém consegue conferir depois.
const EVIDENCIA = path.join(process.cwd(), "evidence", "etapa-avisa-na-central");
fs.mkdirSync(EVIDENCIA, { recursive: true });

const ESPERA = 60_000;
const SENHA = `Local-${randomUUID()}!`;
const SUFIXO = randomUUID().slice(0, 8);
const CLIENTE = `Maria Souza ${SUFIXO}`;

let userId = "";
let email = "";
let orgId = "";
let funilId = "";
let etapaNovo = "";
let etapaConfirmado = "";
let etapaEnviado = "";
let negocioId = "";

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function entrar(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(SENHA);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: ESPERA });
}

async function drenar(page: Page): Promise<void> {
  const r = await page.request.post("/api/v1/cron/event-log-drain", {
    headers: { authorization: `Bearer ${SEGREDO_DO_DRENO}` },
  });
  expect(r.status(), "o dreno tem que responder 200").toBe(200);
  // O 200 diz que o dreno RODOU, não que os handlers deram certo.
  const resumo = ((await r.json()) as { data: { failed: number; dead: number } }).data;
  expect(resumo.failed + resumo.dead, "nenhum handler pode ter falhado no dreno").toBe(0);
}

async function mover(page: Page, etapa: string): Promise<void> {
  const { data, error } = await db.from("crm_leads").select("updated_at").eq("id", negocioId).single();
  if (error) throw error;
  const r = await page.request.post(`/api/v1/leads/${negocioId}/move`, {
    data: { stage_id: etapa, position_in_stage: 1, expected_updated_at: (data as { updated_at: string }).updated_at },
  });
  expect(r.status(), await r.text()).toBe(200);
}

test.beforeAll(async () => {
  email = `etapa-avisa-${SUFIXO}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: SENHA, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("usuário não nasceu");
  userId = data.user.id;

  orgId = await inserir("organizations", {
    slug: `etapa-avisa-${SUFIXO}`,
    legal_name: `Loja ${SUFIXO}`,
    display_name: `Loja ${SUFIXO}`,
    onboarded_at: new Date().toISOString(),
  });
  const { error: erroDoVinculo } = await db.from("user_organizations").insert({
    organization_id: orgId,
    user_id: userId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (erroDoVinculo) throw erroDoVinculo;

  funilId = await inserir("crm_pipelines", { organization_id: orgId, name: `Pedidos ${SUFIXO}`, slug: `pedidos-${SUFIXO}` });
  etapaNovo = await inserir("crm_stages", { organization_id: orgId, pipeline_id: funilId, name: "Novo", slug: "novo", position: 1 });
  etapaConfirmado = await inserir("crm_stages", {
    organization_id: orgId, pipeline_id: funilId, name: "Pedido confirmado", slug: "pedido-confirmado", position: 2,
  });
  etapaEnviado = await inserir("crm_stages", { organization_id: orgId, pipeline_id: funilId, name: "Enviado", slug: "enviado", position: 3 });
  const contato = await inserir("contacts", {
    organization_id: orgId, display_name: CLIENTE, phone_number: `+55119${String(Date.now()).slice(-8)}`,
  });
  negocioId = await inserir("crm_leads", {
    organization_id: orgId, pipeline_id: funilId, stage_id: etapaNovo, contact_id: contato, title: CLIENTE,
  });
});

test.afterAll(async () => {
  if (orgId) await db.from("organizations").delete().eq("id", orgId);
  if (userId) await db.auth.admin.deleteUser(userId);
});

/**
 * A tela de Etapas nasce com cada funil RECOLHIDO quando a empresa tem mais de
 * um (#4083) — e esta organização tem o funil semeado no onboarding MAIS o
 * «Pedidos» criado aqui. O cabeçalho é o que abre; com um funil só ele já vem
 * aberto, e um clique cego FECHARIA, daí a checagem do `aria-expanded`.
 */
async function abrirOFunil(page: Page, pipelineId: string): Promise<void> {
  const cabecalho = page.getByTestId(`abrir-funil-${pipelineId}`);
  if ((await cabecalho.getAttribute("aria-expanded")) === "false") {
    await cabecalho.click();
    await expect(cabecalho).toHaveAttribute("aria-expanded", "true");
  }
}

test("a etapa marcada avisa a equipe na Central; a vizinha, sem a marca, não", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await entrar(page);

  // ---- 1. a chave, pela tela ----
  await page.goto("/app/settings/tenant/pipelines");
  await abrirOFunil(page, funilId);
  const chave = page.getByTestId(`avisar-${etapaConfirmado}`);
  await expect(chave).toBeVisible({ timeout: ESPERA });
  await expect(chave, "vem desligada").toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId(`avisar-${etapaEnviado}`)).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId(`etapa-${etapaConfirmado}`)).toContainText(
    "Avisar a equipe na Central quando um negócio entrar aqui",
  );
  await chave.click();
  await expect(chave).toHaveAttribute("aria-checked", "true", { timeout: ESPERA });
  await page.screenshot({ path: path.join(EVIDENCIA, "01-chave-ligada-na-etapa.png"), fullPage: true });

  // A chave ficou gravada: recarregar a tela mostra a mesma coisa.
  await page.reload();
  await expect(page.getByTestId(`avisar-${etapaConfirmado}`)).toHaveAttribute("aria-checked", "true", { timeout: ESPERA });
  await expect(page.getByTestId(`avisar-${etapaEnviado}`)).toHaveAttribute("aria-checked", "false");

  // ---- 2. o negócio entra na etapa marcada ----
  await mover(page, etapaConfirmado);
  await drenar(page);

  // ---- 3. a Central mostra o aviso, sem dado do cliente, e o botão leva ao negócio ----
  await page.goto("/app/ai/inbox");
  const aviso = page.getByTestId("inbox-item").filter({ hasText: "Negócio entrou em «Pedido confirmado»" });
  await expect(aviso).toHaveCount(1, { timeout: ESPERA });
  await expect(aviso).toContainText("Abra o negócio para dar o próximo passo.");
  await expect(aviso).not.toContainText(CLIENTE);
  await page.screenshot({ path: path.join(EVIDENCIA, "02-aviso-na-central.png"), fullPage: true });

  // ---- 4. a etapa sem a marca não avisa ----
  await mover(page, etapaEnviado);
  await drenar(page);
  await page.reload();
  await expect(page.getByTestId("inbox-item").filter({ hasText: "Negócio entrou em" })).toHaveCount(1);
  await expect(page.getByTestId("inbox-item").filter({ hasText: "«Enviado»" })).toHaveCount(0);

  await aviso.getByRole("link", { name: "Abrir negócio" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/pipelines/${funilId}\\?lead=${negocioId}`), { timeout: ESPERA });
  await expect(page.getByRole("dialog").getByText(CLIENTE, { exact: true }).first()).toBeVisible({ timeout: ESPERA });
  await page.screenshot({ path: path.join(EVIDENCIA, "03-abrir-negocio.png"), fullPage: true });
});
