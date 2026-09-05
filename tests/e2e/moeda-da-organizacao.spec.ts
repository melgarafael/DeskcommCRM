/**
 * A MOEDA DA ORGANIZAÇÃO — PROVA PELA TELA (DoD item 12).
 *
 * Os testes unitários provam que `formatCents` deriva o locale certo e que a
 * rota ignora a moeda do corpo. Isto prova o que um dono de loja no México faz
 * de verdade: abre Configurações, escolhe Peso mexicano, cadastra um produto,
 * e lê o preço na tela — não um mock de `Intl`, o `next start` real contra o
 * Postgres real.
 *
 * Dois atos, e o segundo é o que fecha o círculo:
 *   1. Configurações › Organização: mudar para MXN, salvar, RECARREGAR a
 *      página e confirmar que persistiu — não só que o formulário aceitou.
 *   2. Produtos: cadastrar um preço e ler `$249.90` na lista — ponto decimal,
 *      cifrão na frente. Não `MXN 249,90`, que era o que a tela mostrava antes
 *      desta feature (vírgula decimal brasileira com o código colado).
 *
 * Devolve a organização para BRL no final: outros specs que compartilham este
 * banco local presumem `'BRL'`.
 *
 * Pré-requisito: `.e2e-creds.json` (gerado por scripts/seed-e2e-credentials.ts).
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

let creds = lerCreds();
// ⚠️ `evidence/`, não `.superpowers/evidence/` — a segunda é gitignored de
// propósito. Escrever nela fazia o journey map citar caminho que `git
// ls-files` não conhece (reprova em `tests/unit/evidencia-citada.test.ts`) e,
// mais grave: um rerun deste spec não atualizava a evidência que o mapa cita,
// porque as duas pastas divergem. Mesmo padrão de `agente-novo-e-uso.spec.ts`,
// `followup-linguagem.spec.ts` e outros ~15 specs.
const EVIDENCE = path.join(process.cwd(), "evidence", "moeda-da-organizacao");
mkdirSync(EVIDENCE, { recursive: true });

async function loginAdmin(page: Page): Promise<void> {
  creds = await loginComoAdmin(page, creds);
}

/** Código único por execução — reruns num banco compartilhado ficam verdes. */
const SUFIXO = Date.now().toString(36);

test.describe("moeda da organização", () => {
  test.afterEach(async ({ page }) => {
    // Devolve o padrão para não vazar estado a outros specs do mesmo banco.
    await page.goto("/app/settings/tenant");
    const moeda = page.locator("#currency");
    if (await moeda.isVisible().catch(() => false)) {
      await moeda.click();
      await page.getByRole("option", { name: /^BRL/ }).click();
      await page.getByRole("button", { name: /salvar/i }).click();
      await expect(page.getByText(/organiza..o atualizada/i)).toBeVisible({ timeout: 10_000 });
    }
  });

  test("mudar para peso mexicano persiste depois de recarregar", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/app/settings/tenant");

    const moeda = page.locator("#currency");
    await expect(moeda).toBeVisible();
    // Estado inicial: a única organização deste banco local nasce em BRL.
    await expect(moeda).toContainText("BRL");

    await page.screenshot({ path: path.join(EVIDENCE, "moeda-01-antes.png") });

    await moeda.click();
    await page.getByRole("option", { name: /^MXN/ }).click();
    await page.getByRole("button", { name: /salvar/i }).click();
    await expect(page.getByText(/organiza..o atualizada/i)).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: path.join(EVIDENCE, "moeda-02-mxn-salvo.png") });

    // ⚠️ O TESTE É O RELOAD, não o toast. Um formulário que só atualiza o
    // estado local em memória mostraria "salvo" e a tela recarregada voltaria
    // a BRL — foi exatamente o defeito que o seletor de idioma do perfil teve
    // meses antes desta feature.
    await page.reload();
    await expect(page.locator("#currency")).toContainText("MXN");

    await page.screenshot({ path: path.join(EVIDENCE, "moeda-03-mxn-apos-reload.png") });
  });

  test("produto em peso mexicano mostra o preço na convenção do México", async ({ page }) => {
    await loginAdmin(page);

    // Precondição: a organização precisa estar em MXN para este produto herdar.
    await page.goto("/app/settings/tenant");
    await page.locator("#currency").click();
    await page.getByRole("option", { name: /^MXN/ }).click();
    await page.getByRole("button", { name: /salvar/i }).click();
    await expect(page.getByText(/organiza..o atualizada/i)).toBeVisible({ timeout: 10_000 });

    await page.goto("/app/products");
    await page.getByTestId("novo-produto").click();

    const codigo = `E2E-MXN-${SUFIXO}`;
    await page.getByTestId("produto-codigo").fill(codigo);
    await page.getByLabel(/^Nome$/).fill("Producto de prueba MXN");
    await page.getByTestId("produto-preco").fill("249,90");
    await page.getByTestId("salvar-produto").click();

    const linha = page.getByTestId(`produto-${codigo}`);
    await expect(linha).toBeVisible({ timeout: 10_000 });

    // ⚠️ A ASSERÇÃO É O NÚMERO, não a presença da linha. `comoMoeda()` (o
    // ajudante que este PR removeu) mostraria "MXN 249,90" aqui — os mesmos
    // dígitos, na convenção errada, e um teste que só checasse "o preço
    // apareceu" teria passado verde com o defeito.
    await expect(linha).toContainText("$249.90");
    await expect(linha).not.toContainText("MXN 249,90");

    await page.screenshot({ path: path.join(EVIDENCE, "moeda-04-produto-mxn.png") });
  });
});
