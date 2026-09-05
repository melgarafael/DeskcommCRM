/**
 * IMPORTAR LEADS DE UMA PLANILHA — provado PELA TELA, com o form real.
 *
 * Bug medido em QA visual (sessão de tradução ao espanhol, 2026-09-05): a
 * importação morria SEMPRE com "Elige el embudo y la etapa de destino." —
 * mesmo com um funil válido escolhido. Causa: `ImportarLeads.tsx` só tem
 * seletor de FUNIL (o comentário no próprio componente diz que planilha traz
 * gente NOVA, e gente nova entra na primeira etapa — não deveria haver escolha
 * de etapa), mas `app/api/v1/leads/import/route.ts` exigia `stage_id` sem
 * nenhum fallback. A suíte unitária (`tests/unit/leads-import-route.test.ts`)
 * não pegava isto porque seu helper de request mandava `stage_id` por padrão —
 * verde medindo um caminho que o usuário real nunca percorre.
 *
 * Este spec dirige o FRONTEND de verdade: abre o diálogo, escolhe só o funil
 * (nenhum seletor de etapa existe na tela, e não deveria), sobe um CSV em
 * memória, e confirma pela TELA e pelo BANCO que o negócio nasceu na primeira
 * etapa do funil.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/importar-leads-planilha.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA =
  process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), ".superpowers/evidence/importar-leads");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
  kanban?: { pipeline_id: string; stage_id: string };
}

function loadCreds(): Creds {
  const needsBase = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.agent;
  };
  if (needsBase()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.kanban?.pipeline_id || !c.kanban?.stage_id) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-kanban.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = loadCreds();
const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Sufixo único por execução — o banco de e2e é compartilhado entre frentes.
const SUFIXO = `${Date.now()}`.slice(-7);
const NOME_DO_NEGOCIO = `Importado E2E ${SUFIXO}`;

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test("importa uma planilha sem escolher etapa (não há esse seletor) e o negócio nasce na primeira etapa do funil", async ({
  page,
}) => {
  await login(page, creds.users.agent!.email);
  await page.goto("/app/kanban");

  await page.getByTestId("abrir-importar-leads").click();

  const dialogo = page.getByRole("dialog", { name: "Importar leads de uma planilha" });
  await expect(dialogo).toBeVisible();

  // ⚠️ NÃO há campo de etapa nesta tela — só o de funil. O form real do
  // produto nunca manda `stage_id`; é exatamente o que este spec reproduz.
  await expect(dialogo.getByLabel("Funil de destino")).toBeVisible();
  await expect(dialogo.getByText(/há escolha de etapa|escolha de etapa/i)).toHaveCount(0);

  const csv = `nome\n${NOME_DO_NEGOCIO}\n`;
  await dialogo.getByTestId("arquivo-de-leads").setInputFiles({
    name: "leads.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });

  // A confirmação NA TELA: nem toast (some em 4s) nem exceção não tratada.
  await expect(dialogo.getByRole("alert")).toHaveCount(0);
  const resumo = dialogo.getByTestId("resumo-da-importacao");
  await expect(resumo).toBeVisible({ timeout: 15_000 });
  await expect(resumo).toContainText("1");
  await expect(resumo).toContainText("leads criados");
  await captura(page, "resumo-da-importacao");

  // A confirmação no BANCO, relida — não o que o toast prometeu.
  const { data: negocio, error } = await admin
    .from("crm_leads")
    .select("id, pipeline_id, stage_id")
    .eq("organization_id", creds.org_id)
    .eq("title", NOME_DO_NEGOCIO)
    .single();
  expect(error).toBeNull();
  expect(negocio?.pipeline_id).toBe(creds.kanban!.pipeline_id);
  expect(negocio?.stage_id).toBe(creds.kanban!.stage_id);

  // E o card aparece no board, na coluna certa — reload, não confiar no DOM
  // que a própria ação acabou de escrever.
  await page.goto(`/app/pipelines/${creds.kanban!.pipeline_id}`);
  await expect(page.getByText(NOME_DO_NEGOCIO)).toBeVisible({ timeout: 15_000 });
});
