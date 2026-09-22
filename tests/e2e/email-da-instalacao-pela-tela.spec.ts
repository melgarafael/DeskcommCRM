import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

/**
 * O DONO DA INSTALAÇÃO CONFIGURA O SERVIDOR DE E-MAIL PELA TELA.
 *
 * ═══ POR QUE ESTA SPEC EXISTE ═══
 *
 * Este produto é distribuído open-source: a experiência de quem instala numa VPS
 * É o produto. Até aqui, mandar e-mail exigia abrir conta num serviço externo e
 * verificar domínio lá ANTES do primeiro convite de equipe — e o caminho novo só
 * vale se a pessoa conseguir percorrê-lo pela interface, sem SSH e sem `.env`.
 * `curl` na server action provaria o backend e não provaria isso.
 *
 * ═══ O QUE ELA DIRIGE, E EM QUE ORDEM ═══
 *
 * A ordem é a de quem acabou de instalar:
 *   1. entra, e ACHA a tela pelo menu — não digitando a URL. Tela que existe e
 *      tela que é alcançável são coisas diferentes, e a versão original desta
 *      funcionalidade vivia no menu da EMPRESA, escondida por uma exceção.
 *   2. lê o estado honesto de uma instalação recém-subida: nenhum caminho de
 *      e-mail configurado, e o que isso significa na prática.
 *   3. preenche, testa e salva.
 *   4. volta à tela e encontra o que salvou — MENOS a senha, que não volta.
 *
 * ═══ O QUE ELA NÃO PROVA ═══
 *
 * Que um e-mail CHEGA. Não há servidor SMTP de verdade neste ambiente, e o botão
 * de testar conexão fala com a rede: o caso (3) exercita o caminho até a recusa,
 * que é o desfecho correto contra um host que não existe, e é o que o operador
 * vê quando erra o endereço. Entrega ponta a ponta precisa de um receiver real e
 * é outro teste.
 *
 * ⚠️ Esta spec ESCREVE a configuração de e-mail da instalação (singleton
 * `platform_smtp_settings`). Ela limpa o que subiu no `afterAll`, pela mesma
 * server action que a tela usa — e não por SQL, porque quem valida a entrada é o
 * produto.
 */

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "email-da-instalacao");

interface E2ECreds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  admin_totp?: { factor_id: string; secret: string };
  dono_totp?: { factor_id: string; secret: string };
}

function loadCreds(): E2ECreds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
    return !c.users?.dono || !c.admin_totp?.secret || !c.dono_totp?.secret || !c.org_id;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  // Promove `dono` a platform admin e REVOGA a do `admin` — idempotente. Sem a
  // revogação, o caso (4) mediria um escape e chamaria de separação de camadas.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-system-update.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

const creds = loadCreds();

/** Mesmo helper das demais specs: os dois usuários do seed têm TOTP cadastrado. */
async function loginComTotp(page: Page, email: string, secret: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click({ timeout: 15_000 });
  await page.waitForURL(/\/login\/mfa/);

  const digito1 = page.locator('input[aria-label="Dígito 1"]');
  const recusa = page.locator("form").getByRole("alert");

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    await digito1.click({ timeout: 15_000 });
    await page.keyboard.type(generateTotp(secret), { delay: 40 });

    const desfecho = await Promise.race([
      page.waitForURL(/\/app\//, { timeout: 60_000 }).then(
        () => "entrou" as const,
        () => "sem-desfecho" as const,
      ),
      recusa.waitFor({ state: "visible", timeout: 60_000 }).then(
        () => "recusado" as const,
        () => "sem-desfecho" as const,
      ),
    ]);
    if (desfecho === "entrou") return;
    if (desfecho === "sem-desfecho") {
      throw new Error(
        `o desafio de MFA de ${email} não terminou em 60s. url=${page.url()}`,
      );
    }
    await page.waitForTimeout(msUntilNextTotpWindow() + 200);
  }
  throw new Error(`MFA falhou depois de 2 tentativas para ${email} (url=${page.url()})`);
}

async function entrarComoDono(page: Page): Promise<void> {
  const email = creds.users.dono?.email;
  const secret = creds.dono_totp?.secret;
  expect(email, "sem `dono` no .e2e-creds.json").toBeTruthy();
  expect(secret, "sem `dono_totp` no .e2e-creds.json").toBeTruthy();
  await loginComTotp(page, email!, secret!);
}

const SERVIDOR = {
  host: "smtp.exemplo-e2e.test",
  porta: "465",
  usuario: "nao-responda@exemplo-e2e.test",
  senha: "senha-de-teste-do-smtp",
  remetente: "nao-responda@exemplo-e2e.test",
  nome: "Clínica Bem Viver",
};

test.beforeAll(() => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
});

