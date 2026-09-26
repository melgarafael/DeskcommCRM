/**
 * OS MOTIVOS DE PERDA DO FUNIL, PELA TELA (issue #918).
 *
 * ─── O que só a tela responde ───────────────────────────────────────────────
 *
 * A cobertura de unidade (`tests/unit/kanban-motivos-de-perda-do-funil.test.tsx`)
 * roda em jsdom sobre uma cache escrita à mão: ela prova a REGRA. O que ela não
 * alcança é a cadeia inteira — `crm_pipelines.settings.lost_reasons` no banco →
 * a rota do quadro → a cache do `useBoard` → a janela → o POST → o TRIGGER. O
 * defeito da #918 morava exatamente nessa cadeia: a tela oferecia o padrão do
 * produto e o banco recusava com 22023 depois do clique.
 *
 * Três coisas, por isso, só aqui:
 *  · A lista que a janela desenha vem do funil DESTE card, num banco de verdade.
 *  · O texto livre que o funil não aceita é recusado ANTES do clique — e o aviso
 *    diz ONDE se cadastra um motivo novo, senão "Outro" é beco sem saída.
 *  · Confirmar GRAVA o motivo com o texto do operador e o card fecha como perda:
 *    é a metade que prova que o trigger aceitou o valor que a tela ofereceu.
 *
 * ─── Por que o cadastro é semeado, e não digitado ───────────────────────────
 *
 * A tela de Funis (`/app/settings/tenant/pipelines`) lista TODOS os funis da
 * organização num banco de e2e compartilhado, e ela não faz parte do diff do
 * #918. Escrever `lost_reasons` por lá significaria mirar um cartão entre vários
 * e deixar configuração de organização para trás se a spec quebrasse no meio.
 * A fixture é um funil PRÓPRIO desta spec, semeado e apagado por ela — o mesmo
 * padrão de `lote-no-quadro-do-funil.spec.ts`.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/motivos-de-perda-do-funil.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA =
  process.env.E2E_EVIDENCIA_PERDA ?? path.join(process.cwd(), "evidence/motivos-de-perda-do-funil");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;
const SUFIXO = `${Date.now()}`.slice(-7);
const NOME_DO_FUNIL = `Perda E2E ${SUFIXO}`;
const TITULO = `Perda ${SUFIXO} card`;
/** Os motivos DESTE funil. Nenhum deles é canônico — é isso que os distingue. */
const MOTIVOS = ["Sem orçamento", "Fora do perfil"];

let pipelineId = "";
let etapaAbertaId = "";
let leadId = "";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/** As VALUES dos rádios — o valor é o contrato com o servidor, o rótulo não. */
async function valoresOferecidos(page: Page): Promise<string[]> {
  return page.locator('input[name="lost-reason"]').evaluateAll((els) =>
    els.map((el) => (el as HTMLInputElement).value),
  );
}

async function limparFixtures(): Promise<void> {
  const { data } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("name", "Perda E2E %");
  const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (ids.length === 0) return;
  await admin.from("crm_lead_activities").delete().in("pipeline_id", ids);
  await admin.from("crm_leads").delete().in("pipeline_id", ids);
  await admin.from("crm_stages").delete().in("pipeline_id", ids);
  await admin.from("crm_pipelines").delete().in("id", ids);
}

