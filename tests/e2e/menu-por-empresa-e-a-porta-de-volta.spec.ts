/**
 * Menu lateral por EMPRESA — prova pela TELA (DoD item 12, issue #1341, PR #1359).
 *
 * Os unitários provam a álgebra (empresa ∩ vínculo ∩ papel) sobre módulos. Isto
 * prova o que a pessoa faz: abre Configurações → Organização, escolhe menos áreas,
 * salva, e o menu encolhe de verdade.
 *
 * ─── O caso que esta spec existe para guardar ────────────────────────────────
 *
 * A pergunta que não é de álgebra: **depois de encolher, dá para voltar?**
 *
 * A tela que hospeda a escolha é a própria `/app/settings/tenant`. Se ela puder
 * ser ocultada, quem administra se tranca do lado de fora — a porta que desfaz a
 * decisão some junto com as outras, e não há caminho de volta pela tela, só por
 * banco. Nenhum teste de módulo pega isso como o usuário sente: ele é sobre
 * navegar depois de ter mudado a navegação.
 *
 * Por isso a jornada termina **desfazendo pela tela** o que ela fez na tela.
 *
 * ⚠️ ESTA SPEC MUTA A ORGANIZAÇÃO (`organizations.interface_settings`), que é
 * estado compartilhado com as outras specs da mesma parte — `navegacao.spec.ts`
 * conta itens do menu. Por isso ela restaura no fim E no `afterAll`: o desfazer
 * é ao mesmo tempo a asserção que importa e a limpeza.
 *
 * Pré-requisito: `.e2e-creds.json` (gerado por `scripts/seed-e2e-credentials.ts`).
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

let creds = lerCreds();
const EVIDENCE = path.join(process.cwd(), ".superpowers", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

// A jornada é uma sequência: encolher e depois desfazer não são casos
// independentes, e rodar em paralelo os deixaria disputando a mesma organização.
test.describe.configure({ mode: "serial" });

const CONFIGURACOES = "/app/settings/tenant";

/**
 * O login é o do projeto, não um escrito aqui.
 *
 * A conta de teste tem SEGUNDO FATOR: um `fill` + `click` escrito à mão para em
 * `/login/mfa` e o `waitForURL(/\/app\//)` estoura em 30 s. Medido no job
 * 106138530381 — foi exatamente assim que este arquivo reprovou da primeira vez.
 * `loginComoAdmin` resolve o TOTP e devolve as credenciais (o segredo ROTACIONA
 * entre rodadas, então o retorno é que vale, não o `lerCreds` do início).
 */
async function login(page: Page): Promise<void> {
  creds = await loginComoAdmin(page, creds);
}

/**
 * Os itens do menu lateral, como a pessoa os vê.
 *
 * `page.locator("nav").first()` pega o primeiro `nav` da página, que não é
 * necessariamente este. O menu tem rótulo próprio, e é por ele que se pergunta.
 */
const menuLateral = (page: Page) =>
  page.getByRole("navigation", { name: "Navegação principal" });

async function itensDoMenu(page: Page): Promise<string[]> {
  await expect(menuLateral(page)).toBeVisible();
  return (await menuLateral(page).getByRole("link").allTextContents())
    .map((t) => t.trim())
    .filter(Boolean);
}

async function escolherPerfil(page: Page, perfil: "Completa" | "Simplificada"): Promise<void> {
  await page.goto(CONFIGURACOES);
  const cartao = page.getByText("Menu lateral", { exact: true });
  await expect(cartao, "o card do menu lateral não apareceu em Configurações → Organização").toBeVisible();
  await page.getByLabel(/perfil de interface/i).selectOption({ label: perfil });
  await page.getByRole("button", { name: /aplicar interface/i }).click();
  // A confirmação é a do produto, não um sleep: sem ela, o reload abaixo pode
  // acontecer antes de a action gravar, e o teste mediria o estado anterior.
  await expect(page.getByText(/menu lateral da empresa salvo/i)).toBeVisible({ timeout: 15_000 });
}

