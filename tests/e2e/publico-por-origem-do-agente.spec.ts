/**
 * PÚBLICO DO AGENTE POR ORIGEM — provado PELA TELA.
 *
 * O que só a tela prova:
 *  1. as duas listas de origem APARECEM no "Público do agente", com a origem
 *     "Prospecção" entre as opções — é a que divide o número entre o agente da
 *     prospecção e o de atendimento;
 *  2. marcar "Prospecção" em "Não atender" SOBREVIVE ao salvar e recarregar.
 *     A lista mora no jsonb `trigger_config.filters`, e o schema `.strict()` da
 *     versão descartaria a chave se a validação não a conhecesse: o sintoma
 *     seria a caixa voltar desmarcada depois do refresh, com o salvar "verde";
 *  3. a marcação de "Não atender" não vaza para "Atender só" (são duas listas).
 *
 * Mesmo molde de `escopo-de-funil-do-agente.spec.ts`: login de admin primeiro
 * (só admin edita agente), seed do `mcp_agent` depois, bateria serial. O caso
 * devolve o agente ao estado de antes no fim, porque o seed é compartilhado com
 * outras specs desta tela.
 */
import { execFileSync } from "node:child_process";

import { test, expect, type Browser, type Page } from "./helpers/test";

import { loginComoAdmin, lerCreds, type CredsE2E } from "./helpers/login-admin";

let creds: CredsE2E = lerCreds();

test.use({ locale: "pt-BR" });
test.describe.configure({ timeout: 240_000 });
test.describe.configure({ mode: "serial" });

let pagina: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  const contexto = await browser.newContext({ locale: "pt-BR" });
  pagina = await contexto.newPage();
  creds = await loginComoAdmin(pagina, creds);
  execFileSync("npx", ["tsx", "scripts/seed-e2e-capacidades.ts"], { stdio: "inherit" });
  creds = lerCreds();
});

test.afterAll(async () => {
  await pagina?.context().close();
});

function agenteDeTeste(): string {
  const id = creds.capacidades?.agent_id;
  if (id === undefined || id === "") {
    throw new Error(
      "`.e2e-creds.json` sem `capacidades.agent_id` — o beforeAll deveria ter semeado. " +
        "Rode `pnpm exec tsx scripts/seed-e2e-capacidades.ts` com o ambiente do e2e.",
    );
  }
  return id;
}

/** Abre o agente; o público fica na aba "Conversa com o cliente", a que abre por padrão. */
async function abrirAgente(): Promise<void> {
  await pagina.goto(`/app/ai/agents/${agenteDeTeste()}`);
  await expect(pagina.getByText("Público do agente")).toBeVisible({ timeout: 20_000 });
}

const naoAtender = () => pagina.locator("#exclude_sources");
const atenderSo = () => pagina.locator("#include_sources");

/** Fotografa só a região das duas listas (medida, não a olho), com folga para os rótulos. */
async function fotografarListas(caminho: string): Promise<void> {
  await atenderSo().scrollIntoViewIfNeeded();
  const a = await atenderSo().boundingBox();
  const b = await naoAtender().boundingBox();
  if (a === null || b === null) throw new Error("listas de origem sem caixa medida");
  // `boundingBox` mede na janela; o `clip` com `fullPage` mede na página inteira.
  const rolagem = await pagina.evaluate(() => window.scrollY);
  const x = Math.max(0, Math.min(a.x, b.x) - 24);
  const y = Math.max(0, Math.min(a.y, b.y) + rolagem - 80);
  const largura = Math.max(a.x + a.width, b.x + b.width) - x + 24;
  const altura = Math.max(a.y + a.height, b.y + b.height) + rolagem - y + 60;
  await pagina.screenshot({ path: caminho, fullPage: true, clip: { x, y, width: largura, height: altura } });
}

async function salvarRascunho(): Promise<void> {
  await pagina.getByRole("button", { name: /salvar rascunho/i }).first().click();
  // Espera o SUCESSO, não o botão desabilitar (ver o vizinho escopo-de-funil).
  await expect(pagina.getByText(/rascunho v\d+ salvo/i)).toBeVisible({ timeout: 30_000 });
}

test.describe("público do agente por origem", () => {
  test("as duas listas aparecem, com Prospecção entre as origens", async () => {
    await abrirAgente();

    await expect(pagina.getByText("Atender só quem chegou por estas origens")).toBeVisible();
    await expect(pagina.getByText("Não atender quem chegou por estas origens")).toBeVisible();

    const prospeccao = naoAtender().getByRole("checkbox", { name: "Prospecção" });
    await expect(prospeccao).toBeVisible();
    await expect(prospeccao).toBeEnabled();
    // Controle: o seed nunca marcou origem — o caso seguinte mede a marcação, não um resto.
    await expect(prospeccao).not.toBeChecked();

    await fotografarListas("evidence/publico-por-origem/listas-de-origem.png");
  });

  test("marcar Prospecção em Não atender SOBREVIVE ao salvar e recarregar", async () => {
    await abrirAgente();

    await naoAtender().getByRole("checkbox", { name: "Prospecção" }).check();
    await salvarRascunho();

    // RECARREGAR é o ponto do teste.
    await abrirAgente();
    await expect(
      naoAtender().getByRole("checkbox", { name: "Prospecção" }),
      "a marcação de origem não sobreviveu ao reload",
    ).toBeChecked({ timeout: 20_000 });
    await expect(
      atenderSo().getByRole("checkbox", { name: "Prospecção" }),
      "a exclusão vazou para a lista de inclusão",
    ).not.toBeChecked();

    await fotografarListas("evidence/publico-por-origem/prospeccao-sobrevive-ao-reload.png");

    // Devolve o seed compartilhado ao estado de antes.
    await naoAtender().getByRole("checkbox", { name: "Prospecção" }).uncheck();
    await salvarRascunho();
  });
});
