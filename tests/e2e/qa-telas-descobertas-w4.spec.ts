/**
 * QA DE USO — as três telas da W4 que nenhum spec abria.
 *
 * ⚠️ O QUE ESTE ARQUIVO FAZ DE DIFERENTE. Os E2E do repo provam encanamento: o
 * login é real, mas o ESTADO vem de seed. Isso demonstra que a tela funciona
 * quando alguém já pôs os dados lá — não que uma pessoa consegue chegar lá
 * sozinha. Aqui o estado é criado **pela interface**, clicando, sempre que a
 * tela permitir. Onde não permitir, isso já é o achado.
 *
 * As três telas (`/app/templates`, `/app/settings/templates`, `/app/audit`) são
 * do escopo desta wave e não apareciam em spec nenhum.
 *
 * ⚠️ `/app/audit` É DÍVIDA MINHA, e é a razão de ela estar aqui. O `SeloDeAutoria`
 * passou a prometer "ver o que mudou" apontando para lá — e eu nunca abri essa
 * tela. Se ela não permitir achar a mudança do assistente, o link que criei leva
 * o dono a um beco, e a correção do invariante 5 é decorativa.
 *
 * Tela sadia provada também é resultado: cada uma sai com captura.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const AGENTE_PATH = path.join(process.cwd(), ".e2e-agente-mcp.json");
const SAIDA = path.join(process.cwd(), "evidence", "ia-360-w4");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
const ts = Date.now();

async function login(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.getByLabel(/e-?mail/i).fill(creds.users.manager!.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

/** O que a tela mostra quando alguém abre: título, vazio, erro — o que der. */
async function radiografia(page: Page, rotulo: string): Promise<void> {
  const h1 = await page
    .getByRole("heading", { level: 1 })
    .first()
    .textContent()
    .catch(() => null);
  const corpo = (await page.locator("main, body").first().innerText().catch(() => "")) ?? "";
  const botoes = await page.getByRole("button").allTextContents();
  console.info(`[QA] ${rotulo} · h1="${(h1 ?? "(sem h1)").trim()}"`);
  console.info(`[QA] ${rotulo} · botões: ${botoes.filter(Boolean).slice(0, 8).join(" | ") || "(nenhum)"}`);
  console.info(`[QA] ${rotulo} · primeiros 220 chars: ${corpo.replace(/\s+/g, " ").slice(0, 220)}`);
}

test.describe("QA — as telas da W4 que ninguém abria", () => {
  test("respostas prontas: o usuário cria uma PELA TELA", async ({ page }) => {
    test.setTimeout(180_000);
    fs.mkdirSync(SAIDA, { recursive: true });
    await login(page);

    await page.goto(`${APP_URL}/app/templates`);
    await page.waitForLoadState("networkidle");
    await radiografia(page, "/app/templates");
    await page.screenshot({ path: path.join(SAIDA, "qa-tela-templates.png"), fullPage: true });

    // O caminho do leigo: achar o botão de criar sem saber o nome dele.
    const criar = page
      .getByRole("button", { name: /nov[ao]|criar|adicionar/i })
      .first();
    const temBotao = (await criar.count()) > 0;
    console.info(`[QA] /app/templates · dá para criar pela tela? ${temBotao ? "SIM" : "NÃO"}`);
    expect(temBotao, "sem caminho de criação, a tela nasce vazia e sem saída").toBe(true);

    await criar.click();
    const titulo = `Resposta QA ${ts}`;
    // Os campos, pelo rótulo que o usuário lê — não por testid.
    await page.getByLabel(/t[íi]tulo/i).first().fill(titulo);
    await page.getByLabel(/mensagem|texto|corpo/i).first().fill(
      "Olá {{nome}}, recebemos seu contato e retornamos em breve.",
    );
    await page.screenshot({
      path: path.join(SAIDA, "qa-tela-templates-criando.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: /salvar|criar|adicionar/i }).last().click();
    // A prova é a resposta aparecer na lista, não o toast sumir.
    await expect(page.getByText(titulo, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    console.info(`[QA] /app/templates · resposta criada pela interface e visível na lista`);
    await page.screenshot({ path: path.join(SAIDA, "qa-tela-templates-criada.png"), fullPage: true });
  });

  test("settings/templates: o que é essa segunda porta", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto(`${APP_URL}/app/settings/templates`);
    await page.waitForLoadState("networkidle");
    console.info(`[QA] /app/settings/templates · URL final: ${page.url()}`);
    await radiografia(page, "/app/settings/templates");
    await page.screenshot({
      path: path.join(SAIDA, "qa-tela-settings-templates.png"),
      fullPage: true,
    });
  });

  test("histórico: o dono consegue achar o que o assistente mudou?", async ({ page }) => {
    test.setTimeout(240_000);
    await login(page);

    // Primeiro faz o assistente mexer em algo, para haver o que procurar.
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agente-mcp.ts"], { stdio: "pipe" });
    const { bearer } = JSON.parse(fs.readFileSync(AGENTE_PATH, "utf8")) as { bearer: string };
    const funis = await page.request.get(`${APP_URL}/api/v1/pipelines`);
    const funilId = ((await funis.json()) as { data?: Array<{ id: string }> }).data?.[0]?.id;

    console.info(`[QA] funil alvo: ${funilId ?? "(NENHUM — /api/v1/pipelines não devolveu id)"}`);

    const criacao = await page.request.post(`${APP_URL}/api/mcp`, {
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json, text/event-stream" },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "crm_create_stage",
          arguments: { pipeline_id: funilId, name: `Etapa QA audit ${ts}` },
        },
      },
    });
    // ⚠️ HTTP 200 NÃO É SUCESSO NO MCP: o protocolo devolve 200 com `isError` no
    // corpo. A primeira versão desta sonda olhava só o status e reportou "criou"
    // sobre uma chamada que falhou — o erro estava no payload, calado.
    const corpoMcp = await criacao.text();
    console.info(`[QA] assistente criou etapa → HTTP ${criacao.status()}`);
    console.info(`[QA] corpo da resposta MCP: ${corpoMcp.replace(/\s+/g, " ").slice(0, 500)}`);

    await page.goto(`${APP_URL}/app/audit`);
    await page.waitForLoadState("networkidle");
    await radiografia(page, "/app/audit");
    await page.screenshot({ path: path.join(SAIDA, "qa-tela-audit.png"), fullPage: true });

    // A promessa do selo é "ver o que mudou". Um dono que clicou nele chega aqui
    // e procura pela etapa que o assistente acabou de criar. Ele acha?
    const corpo = await page.locator("body").innerText();
    const achaAcao = corpo.includes("pipeline.stage_created");
    const achaNome = corpo.includes(`Etapa QA audit ${ts}`);
    console.info(`[QA] /app/audit · encontra a AÇÃO (pipeline.stage_created)? ${achaAcao ? "SIM" : "NÃO"}`);
    console.info(`[QA] /app/audit · encontra O QUE MUDOU (nome da etapa)? ${achaNome ? "SIM" : "NÃO"}`);
    console.info(
      `[QA] /app/audit · a linha diz que foi o ASSISTENTE? ${/assistente|ai_agent|agente/i.test(corpo) ? "SIM" : "NÃO"}`,
    );
  });
});
