/**
 * A JORNADA DO ANTI-MORTE, na tela (IA 360 · wave 2).
 *
 * O ciclo inteiro do invariante 4 da doutrina, do jeito que acontece na vida de
 * quem opera:
 *
 *   1. um negócio esfria (5 dias sem movimento);
 *   2. o AGENTE marca o retorno — pela capacidade real, não por INSERT à mão;
 *   3. o retorno aparece no RADAR ("em voo": o sistema mantém a demanda viva) e
 *      na TIMELINE do negócio ("Retorno agendado");
 *   4. uma PESSOA desmarca pela fila — a porta que não existia antes desta wave;
 *   5. o AGENTE descobre o cancelamento ao consultar, e não reagenda.
 *
 * ⚠️ O passo 5 é o que separa esta jornada de um CRUD com telas. Sem ele, o
 * humano decide e a informação não chega do outro lado: o agente reagenda no
 * turno seguinte e insiste com quem acabou de pedir para parar.
 *
 * O seed roda a cada execução e reseta o retorno, então o teste é repetível.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  retorno: {
    lead_id: string;
    lead_title: string;
    pipeline_id: string;
    contact_name: string;
    agent_name: string;
    retorno_id: string;
    motivo: string;
  };
}

function tsx(script: string): string {
  return execFileSync("npx", ["tsx", script], { encoding: "utf8" });
}

function loadCreds(): Creds {
  const precisaDaBase = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Partial<Creds>;
    return !c.users?.manager;
  };
  if (precisaDaBase()) tsx("scripts/seed-e2e-credentials.ts");
  // Sempre re-semeia: o teste CANCELA o retorno, e a próxima execução precisa
  // encontrar um retorno agendado — não o cancelado da rodada anterior.
  tsx("scripts/seed-e2e-retorno.ts");
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

function captura(page: Page, nome: string) {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCIA, nome), fullPage: true });
}

test("o retorno marcado pelo agente aparece no Radar e na linha do tempo", async ({ page }) => {
  await login(page, creds.users.manager!.email);

  await page.goto("/app/radar");
  await expect(page.getByRole("heading", { name: "Radar de risco" })).toBeVisible();

  const linha = page.locator('[data-testid="radar-item"]', { hasText: creds.retorno.lead_title });
  await expect(linha).toBeVisible();
  // "Em voo" é a afirmação de que a demanda NÃO está morrendo: alguém prometeu
  // voltar. Sem o retorno, este mesmo negócio apareceria como crítico.
  await expect(linha).toContainText(/voo/i);
  await captura(page, "w2-retorno-no-radar.png");

  // A timeline do NEGÓCIO — o acontecimento tem de ser legível por quem opera,
  // não só existir em cron_jobs.
  const timeline = await page.request.get(
    `/api/v1/leads/${creds.retorno.lead_id}/timeline?limit=20`,
  );
  expect(timeline.ok()).toBeTruthy();
  const corpo = (await timeline.json()) as {
    data: Array<{ type: string; reason: string | null }>;
  };
  const agendado = corpo.data.find((i) => i.type === "followup_scheduled");
  expect(agendado, "a timeline do negócio não registrou o retorno agendado").toBeTruthy();
  expect(agendado!.reason?.toLowerCase()).toContain(creds.retorno.motivo.toLowerCase());
  // ⚠️ E NÃO REPETE O RÓTULO. A linha na tela é "Retorno agendado" + este texto;
  // começar por "Retorno agendado — " fazia o dossiê dizer a mesma frase duas
  // vezes. A asserção anterior (só `toContain` do motivo) passava com a
  // redundância dentro — foi preciso abrir o dossiê para ver.
  expect(agendado!.reason?.toLowerCase().startsWith("retorno agendado")).toBe(false);
});

test("a linha do tempo do negócio mostra o retorno em português de gente", async ({ page }) => {
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/pipelines/${creds.retorno.pipeline_id}`);

  await page.getByRole("button", { name: creds.retorno.lead_title, exact: true }).click();
  const dossie = page.getByRole("dialog").first();
  await expect(dossie.getByText("Retorno agendado", { exact: true }).first()).toBeVisible();

  // O que o operador LÊ, não o que a API devolve: rótulo humano, sem
  // identificador técnico e sem a frase repetida.
  const linha = (await dossie.innerText()).split("LINHA DO TEMPO")[1] ?? "";
  expect(linha).not.toMatch(/followup_scheduled|followup_cancelled|demand_closed/);
  expect(linha).not.toContain("Atividade registrada");
  await captura(page, "w2-retorno-na-linha-do-tempo.png");
});

test("uma pessoa desmarca o retorno pela fila, e o agente descobre", async ({ page }) => {
  await login(page, creds.users.manager!.email);

  await page.goto("/app/ai/followups");
  await page.getByRole("tab", { name: /fila/i }).click();

  const linha = page.locator('[data-testid="queue-row"]', { hasText: creds.retorno.contact_name });
  await expect(linha).toBeVisible();
  await expect(linha).toContainText("Agendada");
  await captura(page, "w2-retorno-na-fila-agendada.png");

  await linha.getByTestId("cancelar-item-da-fila").click();
  await expect(page.getByText("Cancelar este retorno?")).toBeVisible();
  await captura(page, "w2-retorno-dialogo-de-cancelamento.png");
  await page.getByRole("button", { name: "Cancelar retorno" }).click();

  // ⚠️ "Cancelada", não "Concluída". Antes desta wave `enabled=false` era as duas
  // coisas, e a fila dizia ao operador que a mensagem tinha saído.
  await expect(linha).toContainText("Cancelada", { timeout: 15_000 });
  await captura(page, "w2-retorno-na-fila-cancelada.png");

  // A OUTRA PONTA: o agente, consultando pela capacidade real, vê o
  // cancelamento e o motivo — é o que o impede de reagendar o que uma pessoa
  // acabou de desmarcar.
  const saida = tsx("scripts/e2e-retorno-visao-do-agente.ts");
  const linhaJson = saida.split("\n").find((l) => l.startsWith("VISAO_DO_AGENTE="));
  expect(linhaJson, "o script de visão do agente não imprimiu o resultado").toBeTruthy();
  const visto = JSON.parse(linhaJson!.slice("VISAO_DO_AGENTE=".length)) as {
    retornos: Array<{ id: string; situacao: string; motivo_do_cancelamento: string | null }>;
  };
  const doTeste = visto.retornos.find((r) => r.id === creds.retorno.retorno_id);
  expect(doTeste, "o agente não enxergou o retorno que ele mesmo marcou").toBeTruthy();
  expect(doTeste!.situacao).toBe("cancelado");
  expect(doTeste!.motivo_do_cancelamento).toContain("pessoa da equipe");
});
