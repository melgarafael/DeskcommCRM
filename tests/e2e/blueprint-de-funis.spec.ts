/**
 * BLUEPRINT DE FUNIS PELA TELA (#1995, fatia 2) — a jornada de quem leva a
 * configuração do quadro de uma organização para outra.
 *
 * Um fio só, porque é assim que se usa: em Configurações › Funis o gestor
 * exporta o arquivo, aplica-o (aqui, um funil dele com nome novo, para a prova
 * não depender do estado da organização) e vê o funil novo na lista; aplica o
 * MESMO arquivo de novo e a tela diz que ele já estava lá — nada duplicou.
 *
 * O funil criado termina arquivado pela API, então a spec roda quantas vezes
 * for preciso. Pré-requisito: seed de credenciais (rodado aqui se faltar).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.users?.manager) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = loadCreds();
const NOME = `Blueprint E2E ${Date.now()}`;

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/);
}

async function importar(page: Page, arquivo: string): Promise<void> {
  await page.getByTestId("importar-funis").click();
  const dialogo = page.getByRole("dialog");
  await dialogo.getByLabel("Arquivo de funis (.json)").setInputFiles(arquivo);
  await dialogo.getByRole("button", { name: "Importar", exact: true }).click();
  await expect(dialogo.getByTestId("importar-funis-resultado")).toBeVisible();
}

test("exporta, aplica e reaplica o blueprint de funis sem duplicar", async ({ page }, info) => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await login(page, creds.users.manager!.email);
  await page.goto("/app/settings/tenant/pipelines");

  // ─── Exportar ─────────────────────────────────────────────────────────
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("exportar-funis").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^funis-\d{4}-\d{2}-\d{2}\.json$/);
  const exportado = JSON.parse(fs.readFileSync((await download.path())!, "utf8")) as {
    tipo: string;
    itens: Array<{ nome: string; etapas: unknown[] }>;
  };
  expect(exportado.tipo).toBe("funis");
  expect(exportado.itens.length).toBeGreaterThan(0);
  expect(exportado.itens[0]!.etapas.length).toBeGreaterThan(0);

  // Um funil do arquivo, com nome que esta organização ainda não tem.
  const arquivo = info.outputPath("funis.json");
  fs.writeFileSync(
    arquivo,
    JSON.stringify({ ...exportado, itens: [{ ...exportado.itens[0]!, nome: NOME }] }),
  );

  // ─── Aplicar ──────────────────────────────────────────────────────────
  await importar(page, arquivo);
  const dialogo = page.getByRole("dialog");
  await expect(dialogo.getByText("Funis criados: 1.")).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "blueprint-funis-01-aplicado.png") });
  await dialogo
    .getByTestId("importar-funis-resultado")
    .getByRole("button", { name: "Fechar", exact: true })
    .click();

  const cabecalho = page.getByRole("button", { name: NOME, exact: true });
  await expect(cabecalho).toBeVisible();
  const id = (await cabecalho.getAttribute("data-testid"))!.replace(/^abrir-funil-/, "");

  try {
    // ─── Reaplicar o MESMO arquivo ──────────────────────────────────────
    await importar(page, arquivo);
    await expect(dialogo.getByText("Funis criados: 0.")).toBeVisible();
    await expect(
      dialogo.getByText("Já estavam aqui, com as mesmas etapas, e ficaram como estavam: 1."),
    ).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCIA, "blueprint-funis-02-reaplicado.png") });
    await dialogo
      .getByTestId("importar-funis-resultado")
      .getByRole("button", { name: "Fechar", exact: true })
      .click();

    await page.reload();
    await expect(page.getByRole("button", { name: new RegExp(`^${NOME}`) })).toHaveCount(1);
  } finally {
    // Devolve a organização como estava: o funil criado sai da lista.
    const res = await page.request.delete(`/api/v1/pipelines/${id}`);
    expect(res.ok()).toBe(true);
  }
});