test.afterAll(async ({ browser }) => {
  // Rede de segurança: se um caso falhar no meio, a organização não pode ficar
  // simplificada para as specs seguintes da mesma parte.
  const page = await browser.newPage();
  try {
    await login(page);
    await escolherPerfil(page, "Completa");
  } finally {
    await page.close();
  }
});

test("o menu da empresa encolhe pela tela — e a porta que desfaz continua lá", async ({ page }) => {
  await login(page);

  // ── 1. Quem não mexeu em nada não vê diferença ─────────────────────────────
  // A terceira pergunta de aceite do dono. O padrão é a interface COMPLETA, e
  // ela tem de continuar sendo o que sempre foi.
  const antes = await itensDoMenu(page);
  expect(antes.length, "o menu nasceu vazio — a medição seguinte seria vacuidade").toBeGreaterThan(5);
  await page.screenshot({ path: `${EVIDENCE}/1359-1-menu-completo.png`, fullPage: true });

  // ── 2. A tela nova existe e é achável ──────────────────────────────────────
  await page.goto(CONFIGURACOES);
  await expect(page.getByText("Menu lateral", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/1359-2-card-menu-lateral.png`, fullPage: true });

  // ── 3. Escolher menos áreas encolhe o menu de verdade ──────────────────────
  await escolherPerfil(page, "Simplificada");
  await page.goto("/app/inbox");
  const depois = await itensDoMenu(page);
  expect(
    depois.length,
    `o menu não encolheu: ${antes.length} itens antes, ${depois.length} depois`,
  ).toBeLessThan(antes.length);
  await page.screenshot({ path: `${EVIDENCE}/1359-3-menu-simplificado.png`, fullPage: true });

  // ── 4. A PROVA: a porta de volta sobreviveu, e ela ABRE ────────────────────
  //
  // Sem isto, os passos acima seriam um caminho só de ida.
  //
  // A prova é CLICAR, não encontrar: um link visível que não leva a lugar nenhum
  // deixaria a pessoa trancada do mesmo jeito. E o percurso é o de quem não sabe
  // a URL — que é justamente quem fica preso.
  //
  // ⚠️ O grupo de Configurações NÃO mora dentro do `nav` que rola: o Sidebar o
  // manda para um rodapé fixo (`GRUPO_NO_RODAPE`, `Sidebar.tsx:51-52`), como
  // link do HUB (`/app/settings`). Procurá-lo dentro do `nav` devolve "não
  // encontrado" com a porta intacta — foi assim que este caso reprovou na
  // primeira rodada, e a mensagem acusava trancamento que não existia.
  const portaDeVolta = page.getByRole("link", { name: /configurações/i }).last();
  await expect(
    portaDeVolta,
    "a empresa encolheu o menu e perdeu a porta que desfaz a escolha — trancada do lado de fora",
  ).toBeVisible();
  await portaDeVolta.click();
  await page.waitForURL(/\/app\/settings/);
  await page.getByRole("link", { name: /organização/i }).first().click();
  await page.waitForURL(new RegExp(CONFIGURACOES.replace(/\//g, "\\/")));
  await expect(
    page.getByText("Menu lateral", { exact: true }),
    "chegou em Configurações → Organização e o card que desfaz a escolha não está lá",
  ).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/1359-4-porta-de-volta.png`, fullPage: true });

  // ── 5. E ela funciona: desfazer pela TELA devolve o menu ───────────────────
  await escolherPerfil(page, "Completa");
  await page.goto("/app/inbox");
  const restaurado = await itensDoMenu(page);
  expect(
    restaurado.length,
    "desfazer pela tela não devolveu o menu ao que era",
  ).toBe(antes.length);
  await page.screenshot({ path: `${EVIDENCE}/1359-5-menu-restaurado.png`, fullPage: true });
});
