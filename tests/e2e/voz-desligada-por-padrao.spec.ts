/**
 * A CHAMADA DE VOZ NUM PRIMEIRO DEPLOY — provada pela tela, sem o serviço instalado.
 *
 * ## Por que ESTE é o estado que importa
 *
 * Nenhuma instalação nasce com a chamada de voz. O serviço `wacalls` vive atrás
 * do profile `voz` no `docker-compose.prod.yml`, e `WACALLS_API_BASE_URL` nasce
 * vazia. Ou seja: **este spec roda no estado em que 100% das instalações
 * começam** — que é o que a doutrina de QA Visual manda testar ("com os envs
 * opcionais AUSENTES, é o estado real de um primeiro deploy, e é onde moram os
 * piores bugs de primeira impressão").
 *
 * Não é preciso configurar nada para chegar nele: o `.env.e2e` do CI não define
 * `WACALLS_API_BASE_URL`. E se alguém a acrescentar lá, o primeiro caso falha
 * **alto** em vez de virar verde vazio — ele confere o estado com o backend
 * antes de afirmar qualquer coisa sobre a tela.
 *
 * ## O que ele guarda
 *
 * Três coisas que o dono do produto pediu explicitamente, e que só a tela prova:
 *
 * 1. **Desligada por padrão.** Chamada de voz vincula um segundo aparelho ao
 *    número de WhatsApp por um caminho não-oficial, e o risco é a CONTA, não a
 *    chamada. Nascer ligada seria decidir esse risco pelo dono do negócio.
 * 2. **O risco vem ANTES do controle**, em português de quem não é técnico.
 * 3. **Nada de controle decorativo.** Numa instalação sem o serviço, a tela
 *    NÃO oferece um botão que falharia — ela explica que quem cuida do servidor
 *    precisa ligá-lo antes. Oferecer o botão faria a pessoa tentar, falhar, e
 *    não saber por quê.
 *
 * ## O que ele NÃO tenta provar, e por quê
 *
 * Não prova uma ligação real. Isso depende de parear um número de WhatsApp de
 * verdade (QR num celular) e de alguém do outro lado do telefone — não é
 * reproduzível num runner do CI, e fingir que sim com mock seria pior que a
 * ausência declarada. A ligação de verdade é medida à mão, na VPS.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3031 pnpm exec playwright test tests/e2e/voz-desligada-por-padrao.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "e2e-artifacts");
fs.mkdirSync(EVIDENCIA, { recursive: true });

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  admin_totp?: { factor_id: string; secret: string };
}

function loadCreds(): Creds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.admin;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

/**
 * ⚠️ ADMIN, e aqui isso NÃO é opcional — diferente do spec de notificações.
 *
 * O painel mostra o controle só para `podeEditar`, que é `role >= admin`. Um
 * `agent` veria "Só quem é administrador desta empresa pode mudar isto" e o
 * spec mediria a frase errada. E o admin do seed tem TOTP **verified** sempre,
 * então o login para em `/login/mfa` — por isso o challenge abaixo.
 */
async function entrarComoAdmin(page: Page): Promise<void> {
  const segredo = creds.admin_totp?.secret;
  expect(segredo, "o seed não trouxe o segredo TOTP do admin — sem ele não há como entrar").toBeTruthy();

  await page.goto("/login");
  await page.locator("#email").fill(creds.users.admin!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/login\/mfa/);

  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    if (msUntilNextTotpWindow() < 3_000) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(segredo as string), { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 8_000 });
      return;
    } catch {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA do admin não passou em 2 tentativas de TOTP");
}

