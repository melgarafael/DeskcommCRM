import { mkdir } from "node:fs/promises";

import { expect as expectBase, test, type BrowserContext, type Page } from "@playwright/test";

import {
  criarAtoresDasExtensoes,
  criarCatalogoDeVersoes,
  type AtoresDasExtensoes,
  type CatalogoDeVersoes,
} from "./fixtures/catalogo-extensoes";

// J26 — atualizar, desfazer a última troca, remover e reinstalar, pela tela, como o responsável
// pela instalação faria. As asserções esperam a mutação e a recarga da lista; o prazo sobe pelo
// mesmo motivo medido no J25 (duas idas ao servidor sob carga).
const expect = expectBase.configure({ timeout: 20_000 });

const EVIDENCE = "evidence/extensoes/versao";

test.use({ trace: "on" });
// O prazo vale para o arquivo inteiro, e não só dentro do corpo: gravar o trace de uma jornada de
// quatro minutos acontece depois do corpo e estourava os 30 s da configuração global (medido na
// segunda rodada: oito capturas gravadas, trace.zip incompleto, "Test timeout of 30000ms").
test.describe.configure({ timeout: 480_000 });

let atores: AtoresDasExtensoes | undefined;
let catalogo: CatalogoDeVersoes | undefined;
const contextosExtras: BrowserContext[] = [];

/**
 * Registra cada aviso (toast) assim que ele entra na página. Um aviso dura 4 s na tela; com a
 * máquina carregada, o Playwright chegou a olhar só depois de ele sair (medido na terceira
 * rodada: admissão concluída no banco, aviso nunca flagrado). O registro não perde o aviso, e a
 * asserção continua sendo sobre o texto que a pessoa viu.
 */
async function registrarAvisos(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const vistos: string[] = [];
    Object.defineProperty(window, "__avisosVistos", { value: vistos });
    new MutationObserver(() => {
      for (const aviso of document.querySelectorAll("[data-sonner-toast]")) {
        const texto = aviso.textContent ?? "";
        if (texto && !vistos.includes(texto)) vistos.push(texto);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
}

async function esperarAviso(page: Page, texto: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as { __avisosVistos?: string[] }).__avisosVistos?.join("\n") ?? "",
        ),
      { timeout: 30_000 },
    )
    .toContain(texto);
}

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

async function trocarOrganizacao(page: Page, organizationId: string): Promise<void> {
  // Mesma receita medida no J25: subir a página antes do seletor e esperar o documento novo.
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
}

/**
 * Espera a gestão carregar a lista. Com o Supabase sintético sobrecarregado (autenticação em 504,
 * checagem de papel em 500), a leitura falha e a tela mostra "Tentar novamente"; a prova ficava
 * esperando uma aba que só volta com esse clique (medido: 7 min parada). Ela clica como uma pessoa
 * faria, registra cada nova tentativa como anotação no relatório, e desiste depois de três.
 */
async function esperarGestao(page: Page): Promise<void> {
  const abas = page.getByRole("tablist", { name: "Seções de extensões" });
  const indisponivel = page.getByTestId("extensions-unavailable");
  for (let tentativa = 0; tentativa <= 3; tentativa += 1) {
    await expect(abas.or(indisponivel)).toBeVisible({ timeout: 60_000 });
    if (await abas.isVisible()) return;
    if (tentativa === 3) break;
    test.info().annotations.push({
      type: "recarga-pela-tela",
      description: `a gestão não carregou (tentativa ${tentativa + 1}): ${await indisponivel.innerText()}`,
    });
    await indisponivel.getByRole("button", { name: "Tentar novamente" }).click();
  }
  throw new Error("A gestão de extensões não carregou depois de três tentativas pela tela.");
}

async function gestao(page: Page, aba: "Instaladas" | "Catálogo"): Promise<void> {
  await page.goto("/app/extensions");
  await expect(page.getByTestId("extensions-manager")).toBeVisible({ timeout: 30_000 });
  await esperarGestao(page);
  await page.getByRole("tab", { name: aba }).click();
}

async function instalacao(): Promise<{
  id: string;
  version: string;
  revision: number;
  previous_artifact_id: string | null;
  removed_at: string | null;
}> {
  const { data, error } = await atores!.db
    .from("extension_installations")
    .select("id,version,revision,previous_artifact_id,removed_at")
    .eq("publisher", catalogo!.publisher)
    .eq("name", catalogo!.name)
    .single();
  if (error) throw new Error(error.message);
  return data as Awaited<ReturnType<typeof instalacao>>;
}

