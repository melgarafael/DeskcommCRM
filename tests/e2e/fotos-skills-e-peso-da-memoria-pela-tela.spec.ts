/**
 * TRÊS ESCOLHAS DE CUSTO, PROVADAS PELA TELA — como o dono da clínica as faria.
 *
 *   1. "Ver as fotos que o cliente envia", por agente (migration 9108,
 *      `ai_agent_versions.image_vision_enabled`). Nasce LIGADA; desligar, salvar
 *      e publicar sobrevive ao recarregar, e o Diff do Histórico mostra a troca.
 *   2. O limite do aviso de peso da Memória da IA
 *      (`settings.memoria_da_ia.limite_do_aviso_tokens`). O admin baixa para 100
 *      e o aviso acende com um texto curto; o valor fica salvo; o gerente vê o
 *      limite em vigor e NÃO vê o campo de edição.
 *   3. As skills de cada agente (migration 9107, `skill_names`). O padrão é
 *      "todas"; trocar para uma lista própria com uma skill marcada sobrevive ao
 *      recarregar.
 *
 * As duas chaves de custo também são medidas a 375 px: o controle cabe sem
 * rolagem horizontal (`scrollWidth <= clientWidth`), medido por
 * `getBoundingClientRect`, nunca a olho.
 *
 * Fixtures, todas pelos seeds que as specs irmãs já usam:
 *   - `seed-e2e-credentials.ts` (admin com TOTP e o `manager`);
 *   - `seed-e2e-elegibilidade.ts` (credencial de IA validada + número `WORKING`,
 *     as duas condições para o botão "Publicar" destravar numa instalação sem
 *     chave de IA nenhuma). Rodado aqui se o bloco faltar, como nas j20.
 *   - o agente nasce pela API real (`POST /api/v1/ai/agents`), como em
 *     `motivo-do-publicar-na-tela.spec.ts`, e é arquivado no `finally`.
 *   - as skills são as duas de plataforma que o `baseline.sql` já traz.
 *
 * O limite da memória é da EMPRESA: o caso devolve 1500 no fim, pela tela.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { esperarARevelacaoNasCargas, test, expect, esperarARevelacao, type Locator, type Page } from "./helpers/test";

import { loginComoAdmin, lerCreds, type CredsE2E } from "./helpers/login-admin";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA =
  process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), "evidence", "tokens-visual-2026-11-01");
const CELULAR = { width: 375, height: 812 };

let creds: CredsE2E = lerCreds();

function fixturesDePublicacao(): { credential_id: string; channel_session_id: string } {
  const ler = () =>
    (JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as {
      elegibilidade?: { credential_id: string; channel_session_id: string };
    }).elegibilidade;
  if (!ler()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-elegibilidade.ts"], { stdio: "inherit" });
  }
  const bloco = ler();
  if (!bloco) throw new Error("bloco `elegibilidade` ausente depois do seed — veja a saída de seed-e2e-elegibilidade.ts");
  return bloco;
}

const PUBLICAVEL = fixturesDePublicacao();

test.use({ locale: "pt-BR" });
// 240s, como as vizinhas: inclui UMA re-semeadura do TOTP no login e duas publicações.
test.describe.configure({ timeout: 240_000 });

test.beforeEach(async ({ page }) => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  creds = await loginComoAdmin(page, creds);
});

async function foto(page: Page, nome: string): Promise<void> {
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/** Agente publicável (credencial validada + número conectado), pela API real. */
async function criarAgente(page: Page, nome: string): Promise<string> {
  const r = await page.request.post("/api/v1/ai/agents", {
    data: {
      name: nome,
      version: {
        system_prompt: "Você é a recepção de uma clínica. Atenda com educação, em pt-BR.",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        credential_id: PUBLICAVEL.credential_id,
        channel_session_id: PUBLICAVEL.channel_session_id,
      },
    },
  });
  expect(r.status(), `a fixture do agente não nasceu: ${await r.text()}`).toBe(201);
  return ((await r.json()) as { data: { agent: { id: string } } }).data.agent.id;
}

async function publicar(page: Page, n: number): Promise<void> {
  const botao = page.getByRole("button", { name: `Publicar v${n}` }).first();
  const motivo = page.getByTestId("motivo-do-publicar");
  const porque = (await motivo.count()) > 0 ? await motivo.innerText() : "";
  await expect(botao, `o Publicar v${n} devia estar livre (motivo na tela: "${porque}")`).toBeEnabled();
  await botao.click();
  await page.getByRole("alertdialog").getByRole("button", { name: `Publicar v${n}` }).click();
  await expect(page.getByText(`v${n} publicada e ativa.`)).toBeVisible({ timeout: 30_000 });
  // O `router.refresh()` reinicia o formulário: mexer antes dele é mexer no que vai sumir.
  await expect(page.getByText(`Publicado v${n}`, { exact: true })).toBeVisible({ timeout: 30_000 });
}

