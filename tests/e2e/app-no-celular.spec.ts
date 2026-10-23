/**
 * O APP NO CELULAR, PELA TELA (ADR-0006, fase F1).
 *
 * O que esta bateria mede, e por que cada caso existe:
 *
 * 1. o manifest e os ícones que o Android e o iPhone pedem existem ANTES do
 *    login, nos tamanhos declarados — medidos no cabeçalho do PNG;
 * 2. o service worker nasce em todo /app sem a pessoa ter permitido avisos —
 *    é ele que responde quando a rede cai;
 * 3. navegação sem rede cai numa página neutra (sem dado nenhum do app) e o
 *    "Tentar de novo" devolve o app quando a rede volta;
 * 4. a tela de instalar diz o passo certo para cada aparelho, e em endereço
 *    sem conexão segura diz que NÃO há app, sem botão que não funciona;
 * 5. medidas por ferramenta: nada estoura a largura, o botão tem 44 px e o
 *    dedo no centro dele acerta ele mesmo;
 * 6. a tela tem porta: chega-se a ela a partir de Notificações.
 *
 * ⚠️ O QUE É EMULAÇÃO, DECLARADO. O CI roda Chromium de computador. Os
 * aparelhos são simulados pelo user agent; o pedido de instalação do Android é
 * um evento sintético; "sem https" e "aberto pelo ícone do iPhone" são
 * propriedades redefinidas antes de a página carregar. Isso prova a REGRA da
 * tela, não o aparelho: a prova em Android e iPhone reais é critério da ADR e
 * mora em `evidence/<data>-f1/`, fora do alcance do CI.
 *
 * O resto da suíte roda com service worker BLOQUEADO (`playwright.config.ts`);
 * esta spec libera, porque o SW é o assunto.
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), "evidence", "app-no-celular-20261020");
mkdirSync(EVIDENCIA, { recursive: true });

const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** O piso de alvo de toque, o mesmo de `celular-cabe-na-tela.spec.ts`. */
const PISO_DE_TOQUE = 44;

// Um login por arquivo: o seguinte esperaria a próxima janela do TOTP.
const SESSAO = `/tmp/e2e-sessao-app-no-celular-${process.pid}.json`;

test.describe.configure({ mode: "serial", timeout: 90_000 });
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  locale: "pt-BR",
  serviceWorkers: "allow",
  storageState: SESSAO,
});

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const contexto = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: undefined,
  });
  const page = await contexto.newPage();
  await loginComoAdmin(page, lerCreds());
  await contexto.storageState({ path: SESSAO });
  await contexto.close();
});

/** `body.scrollWidth` contra a janela — a régua de `celular-cabe-na-tela.spec.ts`. */
async function estouroHorizontal(page: Page): Promise<number> {
  return page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
}

async function abrirATela(page: Page): Promise<void> {
  await page.goto("/app/settings/aplicativo");
  await expect(page.getByRole("heading", { name: "App no celular" })).toBeVisible();
}

test("1. manifest, ícones e o ícone do iPhone existem antes do login", async ({ page }) => {
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.id).toBe("/app");
  expect(manifest.display).toBe("standalone");
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.theme_color).toBe(manifest.background_color);
  expect(manifest.icons[2].purpose).toBe("maskable");

  const lados: Array<[string, number]> = [
    ["/app-icon/192", 192],
    ["/app-icon/512", 512],
    ["/app-icon/maskable", 512],
    ["/app-icon/180", 180],
  ];
  for (const [caminho, lado] of lados) {
    const resposta = await page.request.get(caminho, { maxRedirects: 0 });
    expect(resposta.status(), caminho).toBe(200);
    const png = await resposta.body();
    expect(png.readUInt32BE(16), caminho).toBe(lado);
    expect(png.readUInt32BE(20), caminho).toBe(lado);
  }

  await page.goto("/login");
  const href = await page.locator('link[rel="apple-touch-icon"]').first().getAttribute("href");
  expect(new URL(href ?? "", "http://x").pathname).toBe("/app-icon/180");
});

test("2. o service worker nasce em todo /app, sem permissão de avisos", async ({ page }) => {
  await page.goto("/app/inbox");
  expect(await page.evaluate(() => Notification.permission)).not.toBe("granted");
  const script = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? "");
  expect(script).toMatch(/\/notify-sw\.js$/);
});

