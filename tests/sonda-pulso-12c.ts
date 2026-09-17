/**
 * `12.c` — a aba que AGE não pode pulsar (verificação do fix do eco local).
 *
 * Três pernas, porque duas deixavam passar verde vácuo:
 *
 *  1. o card MUDOU de coluna — contar zero pulsos num arrasto que não aconteceu
 *     não prova nada (o `@QAVivo` já tinha derivado esta);
 *  2. a própria aba NÃO teve início de animação de pulso;
 *  3. a ação produziu DUAS escritas na linha — sem isto o defeito nem é
 *     exercitado, e o verde seria sobre um caso que não ocorreu. A segunda
 *     escrita é o carimbo de `last_activity_at` da atividade `stage_changed`
 *     (Wave 3), que chega ~112ms depois e era exatamente quem fazia a aba
 *     piscar. Detectada comparando o `updated_at` que ficou no lead com o
 *     `created_at` da atividade: a segunda escrita é a única posterior a ela.
 *
 * O alvo é escolhido DENTRO do pipeline do CRM Vivo e fora do último estágio:
 * `position` empata entre pipelines, então "o primeiro estágio" global é
 * sorteio — e um estágio vazio derruba a sonda por motivo que não é o dela.
 *
 * Run: E2E_PORT=3020 npx tsx tests/sonda-pulso-12c.ts
 */
import * as fs from "node:fs";

