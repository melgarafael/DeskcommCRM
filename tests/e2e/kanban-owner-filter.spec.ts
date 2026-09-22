/**
 * G3-03 — filtro por responsável no board (deep-linkável via query param).
 *
 * Verifica: os dois leads seed aparecem (um com responsável, um "Sem
 * responsável"); ao filtrar por "Sem responsável" a URL ganha ?owner=unassigned
 * e o card com dono some. Login como manager (sem MFA; vê todos os leads da org).
 *
 * Pré-requisito: seed de credenciais + seed de kanban (rodados aqui se faltarem).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
  kanban?: { pipeline_id: string };
}

function loadCreds(): Creds {
  const needsBase = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (needsBase()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.kanban?.pipeline_id) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-kanban.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = loadCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

test("filtro por responsável reflete na URL e esconde leads com dono", async ({ page }) => {
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/pipelines/${creds.kanban!.pipeline_id}`);

  const owned = page.getByRole("heading", { name: "Pedido E2E com responsavel" });
  const unowned = page.getByRole("heading", { name: "Pedido E2E sem responsavel" });
  await expect(owned).toBeVisible();
  await expect(unowned).toBeVisible();
  // A badge de ausência de dono está presente em ao menos um card.
  await expect(page.getByText("Sem responsável").first()).toBeVisible();

  // Abre o filtro de responsável e escolhe "Sem responsável".
  await page.getByRole("button", { name: /^Responsável:/ }).click();
  await page.getByRole("menuitem", { name: "Sem responsável" }).click();

  await expect(page).toHaveURL(/owner=unassigned/);
  await expect(unowned).toBeVisible();
  await expect(owned).toHaveCount(0);
});

/**
 * #916 / PR #919 — arrastar o MESMO card duas vezes seguidas, pela tela.
 *
 * O primeiro arrasto funcionava e o segundo, logo em seguida, mostrava "Lead foi
 * modificado por outro usuário" sem ninguém mais usando. O próprio movimento grava
 * a atividade `stage_changed`, e o gatilho dela escreve no lead DEPOIS de a tela ter
 * guardado a versão anterior: o segundo arrasto mandava um `expected_updated_at`
 * que a primeira requisição já tinha vencido.
 *
 * ⚠️ O GET do quadro é SEGURADO depois da primeira carga, de propósito. A janela do
 * defeito é o intervalo entre a resposta do movimento e o refetch do quadro chegar;
 * numa rede rápida o refetch fecha essa janela antes de a mão arrastar de novo, e
 * este teste ficaria verde com o conserto apagado. Segurar o refetch é a rede lenta
 * de quem usa o produto numa VPS do outro lado do país — e é o que faz o caso medir
 * o conserto (o card guardar o lead que o servidor devolveu), e não a sorte.
 *
 * Funil PRÓPRIO, com três etapas abertas: o funil padrão é de outros specs, e um
 * card seu movido mudaria o que eles veem.
 */
test.describe("arrastar o mesmo card duas vezes seguidas (#916)", () => {
  test.describe.configure({ timeout: 240_000 });

  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const SUFIXO = `${Date.now()}`.slice(-7);
  const TITULO = `Arrasto ${SUFIXO} duas vezes`;
  const EVIDENCIA = path.join(process.cwd(), "evidence", "arrastar-duas-vezes");
  let funilId = "";
  let leadId = "";
  const etapas: string[] = [];

  async function limpar(): Promise<void> {
    const { data } = await admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", creds.org_id)
      .like("name", "Arrasto E2E %");
    const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
    if (ids.length === 0) return;
    await admin.from("crm_lead_activities").delete().in("pipeline_id", ids);
    await admin.from("crm_leads").delete().in("pipeline_id", ids);
    await admin.from("crm_stages").delete().in("pipeline_id", ids);
    await admin.from("crm_pipelines").delete().in("id", ids);
  }

  test.beforeAll(async () => {
    await limpar();
    const { data: funil, error } = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: creds.org_id,
        name: `Arrasto E2E ${SUFIXO}`,
        slug: `arrasto-e2e-${SUFIXO}`,
      })
      .select("id")
      .single();
    if (error) throw new Error(`funil: ${error.message}`);
    funilId = (funil as { id: string }).id;
    for (const [nome, posicao] of [
      ["Entrada", 1000],
      ["Conversa", 2000],
      ["Proposta", 3000],
    ] as [string, number][]) {
      const { data, error: erroEtapa } = await admin
        .from("crm_stages")
        .insert({
          organization_id: creds.org_id,
          pipeline_id: funilId,
          name: nome,
          slug: `${nome.toLowerCase()}-${SUFIXO}`,
          position: posicao,
        })
        .select("id")
        .single();
      if (erroEtapa) throw new Error(`etapa ${nome}: ${erroEtapa.message}`);
      etapas.push((data as { id: string }).id);
    }
    const { data: lead, error: erroLead } = await admin
      .from("crm_leads")
      .insert({
        organization_id: creds.org_id,
        pipeline_id: funilId,
        stage_id: etapas[0],
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
    await limpar();
  });

  function listaDaEtapa(page: Page, etapaId: string): Locator {
    return page.locator(`[data-rfd-droppable-id="${etapaId}"]`);
  }

  /** O arrasto acessível do @hello-pangea/dnd — o mesmo `onDragEnd` do mouse. */
  async function arrastarParaADireita(page: Page, card: Locator): Promise<number> {
    const resposta = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/leads/${leadId}/move`) && r.request().method() === "POST",
      { timeout: 60_000 },
    );
    await card.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(400);
    await page.keyboard.press("Space");
    return (await resposta).status();
  }

  test("o segundo arrasto, logo depois do primeiro, não cai em 'modificado por outro usuário'", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email);
    await page.goto(`/app/pipelines/${funilId}`);
    const card = page.getByRole("group", { name: `Lead: ${TITULO}` });
    await expect(card).toBeVisible({ timeout: 60_000 });

    // Primeira carga feita: daqui em diante o refetch do quadro demora a voltar.
    await page.route(`**/api/v1/pipelines/${funilId}/board**`, async (rota) => {
      await new Promise((resolver) => setTimeout(resolver, 15_000));
      await rota.continue().catch(() => undefined);
    });

    expect(await arrastarParaADireita(page, card), "primeiro arrasto").toBe(200);
    await expect(listaDaEtapa(page, etapas[1]!).getByRole("group", { name: `Lead: ${TITULO}` })).toBeVisible();
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "01-depois-do-primeiro.png"), fullPage: true });

    // O gesto seguinte, sem recarregar e sem esperar o quadro se atualizar sozinho.
    expect(await arrastarParaADireita(page, card), "segundo arrasto").toBe(200);
    await expect(listaDaEtapa(page, etapas[2]!).getByRole("group", { name: `Lead: ${TITULO}` })).toBeVisible();
    await expect(page.getByText(/modificado por outro/i)).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "02-depois-do-segundo.png"), fullPage: true });

    const { data } = await admin.from("crm_leads").select("stage_id").eq("id", leadId).single();
    expect((data as { stage_id: string }).stage_id, "o banco guardou a terceira etapa").toBe(etapas[2]);
  });
});
