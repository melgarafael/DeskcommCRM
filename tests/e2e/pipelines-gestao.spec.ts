/**
 * Gestão de funis pela tela do Kanban — a jornada de quem organiza o próprio CRM.
 *
 * Cobre a feature inteira num só fio, porque é assim que ela é usada: a lista
 * respeita a organização ativa, o funil nasce com colunas, é renomeado,
 * reordenado, vira padrão, e as duas recusas que protegem a operação aparecem
 * explicadas na tela (arquivar o padrão, arquivar o último).
 *
 * ⚠️ O PRIMEIRO CASO SÓ TEM PODER COM DUAS ORGANIZAÇÕES. `seed-e2e-funis.ts`
 * coloca o manager numa segunda org que também tem um funil "Pedidos" (o gatilho
 * de seed cria um em toda org nova). Com uma org só, o caso passaria mesmo com o
 * filtro de `organization_id` apagado da página — mediria o seed, não o código.
 *
 * O teste devolve o estado como encontrou (o funil criado termina arquivado, e o
 * padrão volta para onde estava), então roda quantas vezes for preciso.
 *
 * Pré-requisito: seed de credenciais + seed de funis (rodados aqui se faltarem).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { rodaSeed } from "./helpers/seed";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  funis?: { segunda_org_id: string };
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    rodaSeed("scripts/seed-e2e-credentials.ts");
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.users?.manager) {
    rodaSeed("scripts/seed-e2e-credentials.ts");
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  if (!c.funis?.segunda_org_id) {
    rodaSeed("scripts/seed-e2e-funis.ts");
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = loadCreds();
const NOME = `Clinica E2E ${Date.now()}`;
const RENOMEADO = `${NOME} renomeado`;

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/);
}

/** A linha do funil pelo nome visível — a lista não expõe id para o usuário. */
function linhaDoFunil(page: Page, nome: string) {
  return page.locator('li[data-testid^="funil-"]').filter({ hasText: nome });
}

/**
 * O id do funil, lido da própria linha.
 *
 * ⚠️ SEM ISTO O SPEC PEGA O BOTÃO ERRADO. "Arquivar" aparece três vezes na tela
 * com o painel de confirmação aberto (o botão de cada linha e o de confirmar), e
 * casar por TEXTO resolve para vários elementos. Com o id, cada clique aponta
 * para um alvo só — que é o que o teste quer dizer quando diz "clique aqui".
 */
async function idDoFunil(page: Page, nome: string): Promise<string> {
  const testid = await linhaDoFunil(page, nome).getAttribute("data-testid");
  if (!testid) throw new Error(`funil «${nome}» não está na lista`);
  return testid.replace(/^funil-/, "");
}

test.describe("gestão de funis", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, creds.users.manager!.email);
    await page.goto("/app/kanban");
    await expect(page.getByRole("heading", { name: "Pipelines" })).toBeVisible();
  });

  test("a lista mostra só a organização ativa, mesmo com funil homônimo em outra", async ({
    page,
  }) => {
    // O manager é membro de DUAS organizações, e as duas têm um funil "Pedidos".
    // Sem o filtro por organização, apareceriam as duas linhas — indistinguíveis,
    // cada uma levando a um quadro diferente.
    await expect(page.getByText("Pedidos", { exact: true })).toHaveCount(1);
  });

  test("cria funil com colunas, edita, e as recusas aparecem explicadas", async ({ page }) => {
    // ---- criar ----
    await page.getByTestId("novo-funil").click();
    await page.getByTestId("nome-do-novo-funil").fill(NOME);
    await page.getByTestId("confirmar-novo-funil").click();
    await expect(linhaDoFunil(page, NOME)).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCIA, "funis-01-criado.png"), fullPage: true });

    // ---- o funil nasce com as quatro colunas (senão o quadro é morto) ----
    await linhaDoFunil(page, NOME).getByRole("link").click();
    await page.waitForURL(/\/app\/pipelines\//);
    for (const coluna of ["Novo", "Em andamento", "Ganho", "Perdido"]) {
      await expect(page.getByText(coluna, { exact: true }).first()).toBeVisible();
    }
    await page.screenshot({ path: path.join(EVIDENCIA, "funis-02-quadro-novo.png"), fullPage: true });

    await page.goto("/app/kanban");

    // ---- renomear ----
    const id = await idDoFunil(page, NOME);
    await page.getByTestId(`renomear-${id}`).click();
    await page.getByTestId(`nome-${id}`).fill(RENOMEADO);
    await page.getByTestId(`salvar-nome-${id}`).click();
    await expect(linhaDoFunil(page, RENOMEADO)).toBeVisible();

    // ---- reordenar: sobe para o topo ----
    await page.getByTestId(`subir-${id}`).click();
    await expect(page.locator('li[data-testid^="funil-"]').first()).toContainText(RENOMEADO);

    // ---- tornar padrão ----
    await page.getByTestId(`padrao-${id}`).click();
    await expect(linhaDoFunil(page, RENOMEADO).getByText("Padrão")).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCIA, "funis-03-padrao.png"), fullPage: true });

    // ---- recusa: arquivar o funil padrão ----
    await page.getByTestId(`arquivar-${id}`).click();
    await page.getByTestId(`arquivar-confirmar-${id}`).click();
    await expect(page.getByTestId(`arquivar-erro-${id}`)).toContainText(/padrão/i);
    await page.screenshot({
      path: path.join(EVIDENCIA, "funis-04-recusa-padrao.png"),
      fullPage: true,
    });

    // ---- devolve o padrão e arquiva de verdade ----
    const idPedidos = await idDoFunil(page, "Pedidos");
    await page.getByTestId(`padrao-${idPedidos}`).click();
    await expect(linhaDoFunil(page, "Pedidos").getByText("Padrão")).toBeVisible();

    await page.getByTestId(`arquivar-${id}`).click();
    await page.getByTestId(`arquivar-confirmar-${id}`).click();
    await expect(linhaDoFunil(page, RENOMEADO)).toHaveCount(0);

    // ---- recusa: arquivar o último funil ----
    await page.getByTestId(`arquivar-${idPedidos}`).click();
    await page.getByTestId(`arquivar-confirmar-${idPedidos}`).click();
    await expect(page.getByTestId(`arquivar-erro-${idPedidos}`)).toContainText(/único/i);
    await page.screenshot({
      path: path.join(EVIDENCIA, "funis-05-recusa-ultimo.png"),
      fullPage: true,
    });
  });

});

/**
 * Fora do `describe` acima de propósito: este caso entra com OUTRO usuário, e o
 * `beforeEach` de lá já teria logado como manager — a sessão do manager mascararia
 * exatamente o que se quer medir.
 */
test("quem não pode gerenciar vê a lista sem os controles de escrita", async ({ page }) => {
  // Botão que o servidor recusaria é promessa que não se cumpre: `requireRole`
  // cobra manager nas rotas, então agent não vê "Novo funil" nem "Arquivar".
  await login(page, creds.users.agent!.email);
  await page.goto("/app/kanban");
  await expect(page.getByRole("heading", { name: "Pipelines" })).toBeVisible();
  await expect(page.getByText("Pedidos", { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("novo-funil")).toHaveCount(0);
  await expect(page.locator('[data-testid^="arquivar-"]')).toHaveCount(0);
});
