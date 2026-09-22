import { mkdir, rm, writeFile } from "node:fs/promises";

import { expect as expectBase, test, type Page, type TestInfo } from "@playwright/test";

import {
  criarAtoresDasExtensoes,
  criarCatalogoDeExtensoes,
  type AtoresDasExtensoes,
  type CatalogoDeExtensoes,
} from "./fixtures/catalogo-extensoes";
import {
  iniciarCatalogoInterrompido,
  type CatalogoInterrompido,
} from "./fixtures/catalogo-interrompido";

// Estas jornadas esperam, em quase toda asserção, DUAS idas reais ao servidor: a
// mutação e a recarga da lista que a tela faz antes de anunciar o resultado. Medido
// no trace da rodada de 15/set (load average entre 50 e 120): POST de admissão em
// 4,9 s e o GET seguinte ainda sem resposta aos 5 s — o prazo padrão do Playwright
// reprovava a tela certa. O prazo sobe só aqui; asserção de ausência que já é
// verdadeira continua passando na hora.
const expect = expectBase.configure({ timeout: 20_000 });

const EVIDENCE = ".superpowers/evidence/extensoes-integracao/e2e/recuperacao";
const CAPTURES = [
  "recuperacao-dark.png",
  "recuperacao-es-fallback.png",
  "recuperacao-cancelada.png",
  "recuperacao-interrompida.png",
] as const;

test.use({ trace: "on" });

let atores: AtoresDasExtensoes | undefined;
let catalogo: CatalogoDeExtensoes | undefined;
let receiver: CatalogoInterrompido | undefined;

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