test.describe("chamada de voz — o estado em que toda instalação começa", () => {
  test("desligada por padrão, com o risco antes do controle e sem botão que falharia", async ({
    page,
  }) => {
    await entrarComoAdmin(page);

    // ── CONTROLE DE ESTADO, antes de olhar a tela ──────────────────────────
    // Sem isto, todas as asserções abaixo poderiam estar medindo uma instalação
    // COM o serviço e passando por outro motivo. É o mesmo desenho do spec de
    // notificações: conferir com o backend antes de afirmar sobre a tela.
    const estado = await page.evaluate(async () => {
      const r = await fetch("/api/v1/voice/opt-in", { credentials: "include" });
      return { status: r.status, corpo: (await r.json()) as { data?: Record<string, unknown> } };
    });
    expect(estado.status, "a rota do opt-in não respondeu").toBe(200);
    expect(
      estado.corpo.data?.ligada,
      "a organização nasceu com a chamada de voz LIGADA — isso decide o risco da conta pelo dono do negócio",
    ).toBe(false);
    expect(
      estado.corpo.data?.motivo,
      "o `.env.e2e` ganhou WACALLS_API_BASE_URL: este spec mede o primeiro deploy, e deixou de medi-lo",
    ).toBe("instalacao_nao_oferece");
    expect(
      estado.corpo.data?.podeEditar,
      "a sessão não é admin — o painel mostraria a frase de permissão e o spec mediria outra coisa",
    ).toBe(true);

    // ── A TELA ─────────────────────────────────────────────────────────────
    await page.goto("/app/settings/security");
    const painel = page.getByTestId("painel-voz");
    await expect(painel).toBeVisible();

    await expect(
      page.getByText(/Desligada\. Ninguém consegue ligar nem receber chamadas por aqui\./),
    ).toBeVisible();

    // O risco, em português de quem não é técnico, e ANTES do controle.
    const aviso = page.getByText(/Leia antes de ligar/);
    await expect(aviso).toBeVisible();
    await expect(page.getByText(/bloquear a CONTA — não só a chamada/)).toBeVisible();
    await expect(page.getByText(/Você pode desligar a qualquer momento aqui mesmo/)).toBeVisible();

    // ── NADA DE CONTROLE DECORATIVO ────────────────────────────────────────
    // Sem o serviço, nenhum clique nesta tela resolve. A tela diz isso em vez
    // de oferecer um botão que falharia.
    await expect(
      page.getByText(/Este servidor não tem a chamada de voz instalada/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Ligar chamada de voz/ }),
      "a tela ofereceu ligar numa instalação que não tem o serviço — o clique falharia sem explicação",
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Desligar e desconectar o aparelho/ }),
    ).toHaveCount(0);

    // ── QUALIDADE DE TELA, medida por ferramenta e não a olho ──────────────
    const texto = (await painel.innerText()).trim();

    // Vazamento de chave de tradução: `t()` devolve a chave quando o verbete
    // falta, e a chave chega à tela parecendo texto.
    expect(texto, "a tela mostra o que parece uma chave de tradução crua").not.toMatch(
      /\b[a-z]+(?:[._][a-z]+){2,}\b/,
    );
    // Asterisco literal de markdown mal fechado, e chaves de interpolação.
    expect(texto).not.toMatch(/\*\*|\{\{|\}\}|undefined|NaN|\[object Object\]/);

    // O painel não pode estourar a largura da página.
    const estouro = await page.evaluate(() => {
      const doc = document.documentElement;
      return { scroll: doc.scrollWidth, cliente: doc.clientWidth };
    });
    expect(
      estouro.scroll,
      `a página rola na horizontal (${estouro.scroll}px de conteúdo para ${estouro.cliente}px de tela)`,
    ).toBeLessThanOrEqual(estouro.cliente + 1);

    await page.screenshot({
      path: path.join(EVIDENCIA, "voz-primeiro-deploy.png"),
      fullPage: true,
    });
  });

  test("o painel aparece para quem administra, e não é preciso digitar a URL para chegar nele", async ({
    page,
  }) => {
    // Ter tela e ser alcançável são coisas diferentes (DoD 14). Este caso
    // chega ao painel PELA NAVEGAÇÃO, como um leigo faria — não por `goto`.
    await entrarComoAdmin(page);

    await page.goto("/app");

    // Locator por HREF, não por rótulo: o texto do menu é matéria de produto e
    // pode mudar; o endereço é o contrato. Um spec que casa rótulo reprova
    // quando alguém renomeia "Configurações", e isso não é o defeito que ele
    // existe para pegar.
    const porta = page.locator('a[href="/app/settings"]').first();
    await expect(porta, "não há porta para Configurações na navegação").toBeVisible();
    await porta.click();
    await page.waitForURL(/\/app\/settings(\/)?$/);

    const paraSeguranca = page.locator('a[href="/app/settings/security"]').first();
    await expect(paraSeguranca, "a tela de Segurança não está listada em Configurações").toBeVisible();
    await paraSeguranca.click();
    await page.waitForURL(/\/app\/settings\/security/);

    await expect(page.getByTestId("painel-voz")).toBeVisible();
  });
});
