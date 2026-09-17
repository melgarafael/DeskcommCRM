import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";

import {
  expect as expectBase,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

import {
  criarAtoresDasExtensoes,
  criarCatalogoDeExtensoes,
  type AtoresDasExtensoes,
  type CatalogoDeExtensoes,
} from "./fixtures/catalogo-extensoes";

// Estas jornadas esperam, em quase toda asserção, DUAS idas reais ao servidor: a
// mutação e a recarga da lista que a tela faz antes de anunciar o resultado. Medido
// no trace da rodada de 15/set (load average entre 50 e 120): POST de admissão em
// 4,9 s e o GET seguinte ainda sem resposta aos 5 s — o prazo padrão do Playwright
// reprovava a tela certa. O prazo sobe só aqui; asserção de ausência que já é
// verdadeira continua passando na hora.
const expect = expectBase.configure({ timeout: 20_000 });

const EVIDENCE = ".superpowers/evidence/extensoes-integracao/e2e";
const EXPECTED_ORGANIZATION_HEADER = "X-Expected-Organization-Id";
const SCREENSHOTS = [
  { name: "extension-install-failure", path: `${EVIDENCE}/falha.png` },
  { name: "extensions-desktop", path: `${EVIDENCE}/desktop.png` },
  { name: "extensions-mobile-390", path: `${EVIDENCE}/mobile.png` },
  { name: "extension-guide", path: `${EVIDENCE}/guia.png` },
] as const;
const BROWSER_OBSERVATIONS = `${EVIDENCE}/browser-observations.json`;

test.use({ trace: "on" });

let atores: AtoresDasExtensoes | undefined;
let catalogo: CatalogoDeExtensoes | undefined;
const contextosExtras: BrowserContext[] = [];

type ObservacoesBrowser = {
  pageErrors: string[];
  consoleErrors: Array<{ page: string; text: string; url: string }>;
  httpRejections: Array<{
    step: string;
    method: string;
    status: number;
    url: string;
  }>;
  networkFailures: Array<{
    step: string;
    method: string;
    errorText: string;
    url: string;
  }>;
};

let observacoesAtuais: ObservacoesBrowser | undefined;

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
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

function observarErros(page: Page, rotulo: string, observacoes: ObservacoesBrowser): void {
  page.on("pageerror", (error) =>
    observacoes.pageErrors.push(`${rotulo}: pageerror: ${error.message}`),
  );
  page.on("console", (message) => {
    if (message.type() === "error") {
      observacoes.consoleErrors.push({
        page: rotulo,
        text: message.text(),
        url: message.location().url,
      });
    }
  });
}

async function registrarRecusaHttp(
  observacoes: ObservacoesBrowser,
  step: string,
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status()).toBe(status);
  expect((await response.json()) as unknown).toMatchObject({ error: { code } });
  observacoes.httpRejections.push({
    step,
    method: response.request().method(),
    status,
    url: response.url(),
  });
}

function registrarFalhaDeRede(
  observacoes: ObservacoesBrowser,
  step: string,
  request: Request,
): void {
  const errorText = request.failure()?.errorText ?? "";
  expect(errorText).toContain("net::ERR_FAILED");
  observacoes.networkFailures.push({
    step,
    method: request.method(),
    errorText,
    url: request.url(),
  });
}

function errosDeConsoleInesperados(observacoes: ObservacoesBrowser) {
  return observacoes.consoleErrors.filter((error) => {
    const isKnownHttpRejection = observacoes.httpRejections.some(
      (rejection) =>
        rejection.url === error.url &&
        error.text.includes("Failed to load resource") &&
        error.text.includes(String(rejection.status)),
    );
    const isKnownNetworkFailure = observacoes.networkFailures.some(
      (failure) =>
        failure.url === error.url &&
        error.text.includes("Failed to load resource") &&
        error.text.includes("net::ERR_FAILED"),
    );
    return !isKnownHttpRejection && !isKnownNetworkFailure;
  });
}

async function paginaAutenticada(
  browser: Browser,
  email: string,
  senha: string,
  rotulo: string,
  observacoes: ObservacoesBrowser,
): Promise<Page> {
  const contexto = await browser.newContext();
  contextosExtras.push(contexto);
  const page = await contexto.newPage();
  observarErros(page, rotulo, observacoes);
  await login(page, email, senha);
  return page;
}