import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { BASE, CARD_ATTR, carimbar, login } from "./qa-helpers";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main(): Promise<void> {
  // O veredito só vale para um commit: se o que esta sonda mede estiver com
  // diff pendente, ela grita antes de medir.
  carimbar([
    "lib/kanban/local-echo.ts",
    "hooks/kanban/useBoard.ts",
    "hooks/kanban/useMoveCard.ts",
    "app/api/v1/leads/[id]/move/route.ts",
  ]);

  const creds = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")) as {
    crm_vivo: { pipeline_id: string };
  };
  const pipelineId = creds.crm_vivo.pipeline_id;

  const { data: stages } = await admin
    .from("crm_stages")
    .select("id, name, position")
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true });
  if (!stages || stages.length < 2) throw new Error("pipeline sem estágios suficientes");

  // O estágio MAIS À ESQUERDA que tenha lead, não um sorteado entre os que têm
  // destino: coluna à direita pode nascer fora da viewport, e aí o arrasto por
  // teclado simplesmente não acontece — a sonda estoura no `waitForResponse` e
  // o erro não diz nada sobre o pulso. Sem `order`, o `.limit(1)` era loteria.
  const { data: candidatos } = await admin
    .from("crm_leads")
    .select("id, title, stage_id, updated_at")
    .eq("pipeline_id", pipelineId)
    .in("stage_id", stages.slice(0, -1).map((s) => s.id));
  const posicaoDoEstagio = new Map(stages.map((s) => [s.id, s.position]));
  const lead = (candidatos ?? []).sort(
    (a, b) =>
      (posicaoDoEstagio.get(a.stage_id) ?? 0) - (posicaoDoEstagio.get(b.stage_id) ?? 0),
  )[0];
  if (!lead) throw new Error("nenhum lead com estágio à direita");
  console.info(`alvo: "${lead.title}"`);

  const browser = await chromium.launch();
  const page = await browser
    .newContext({ viewport: { width: 1900, height: 900 } })
    .then((c) => c.newPage());
  // `manager`, não `admin`: o admin tem MFA forçado e a sonda pararia no
  // campo de código — travar por autenticação não diz nada sobre o pulso.
  await login(page, "manager");
  await page.goto(`${BASE}/app/pipelines/${pipelineId}`, { waitUntil: "networkidle" });

  const card = page.locator(`[${CARD_ATTR}="${lead.id}"]`).first();
  await card.waitFor({ state: "visible", timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();

  // Evento NATIVO, não amostragem: uma animação de 320ms medida com régua mais
  // lenta inventa o resultado.
  await page.evaluate(() => {
    (window as unknown as { __pulsos: number }).__pulsos = 0;
    document.addEventListener(
      "animationstart",
      (e) => {
        if ((e.target as HTMLElement)?.hasAttribute?.("data-pulse")) {
          (window as unknown as { __pulsos: number }).__pulsos += 1;
        }
      },
      true,
    );
  });
  await page.waitForTimeout(1_500);

  // Ação da INTERFACE, pelo teclado — mesmo `onDragEnd` do mouse.
  await card.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(600);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(600);
  await page.keyboard.press("Space");

  const resposta = await page.waitForResponse(
    (r) => r.url().includes("/move") && r.request().method() === "POST",
    { timeout: 20_000 },
  );
  const corpo = (await resposta.json()) as { data?: { updated_at?: string } };
  const updatedAtDaRota = corpo.data?.updated_at ?? null;

  await page.waitForTimeout(4_000);

  const { data: depois } = await admin
    .from("crm_leads")
    .select("stage_id, updated_at")
    .eq("id", lead.id)
    .maybeSingle();

  // A SEGUNDA escrita é o carimbo de `last_activity_at` que o INSERT da
  // atividade `stage_changed` dispara (`trg_update_last_activity_at` → UPDATE no
  // lead → `trg_crm_leads_updated_at`). Ela acontece DEPOIS da atividade; a
  // primeira (o UPDATE do próprio move) acontece ANTES. Então quem separa uma
  // escrita de duas é o `updated_at` do lead contra o `created_at` da atividade.
  //
  // ⚠️ Esta sonda comparava o `updated_at` que a ROTA devolveu com o que ficou no
  // banco. Isso deixou de medir qualquer coisa quando o #919 passou a reler o
  // lead DEPOIS de gravar a atividade: os dois valores passaram a ser o mesmo
  // por construção, e a sonda diria "só uma escrita" — INCONCLUSIVO — num
  // arrasto que continua produzindo duas. Comparar contra o que o CLIENTE mandou
  // também não serve: uma escrita só já muda o `updated_at`, então a pergunta
  // "mudou em relação ao enviado?" responde SIM com uma escrita e com duas.
  //
  // O corte é o `updated_at` de ANTES do arrasto, e não o relógio deste
  // processo: os dois relógios divergem, e a atividade é carimbada pelo
  // Postgres.
  const { data: atividade } = await admin
    .from("crm_lead_activities")
    .select("created_at")
    .eq("lead_id", lead.id)
    .eq("type", "stage_changed")
    .gt("created_at", lead.updated_at)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const mudou = depois?.stage_id !== lead.stage_id;
  const duasEscritas =
    !!depois?.updated_at &&
    !!atividade?.created_at &&
    Date.parse(depois.updated_at) > Date.parse(atividade.created_at);
  const pulsos = await page.evaluate(
    () => (window as unknown as { __pulsos: number }).__pulsos,
  );

  console.info(`1. card mudou de coluna:            ${mudou ? "SIM" : "NÃO"}`);
  console.info(`2. pulsos na própria aba:           ${pulsos}`);
  console.info(
    `3. a ação produziu 2 escritas:      ${duasEscritas ? "SIM" : "NÃO"} (banco ${depois?.updated_at} / atividade ${atividade?.created_at ?? "nenhuma"} / rota ${updatedAtDaRota})`,
  );

  if (!mudou) {
    console.info("INCONCLUSIVO — o arrasto não moveu o card");
    process.exitCode = 1;
  } else if (!duasEscritas) {
    console.info("INCONCLUSIVO — só uma escrita; o defeito do 12.c não foi exercitado");
    process.exitCode = 1;
  } else if (pulsos > 0) {
    console.info(`FALHA  a aba que agiu pulsou (${pulsos}) — ruído com cara de novidade`);
    process.exitCode = 1;
  } else {
    console.info("PASS   duas escritas, e a aba que agiu não pulsou em nenhuma delas");
  }

  await browser.close();
}

void main();