interface Medida {
  largura: number;
  direita: number;
  scrollWidth: number;
  clientWidth: number;
  docScrollWidth: number;
  docClientWidth: number;
}

/** Caixa do controle e a rolagem dele e da página — medidas no DOM. */
async function medir(controle: Locator, caixa: Locator): Promise<Medida> {
  await caixa.scrollIntoViewIfNeeded();
  const largura = await controle.evaluate((el) => el.getBoundingClientRect().width);
  return caixa.evaluate(
    (el, larguraDoControle) => ({
      largura: Math.round(larguraDoControle * 10) / 10,
      direita: Math.round(el.getBoundingClientRect().right * 10) / 10,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    }),
    largura,
  );
}

function cabeSemRolar(m: Medida, onde: string): void {
  expect(m.largura, `${onde}: o controle não tem largura`).toBeGreaterThan(0);
  expect(m.scrollWidth, `${onde}: a caixa rola na horizontal`).toBeLessThanOrEqual(m.clientWidth);
  expect(m.direita, `${onde}: a caixa passa da borda de ${CELULAR.width}px`).toBeLessThanOrEqual(CELULAR.width);
  expect(m.docScrollWidth, `${onde}: a PÁGINA rola na horizontal`).toBeLessThanOrEqual(m.docClientWidth);
}

test.describe("Ver as fotos que o cliente envia, por agente", () => {
  test("nasce ligada, desligar + salvar + publicar sobrevive ao recarregar, e o Diff mostra a troca", async ({
    page,
  }) => {
    // O padrão de quem cria pela tela.
    await page.goto("/app/ai/agents/new");
    await expect(page.locator("#image_vision_enabled")).toHaveAttribute("aria-checked", "true");

    const nome = `E2E Fotos ${Date.now()}`;
    const agentId = await criarAgente(page, nome);
    try {
      await page.goto(`/app/ai/agents/${agentId}`);
      await expect(page.getByRole("heading", { name: nome })).toBeVisible();

      const chave = page.locator("#image_vision_enabled");
      // O padrão de quem nasce pela API: o default da coluna.
      await expect(chave).toHaveAttribute("aria-checked", "true");
      await expect(page.getByText("Ver as fotos que o cliente envia", { exact: true })).toBeVisible();
      const ajuda = page.getByTestId("visao-de-foto-ajuda");
      await expect(ajuda).toContainText("cada foto descrita é uma chamada paga");
      await expect(ajuda).toContainText("PDF não muda com esta opção");
      console.info(`[prova-fotos] ajuda="${(await ajuda.innerText()).trim()}"`);
      await ajuda.scrollIntoViewIfNeeded();
      await foto(page, "fotos-01-padrao-ligado");

      await publicar(page, 1);

      await chave.click();
      await expect(chave).toHaveAttribute("aria-checked", "false");
      const salvar = page.getByRole("button", { name: "Salvar rascunho" });
      await expect(salvar, "desligar a chave de fotos não contou como mudança a salvar").toBeEnabled();
      await salvar.click();
      await expect(page.getByText("Rascunho v2 salvo.")).toBeVisible({ timeout: 30_000 });
      await publicar(page, 2);

      await page.reload();
      await expect(page.getByRole("heading", { name: nome })).toBeVisible();
      await expect(page.locator("#image_vision_enabled")).toHaveAttribute("aria-checked", "false");
      await page.getByTestId("visao-de-foto-ajuda").scrollIntoViewIfNeeded();
      await foto(page, "fotos-02-desligada-depois-de-recarregar");

      // A comparação de versões: v2 publicada, v1 substituída.
      await page.getByRole("tab", { name: "Histórico" }).click();
      const linhaV2 = page.locator("li").filter({ has: page.locator("span.font-mono", { hasText: /^v2$/ }) });
      await linhaV2.getByRole("button", { name: "Diff" }).click();
      const dialogo = page.getByRole("dialog");
      await expect(dialogo.getByRole("heading", { name: "Diff v1 ↔ v2" })).toBeVisible();
      const troca = dialogo.locator("tr").filter({ hasText: "image_vision_enabled" });
      await expect(troca).toHaveCount(1);
      const celulas = (await troca.locator("td").allInnerTexts()).map((s) => s.trim());
      console.info(`[prova-fotos] diff=${JSON.stringify(celulas)}`);
      expect(celulas).toEqual(["image_vision_enabled", "true", "false"]);
      await foto(page, "fotos-03-diff-v1-v2");
      await page.keyboard.press("Escape");

      // A 375 px a chave e a ajuda cabem sem rolagem horizontal.
      await page.setViewportSize(CELULAR);
      await page.reload();
      // A 375 px a fila de seis abas transborda. Ir ao Histórico e voltar prova
      // que a PRIMEIRA aba continua alcançável (centralizada, ela ficava em
      // left = -80 px, fora da rolagem — components/ui/tabs.tsx).
      await page.getByRole("tab", { name: "Histórico" }).click();
      const abaConfig = page.getByRole("tab", { name: "Configuração" });
      await abaConfig.click({ timeout: 15_000 });
      await expect(abaConfig).toHaveAttribute("aria-selected", "true");
      const fila = await abaConfig.evaluate((aba) => {
        const lista = aba.parentElement!;
        return {
          abaLeft: Math.round(aba.getBoundingClientRect().left),
          listaLeft: Math.round(lista.getBoundingClientRect().left),
          listaScrollWidth: lista.scrollWidth,
          listaClientWidth: lista.clientWidth,
        };
      });
      console.info(`[prova-fotos] 375px abas ${JSON.stringify(fila)}`);
      expect(fila.abaLeft, "a primeira aba saiu pela esquerda da fila").toBeGreaterThanOrEqual(fila.listaLeft);
      const caixa = page.getByTestId("visao-de-foto-ajuda").locator("..");
      const m = await medir(page.locator("#image_vision_enabled"), caixa);
      console.info(`[prova-fotos] 375px ${JSON.stringify(m)}`);
      cabeSemRolar(m, "chave de fotos a 375px");
      await foto(page, "fotos-04-375px");
    } finally {
      await page.request.delete(`/api/v1/ai/agents/${agentId}`);
    }
  });
});

