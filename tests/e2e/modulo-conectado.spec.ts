import { mkdir } from "node:fs/promises";

import {
  esperarARevelacaoNasCargas,
  expect as expectBase,
  test,
  type Browser,
  type BrowserContext,
  type FrameLocator,
  type Page,
} from "./helpers/test";

import {
  criarAtoresDasExtensoes,
  type AtoresDasExtensoes,
} from "./fixtures/catalogo-extensoes";
import {
  criarCatalogoDoModuloConectado,
  type CatalogoDoModuloConectado,
} from "./fixtures/modulo-conectado";

/**
 * MÓDULO CONECTADO (Spec 33) — a prova de aceite, pela tela, como um leigo a faria.
 *
 * Seis passos, um serviço de módulo de verdade (o de ensaio do laboratório, num processo HTTP real,
 * dentro de um iframe real) e o CRM real: nada é simulado no caminho do módulo ao CRM. O módulo busca
 * o token por HMAC, recebe o JWT de contexto por postMessage e chama `/api/v1/contacts`; a página dele
 * mostra o status HTTP e o código de erro que o CRM respondeu, e é isso que a prova lê.
 *
 * O segredo da instalação nasce no CRM (botão "Gerar segredo", pela tela) e é entregue ao serviço
 * de ensaio por `POST /ensaio/configurar`. Nenhum segredo fixo mora no repositório.
 *
 * Pré-requisitos do ambiente (o `e2e.yml` os publica): `MODULE_JWT_PRIVATE_KEY` (a chave que assina o
 * JWT de contexto; sem ela o CRM responde 503 `module_context_unavailable` e o módulo nunca recebe
 * contexto) e `AI_CRED_AES_KEY` (cifra o segredo da instalação).
 */

const expect = expectBase.configure({ timeout: 20_000 });

const EVIDENCE = "evidence/modulo-conectado-e2e";

let atores: AtoresDasExtensoes | undefined;
let catalogo: CatalogoDoModuloConectado | undefined;
const contextosExtras: BrowserContext[] = [];

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

async function paginaAutenticada(browser: Browser, email: string, senha: string): Promise<Page> {
  const contexto = await browser.newContext();
  contexto.on("page", esperarARevelacaoNasCargas);
  contextosExtras.push(contexto);
  const page = await contexto.newPage();
  await login(page, email, senha);
  return page;
}

