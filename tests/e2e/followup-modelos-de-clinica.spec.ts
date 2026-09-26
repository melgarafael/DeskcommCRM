/**
 * MODELOS PRONTOS — a porta pela qual uma clínica sai do zero.
 *
 * O que esta spec prova, pela TELA, como um dono de clínica faria:
 *
 *  1. A galeria abre pelo botão «Começar de um modelo» e mostra as quatro
 *     jornadas com o que importa para decidir: quantas mensagens, por quanto
 *     tempo, o que dispara.
 *  2. Instalar um modelo de SILÊNCIO cria o fluxo e abre o construtor, com o
 *     grafo já desenhado — o valor inteiro da feature está aqui: a pessoa não
 *     desenhou nó nenhum.
 *  3. O fluxo nasce RASCUNHO. Instalar não manda mensagem para paciente nenhum.
 *  4. O modelo de ETAPA não instala sem etapa escolhida — o botão fica travado
 *     em vez de gravar um fluxo que nunca dispararia.
 *  5. Modelo já instalado aparece marcado, para ninguém instalar duas vezes e
 *     ter dois fluxos idênticos disputando o mesmo paciente.
 *
 * ⚠️ Cada run instala com o nome do catálogo, que é único por organização. Por
 * isso o caso 2 usa o modelo de FALTA e o 5 confere a marca nele: rodar a spec
 * duas vezes no mesmo banco encontra o modelo já instalado, que é exatamente o
 * estado que o caso 5 mede.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

test.describe("follow-ups · modelos prontos de clínica", () => {
  test("manager instala um modelo e cai no construtor com o fluxo desenhado", async ({ page }) => {
    await login(page, creds.users.manager!.email);
    await page.goto("/app/ai/followups");
    await expect(page.getByRole("heading", { name: "Follow-ups" })).toBeVisible();

    await page.getByRole("button", { name: /Começar de um modelo/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Modelos prontos")).toBeVisible();

    // As quatro jornadas, com a régua de decisão visível — não só o nome.
    for (const jornada of ["Consulta", "Exame", "Cirurgia", "Falta"]) {
      await expect(dialog.getByText(jornada, { exact: true }).first()).toBeVisible();
    }
    const cartaoDaFalta = dialog.getByTestId("modelo-clinica-falta-remarcar");
    await expect(cartaoDaFalta).toContainText("mensagens, se ninguém responder");
    await expect(cartaoDaFalta).toContainText("acompanha por");
    await expect(cartaoDaFalta).toContainText("Dispara quando");
    // O que falta depois de instalar está escrito, não subentendido.
    await expect(dialog).toContainText(/Publicar/);
    await expect(dialog).toContainText(/agente/i);
    await page.screenshot({
      path: "test-results/followup-modelos-01-galeria.png",
      fullPage: true,
    });

    const jaInstalado = await cartaoDaFalta.getByText("Já instalado").isVisible();

    if (!jaInstalado) {
      await cartaoDaFalta.getByRole("button", { name: "Instalar" }).click();
      // Instalar leva ao construtor — instalar é o começo, não o fim.
      await page.waitForURL(/\/app\/ai\/followups\/[0-9a-f-]{36}/);
      await page.screenshot({
        path: "test-results/followup-modelos-02-construtor.png",
        fullPage: true,
      });

      // O grafo veio pronto: a mensagem do primeiro toque está no canvas.
      await expect(page.getByText("Oferece outra data").first()).toBeVisible();

      await page.goto("/app/ai/followups");
    }

    // Nasce RASCUNHO: instalar não manda mensagem para ninguém.
    const cartaoNaLista = page.locator("li", { hasText: "Falta · remarcar quem não veio" });
    await expect(cartaoNaLista).toBeVisible();
    await expect(cartaoNaLista.getByText("Rascunho", { exact: true })).toBeVisible();

    // E aparece marcado na galeria, para ninguém instalar o mesmo duas vezes.
    await page.getByRole("button", { name: /Começar de um modelo/i }).click();
    await expect(
      page.getByTestId("modelo-clinica-falta-remarcar").getByText("Já instalado"),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/followup-modelos-03-ja-instalado.png",
      fullPage: true,
    });
  });

  test("modelo de etapa não instala sem etapa escolhida", async ({ page }) => {
    await login(page, creds.users.manager!.email);
    await page.goto("/app/ai/followups");

    await page.getByRole("button", { name: /Começar de um modelo/i }).click();
    const cartaoDoExame = page.getByTestId("modelo-clinica-exame-marcar");

    // Botão travado enquanto a etapa não foi escolhida: gravar sem ela criaria
    // um fluxo que o publish recusa e que nunca enrollaria ninguém.
    await expect(cartaoDoExame.getByRole("button", { name: "Instalar" })).toBeDisabled();
    await expect(cartaoDoExame.getByText("Etapa do funil que dispara")).toBeVisible();
    await page.screenshot({
      path: "test-results/followup-modelos-04-etapa-obrigatoria.png",
      fullPage: true,
    });
  });

  test("viewer não vê a galeria de modelos (RBAC)", async ({ page }) => {
    await login(page, creds.users.viewer!.email);
    await page.goto("/app/ai/followups");
    await expect(page.getByRole("heading", { name: "Follow-ups" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Começar de um modelo/i })).toHaveCount(0);
  });
});