const TEXTO_CURTO =
  "Atendimento de segunda a sexta, das 9h às 18h. Nunca prometa desconto sem falar com um humano. " +
  "Chame o cliente pelo primeiro nome. Consulta de avaliação custa R$ 150 e pode ser parcelada em duas vezes. " +
  "Se o cliente pedir para remarcar, ofereça os dois próximos horários livres. " +
  "Retorno em até 30 dias não é cobrado.";

async function tokensNaTela(page: Page): Promise<number> {
  const texto = await page.getByTestId("memoria-peso").innerText();
  const m = texto.match(/≈\s*([\d.]+)\s*tokens/);
  expect(m, `o peso não está em tokens: "${texto}"`).not.toBeNull();
  return Number(m![1]!.replace(/\./g, ""));
}

async function salvarLimite(page: Page, valor: number): Promise<void> {
  const campo = page.locator("#memoria-limite-tokens");
  await campo.fill(String(valor));
  await page.getByTestId("memoria-limite").getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText("Salvo", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(campo).toHaveValue(String(valor));
}

test.describe("Limite do aviso de peso da Memória da IA", () => {
  test("o admin baixa para 100 e o aviso acende com texto curto; fica salvo; o gerente só lê", async ({
    page,
    browser,
  }, testInfo) => {
    await page.goto("/app/ai/memory");
    const campo = page.locator("#memoria-limite-tokens");
    await expect(campo).toHaveValue("1500");
    await expect(page.getByTestId("memoria-limite")).toContainText("Mostrar o aviso de peso acima de");
    await expect(page.getByText(/^Recomendado: 1\.500 tokens\./)).toBeVisible();

    const textarea = page.locator("textarea").first();
    await textarea.fill(TEXTO_CURTO);
    const tokens = await tokensNaTela(page);
    console.info(`[prova-memoria] peso="${(await page.getByTestId("memoria-peso").innerText()).trim()}"`);
    expect(tokens, "o texto da prova precisa pesar entre 100 e 1500 tokens").toBeGreaterThan(100);
    expect(tokens).toBeLessThan(1500);
    await expect(page.getByTestId("memoria-peso-aviso")).toHaveCount(0);

    try {
      await salvarLimite(page, 100);
      const aviso = page.getByTestId("memoria-peso-aviso");
      await expect(aviso).toBeVisible();
      const estilo = await aviso.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return { altura: r.height, cor: s.color, display: s.display, visibility: s.visibility };
      });
      console.info(`[prova-memoria] aviso="${(await aviso.innerText()).trim()}" ${JSON.stringify(estilo)}`);
      expect(estilo.altura).toBeGreaterThan(0);
      expect(estilo.visibility).toBe("visible");
      await foto(page, "memoria-01-limite-100-aviso-aceso");

      // Recarregar: o valor vem do banco, e é ele que acende o aviso.
      await page.reload();
      await expect(page.locator("#memoria-limite-tokens")).toHaveValue("100");
      await page.locator("textarea").first().fill(TEXTO_CURTO);
      await expect(page.getByTestId("memoria-peso-aviso")).toBeVisible();
      await foto(page, "memoria-02-depois-de-recarregar");

      // A 375 px o campo do limite cabe sem rolagem horizontal.
      await page.setViewportSize(CELULAR);
      const m = await medir(page.locator("#memoria-limite-tokens"), page.getByTestId("memoria-limite"));
      console.info(`[prova-memoria] 375px ${JSON.stringify(m)}`);
      cabeSemRolar(m, "campo do limite a 375px");
      await foto(page, "memoria-03-375px");

      // O gerente: vê o limite em vigor, não vê o campo.
      const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, locale: "pt-BR" });
      ctx.on("page", esperarARevelacaoNasCargas);
      try {
        const gerente = await ctx.newPage();
        await gerente.goto("/login");
        await gerente.locator("#email").fill(creds.users.manager!.email);
        await gerente.locator("#password").fill(creds.password);
        await gerente.getByRole("button", { name: "Entrar", exact: true }).click();
        await gerente.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
        await gerente.goto("/app/ai/memory");
        await esperarARevelacao(gerente);
        const leitura = gerente.getByTestId("memoria-limite");
        await expect(leitura).toHaveText("Mostrar o aviso de peso acima de 100 tokens");
        console.info(`[prova-memoria] gerente="${(await leitura.innerText()).trim()}"`);
        await expect(gerente.locator("#memoria-limite-tokens")).toHaveCount(0);
        await expect(leitura.getByRole("button", { name: "Salvar" })).toHaveCount(0);
        await gerente.locator("textarea").first().fill(TEXTO_CURTO);
        await expect(gerente.getByTestId("memoria-peso-aviso")).toBeVisible();
        await gerente.screenshot({ path: path.join(EVIDENCIA, "memoria-04-gerente-so-le.png"), fullPage: true });
      } finally {
        await ctx.close();
      }
    } finally {
      // O limite é da empresa inteira: volta ao recomendado pela tela.
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto("/app/ai/memory");
      if ((await page.locator("#memoria-limite-tokens").inputValue()) !== "1500") {
        await salvarLimite(page, 1500);
      }
    }
    await page.reload();
    await expect(page.locator("#memoria-limite-tokens")).toHaveValue("1500");
  });
});