test.describe("Janela de perder — os motivos são os do funil", () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limparFixtures();

    const { data: funil, error: erroFunil } = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: creds.org_id,
        name: NOME_DO_FUNIL,
        slug: `perda-e2e-${SUFIXO}`,
        // O cadastro que a janela tem de ler. É o MESMO caminho da tela de
        // Funis: aquela tela grava exatamente esta chave.
        settings: { lost_reasons: MOTIVOS },
      })
      .select("id")
      .single();
    if (erroFunil) throw new Error(`funil: ${erroFunil.message}`);
    pipelineId = (funil as { id: string }).id;

    for (const [nome, posicao, perda] of [
      ["Aberto", 1000, false],
      ["Perdido", 2000, true],
    ] as [string, number, boolean][]) {
      const { data, error } = await admin
        .from("crm_stages")
        .insert({
          organization_id: creds.org_id,
          pipeline_id: pipelineId,
          name: nome,
          slug: `${nome.toLowerCase()}-${SUFIXO}`,
          position: posicao,
          is_lost: perda,
        })
        .select("id")
        .single();
      if (error) throw new Error(`etapa ${nome}: ${error.message}`);
      if (nome === "Aberto") etapaAbertaId = (data as { id: string }).id;
    }

    const { data: lead, error: erroLead } = await admin
      .from("crm_leads")
      .insert({
        organization_id: creds.org_id,
        pipeline_id: pipelineId,
        stage_id: etapaAbertaId,
        title: TITULO,
        position_in_stage: 1000,
        source: "manual",
      })
      .select("id")
      .single();
    if (erroLead) throw new Error(`lead: ${erroLead.message}`);
    leadId = (lead as { id: string }).id;
  });

  test.afterAll(async () => {
    await limparFixtures();
  });

  test("a janela oferece os motivos do funil, recusa o que o banco negaria e grava o escolhido", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/pipelines/${pipelineId}`);
    await expect(page.getByText(TITULO, { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Ações do lead" }).first().click();
    await page.getByRole("menuitem", { name: "Marcar como perdido" }).click();
    await expect(page.getByText("Marcar como perdido").last()).toBeVisible();

    // ── 1. A LISTA É A DO FUNIL ────────────────────────────────────────────
    expect(
      await valoresOferecidos(page),
      "a janela tem de oferecer os motivos DESTE funil, mais o escape 'Outro'",
    ).toEqual([...MOTIVOS, "other"]);
    // O padrão do produto não pode sobrar: motivo que o funil não tem é 22023.
    await expect(page.getByText("Falha no pagamento")).toHaveCount(0);
    await captura(page, "01-motivos-do-funil");

    // ── 2. "OUTRO" RECUSA ANTES DO CLIQUE, E DIZ ONDE CADASTRAR ────────────
    await page.locator('input[name="lost-reason"][value="other"]').check();
    await expect(
      page.getByText(/cadastre em Configurações/),
      "sem esta frase, 'Outro' é beco sem saída: recusa todo texto novo e não diz onde se cadastra um",
    ).toBeVisible();

    const confirmar = page.getByRole("button", { name: "Confirmar" });
    // ⚠️ DETALHE VAZIO PASSA, e é de propósito: `other` é canônico, então o
    // trigger o aceita em qualquer funil. Exigir o detalhe aqui deixava sem saída
    // o `agent` que tem uma perda fora da lista e não pode cadastrar motivo.
    await expect(confirmar, "'Outro' sem detalhe é o escape que o servidor aceita").toBeEnabled();

    await page.getByLabel(/Detalhe \(opcional\)/).fill("Cliente mudou de ideia");
    await expect(page.getByRole("alert")).toHaveText(
      "Esse motivo de perda não está na lista deste funil — escolha um dos motivos configurados.",
    );
    await expect(confirmar, "texto fora da lista é o que o trigger recusa").toBeDisabled();
    await captura(page, "02-outro-recusado");

    // ── 3. O MOTIVO ESCOLHIDO CHEGA AO BANCO ───────────────────────────────
    await page.locator(`input[name="lost-reason"][value="${MOTIVOS[1]}"]`).check();
    const resposta = page.waitForResponse(
      (r) => r.url().includes(`/leads/${leadId}/lose`) && r.request().method() === "POST",
    );
    await confirmar.click();
    const r = await resposta;
    expect(r.status(), "o trigger aceita o valor que a tela ofereceu").toBe(200);

    // A PROVA É NO BANCO. Toast não é persistência, e o 22023 que esta issue
    // fecha acontecia DEPOIS do 200 da tela em versões antigas.
    const { data } = await admin
      .from("crm_leads")
      .select("lost_reason, status")
      .eq("id", leadId)
      .single();
    expect(data).toMatchObject({ lost_reason: MOTIVOS[1], status: "lost" });
    await captura(page, "03-perdido-com-o-motivo-do-funil");
  });
});