test("3. sem rede, a navegação cai na página neutra e volta com a rede", async ({ page, context }) => {
  await page.goto("/app/inbox");
  await expect(page.locator("[data-rodape-ocupado]")).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });

  await context.setOffline(true);
  try {
    const resposta = await page.goto("/app/inbox");
    expect(resposta?.status()).toBe(503);
    await expect(page.getByRole("heading", { name: "Sem conexão" })).toBeVisible();
    // Nada do app: nem a casca, nem dado de atendimento.
    await expect(page.locator("[data-rodape-ocupado]")).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "offline.png") });
  } finally {
    await context.setOffline(false);
  }
  await page.getByRole("button", { name: "Tentar de novo" }).click();
  await expect(page.locator("[data-rodape-ocupado]")).toBeVisible({ timeout: 30_000 });
});

test.describe("Android", () => {
  test.use({ userAgent: ANDROID });

  // A página é instalável (manifest + SW + localhost): um pedido VERDADEIRO do
  // Chromium mudaria o 4a para "botão" sem aviso. Só o evento sintético do 4b
  // (que não é `isTrusted`) chega ao app.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.addEventListener(
        "beforeinstallprompt",
        (evento) => {
          if (evento.isTrusted) evento.stopImmediatePropagation();
        },
        true,
      );
    });
  });

  test("4a. sem pedido do navegador, ensina pelo menu", async ({ page }) => {
    await abrirATela(page);
    await expect(page.getByTestId("app-android-menu")).toBeVisible();
    expect(await estouroHorizontal(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "android-menu.png") });
  });

  test("4b. com o pedido do navegador, há botão de 44 px que o abre", async ({ page }) => {
    await abrirATela(page);
    await expect(page.getByTestId("app-android-menu")).toBeVisible();
    // Evento sintético depois do load: o módulo que o captura já existe.
    await page.evaluate(() => {
      const janela = window as unknown as { __pedidos: number };
      janela.__pedidos = 0;
      const evento = new Event("beforeinstallprompt");
      Object.assign(evento, {
        prompt: () => {
          janela.__pedidos += 1;
          return Promise.resolve();
        },
      });
      window.dispatchEvent(evento);
    });
    const botao = page.getByRole("button", { name: "Instalar app" });
    await expect(page.getByTestId("app-android-botao")).toBeVisible();
    await expect(botao).toBeVisible();

    const medida = await botao.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const alvo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { altura: r.height, acerta: alvo !== null && (alvo === el || el.contains(alvo)) };
    });
    expect(medida.altura).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    expect(medida.acerta).toBe(true);
    expect(await estouroHorizontal(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "android-botao.png") });

    await botao.click();
    expect(await page.evaluate(() => (window as unknown as { __pedidos: number }).__pedidos)).toBe(1);
    // O pedido serve uma vez: depois do diálogo, volta o passo pelo menu.
    await expect(page.getByTestId("app-android-menu")).toBeVisible();
  });

  test("4c. [P0] sem conexão segura (emulado), diz que não há app e não oferece botão", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "isSecureContext", { get: () => false });
    });
    await abrirATela(page);
    await expect(page.getByTestId("app-sem-https")).toBeVisible();
    await expect(page.getByText("Esta instalação não tem app no celular.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Instalar/ })).toHaveCount(0);
    expect(await estouroHorizontal(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "sem-https.png") });
  });
});

test.describe("iPhone", () => {
  test.use({ userAgent: IPHONE });

  test("4d. passo a passo pelo Compartilhar, com o aviso do iOS 16.4", async ({ page }) => {
    await abrirATela(page);
    await expect(page.getByTestId("app-iphone")).toBeVisible();
    await expect(page.getByText(/iOS 16\.4 ou mais novo/)).toBeVisible();
    expect(await estouroHorizontal(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "iphone.png") });
  });

  test("4e. aberto pelo ícone (emulado), diz que já é o app", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "standalone", { get: () => true, configurable: true });
    });
    await abrirATela(page);
    await expect(page.getByTestId("app-instalado")).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCIA, "instalado.png") });
  });
});

test("6. a porta: de Notificações chega-se à tela", async ({ page }) => {
  await page.goto("/app/settings/notifications");
  await page.getByTestId("link-app-no-celular").click();
  await expect(page).toHaveURL(/\/app\/settings\/aplicativo$/);
  await expect(page.getByRole("heading", { name: "App no celular" })).toBeVisible();
});