test.describe("o servidor de e-mail da instalação, pela tela", () => {
  test("(1) o dono acha a tela PELO MENU, e ela diz o estado honesto de quem acabou de instalar", async ({
    page,
  }) => {
    await entrarComoDono(page);

    // Pela porta, e não pela URL: é a diferença entre uma tela que existe e uma
    // tela alcançável por quem não sabe que ela existe.
    await page.goto("/admin/dashboard");
    const porta = page.getByRole("link", { name: "E-mail", exact: true });
    await expect(porta, "não há porta para a tela de e-mail no menu do admin").toBeVisible({
      timeout: 15_000,
    });
    await porta.click();
    await page.waitForURL(/\/admin\/email/);

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Servidor de e-mail");
    // O estado honesto: numa instalação sem e-mail nenhum, a tela diz o que
    // acontece na prática com os convites, em vez de só "não configurado".
    await expect(page.getByTestId("smtp-estado")).toContainText(/link para copiar/i);
    await expect(page.getByTestId("smtp-host")).toHaveValue("");

    // Medido por ferramenta, não a olho: a tela não pode estourar a largura no
    // telefone, que é onde o dono da VPS costuma abrir o painel.
    await page.setViewportSize({ width: 390, height: 844 });
    const estouro = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(estouro, `a tela rola ${estouro}px na horizontal a 390px de largura`).toBeLessThanOrEqual(0);

    await page.screenshot({ path: path.join(EVIDENCIA, "1-recem-instalado.png"), fullPage: true });
  });

  test("(2) preencher e salvar deixa a tela dizendo que o e-mail passou a sair por ele", async ({
    page,
  }) => {
    await entrarComoDono(page);
    await page.goto("/admin/email");

    await page.getByTestId("smtp-host").fill(SERVIDOR.host);
    await page.getByTestId("smtp-port").fill(SERVIDOR.porta);
    await page.getByTestId("smtp-security").selectOption("tls");
    await page.getByTestId("smtp-username").fill(SERVIDOR.usuario);
    await page.getByTestId("smtp-password").fill(SERVIDOR.senha);
    await page.getByTestId("smtp-from-email").fill(SERVIDOR.remetente);
    await page.getByTestId("smtp-from-name").fill(SERVIDOR.nome);
    await page.screenshot({ path: path.join(EVIDENCIA, "2-preenchido.png"), fullPage: true });

    await page.getByTestId("smtp-salvar").click();
    await expect(page.getByText(/servidor de e-mail salvo/i)).toBeVisible({ timeout: 20_000 });

    // O estado da tela acompanha o que foi salvo — sem isto, quem salva não tem
    // como saber se a entrega mudou de caminho.
    await expect(page.getByTestId("smtp-estado")).toContainText(/em uso/i, { timeout: 20_000 });
    await page.screenshot({ path: path.join(EVIDENCIA, "3-em-uso.png"), fullPage: true });
  });

  test("(3) ao voltar, os campos estão lá — e a SENHA não volta", async ({ page }) => {
    await entrarComoDono(page);
    await page.goto("/admin/email");

    await expect(page.getByTestId("smtp-host")).toHaveValue(SERVIDOR.host);
    await expect(page.getByTestId("smtp-port")).toHaveValue(SERVIDOR.porta);
    await expect(page.getByTestId("smtp-from-email")).toHaveValue(SERVIDOR.remetente);
    await expect(page.getByTestId("smtp-from-name")).toHaveValue(SERVIDOR.nome);

    // A senha NÃO volta preenchida, e a tela diz que existe uma guardada — as
    // duas coisas, porque campo vazio sem explicação faria o dono achar que ela
    // se perdeu e digitar de novo.
    await expect(page.getByTestId("smtp-password")).toHaveValue("");
    await expect(page.getByText(/já existe uma senha gravada/i)).toBeVisible();

    // E ela também não está escondida em lugar nenhum do que o servidor mandou.
    const html = await page.content();
    expect(html, "a senha do SMTP apareceu no HTML da tela").not.toContain(SERVIDOR.senha);

    // O botão de testar fala com a rede: contra um host que não existe, o
    // desfecho certo é a recusa NOMEADA — é o que o operador vê quando erra o
    // endereço, e "não deu" o mandaria conferir quatro coisas de uma vez.
    await page.getByTestId("smtp-testar").click();
    await expect(
      page.getByText(/não foi possível falar com o servidor|recusou o usuário e a senha/i),
    ).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: path.join(EVIDENCIA, "4-senha-nao-volta.png"), fullPage: true });
  });

  test("(4) quem administra uma EMPRESA não alcança a tela da instalação", async ({ page }) => {
    const email = creds.users.admin?.email;
    const secret = creds.admin_totp?.secret;
    expect(email, "sem `admin` no .e2e-creds.json").toBeTruthy();
    await loginComTotp(page, email!, secret!);

    await page.goto("/admin/email");

    // O que o produto FAZ, medido: o layout de `/admin/(protected)` roda
    // `requirePlatformAdmin()` ANTES da página, e quem não tem linha ativa em
    // `platform_admins` é REDIRECIONADO para `/admin/forbidden`. O `notFound()`
    // da página é o segundo cadeado (ele vale se o layout for movido) e por isso
    // nunca chega a rodar aqui.
    //
    // Esta asserção pedia 404 e recebia 200 — o 200 da tela de recusa, para onde
    // o redirect leva. Medir o STATUS da navegação final não distingue "foi
    // barrado" de "entrou": as duas coisas são 200. Quem distingue é ONDE ele
    // parou e o que a tela mostra.
    await expect(page).toHaveURL(/\/admin\/forbidden(\?|$)/);
    await expect(page.getByTestId("smtp-salvar")).toHaveCount(0);
  });
});

test.afterAll(async ({ browser }) => {
  // Limpeza pela MESMA action que a tela usa. Um `update` direto no banco pularia
  // a validação e deixaria a próxima spec medindo um estado que o produto nunca
  // produziria.
  const page = await browser.newPage();
  try {
    await entrarComoDono(page);
    await page.goto("/admin/email");
    await page.getByTestId("smtp-host").fill("");
    await page.getByTestId("smtp-from-email").fill("");
    await page.getByTestId("smtp-username").fill("");
    await page.getByTestId("smtp-from-name").fill("");
    await page.getByTestId("smtp-salvar").click();
    await expect(page.getByText(/servidor de e-mail salvo/i)).toBeVisible({ timeout: 20_000 });
  } finally {
    await page.close();
  }
});