test.describe("Skills por agente", () => {
  test("trocar para lista própria com uma skill marcada sobrevive ao recarregar", async ({ page }) => {
    const nome = `E2E Skills ${Date.now()}`;
    const agentId = await criarAgente(page, nome);
    try {
      await page.goto(`/app/ai/agents/${agentId}`);
      await expect(page.getByRole("heading", { name: nome })).toBeVisible();

      const secao = page.getByTestId("agente-skills");
      const todas = page.getByTestId("skills-todas");
      await expect(secao.getByText("Usar todas as skills da organização (padrão)")).toBeVisible();
      await expect(todas).toBeChecked();

      await todas.uncheck();
      const caixas = page.getByTestId("skills-lista").locator('input[type="checkbox"]');
      const quantas = await caixas.count();
      expect(quantas, "a organização devia ter skills de plataforma do baseline").toBeGreaterThan(0);
      // Sair do padrão começa com TODAS marcadas; desmarco todas e marco uma.
      for (let i = 0; i < quantas; i++) await caixas.nth(i).uncheck();
      await expect(page.getByTestId("skills-nenhuma-marcada")).toBeVisible();
      const escolhida = caixas.first();
      const idDaEscolhida = (await escolhida.getAttribute("data-testid"))!;
      await escolhida.check();
      console.info(`[prova-skills] marcada=${idDaEscolhida} de ${quantas}`);
      await foto(page, "skills-01-lista-propria-antes-de-salvar");

      await page.getByRole("button", { name: "Salvar rascunho" }).click();
      await expect(page.getByText(/^Rascunho v\d+ salvo\.$/)).toBeVisible({ timeout: 30_000 });

      await page.reload();
      await expect(page.getByRole("heading", { name: nome })).toBeVisible();
      await expect(page.getByTestId("skills-todas")).not.toBeChecked();
      await expect(page.getByTestId(idDaEscolhida)).toBeChecked();
      const marcadas = await page
        .getByTestId("skills-lista")
        .locator('input[type="checkbox"]:checked')
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      console.info(`[prova-skills] depois de recarregar marcadas=${JSON.stringify(marcadas)}`);
      expect(marcadas).toEqual([idDaEscolhida]);
      await page.getByTestId("agente-skills").scrollIntoViewIfNeeded();
      await foto(page, "skills-02-depois-de-recarregar");
    } finally {
      await page.request.delete(`/api/v1/ai/agents/${agentId}`);
    }
  });
});