async function quantidadeDeOperacoes(actorId: string): Promise<number> {
  const { count, error } = await atores!.db
    .from("extension_operations")
    .select("id", { count: "exact", head: true })
    .eq("actor_id", actorId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function provarPapelSemGestao(
  browser: Browser,
  usuario: { id: string; email: string },
  rotulo: string,
  installationId: string,
  catalogId: string,
  observacoes: ObservacoesBrowser,
): Promise<void> {
  const page = await paginaAutenticada(browser, usuario.email, atores!.senha, rotulo, observacoes);
  await page.goto("/app/extensions");
  await expect(page.getByTestId("extensions-manager")).toBeVisible();
  await expect(page.getByTestId(`extension-installed-${installationId}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("extension-catalog-admission")).toHaveCount(0);
  await expect(page.getByTestId(`extension-save-${installationId}`)).toHaveCount(0);
  await page.getByRole("tab", { name: "Catálogo" }).click();
  await expect(
    page.getByTestId(
      `extension-catalog-${catalogo!.pacote.publisher}-${catalogo!.pacote.name}-${catalogo!.pacote.version}`,
    ),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByTestId(
      `extension-install-${catalogo!.pacote.publisher}-${catalogo!.pacote.name}-${catalogo!.pacote.version}`,
    ),
  ).toHaveCount(0);

  const antes = await quantidadeDeOperacoes(usuario.id);
  const admissao = await page.request.post("/api/v1/extensions/catalogs", {
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    data: catalogo!.pacote.bytes,
  });
  expect(admissao.status()).toBe(403);
  const instalacao = await page.request.post("/api/v1/extensions/install", {
    headers: { "Idempotency-Key": randomUUID() },
    data: {
      catalog_id: catalogId,
      publisher: catalogo!.pacote.publisher,
      name: catalogo!.pacote.name,
      version: catalogo!.pacote.version,
    },
  });
  expect(instalacao.status()).toBe(403);
  const configuracao = await page.request.put(
    `/api/v1/extensions/${installationId}/configuration`,
    {
      headers: {
        "Idempotency-Key": randomUUID(),
        [EXPECTED_ORGANIZATION_HEADER]: atores!.organizacaoA,
      },
      data: {
        expected_revision: 0,
        enabled: true,
        configuration: { density: "compact", show_description: false },
      },
    },
  );
  expect(configuracao.status()).toBe(403);
  expect(await quantidadeDeOperacoes(usuario.id)).toBe(antes);
}

async function semOverflowHorizontal(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  await Promise.all(SCREENSHOTS.map((screenshot) => rm(screenshot.path, { force: true })));
  atores = await criarAtoresDasExtensoes();
  catalogo = await criarCatalogoDeExtensoes(atores.db, EVIDENCE);
});

test.afterAll(async () => {
  for (const contexto of contextosExtras) await contexto.close();
  await catalogo?.limpar();
  await atores?.limpar();
});

test.afterEach(async ({}, testInfo) => {
  if (!observacoesAtuais) return;
  await writeFile(BROWSER_OBSERVATIONS, `${JSON.stringify(observacoesAtuais, null, 2)}\n`, "utf8");
  await testInfo.attach("browser-observations", {
    path: BROWSER_OBSERVATIONS,
    contentType: "application/json",
  });
  for (const screenshot of SCREENSHOTS) {
    try {
      await access(screenshot.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await testInfo.attach(screenshot.name, {
      path: screenshot.path,
      contentType: "image/png",
    });
  }
});

test("pacote pós-build atravessa catálogo, tenants, guia e Tarefas com recuperação real", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const observacoes: ObservacoesBrowser = {
    pageErrors: [],
    consoleErrors: [],
    httpRejections: [],
    networkFailures: [],
  };
  observacoesAtuais = observacoes;
  observarErros(page, "owner", observacoes);

  let catalogId = "";
  let installationId = "";
  let staleGuide: Page | undefined;
  let managerPage: Page | undefined;
  const taskTitle = `Retorno da extensão ${randomUUID().slice(0, 8)}`;

  await test.step("admite pela UI o arquivo exportado pelo CLI", async () => {
    expect(catalogo!.manifestoMtimeMs).toBeGreaterThan(catalogo!.buildMtimeMs);
    expect(catalogo!.digestCatalogo).toMatch(/^[a-f0-9]{64}$/);
    expect(catalogo!.publicadoEm).toBeTruthy();
    expect(catalogo!.estaLigado()).toBe(true);

    await login(page, atores!.usuarios.owner.email, atores!.senha);
    await page.goto("/app/extensions");
    await trocarOrganizacao(page, atores!.organizacaoA);
    await page.goto("/app/extensions");
    await expect(page.getByTestId("extension-catalog-admission")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("extension-catalog-file").setInputFiles(catalogo!.catalogo);
    await expect(page.getByTestId("extension-catalog-submit")).toBeVisible();
    await page.getByTestId("extension-catalog-submit").click();
    await expect(page.getByText("Catálogo admitido e disponível para instalação.")).toBeVisible();
    await page.getByRole("tab", { name: "Catálogo" }).click();
    await expect(
      page.getByTestId(
        `extension-catalog-${catalogo!.pacote.publisher}-${catalogo!.pacote.name}-${catalogo!.pacote.version}`,
      ),
    ).toBeVisible();

    const { data, error } = await atores!.db
      .from("extension_catalogs")
      .select("id,digest,revision,admitted_at")
      .eq("origin", catalogo!.origem)
      .single();
    if (error) throw new Error(error.message);
    catalogId = data.id as string;
    expect(data.digest).toBe(catalogo!.digestCatalogo);
    expect(data.revision).toBe(catalogo!.revisao);
    expect(new Date(data.admitted_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(catalogo!.publicadoEm).getTime(),
    );
  });

  await test.step("recusa pelo HTTP real um pacote cujo corpo mudou", async () => {
    await page
      .getByTestId(
        `extension-install-${catalogo!.pacote.publisher}-${catalogo!.pacoteAlterado.name}-${catalogo!.pacote.version}`,
      )
      .click();

    const operacao = page
      .locator('[data-testid^="extension-operation-"]')
      .filter({ hasText: catalogo!.pacoteAlterado.name });
    await expect(operacao).toContainText("Falhou");
    await expect(operacao).toContainText(/não corresponde|integridade/i);
    await page.screenshot({ path: `${EVIDENCE}/falha.png`, fullPage: true });

    const { count, error } = await atores!.db
      .from("extension_installations")
      .select("id", { count: "exact", head: true })
      .eq("publisher", catalogo!.pacote.publisher)
      .eq("name", catalogo!.pacoteAlterado.name);
    if (error) throw new Error(error.message);
    expect(count).toBe(0);

    const { data: receipt, error: receiptError } = await atores!.db
      .from("extension_operations")
      .select("status,error_code,installation_id")
      .eq("publisher", catalogo!.pacote.publisher)
      .eq("name", catalogo!.pacoteAlterado.name)
      .single();
    if (receiptError) throw new Error(receiptError.message);
    expect(receipt).toMatchObject({
      status: "failed",
      error_code: "extension_digest_mismatch",
      installation_id: null,
    });
  });

  await test.step("armazenamento indisponível bloqueia o pedido antes do POST", async () => {
    const chavesAntes = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((key) => key.startsWith("extensions:pending:v2:")),
    );
    let postsDoPacote = 0;
    const contarPost = (request: Request) => {
      if (request.method() !== "POST" || !request.url().endsWith("/api/v1/extensions/install")) {
        return;
      }
      const body = request.postDataJSON() as { name?: string };
      if (body.name === catalogo!.pacote.name) postsDoPacote += 1;
    };
    page.on("request", contarPost);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Object.defineProperty(window, "__extensionsOriginalStorageSetItem", {
        configurable: true,
        value: original,
      });
      Storage.prototype.setItem = function setItemComFalhaRestrita(key, value) {
        if (key.startsWith("extensions:pending:v2:")) {
          throw new DOMException("Falha de armazenamento injetada pelo E2E", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });

    await page
      .getByTestId(
        `extension-install-${catalogo!.pacote.publisher}-${catalogo!.pacote.name}-${catalogo!.pacote.version}`,
      )
      .click();
    await expect(page.getByText("Os pedidos estão bloqueados neste navegador")).toBeVisible();
    await expect(
      page.getByText(/Este navegador não conseguiu guardar o recibo/).first(),
    ).toBeVisible();
    expect(postsDoPacote).toBe(0);
    const chavesDepois = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((key) => key.startsWith("extensions:pending:v2:")),
    );
    expect(chavesDepois).toEqual(chavesAntes);
    const { count, error } = await atores!.db
      .from("extension_operations")
      .select("id", { count: "exact", head: true })
      .eq("publisher", catalogo!.pacote.publisher)
      .eq("name", catalogo!.pacote.name);
    if (error) throw new Error(error.message);
    expect(count).toBe(0);

    await page.evaluate(() => {
      const target = window as typeof window & {
        __extensionsOriginalStorageSetItem?: typeof Storage.prototype.setItem;
      };
      const original = target.__extensionsOriginalStorageSetItem;
      if (!original) throw new Error("O Storage original não foi preservado.");
      Storage.prototype.setItem = original;
      delete target.__extensionsOriginalStorageSetItem;
    });
    page.off("request", contarPost);
    await page.reload();
    await page.getByRole("tab", { name: "Catálogo" }).click();
    await expect(
      page.getByTestId(
        `extension-install-${catalogo!.pacote.publisher}-${catalogo!.pacote.name}-${catalogo!.pacote.version}`,
      ),
    ).toBeEnabled({ timeout: 30_000 });
  });

  await test.step("perde a resposta do app depois do commit e reconcilia o mesmo recibo", async () => {
    type RespostaDaInstalacao = {
      data?: { id?: string; status?: string; installation_id?: string };
    };
    let respostaRealJson = "";
    let receiptId = "";
    let postsDoPacote = 0;
    const contarPostsDoPacote = (request: Request) => {
      if (request.method() !== "POST" || !request.url().endsWith("/api/v1/extensions/install")) {
        return;
      }
      const body = request.postDataJSON() as { name?: string };
      if (body.name === catalogo!.pacote.name) postsDoPacote += 1;
    };
    page.context().on("request", contarPostsDoPacote);
    await page.route("**/api/v1/extensions/install", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON() as { name?: string };
      if (body.name !== catalogo!.pacote.name) return route.continue();
      receiptId = route.request().headers()["idempotency-key"] ?? "";
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      respostaRealJson = JSON.stringify(await committed.json());
      await route.abort("failed");
    });

    const falhaEntregueAoNavegador = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        request.method() === "POST" && request.url().endsWith("/api/v1/extensions/install"),
    });
    await page
      .getByTestId(
        `extension-install-${catalogo!.pacote.publisher}-${catalogo!.pacote.name}-${catalogo!.pacote.version}`,
      )
      .click();
    registrarFalhaDeRede(
      observacoes,
      "resposta perdida depois do commit",
      await falhaEntregueAoNavegador,
    );
    await expect(page.getByText(/A conexão caiu sem confirmação/)).toBeVisible();
    await expect.poll(() => receiptId).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(() => respostaRealJson).not.toBe("");
    const respostaReal = JSON.parse(respostaRealJson) as RespostaDaInstalacao;
    expect(respostaReal?.data?.status).toBe("completed");
    expect(respostaReal?.data?.id).toBe(receiptId);
    await expect(page.getByTestId(`extension-local-receipt-${receiptId}`)).toBeVisible();
    const reciboPersistido = await page.evaluate(
      ({ actorId, organizationId, id }) => {
        const key = `extensions:pending:v2:${actorId}:${organizationId}:${id}`;
        const raw = window.localStorage.getItem(key);
        return raw ? { key, value: JSON.parse(raw) as unknown } : null;
      },
      {
        actorId: atores!.usuarios.owner.id,
        organizationId: atores!.organizacaoA,
        id: receiptId,
      },
    );
    expect(reciboPersistido).toMatchObject({
      key: `extensions:pending:v2:${atores!.usuarios.owner.id}:${atores!.organizacaoA}:${receiptId}`,
      value: { id: receiptId, kind: "install" },
    });
    await page.unroute("**/api/v1/extensions/install");

    const reconciliacao = await page.context().newPage();
    observarErros(reconciliacao, "reconciliação do recibo", observacoes);
    await reconciliacao.goto("/app/extensions");
    await expect(reconciliacao.getByTestId(`extension-operation-${receiptId}`)).toContainText(
      "Concluída",
      { timeout: 30_000 },
    );
    await expect(reconciliacao.getByTestId(`extension-local-receipt-${receiptId}`)).toHaveCount(0);
    await page.bringToFront();
    await expect(page.getByTestId(`extension-local-receipt-${receiptId}`)).toHaveCount(0);
    await expect(page.getByText(/A conexão caiu sem confirmação/)).toHaveCount(0);
    expect(postsDoPacote).toBe(1);
    page.context().off("request", contarPostsDoPacote);
    await reconciliacao.close();

    await expect
      .poll(async () => {
        const { count, error } = await atores!.db
          .from("extension_installations")
          .select("id", { count: "exact", head: true })
          .eq("publisher", catalogo!.pacote.publisher)
          .eq("name", catalogo!.pacote.name);
        if (error) throw new Error(error.message);
        return count;
      })
      .toBe(1);

    const { data: instalada, error: erroInstalada } = await atores!.db
      .from("extension_installations")
      .select("id,artifact_id,installed_at")
      .eq("publisher", catalogo!.pacote.publisher)
      .eq("name", catalogo!.pacote.name)
      .single();
    if (erroInstalada) throw new Error(erroInstalada.message);
    installationId = instalada.id as string;
    expect(respostaReal?.data?.installation_id).toBe(installationId);
    expect(new Date(instalada.installed_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(catalogo!.publicadoEm).getTime(),
    );

    const { data: artefato, error: erroArtefato } = await atores!.db
      .from("extension_artifacts")
      .select("sha256,byte_length,document")
      .eq("id", instalada.artifact_id)
      .single();
    if (erroArtefato) throw new Error(erroArtefato.message);
    expect(artefato.sha256).toBe(catalogo!.pacote.digest);
    expect(Buffer.byteLength(artefato.document as string, "utf8")).toBe(
      catalogo!.pacote.bytes.byteLength,
    );
    expect(
      createHash("sha256")
        .update(artefato.document as string)
        .digest("hex"),
    ).toBe(catalogo!.pacote.digest);

    await page.getByRole("tab", { name: "Instaladas" }).click();
    await expect(page.getByTestId(`extension-installed-${installationId}`)).toBeVisible();
  });

  await test.step("papéis sem gestão não recebem controles nem criam operação por POST", async () => {
    await provarPapelSemGestao(
      browser,
      atores!.usuarios.agentA,
      "agent A",
      installationId,
      catalogId,
      observacoes,
    );
    await provarPapelSemGestao(
      browser,
      atores!.usuarios.viewerA,
      "viewer A",
      installationId,
      catalogId,
      observacoes,
    );
  });

  await test.step("configura compacta, sem descrição, ativa em A e mede desktop/mobile", async () => {
    const enabled = page.getByTestId(`extension-enabled-${installationId}`);
    const description = page.getByTestId(`extension-description-${installationId}`);
    await expect(enabled).toHaveAttribute("data-state", "unchecked");
    await enabled.click();
    await page.getByTestId(`extension-density-${installationId}`).click();
    await page.getByRole("option", { name: "Compacta", exact: true }).click();
    await expect(description).toHaveAttribute("data-state", "checked");
    await description.click();
    await page.getByTestId(`extension-save-${installationId}`).click();
    await expect(page.getByText("Configuração salva.", { exact: true })).toBeVisible();

    await expect
      .poll(async () => {
        const { data } = await atores!.db
          .from("organization_extensions")
          .select("enabled,configuration,revision")
          .eq("organization_id", atores!.organizacaoA)
          .eq("installation_id", installationId)
          .maybeSingle();
        return data;
      })
      .toMatchObject({
        enabled: true,
        configuration: { density: "compact", show_description: false },
        revision: 1,
      });

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId(`extension-save-${installationId}`)).toBeVisible();
    await semOverflowHorizontal(page);
    await page.screenshot({ path: `${EVIDENCE}/desktop.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId(`extension-installed-${installationId}`).scrollIntoViewIfNeeded();
    await expect(page.getByTestId(`extension-enabled-${installationId}`)).toBeVisible();
    await expect(page.getByTestId(`extension-save-${installationId}`)).toBeVisible();
    await semOverflowHorizontal(page);
    await page.screenshot({ path: `${EVIDENCE}/mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await test.step("uma aba antiga de A não grava em B depois da troca de organização", async () => {
    const abaTroca = await page.context().newPage();
    observarErros(abaTroca, "troca concorrente", observacoes);
    await abaTroca.goto("/app/extensions");
    await expect(abaTroca.getByTestId(`extension-installed-${installationId}`)).toBeVisible({
      timeout: 30_000,
    });
    await trocarOrganizacao(abaTroca, atores!.organizacaoB);

    const description = page.getByTestId(`extension-description-${installationId}`);
    await expect(description).toHaveAttribute("data-state", "unchecked");
    await description.click();
    const respostaPendente = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith(`/api/v1/extensions/${installationId}/configuration`),
    );
    const recargaDoContexto = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().endsWith("/api/v1/extensions") &&
        response.request().headers()[EXPECTED_ORGANIZATION_HEADER.toLowerCase()] ===
          atores!.organizacaoB &&
        response.status() === 200,
    );
    await page.getByTestId(`extension-save-${installationId}`).click();
    const resposta = await respostaPendente;
    expect(resposta.request().headers()[EXPECTED_ORGANIZATION_HEADER.toLowerCase()]).toBe(
      atores!.organizacaoA,
    );
    await registrarRecusaHttp(
      observacoes,
      "salvamento da aba A depois da troca para B",
      resposta,
      409,
      "extension_context_changed",
    );
    await recargaDoContexto;

    await expect(page.getByTestId("extensions-manager")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("tenant-switcher").click();
    await expect(
      page
        .getByTestId(`tenant-switcher-item-${atores!.organizacaoB}`)
        .getByText("✓", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");

    const { count: bindingsB, error: erroBindingsB } = await atores!.db
      .from("organization_extensions")
      .select("installation_id", { count: "exact", head: true })
      .eq("organization_id", atores!.organizacaoB)
      .eq("installation_id", installationId);
    if (erroBindingsB) throw new Error(erroBindingsB.message);
    expect(bindingsB).toBe(0);

    const { data: bindingA, error: erroBindingA } = await atores!.db
      .from("organization_extensions")
      .select("enabled,configuration,revision")
      .eq("organization_id", atores!.organizacaoA)
      .eq("installation_id", installationId)
      .single();
    if (erroBindingA) throw new Error(erroBindingA.message);
    expect(bindingA).toMatchObject({
      enabled: true,
      configuration: { density: "compact", show_description: false },
      revision: 1,
    });

    await trocarOrganizacao(abaTroca, atores!.organizacaoA);
    await abaTroca.close();
    await page.reload();
    await expect(page.getByTestId(`extension-enabled-${installationId}`)).toHaveAttribute(
      "data-state",
      "checked",
    );
    await expect(page.getByTestId(`extension-description-${installationId}`)).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  await test.step("B não recebe card nem acesso direto", async () => {
    const adminB = await paginaAutenticada(
      browser,
      atores!.usuarios.adminB.email,
      atores!.senha,
      "admin B",
      observacoes,
    );
    await adminB.goto("/app/crm");
    await expect(
      adminB.getByTestId(`extension-contribution-${installationId}-${catalogo!.pacote.cardId}`),
    ).toHaveCount(0);
    const resposta = await adminB.request.get(`/api/v1/extensions/${installationId}`, {
      headers: { [EXPECTED_ORGANIZATION_HEADER]: atores!.organizacaoB },
    });
    expect(resposta.status()).toBe(404);
    expect((await resposta.json()) as unknown).toMatchObject({ error: { code: "extension_inactive" } });
    const recusaDoGuiaB = adminB.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().endsWith(`/api/v1/extensions/${installationId}`),
    );
    await adminB.goto(
      `/app/extensions/${installationId}?card=${encodeURIComponent(catalogo!.pacote.cardId)}`,
    );
    await registrarRecusaHttp(
      observacoes,
      "guia direto sem vínculo em B",
      await recusaDoGuiaB,
      404,
      "extension_inactive",
    );
    await expect(adminB.getByTestId("extension-guide-unavailable")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      adminB.getByRole("heading", { name: "Este guia não está disponível", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(adminB.getByText(/desativada nesta organização/i)).toBeVisible();

    const { data, error } = await atores!.db
      .from("organization_extensions")
      .select("organization_id")
      .eq("organization_id", atores!.organizacaoB)
      .eq("installation_id", installationId);
    if (error) throw new Error(error.message);
    expect(data).toEqual([]);

    // O recibo de configuração de A é lido com service role e filtro MANUAL de organização
    // (readExtensionOperation). Nenhum outro teste mede esse filtro: B, com o UUID em mãos,
    // não lê o recibo nem o vê no histórico da própria gestão.
    const { data: reciboDeA, error: erroRecibo } = await atores!.db
      .from("extension_operations")
      .select("id")
      .eq("organization_id", atores!.organizacaoA)
      .eq("kind", "configure")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (erroRecibo) throw new Error(erroRecibo.message);
    const leituraCruzada = await adminB.request.get(
      `/api/v1/extensions/operations/${reciboDeA.id}`,
      { headers: { [EXPECTED_ORGANIZATION_HEADER]: atores!.organizacaoB } },
    );
    expect(leituraCruzada.status()).toBe(404);
    expect((await leituraCruzada.json()) as unknown).toMatchObject({
      error: { code: "extension_operation_not_found" },
    });
    await adminB.goto("/app/extensions");
    // Espera a lista carregada (a instalação é da instância e aparece para B desativada)
    // antes de afirmar ausência — senão a ausência seria só a tela ainda vazia.
    await expect(adminB.getByTestId(`extension-installed-${installationId}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(adminB.getByTestId(`extension-operation-${reciboDeA.id}`)).toHaveCount(0);
  });

  await test.step("catálogo fora do ar não impede guia local e tarefa em A", async () => {
    await catalogo!.desligar();
    expect(catalogo!.estaLigado()).toBe(false);
    await expect(
      fetch(`${catalogo!.origem}/packages/${catalogo!.pacote.digest}.json`, {
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow();

    await page.goto("/app/crm");
    const contribution = page.getByTestId(
      `extension-contribution-${installationId}-${catalogo!.pacote.cardId}`,
    );
    await expect(contribution).toBeVisible();
    await expect(contribution.getByText(catalogo!.pacote.cardTitle, { exact: true })).toBeVisible();
    await expect(
      contribution.getByText(catalogo!.pacote.cardDescription, { exact: true }),
    ).toHaveCount(0);
    // O Card deste repositório não carrega `data-slot` (components/ui/card.tsx): o card é o
    // filho direto do link da contribuição (components/shell/NavHub.tsx). O seletor antigo
    // nunca casava e a medição esperava até estourar o prazo do teste inteiro.
    const padding = await contribution
      .locator(":scope > div")
      .first()
      .evaluate((element) => getComputedStyle(element).paddingTop, undefined, {
        timeout: 20_000,
      });
    expect(padding).toBe("12px");
    await contribution.click();
    await expect(page.getByTestId("extension-guide")).toBeVisible();
    await expect(page.getByTestId(`extension-guide-card-${catalogo!.pacote.cardId}`)).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/guia.png`, fullPage: true });

    staleGuide = await page.context().newPage();
    observarErros(staleGuide, "guia antigo", observacoes);
    await staleGuide.goto(page.url());
    await expect(staleGuide.getByTestId("extension-guide")).toBeVisible();

    const openTasks = page.getByTestId(`extension-open-${catalogo!.pacote.cardId}`);
    await expect(openTasks).toBeVisible();
    await openTasks.focus();
    await expect(openTasks).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/app/tasks");
    await expect(page.getByRole("heading", { name: "Tarefas", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Nova tarefa", exact: true }).click();
    await page.getByLabel("O que precisa ser feito").fill(taskTitle);
    await page.getByLabel("Detalhes").fill(`Criada pelo guia ${catalogo!.pacote.title}`);
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();
    const linha = page.locator("div.group", {
      has: page.getByText(taskTitle, { exact: true }),
    });
    await linha.getByRole("checkbox", { name: "Marcar como concluída" }).click();
    await expect(page.getByText(taskTitle, { exact: true })).toHaveCount(0);

    await expect
      .poll(async () => {
        const { data } = await atores!.db
          .from("crm_tasks")
          .select("organization_id,status")
          .eq("title", taskTitle)
          .maybeSingle();
        return data;
      })
      .toEqual({ organization_id: atores!.organizacaoA, status: "done" });
    const { count: countB, error: erroB } = await atores!.db
      .from("crm_tasks")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", atores!.organizacaoB)
      .eq("title", taskTitle);
    if (erroB) throw new Error(erroB.message);
    expect(countB).toBe(0);
  });

  await test.step("desativação fecha URL e aba antigas; reativação preserva configuração", async () => {
    managerPage = await page.context().newPage();
    observarErros(managerPage, "gestão A", observacoes);
    await managerPage.goto("/app/extensions");
    const enabled = managerPage.getByTestId(`extension-enabled-${installationId}`);
    await expect(enabled).toHaveAttribute("data-state", "checked");
    await enabled.click();
    await managerPage.getByTestId(`extension-save-${installationId}`).click();
    await expect(managerPage.getByText("Configuração salva.", { exact: true })).toBeVisible();

    const direta = await managerPage.request.get(`/api/v1/extensions/${installationId}`, {
      headers: { [EXPECTED_ORGANIZATION_HEADER]: atores!.organizacaoA },
    });
    expect(direta.status()).toBe(404);
    expect((await direta.json()) as unknown).toMatchObject({ error: { code: "extension_inactive" } });
    const recusaDaAcaoAntiga = staleGuide!.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/v1/extensions/${installationId}/open`),
    );
    const recusaDaRevalidacaoAntiga = staleGuide!.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().endsWith(`/api/v1/extensions/${installationId}`),
    );
    await staleGuide!.getByTestId(`extension-open-${catalogo!.pacote.cardId}`).click();
    await registrarRecusaHttp(
      observacoes,
      "ação da aba antiga depois da desativação",
      await recusaDaAcaoAntiga,
      404,
      "extension_inactive",
    );
    await registrarRecusaHttp(
      observacoes,
      "revalidação da aba antiga depois da desativação",
      await recusaDaRevalidacaoAntiga,
      404,
      "extension_inactive",
    );
    await expect(staleGuide!.getByTestId("extension-guide-unavailable")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      staleGuide!.getByRole("heading", { name: "Este guia não está disponível", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(staleGuide!.getByText(/desativada nesta organização/i)).toBeVisible();
    expect(staleGuide!.url()).toContain(`/app/extensions/${installationId}`);

    await managerPage.reload();
    await expect(managerPage.getByTestId(`extension-density-${installationId}`)).toContainText(
      "Compacta",
    );
    await expect(
      managerPage.getByTestId(`extension-description-${installationId}`),
    ).toHaveAttribute("data-state", "unchecked");
    await managerPage.getByTestId(`extension-enabled-${installationId}`).click();
    await managerPage.getByTestId(`extension-save-${installationId}`).click();
    await expect(managerPage.getByText("Configuração salva.", { exact: true })).toBeVisible();

    await expect
      .poll(async () => {
        const { data } = await atores!.db
          .from("organization_extensions")
          .select("enabled,configuration,revision")
          .eq("organization_id", atores!.organizacaoA)
          .eq("installation_id", installationId)
          .single();
        return data;
      })
      .toMatchObject({
        enabled: true,
        configuration: { density: "compact", show_description: false },
        revision: 3,
      });
  });

  await test.step("tenant switcher alterna A/B e o uso local continua com catálogo desligado", async () => {
    expect(managerPage).toBeTruthy();
    await managerPage!.bringToFront();
    await trocarOrganizacao(managerPage!, atores!.organizacaoB);
    await managerPage!.goto("/app/crm");
    await expect(
      managerPage!.getByTestId(
        `extension-contribution-${installationId}-${catalogo!.pacote.cardId}`,
      ),
    ).toHaveCount(0);
    expect(
      (
        await managerPage!.request.get(`/api/v1/extensions/${installationId}`, {
          headers: { [EXPECTED_ORGANIZATION_HEADER]: atores!.organizacaoB },
        })
      ).status(),
    ).toBe(404);

    await trocarOrganizacao(managerPage!, atores!.organizacaoA);
    await managerPage!.goto("/app/crm");
    await expect(
      managerPage!.getByTestId(
        `extension-contribution-${installationId}-${catalogo!.pacote.cardId}`,
      ),
    ).toBeVisible();
    expect(catalogo!.estaLigado()).toBe(false);
    await semOverflowHorizontal(managerPage!);
  });

  await test.step("auditoria identifica ator, organização e ações no banco e no visualizador", async () => {
    const { data: auditRows, error: auditError } = await atores!.db
      .from("api_audit_log")
      .select("id,organization_id,actor_user_id,action,resource_id,metadata")
      .eq("actor_user_id", atores!.usuarios.owner.id)
      .like("action", "extension.%");
    if (auditError) throw new Error(auditError.message);
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "extension.catalog_admitted",
          actor_user_id: atores!.usuarios.owner.id,
          organization_id: null,
        }),
        expect.objectContaining({
          action: "extension.installed",
          actor_user_id: atores!.usuarios.owner.id,
          organization_id: null,
          resource_id: installationId,
        }),
        expect.objectContaining({
          action: "extension.configured",
          actor_user_id: atores!.usuarios.owner.id,
          organization_id: atores!.organizacaoA,
          resource_id: installationId,
        }),
        expect.objectContaining({
          action: "extension.deactivated",
          actor_user_id: atores!.usuarios.owner.id,
          organization_id: atores!.organizacaoA,
          resource_id: installationId,
        }),
      ]),
    );
    const configuredAudit = auditRows.find(
      (row) =>
        row.action === "extension.configured" &&
        row.organization_id === atores!.organizacaoA &&
        row.resource_id === installationId,
    );
    if (!configuredAudit)
      throw new Error("A auditoria configurada pela jornada não foi encontrada.");

    const { data: organization, error: organizationError } = await atores!.db
      .from("organizations")
      .select("display_name,slug")
      .eq("id", atores!.organizacaoA)
      .single();
    if (organizationError) throw new Error(organizationError.message);

    const auditPage = await page.context().newPage();
    observarErros(auditPage, "visualizador de auditoria", observacoes);
    await auditPage.goto("/admin/audit");
    await expect(auditPage.getByRole("heading", { name: "Audit Log", exact: true })).toBeVisible();

    await auditPage.getByRole("button", { name: "Tenants", exact: true }).click();
    await auditPage.getByPlaceholder("Buscar...").fill(organization.display_name);
    await auditPage
      .getByRole("button", {
        name: `${organization.display_name} (${organization.slug})`,
        exact: true,
      })
      .click();
    await auditPage.keyboard.press("Escape");

    await auditPage.getByRole("button", { name: "Actions", exact: true }).click();
    await auditPage.getByPlaceholder("Buscar...").fill("extension.configured");
    await auditPage.getByRole("button", { name: "extension.configured", exact: true }).click();
    await auditPage.keyboard.press("Escape");
    const respostaFiltrada = auditPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/v1/admin/audit" &&
        url.searchParams.get("tenant_ids") === atores!.organizacaoA &&
        url.searchParams.get("actions") === "extension.configured" &&
        url.searchParams.get("actor_user_id") === atores!.usuarios.owner.id &&
        response.status() === 200
      );
    });
    await auditPage.getByLabel("Filtrar por actor user ID").fill(atores!.usuarios.owner.id);
    await respostaFiltrada;
    await expect(auditPage.locator(`a[href="/admin/audit/${configuredAudit.id}"]`)).toBeVisible({
      timeout: 30_000,
    });
    await auditPage.close();
  });

  expect(observacoes.pageErrors).toEqual([]);
  expect(errosDeConsoleInesperados(observacoes)).toEqual([]);
});
