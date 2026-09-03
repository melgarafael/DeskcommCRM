/**
 * Jornada: admin cola uma chave de IA e entende o resultado sem ler código.
 * Antes, o card mostrava `auth_failed_401` e a lista de modelos colada por vírgula.
 */
import { test, expect } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

let creds = lerCreds();

test.describe("Chaves de acesso à IA", () => {
  test("[P0] chave inválida vira frase legível, e a tela diz onde pegar outra", async ({ page }) => {
    creds = await loginComoAdmin(page, creds);
    await page.goto("/app/ai/credentials");

    const rotulo = `E2E ${Date.now()}`;
    await page.getByRole("button", { name: /adicionar credencial/i }).first().click();

    const dialog = page.getByRole("dialog");

    // O diálogo ajuda antes de pedir: diz quando usar e onde pegar a chave.
    await expect(page.getByText(/padrão recomendado para conversar/)).toBeVisible();
    await expect(dialog.getByRole("link", { name: /pegar chave em/i })).toHaveAttribute(
      "href",
      /console\.anthropic\.com/,
    );
    await expect(page.locator("#cred-key")).toHaveAttribute("placeholder", "sk-ant-…");

    await page.locator("#cred-label").fill(rotulo);
    await page.locator("#cred-key").fill("sk-ant-c••••••••••••••••••••••••");
    await page.getByRole("button", { name: /salvar e validar/i }).click();

    const card = page.locator("li", { hasText: rotulo });
    await expect(card).toBeVisible();

    // Resultado da validação em até 15 s (401 com rede; network_error sem). O
    // refetch client-side só acontece UMA vez, 3s depois de fechar o diálogo
    // (setTimeout em AddCredentialDialog.tsx) — se a validação demorar mais
    // que isso, a lista nunca reflete o resultado sozinha. Por isso o polling
    // recarrega a página a cada tentativa, em vez de confiar só naquele refetch.
    await expect(async () => {
      await page.reload();
      await expect(
        page.locator("li", { hasText: rotulo }).getByText(/recusou a chave|Não foi possível falar com o provedor/),
      ).toBeVisible();
    }).toPass({ timeout: 15_000 });

    // Código cru nunca aparece como texto visível.
    await expect(card.getByText(/^auth_failed_401$|^network_error$/)).toHaveCount(0);

    // Modelos: contagem ou travessão — nunca uma lista colada por vírgula.
    const modelos = await card.locator("dd").first().innerText();
    expect(modelos).toMatch(/^(\d+|—)$/);

    // Limpeza pela própria tela: não está em uso, então o botão está habilitado.
    await card.getByRole("button", { name: /excluir credencial/i }).click();
    await page.getByRole("button", { name: /^remover$/i }).click();
    await expect(card).toHaveCount(0);

    await page.screenshot({ path: ".superpowers/evidence/credenciais-de-ia.png", fullPage: true });
  });
});