// Mesma troca de organização das outras specs de extensão (ver extensoes-declarativas.spec.ts).
async function trocarOrganizacao(page: Page, organizationId: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByTestId("tenant-switcher").click();
  const item = page.getByTestId(`tenant-switcher-item-${organizationId}`);
  if ((await item.getByText("✓", { exact: true }).count()) > 0) {
    await page.keyboard.press("Escape");
    return;
  }
  const novoDocumento = page.waitForEvent("load", { timeout: 60_000 });
  await item.click({ noWaitAfter: true });
  await novoDocumento;
  await expect(page).toHaveURL(/\/app\/inbox(?:[?#]|$)/);
}

function menuPrincipal(page: Page) {
  return page.getByRole("navigation", { name: "Navegação principal" });
}

async function semGrupoDeModulos(page: Page): Promise<void> {
  await page.goto("/app/inbox");
  await expect(menuPrincipal(page)).toBeVisible({ timeout: 30_000 });
  await expect(menuPrincipal(page).getByText("Módulos", { exact: true })).toHaveCount(0);
}

async function paginaNaoEncontrada(page: Page, caminho: string): Promise<void> {
  // commit: a 404 do Next termina o boundary em erro de servidor por desenho, e a espera da revelação
  // (helpers/test.ts) nunca fecharia nesta página. O texto da 404 é a prova.
  await page.goto(caminho, { waitUntil: "commit" });
  await expect(page.getByText(/404\s*—\s*Página não encontrada/)).toBeVisible({ timeout: 30_000 });
}

/** Abre a tela do módulo e espera o iframe receber o JWT (os botões só liberam depois dele). */
async function abrirModulo(page: Page, slug: string, titulo: string): Promise<FrameLocator> {
  await page.goto(`/app/m/${slug}`);
  const quadro = page.frameLocator(`iframe[title="${titulo}"]`);
  await expect(quadro.getByRole("button", { name: "Listar contatos" })).toBeEnabled({
    timeout: 45_000,
  });
  return quadro;
}

async function lerResposta(
  quadro: FrameLocator,
  botao: "Listar contatos" | "Criar contato",
  status: string,
  codigo: string | null,
): Promise<void> {
  await quadro.getByRole("button", { name: botao }).click();
  await expect(quadro.getByTestId("ensaio-status")).toHaveText(status, { timeout: 30_000 });
  if (codigo !== null) {
    await expect(quadro.getByTestId("ensaio-codigo")).toHaveText(codigo);
  }
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const ausentes = ["MODULE_JWT_PRIVATE_KEY", "AI_CRED_AES_KEY"].filter(
    (chave) => !process.env[chave],
  );
  if (ausentes.length > 0) {
    throw new Error(
      `O runner E2E não publicou o que o módulo conectado exige: ${ausentes.join(", ")}.`,
    );
  }
  await mkdir(EVIDENCE, { recursive: true });
  atores = await criarAtoresDasExtensoes();
  catalogo = await criarCatalogoDoModuloConectado(atores.db);
});

test.afterAll(async () => {
  for (const contexto of contextosExtras) await contexto.close();
  await catalogo?.limpar();
  await atores?.limpar();
});

test("módulo conectado: instalar, consentir, usar, recusar, cair e desligar, tudo pela tela", async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  const pacote = catalogo!.pacote;
  let installationId = "";
  const slug = pacote.slug;

  await test.step("1. zero módulos: sem grupo no menu e /app/m/qualquer não existe", async () => {
    await login(page, atores!.usuarios.owner.email, atores!.senha);
    await page.goto("/app/extensions");
    await trocarOrganizacao(page, atores!.organizacaoA);
    await semGrupoDeModulos(page);
    await paginaNaoEncontrada(page, "/app/m/qualquer");
    await page.screenshot({ path: `${EVIDENCE}/01-zero-modulos.png`, fullPage: true });
  });

  await test.step("2. o admin instala, gera o segredo, ativa, consente e o módulo lista contatos", async () => {
    await page.goto("/app/extensions");
    await expect(page.getByTestId("extension-catalog-admission")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("extension-catalog-file").setInputFiles(catalogo!.catalogo);
    await page.getByTestId("extension-catalog-submit").click();
    await expect(page.getByText("Catálogo admitido e disponível para instalação.")).toBeVisible();

    await page.getByRole("tab", { name: "Catálogo" }).click();
    await page
      .getByTestId(`extension-install-${pacote.publisher}-${pacote.name}-${pacote.version}`)
      .click();

    await expect
      .poll(
        async () => {
          const { data } = await atores!.db
            .from("extension_installations")
            .select("id")
            .eq("publisher", pacote.publisher)
            .eq("name", pacote.name)
            .maybeSingle();
          return (data?.id as string | undefined) ?? "";
        },
        { timeout: 60_000 },
      )
      .not.toBe("");
    const { data: instalada, error } = await atores!.db
      .from("extension_installations")
      .select("id")
      .eq("publisher", pacote.publisher)
      .eq("name", pacote.name)
      .single();
    if (error) throw new Error(error.message);
    installationId = instalada.id as string;

    await page.getByRole("tab", { name: "Instaladas" }).click();
    await expect(page.getByTestId(`extension-installed-${installationId}`)).toBeVisible({
      timeout: 30_000,
    });

    // O segredo nasce no CRM, mostrado uma vez. A prova o lê da caixa da tela e o entrega ao serviço.
    await page.getByTestId(`extension-secret-${installationId}`).click();
    await page.getByTestId(`extension-secret-confirm-${installationId}`).click();
    const caixaDoSegredo = page.getByTestId(`extension-secret-value-${installationId}`);
    await expect(caixaDoSegredo).toBeVisible();
    const segredo = await caixaDoSegredo.inputValue();
    expect(segredo.length).toBeGreaterThanOrEqual(16);
    await page.getByTestId(`extension-secret-close-${installationId}`).click();
    await catalogo!.configurarServico({
      hostOrigin: new URL(page.url()).origin,
      installationId,
      segredo,
    });

    // Ativa nesta organização e consente as áreas (a proposta traz `contatos` e `conversas`).
    await page.getByTestId(`extension-enabled-${installationId}`).click();
    await page.getByTestId(`extension-save-${installationId}`).click();
    await expect(page.getByText("Configuração salva.", { exact: true })).toBeVisible();
    await expect(
      page.getByTestId(`extension-consent-${installationId}-area.contatos.leitura`),
    ).toBeChecked();
    await page.getByTestId(`extension-consent-save-${installationId}`).click();
    await expect(page.getByText("Áreas do módulo salvas.")).toBeVisible();

    // O grupo "Módulos" aparece e o iframe carrega.
    await page.goto("/app/inbox");
    await expect(menuPrincipal(page).getByText("Módulos", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const quadro = await abrirModulo(page, slug, pacote.title);
    await lerResposta(quadro, "Listar contatos", "200", null);
    await page.screenshot({ path: `${EVIDENCE}/02-listar-200.png`, fullPage: true });
  });

  await test.step("3. o viewer lê mas não grava (403 de papel); o admin grava (201)", async () => {
    const viewer = await paginaAutenticada(browser, atores!.usuarios.viewerA.email, atores!.senha);
    const quadroDoViewer = await abrirModulo(viewer, slug, pacote.title);
    await lerResposta(quadroDoViewer, "Listar contatos", "200", null);
    await lerResposta(quadroDoViewer, "Criar contato", "403", "forbidden_role");
    await viewer.screenshot({ path: `${EVIDENCE}/03-viewer-403.png`, fullPage: true });

    const quadroDoAdmin = await abrirModulo(page, slug, pacote.title);
    await lerResposta(quadroDoAdmin, "Criar contato", "201", null);
    await page.screenshot({ path: `${EVIDENCE}/03-admin-201.png`, fullPage: true });
  });

  await test.step("4. o admin retira a área contatos e o CRM recusa na hora", async () => {
    await page.goto("/app/extensions");
    await page.getByRole("tab", { name: "Instaladas" }).click();
    const contatos = page.getByTestId(`extension-consent-${installationId}-area.contatos.leitura`);
    await expect(contatos).toBeChecked({ timeout: 30_000 });
    await contatos.uncheck();
    await page.getByTestId(`extension-consent-save-${installationId}`).click();
    await expect(page.getByText("Áreas do módulo salvas.")).toBeVisible();

    const quadro = await abrirModulo(page, slug, pacote.title);
    await lerResposta(quadro, "Listar contatos", "403", "module_area_not_granted");
    await page.screenshot({ path: `${EVIDENCE}/04-area-retirada.png`, fullPage: true });
  });

  await test.step("5. serviço fora do ar: aviso no prazo e o resto do CRM segue", async () => {
    await catalogo!.desligar();
    await page.goto(`/app/m/${slug}`);
    // PRAZO_DO_PRONTO_MS do QuadroDoModulo é 10 s; a folga cobre a carga da página.
    await expect(page.getByText("O serviço deste módulo não respondeu")).toBeVisible({
      timeout: 25_000,
    });
    await page.screenshot({ path: `${EVIDENCE}/05-servico-fora.png`, fullPage: true });

    await page.goto("/app/inbox");
    await expect(page).toHaveURL(/\/app\/inbox(?:[?#]|$)/);
    await expect(menuPrincipal(page)).toBeVisible({ timeout: 30_000 });
  });

  await test.step("6. o interruptor desliga: o grupo some e a tela do módulo não existe", async () => {
    await page.goto("/app/extensions");
    await page.getByRole("tab", { name: "Instaladas" }).click();
    await page.getByTestId(`extension-switch-${installationId}`).click();
    await expect(page.getByText("Módulo desligado nesta instalação.")).toBeVisible();

    await semGrupoDeModulos(page);
    await paginaNaoEncontrada(page, `/app/m/${slug}`);
    await page.screenshot({ path: `${EVIDENCE}/06-desligado.png`, fullPage: true });
  });
});