async function vinculo(organizationId: string, installationId: string) {
  const { data, error } = await atores!.db
    .from("organization_extensions")
    .select("enabled,revision,configuration,deactivated_by_removal_at")
    .eq("organization_id", organizationId)
    .eq("installation_id", installationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function botaoDoCatalogo(page: Page, versao: string) {
  return page.getByTestId(`extension-install-${catalogo!.publisher}-${catalogo!.name}-${versao}`);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  atores = await criarAtoresDasExtensoes();
  catalogo = await criarCatalogoDeVersoes(atores.db, EVIDENCE);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  for (const contexto of contextosExtras) await contexto.close();
  await catalogo?.limpar();
  await atores?.limpar();
});

test("atualiza, desfaz com o catálogo fora do ar, remove e reinstala sem decidir pela organização", async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000);
  let installationId = "";

  await registrarAvisos(page);

  await test.step("admite o catálogo com as duas versões e instala a 1.0.0", async () => {
    await login(page, atores!.usuarios.owner.email, atores!.senha);
    await page.goto("/app/extensions");
    await trocarOrganizacao(page, atores!.organizacaoA);
    await page.goto("/app/extensions");
    await esperarGestao(page);
    await expect(page.getByTestId("extension-catalog-admission")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("extension-catalog-file").setInputFiles(catalogo!.catalogo);
    await page.getByTestId("extension-catalog-submit").click();
    await esperarAviso(page, "Catálogo admitido e disponível para instalação.");
    await page.getByRole("tab", { name: "Catálogo" }).click();

    await expect(botaoDoCatalogo(page, "1.0.0")).toHaveText("Instalar versão revisada");
    await botaoDoCatalogo(page, "1.0.0").click();
    await esperarAviso(page, "Extensão instalada. Agora um administrador da organização pode ativá-la.");
    const linha = await instalacao();
    installationId = linha.id;
    expect(linha).toMatchObject({ version: "1.0.0", revision: 1, previous_artifact_id: null });
    // A outra versão da MESMA identidade vira "Atualizar", nunca uma segunda instalação.
    await expect(botaoDoCatalogo(page, "1.1.0")).toHaveText("Atualizar para 1.1.0");
  });

  await test.step("ativa em A; B não ativa", async () => {
    await page.getByRole("tab", { name: "Instaladas" }).click();
    const card = page.getByTestId(`extension-installed-${installationId}`);
    await card.getByRole("switch", { name: "Ativa no CRM" }).click();
    await page.getByTestId(`extension-save-${installationId}`).click();
    await expect(card.getByText("Configuração salva.")).toBeVisible();
    expect(await vinculo(atores!.organizacaoA, installationId)).toMatchObject({
      enabled: true,
      revision: 1,
    });
    expect(await vinculo(atores!.organizacaoB, installationId)).toBeNull();
    await expect(page.getByTestId(`extension-active-count-${installationId}`)).toHaveText(
      "1 organização está com esta extensão ativa.",
    );
  });

  await test.step("atualiza para 1.1.0: A continua ativa e vê o card novo", async () => {
    await gestao(page, "Catálogo");
    await botaoDoCatalogo(page, "1.1.0").click();
    const dialogo = page.getByTestId(
      `extension-install-dialog-${catalogo!.publisher}-${catalogo!.name}-1.1.0`,
    );
    await expect(dialogo).toContainText(
      "1 organização tem esta extensão ativa e continua com ela ativa, com a configuração de hoje.",
    );
    await page.screenshot({ path: `${EVIDENCE}/1-confirmar-atualizacao.png` });
    await page
      .getByTestId(`extension-install-confirm-${catalogo!.publisher}-${catalogo!.name}-1.1.0`)
      .click();
    await esperarAviso(page, "Extensão atualizada. As organizações que a usavam continuam com ela ativa.");

    const linha = await instalacao();
    expect(linha).toMatchObject({ id: installationId, version: "1.1.0", revision: 2 });
    expect(linha.previous_artifact_id).not.toBeNull();
    expect(await vinculo(atores!.organizacaoA, installationId)).toMatchObject({
      enabled: true,
      revision: 1,
    });
    expect(await vinculo(atores!.organizacaoB, installationId)).toBeNull();
    await expect(
      page
        .locator('[data-testid^="extension-operation-"]')
        .filter({ hasText: `${catalogo!.publisher}/${catalogo!.name} 1.0.0 → 1.1.0` })
        .first(),
    ).toContainText("Atualização");

    await page.goto(`/app/extensions/${installationId}`);
    await expect(page.getByTestId(`extension-guide-card-${catalogo!.cardNovo.id}`)).toContainText(
      catalogo!.cardNovo.titulo,
    );
    await expect(page.getByTestId(`extension-guide-card-${catalogo!.cardEstavel.id}`)).toBeVisible();
    await expect(page.getByText("v1.1.0")).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/2-guia-na-1.1.0.png`, fullPage: true });
  });

  await test.step("desfaz com o catálogo desligado; uma aba antiga recebe o aviso e não troca de novo", async () => {
    // Outra sessão do mesmo responsável, aberta ANTES do desfazer: armazenamento próprio, então
    // nada a avisa da troca até ela tentar agir.
    const contexto = await browser.newContext();
    contextosExtras.push(contexto);
    const antiga = await contexto.newPage();
    await registrarAvisos(antiga);
    await login(antiga, atores!.usuarios.owner.email, atores!.senha);
    await gestao(antiga, "Instaladas");
    await expect(antiga.getByTestId(`extension-revert-${installationId}`)).toHaveText(
      "Desfazer a última troca (volta para 1.0.0)",
    );

    await catalogo!.desligar();
    expect(catalogo!.estaLigado()).toBe(false);

    await gestao(page, "Instaladas");
    await page.getByTestId(`extension-revert-${installationId}`).click();
    const dialogo = page.getByTestId(`extension-revert-dialog-${installationId}`);
    await expect(dialogo).toContainText(`Voltar ${catalogo!.title} para a versão 1.0.0?`);
    await expect(dialogo).toContainText("1 organização está com esta extensão ativa.");
    await page.getByTestId(`extension-revert-confirm-${installationId}`).click();
    await esperarAviso(page, "Troca desfeita: a versão 1.0.0 voltou a valer em todas as organizações.");
    expect(await instalacao()).toMatchObject({ version: "1.0.0", revision: 3 });

    // A aba antiga ainda mostra a revisão 2; se tivesse recarregado, o botão diria "1.1.0" e
    // a prova não estaria provando a precondição.
    await expect(antiga.getByTestId(`extension-revert-${installationId}`)).toHaveText(
      "Desfazer a última troca (volta para 1.0.0)",
    );
    await antiga.getByTestId(`extension-revert-${installationId}`).click();
    await antiga.getByTestId(`extension-revert-confirm-${installationId}`).click();
    await esperarAviso(antiga, "A extensão mudou em outra sessão. Recarregamos o estado atual; revise antes de repetir.");
    await expect(antiga.getByTestId(`extension-revert-${installationId}`)).toHaveText(
      "Desfazer a última troca (volta para 1.1.0)",
    );
    await antiga.screenshot({ path: `${EVIDENCE}/3-aba-antiga-recusada.png`, fullPage: true });
    // Fecha aqui, e não no afterAll: gravar o trace deste contexto na limpeza estourava o prazo.
    contextosExtras.splice(contextosExtras.indexOf(contexto), 1);
    await contexto.close();
    await page.bringToFront();
    expect(await instalacao()).toMatchObject({ version: "1.0.0", revision: 3 });
  });

  await test.step("remove: o guia aberto em A diz que foi removido, e a auditoria de A registra", async () => {
    const guiaAberto = await page.context().newPage();
    await guiaAberto.goto(`/app/extensions/${installationId}`);
    await expect(guiaAberto.getByTestId("extension-guide")).toBeVisible({ timeout: 30_000 });

    // Uma página em segundo plano não anima: o Chromium congela os quadros dela, e todo clique
    // espera "estável" para sempre (medido na primeira rodada: 8 min parado na aba Instaladas).
    await page.bringToFront();
    await gestao(page, "Instaladas");
    await page.getByTestId(`extension-remove-${installationId}`).click();
    await expect(page.getByTestId(`extension-remove-dialog-${installationId}`)).toContainText(
      "1 organização com ela ativa deixa de ver os guias agora; a configuração dela fica guardada.",
    );
    await page.screenshot({ path: `${EVIDENCE}/4-confirmar-remocao.png` });
    await page.getByTestId(`extension-remove-confirm-${installationId}`).click();
    await esperarAviso(page, "Extensão removida de todas as organizações.");

    expect((await instalacao()).removed_at).not.toBeNull();
    const desligado = await vinculo(atores!.organizacaoA, installationId);
    expect(desligado).toMatchObject({ enabled: false, revision: 2 });
    expect(desligado?.deactivated_by_removal_at).not.toBeNull();

    await guiaAberto.bringToFront();
    await guiaAberto.reload();
    await expect(
      guiaAberto.getByText(
        "O responsável pela instalação removeu esta extensão de todas as organizações.",
      ),
    ).toBeVisible();
    await expect(guiaAberto.getByText(/desativada nesta organização/)).toHaveCount(0);
    await expect(guiaAberto.getByRole("button", { name: "Tentar novamente" })).toHaveCount(0);
    await guiaAberto.screenshot({ path: `${EVIDENCE}/5-guia-removido.png`, fullPage: true });
    await guiaAberto.close();
    await page.bringToFront();

    await gestao(page, "Instaladas");
    await expect(page.getByTestId(`extension-removed-${installationId}`)).toContainText(
      "O responsável pela instalação removeu esta extensão em",
    );

    const { data: linhas, error } = await atores!.db
      .from("api_audit_log")
      .select("action,metadata")
      .eq("organization_id", atores!.organizacaoA)
      .eq("action", "extension.deactivated_by_removal");
    if (error) throw new Error(error.message);
    expect(linhas).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "installation_removed" }),
      }),
    ]);
    await page.goto("/app/audit");
    await expect(page.getByText("extension.deactivated_by_removal").first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${EVIDENCE}/6-auditoria-da-organizacao.png`, fullPage: true });
  });

  await test.step("religa o catálogo e reinstala: A precisa ativar de novo", async () => {
    await catalogo!.religar();
    await gestao(page, "Catálogo");
    await expect(botaoDoCatalogo(page, "1.0.0")).toHaveText("Reinstalar versão 1.0.0");
    await botaoDoCatalogo(page, "1.0.0").click();
    await expect(
      page.getByTestId(`extension-install-dialog-${catalogo!.publisher}-${catalogo!.name}-1.0.0`),
    ).toContainText(
      "1 organização a usava e não volta a vê-la sozinha: o administrador dela precisa ativar de novo.",
    );
    await page
      .getByTestId(`extension-install-confirm-${catalogo!.publisher}-${catalogo!.name}-1.0.0`)
      .click();
    await esperarAviso(page, "Extensão reinstalada. Cada organização precisa ativá-la de novo.");
    expect(await instalacao()).toMatchObject({
      id: installationId,
      version: "1.0.0",
      revision: 5,
      removed_at: null,
      previous_artifact_id: null,
    });

    await page.getByRole("tab", { name: "Instaladas" }).click();
    const aviso = page.getByTestId(`extension-reactivate-${installationId}`);
    await expect(aviso).toContainText("Estava ativa até ser removida da instalação em");
    await expect(aviso).toContainText("Ative de novo para voltar a mostrar os guias.");
    await page.screenshot({ path: `${EVIDENCE}/7-reinstalada-por-ativar.png`, fullPage: true });

    const card = page.getByTestId(`extension-installed-${installationId}`);
    await card.getByRole("switch", { name: "Ativa no CRM" }).click();
    await page.getByTestId(`extension-save-${installationId}`).click();
    await expect(page.getByText("Configuração salva.")).toBeVisible();
    const reativado = await vinculo(atores!.organizacaoA, installationId);
    expect(reativado).toMatchObject({ enabled: true, deactivated_by_removal_at: null });
    await expect(page.getByTestId(`extension-reactivate-${installationId}`)).toHaveCount(0);
  });

  await test.step("uma atualização que falha no download deixa recibo failed e não trava o sistema", async () => {
    await catalogo!.desligar();
    await gestao(page, "Catálogo");
    await botaoDoCatalogo(page, "1.1.0").click();
    await page
      .getByTestId(`extension-install-confirm-${catalogo!.publisher}-${catalogo!.name}-1.1.0`)
      .click();

    // A Atividade recente lista recibos de rodadas anteriores: sem a identidade desta rodada, um
    // "Atualização · Falhou" antigo satisfazia o filtro antes de esta falha existir (medido na
    // quarta rodada: a tela passou e o banco ainda não tinha o recibo).
    const recibo = page
      .locator('[data-testid^="extension-operation-"]')
      .filter({ hasText: `${catalogo!.publisher}/${catalogo!.name}` })
      .filter({ hasText: "Atualização" })
      .filter({ hasText: "Falhou" })
      .first();
    await expect(recibo).toBeVisible();
    await expect(recibo).toContainText(
      "A versão instalada continua a mesma. Confira o catálogo admitido e peça a troca de novo.",
    );
    await page.screenshot({ path: `${EVIDENCE}/8-atualizacao-falhou.png`, fullPage: true });

    const { data: falhas, error } = await atores!.db
      .from("extension_operations")
      .select("status,error_code")
      .eq("kind", "update")
      .eq("name", catalogo!.name)
      .eq("status", "failed");
    if (error) throw new Error(error.message);
    expect(falhas).toEqual([{ status: "failed", error_code: "extension_download_failed" }]);
    expect(await instalacao()).toMatchObject({ version: "1.0.0", revision: 5 });

    // Nenhuma preparação ficou presa: o gatilho do atualizador aceita um `dispatched`. A linha
    // é encerrada na hora, para não travar publicação de outras specs que dividem o banco.
    const { data: run, error: runError } = await atores!.db
      .from("system_update_runs")
      .insert({ requested_by: atores!.usuarios.owner.id })
      .select("id")
      .single();
    if (runError) throw new Error(runError.message);
    const { error: fimError } = await atores!.db
      .from("system_update_runs")
      .update({ status: "failed", finished_at: new Date().toISOString() })
      .eq("id", run.id);
    if (fimError) throw new Error(fimError.message);
  });
});
