/**
 * AS EXTENSÕES VISTAS DE QUEM É DONO DO SERVIDOR.
 *
 * O catálogo de extensões é da INSTALAÇÃO — `extension_catalogs` não tem
 * `organization_id` —, mas a única tela que o mostrava vivia no menu da
 * EMPRESA. O dono do servidor precisava entrar numa organização qualquer para
 * ver de onde vêm as extensões do servidor dele. É a mesma divisão que o
 * DEC-009 achou no e-mail, e esta tela é o lado da instalação.
 *
 * O que esta bateria mede, e por que cada caso existe:
 *
 * 1. a porta EXISTE no menu do painel e leva à tela — tela sem porta é tela a
 *    que só se chega digitando a URL, que é o mesmo que não existir;
 * 2. a tela diz o ESTADO VERDADEIRO quando não há nada — instalação nova não
 *    tem catálogo, e a tela que nesse caso fica em branco parece quebrada;
 * 3. administrador de ORGANIZAÇÃO não entra — o conteúdo é da instalação, e
 *    num revendedor isso é o servidor inteiro;
 * 4. o caminho para a tela da empresa existe e CHEGA — quem precisa instalar
 *    tem de sair daqui sabendo para onde ir.
 */
import { expect, test } from "./helpers/test";

import { lerCreds, loginComoAdmin, loginComoDono } from "./helpers/login-admin";
import { afirmarDonoDoServidor } from "./utils/precondicao";

test.describe("Extensões da instalação", () => {
  test.beforeAll(async () => {
    await afirmarDonoDoServidor(lerCreds().users.dono!.email);
  });

  test.describe("como dono do servidor", () => {
    // Um login por arquivo: o login do dono espera a próxima janela do TOTP
    // (código não reusável) e custaria até 30 s POR CASO. Mesmo molde de
    // `painel-de-configuracao-da-instalacao.spec.ts`, onde isso derrubou o CI.
    const sessao = `/tmp/e2e-sessao-dono-extensoes-${process.pid}.json`;
    test.use({ storageState: sessao });

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(90_000);
      const contexto = await browser.newContext({
        baseURL: testInfo.project.use.baseURL,
        storageState: undefined,
      });
      const page = await contexto.newPage();
      await loginComoDono(page, lerCreds());
      await contexto.storageState({ path: sessao });
      await contexto.close();
    });

    test("a porta existe no menu do painel e leva à tela", async ({ page }) => {
      await page.goto("/admin/configuracao");

      const porta = page.getByRole("link", { name: /extensões/i }).first();
      await expect(porta, "o painel não oferece porta para as extensões").toBeVisible();
      await porta.click();

      await expect(page).toHaveURL(/\/admin\/extensoes/);
      await expect(page.getByTestId("tela-extensoes-da-instalacao")).toBeVisible();
    });

    test("sem catálogo admitido, a tela DIZ isso — não fica em branco", async ({ page }) => {
      await page.goto("/admin/extensoes");

      // O seed do e2e não admite catálogo: este é o estado de uma instalação
      // nova, que é justamente quem mais precisa entender o que está vendo.
      // ⚠️ Se um dia o seed passar a admitir catálogo, este caso não vira
      // vermelho por defeito: ele troca de ramo, e o `or` abaixo diz qual.
      const semCatalogo = page.getByTestId("extensoes-sem-catalogo");
      const comCatalogo = page.locator('[data-testid^="catalogo-"]').first();
      await expect(
        semCatalogo.or(comCatalogo),
        "a seção do catálogo não mostrou nem lista nem o motivo de estar vazia",
      ).toBeVisible();

      await expect(page.getByRole("heading", { name: /de onde vêm as extensões/i })).toBeVisible();
      await expect(page.getByRole("heading", { name: /instaladas neste servidor/i })).toBeVisible();
    });

    test("o caminho para a tela da empresa existe e chega", async ({ page }) => {
      await page.goto("/admin/extensoes");

      const ponteiro = page.getByTestId("ponteiro-extensoes-da-empresa");
      await expect(ponteiro).toBeVisible();
      await ponteiro.click();
      await expect(page).toHaveURL(/\/app\/extensions/);
    });
  });

  test("administrador de ORGANIZAÇÃO não entra na tela da instalação", async ({ page }) => {
    // Único caso com login fresco (papel outro), então só ele paga a janela do
    // TOTP — e por isso declara teto acima do período do código.
    test.setTimeout(90_000);
    await loginComoAdmin(page, lerCreds());

    await page.goto("/admin/extensoes");
    await expect(
      page.getByTestId("tela-extensoes-da-instalacao"),
      "a tela das extensões da INSTALAÇÃO abriu para um admin de organização",
    ).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/admin\/extensoes/);
  });
});