async function trocarOrganizacao(page: Page, organizationId: string): Promise<void> {
  // O cabeçalho rola com a página. Com a gestão rolada até um card, o clique no avatar
  // exigia que o Playwright rolasse até ele, e a janela voltava à posição anterior com o
  // menu aberto: medido, item do seletor em y=-1410 com scrollY=1463. Quem usa sobe a
  // página antes de trocar de organização; a prova faz o mesmo.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByTestId("tenant-switcher").click();
  const item = page.getByTestId(`tenant-switcher-item-${organizationId}`);
  if ((await item.getByText("✓", { exact: true }).count()) > 0) {
    await page.keyboard.press("Escape");
    return;
  }
  // A troca é uma Server Action seguida de window.location.assign("/app/inbox"), um
  // documento NOVO. Esperar a URL não distingue o documento velho do novo: com a aba já
  // em /app/inbox a espera casava antes de a troca acontecer, e fechar a aba nessa hora
  // abortava a Server Action (medido no trace da rodada 4: POST /app/inbox cancelado e a
  // sessão presa na outra organização). O evento `load` só dispara no documento novo.
  const novoDocumento = page.waitForEvent("load", { timeout: 60_000 });
  await item.click({ noWaitAfter: true });
  await novoDocumento;
  await expect(page).toHaveURL(/\/app\/inbox(?:[?#]|$)/);
}

async function semOverflowHorizontal(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}

async function capturar(page: Page, testInfo: TestInfo, name: (typeof CAPTURES)[number]) {
  const path = `${EVIDENCE}/${name}`;
  await semOverflowHorizontal(page);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name.replace(/\.png$/, ""), { path, contentType: "image/png" });
}

async function contarInstalacoes(name: string): Promise<number> {
  const { count, error } = await atores!.db
    .from("extension_installations")
    .select("id", { count: "exact", head: true })
    .eq("publisher", catalogo!.pacote.publisher)
    .eq("name", name);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  await Promise.all(CAPTURES.map((name) => rm(`${EVIDENCE}/${name}`, { force: true })));
  atores = await criarAtoresDasExtensoes();
  catalogo = await criarCatalogoDeExtensoes(atores.db, EVIDENCE);
});

test.afterAll(async () => {
  await receiver?.encerrar();
  await catalogo?.limpar();
  await atores?.limpar();
});

test("recupera preparação em HTTP real e mantém tema, idioma e fallback legíveis", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const observar = (target: Page, label: string) => {
    target.on("pageerror", (error) => pageErrors.push(`${label}: ${error.message}`));
    target.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`${label}: ${message.text()}`);
    });
  };
  observar(page, "gestão principal");

  let catalogId = "";
  let receiptCancelado = "";
  let receiptInterrompido = "";

  await test.step("admite o catálogo real e registra tema escuro e fallback em espanhol", async () => {
    await login(page, atores!.usuarios.owner.email, atores!.senha);
    await page.goto("/app/extensions");
    await trocarOrganizacao(page, atores!.organizacaoA);
    await page.goto("/app/extensions");
    await expect(page.getByTestId("extension-catalog-admission")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("extension-catalog-file").setInputFiles(catalogo!.catalogo);
    await page.getByTestId("extension-catalog-submit").click();
    await expect(page.getByText("Catálogo admitido e disponível para instalação.")).toBeVisible();
    await page.getByRole("tab", { name: "Catálogo", exact: true }).click();
    await expect(
      page.getByTestId(
        `extension-install-${catalogo!.pacote.publisher}-${catalogo!.pacote.name}-${catalogo!.pacote.version}`,
      ),
    ).toBeVisible();

    const { data, error } = await atores!.db
      .from("extension_catalogs")
      .select("id")
      .eq("origin", catalogo!.origem)
      .single();
    if (error) throw new Error(error.message);
    catalogId = data.id as string;

    const theme = page.getByRole("button", { name: /^Tema:/ });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await theme.getAttribute("aria-label"))?.includes("Tema: dark")) break;
      await theme.click();
    }
    await expect(theme).toHaveAttribute("aria-label", /Tema: dark/);
    // O produto marca o tema no atributo (lib/theme.tsx: setAttribute("data-theme")), não em classe.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capturar(page, testInfo, "recuperacao-dark.png");

    await page.getByTestId("seletor-de-idioma").click();
    const reloadEs = page.waitForEvent("load");
    await page.getByTestId("idioma-es").click();
    await reloadEs;
    await expect(page.getByTestId("seletor-de-idioma")).toHaveText("ES");
    await expect(page.getByRole("heading", { name: "Extensiones", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Catálogo", exact: true }).click();
    await expect(page.getByText("Texto disponible en portugués.").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Instalar versión revisada", exact: true }).first(),
    ).toBeVisible();
    await capturar(page, testInfo, "recuperacao-es-fallback.png");

    await page.getByTestId("seletor-de-idioma").click();
    const reloadPt = page.waitForEvent("load");
    await page.getByTestId("idioma-pt-BR").click();
    await reloadPt;
    await expect(page.getByTestId("seletor-de-idioma")).toHaveText("PT");
    await expect(page.getByRole("heading", { name: "Extensões", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Catálogo", exact: true }).click();
  });

  await test.step("cancela em outra aba enquanto o download continua aberto", async () => {
    await catalogo!.desligar();
    receiver = await iniciarCatalogoInterrompido(catalogo!);

    const pedido = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().endsWith("/api/v1/extensions/install"),
    );
    const respostaDaInstalacao = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/extensions/install"),
    );
    await page
      .getByTestId(
        `extension-install-${catalogo!.pacote.publisher}-${catalogo!.pacote.name}-${catalogo!.pacote.version}`,
      )
      .click();
    receiptCancelado = (await pedido).headers()["idempotency-key"] ?? "";
    expect(receiptCancelado).toMatch(/^[0-9a-f-]{36}$/);
    await receiver!.esperarDownloadPausado();
    expect(receiver!.downloadPausadoContinuaAberto()).toBe(true);
    await expect(page.getByTestId(`extension-local-receipt-${receiptCancelado}`)).toBeVisible();

    await expect
      .poll(async () => {
        const { data } = await atores!.db
          .from("extension_operations")
          .select("status")
          .eq("id", receiptCancelado)
          .maybeSingle();
        return data?.status;
      })
      .toBe("preparing");

    const abaCancelamento = await page.context().newPage();
    observar(abaCancelamento, "cancelamento em outra aba");
    await abaCancelamento.goto("/app/extensions");
    const operacao = abaCancelamento.getByTestId(`extension-operation-${receiptCancelado}`);
    await expect(operacao).toContainText("Preparando", { timeout: 30_000 });
    const respostaDoCancelamento = abaCancelamento.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/v1/extensions/operations/${receiptCancelado}/cancel`),
    );
    await abaCancelamento.getByTestId(`extension-operation-cancel-${receiptCancelado}`).click();
    const cancelada = await respostaDoCancelamento;
    expect(cancelada.status()).toBe(200);
    expect((await cancelada.json()) as unknown).toMatchObject({
      data: { id: receiptCancelado, status: "cancelled" },
    });
    expect(receiver!.downloadPausadoContinuaAberto()).toBe(true);
    expect(receiver!.estatisticas().downloadPausadoFinalizado).toBe(false);
    await expect(operacao).toContainText("Cancelada");
    await expect(
      abaCancelamento.getByText("Preparação cancelada. Este pedido não instalará a extensão."),
    ).toBeVisible();

    receiver!.liberarDownloadPausado();
    const conclusaoTardia = await respostaDaInstalacao;
    expect(conclusaoTardia.status()).toBe(200);
    expect((await conclusaoTardia.json()) as unknown).toMatchObject({
      data: { id: receiptCancelado, status: "cancelled", installation_id: null },
    });
    await expect(page.getByTestId(`extension-local-receipt-${receiptCancelado}`)).toHaveCount(0);
    await expect.poll(() => contarInstalacoes(catalogo!.pacote.name)).toBe(0);
    await capturar(abaCancelamento, testInfo, "recuperacao-cancelada.png");
    await abaCancelamento.close();
  });

  await test.step("socket interrompido falha visivelmente e oferece uma nova tentativa", async () => {
    const pedido = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().endsWith("/api/v1/extensions/install"),
    );
    const respostaDaInstalacao = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/extensions/install"),
    );
    await page
      .getByTestId(
        `extension-install-${catalogo!.pacote.publisher}-${catalogo!.pacoteAlterado.name}-${catalogo!.pacote.version}`,
      )
      .click();
    receiptInterrompido = (await pedido).headers()["idempotency-key"] ?? "";
    expect(receiptInterrompido).toMatch(/^[0-9a-f-]{36}$/);
    await receiver!.esperarSocketInterrompido();
    const falha = await respostaDaInstalacao;
    expect(falha.status()).toBe(200);
    expect((await falha.json()) as unknown).toMatchObject({
      data: {
        id: receiptInterrompido,
        status: "failed",
        installation_id: null,
        error_code: "extension_download_failed",
      },
    });

    const operacao = page.getByTestId(`extension-operation-${receiptInterrompido}`);
    await expect(operacao).toContainText("Falhou", { timeout: 30_000 });
    await expect(operacao).toContainText("Não foi possível baixar o pacote de extensão.");
    await expect(operacao).toContainText("tente a instalação novamente");
    await expect(page.getByTestId(`extension-local-receipt-${receiptInterrompido}`)).toHaveCount(0);
    await expect(
      page.getByTestId(
        `extension-install-${catalogo!.pacote.publisher}-${catalogo!.pacoteAlterado.name}-${catalogo!.pacote.version}`,
      ),
    ).toBeEnabled();
    await expect.poll(() => contarInstalacoes(catalogo!.pacoteAlterado.name)).toBe(0);
    expect(receiver!.estatisticas()).toMatchObject({
      downloadPausadoFinalizado: true,
      socketsInterrompidos: 1,
    });
    expect(receiver!.estatisticas().bytesInterrompidosEnviados).toBeGreaterThan(0);
    await capturar(page, testInfo, "recuperacao-interrompida.png");
  });

  const { data: operacoes, error: erroOperacoes } = await atores!.db
    .from("extension_operations")
    .select("id,status,error_code,installation_id")
    .in("id", [receiptCancelado, receiptInterrompido])
    .order("id");
  if (erroOperacoes) throw new Error(erroOperacoes.message);
  expect(operacoes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: receiptCancelado,
        status: "cancelled",
        installation_id: null,
      }),
      expect.objectContaining({
        id: receiptInterrompido,
        status: "failed",
        error_code: "extension_download_failed",
        installation_id: null,
      }),
    ]),
  );
  const recoveryEvidence = `${EVIDENCE}/recovery-http.json`;
  await writeFile(
    recoveryEvidence,
    `${JSON.stringify(
      {
        catalog_id: catalogId,
        cancelled_receipt: receiptCancelado,
        interrupted_receipt: receiptInterrompido,
        receiver: receiver!.estatisticas(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await testInfo.attach("recovery-http", {
    path: recoveryEvidence,
    contentType: "application/json",
  });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
