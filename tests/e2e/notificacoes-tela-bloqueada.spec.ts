/**
 * O QUE O AVISO MOSTRA COM O CELULAR BLOQUEADO — a escolha da empresa, pela tela.
 *
 * O admin abre Configurações › Notificações, vê o padrão ("só quem mandou"),
 * troca, recarrega e encontra o que escolheu. Quem não é admin vê a escolha em
 * vigor e não consegue mudá-la.
 *
 * O que este spec NÃO prova, e por quê: a redação do push (o funil em
 * `lib/notifications/web_push.ts`) e o DELETE da inscrição ao sair. O ambiente
 * de e2e não tem par VAPID (ver `notificacoes-diz-o-que-falta.spec.ts`), então
 * não existe inscrição para redigir nem para apagar. Os dois são provados nos
 * testes unitários (`lib/notifications/web_push.test.ts`,
 * `tests/unit/push-sai-so-pelo-funil.test.ts`, `lib/notifications/push_client.test.ts`).
 *
 * O banco é compartilhado entre specs: o caso do admin volta a escolha para o
 * padrão no `finally`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { expect, test, type Page } from "./helpers/test";

const EVIDENCIA = path.join(process.cwd(), "evidence/notificacoes-tela-bloqueada");

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/** `agent` não tem TOTP no seed: o login simples chega a /app (ver a spec irmã). */
async function loginComoAtendente(page: Page): Promise<void> {
  const creds = lerCreds();
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.agent!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

test.describe("Notificações — o que aparece com o celular bloqueado", () => {
  test.describe.configure({ timeout: 120_000 });

  test("o admin vê o padrão, escolhe esconder tudo e a escolha fica gravada", async ({ page }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/settings/notifications");

    const secao = page.getByTestId("tela-bloqueada");
    await expect(secao).toBeVisible();
    try {
      await expect(page.getByTestId("tela-bloqueada-nome")).toBeChecked();
      await expect(page.getByTestId("tela-bloqueada-oculto")).toBeEnabled();

      await page.getByTestId("tela-bloqueada-oculto").check();
      await expect(page.getByText("Salvo", { exact: true })).toBeVisible();

      await page.reload();
      await expect(page.getByTestId("tela-bloqueada-oculto")).toBeChecked();
      await captura(page, "01-admin-escolheu-esconder-tudo");
    } finally {
      await page.goto("/app/settings/notifications");
      const padrao = page.getByTestId("tela-bloqueada-nome");
      if (!(await padrao.isChecked())) {
        await padrao.check();
        await expect(page.getByText("Salvo", { exact: true }).first()).toBeVisible();
      }
    }
  });

  test("quem não é admin vê a escolha em vigor e não muda", async ({ page }) => {
    await loginComoAtendente(page);
    await page.goto("/app/settings/notifications");

    await expect(page.getByTestId("tela-bloqueada")).toBeVisible();
    for (const opcao of ["oculto", "nome", "nome_e_previa"]) {
      await expect(page.getByTestId(`tela-bloqueada-${opcao}`)).toBeDisabled();
    }
    await expect(page.getByText("Quem decide é um administrador.")).toBeVisible();
    await captura(page, "02-atendente-so-le");
  });
});
