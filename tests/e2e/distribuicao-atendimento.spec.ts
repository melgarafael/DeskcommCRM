/**
 * [P1] A porta da distribuição de atendimento (issue #144).
 *
 * O contribuidor pediu: distribuir leads em rodízio entre atendentes, e cada um
 * enxergando só os seus. Medido antes de escrever: as duas coisas existiam
 * inteiras no backend (worker `lib/routing/`, RLS `fn_can_view_lead`) e não
 * havia UMA tela que as ligasse — nenhum arquivo de `app/` consumia
 * `/api/v1/settings/routing`, e `visibility_mode` só aparecia sendo LIDO. O
 * único jeito de ligar era `UPDATE` à mão no Postgres.
 *
 * Esta spec prova o caminho como o dono do negócio o faria: pela tela, logado,
 * clicando. `curl` na rota provaria o backend — que já funcionava — e não a
 * existência da porta, que é o defeito.
 *
 * Cobre também o RBAC da tela (agent não entra) e a persistência de verdade
 * (recarrega e o estado voltou do banco, não do estado local do React).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const precisa = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (precisa()) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
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

/** O estado marcado vem do atributo que o próprio componente escreve. */
async function marcada(page: Page, nome: string, valor: string): Promise<boolean> {
  return (
    (await page.getByTestId(`opcao-${nome}-${valor}`).getAttribute("data-marcada")) === "sim"
  );
}

test.describe("distribuição de atendimento — a tela que liga o rodízio e a visibilidade", () => {
  test.describe.configure({ timeout: 120_000 });

  test.afterAll(async ({ browser }) => {
    // Devolve a org ao default do produto. Sem isto, uma spec que rode depois
    // herdaria `visibility_mode` alterado e mediria outro produto — e o vermelho
    // dela apontaria para o lugar errado.
    const page = await browser.newPage();
    await login(page, creds.users.manager!.email);
    await page.request.patch("/api/v1/settings/routing", {
      data: { mode: "manual", max_retries: 5, backoff_seconds: 60, visibility_mode: "own_and_unassigned" },
    });
    await page.close();
  });

  test("manager liga o rodízio e a restrição pela tela, e o estado sobrevive ao reload", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email);

    // 1. A tela é ALCANÇÁVEL pela navegação — não só pela URL digitada. É o
    //    defeito da issue: a feature existia e não tinha porta.
    await page.goto("/app/settings");
    const porta = page.getByRole("link", { name: /Distribuição de atendimento/i });
    await expect(porta).toBeVisible();
    await porta.click();
    await page.waitForURL(/\/app\/settings\/atendimento/);

    await expect(
      page.getByRole("heading", { name: "Distribuição de atendimento" }),
    ).toBeVisible();

    // 2. O default do produto aparece: manual + "os seus e os sem dono".
    expect(await marcada(page, "modo", "manual")).toBe(true);

    // 3. Liga o rodízio — e só então os knobs aparecem (config de retentativa
    //    não faz sentido no modo manual, em que ninguém retenta).
    await expect(page.locator("#max_retries")).toHaveCount(0);
    await page.getByTestId("opcao-modo-round_robin").click();
    await expect(page.locator("#max_retries")).toBeVisible();

    // 4. Restringe a visibilidade ao próprio atendente.
    await page.getByTestId("opcao-visibilidade-own").click();
    expect(await marcada(page, "visibilidade", "own")).toBe(true);

    // 5. Salva e recarrega: o estado tem de vir do BANCO. Sem o reload isto
    //    provaria só que o React guardou o clique.
    await page.getByRole("button", { name: /^Salvar$/ }).click();
    await expect(page.getByText(/Distribuição de atendimento salva/i)).toBeVisible();

    await page.reload();
    expect(await marcada(page, "modo", "round_robin")).toBe(true);
    expect(await marcada(page, "visibilidade", "own")).toBe(true);
    await expect(page.locator("#max_retries")).toBeVisible();

    // 6. E a API concorda com a tela — se divergissem, uma das duas estaria
    //    mentindo e o operador não teria como saber qual.
    const res = await page.request.get("/api/v1/settings/routing");
    expect(res.status()).toBe(200);
    const { data } = (await res.json()) as {
      data: { mode: string; visibility_mode: string };
    };
    expect(data.mode).toBe("round_robin");
    expect(data.visibility_mode).toBe("own");
  });

  test("a combinação que mata a operação é avisada antes de salvar", async ({ page }) => {
    // "só os seus" + distribuição manual = ninguém enxerga a fila para pegar,
    // e nenhum cliente é atendido. É a configuração que o operador escolheria
    // achando que está sendo restritivo.
    await login(page, creds.users.manager!.email);
    await page.goto("/app/settings/atendimento");

    await page.getByTestId("opcao-modo-manual").click();
    await page.getByTestId("opcao-visibilidade-own").click();
    await expect(page.getByTestId("aviso-combinacao-morta")).toBeVisible();

    await page.getByTestId("opcao-modo-round_robin").click();
    await expect(page.getByTestId("aviso-combinacao-morta")).toHaveCount(0);
  });

  test("atendente não abre a tela nem consegue gravar pela API", async ({ page }) => {
    await login(page, creds.users.agent!.email);

    await page.goto("/app/settings/atendimento");
    await expect(page.getByTestId("form-atendimento")).toHaveCount(0);

    // O redirect da página não é a defesa — é conforto. A defesa é o servidor:
    // sem esta asserção, tirar o `requireRole` da rota deixaria a spec verde.
    const res = await page.request.patch("/api/v1/settings/routing", {
      data: { mode: "round_robin", max_retries: 5, backoff_seconds: 60, visibility_mode: "all" },
    });
    expect(res.status()).toBe(403);
  });
});
