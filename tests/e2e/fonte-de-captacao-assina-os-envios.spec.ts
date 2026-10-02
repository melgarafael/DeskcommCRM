/**
 * A ASSINATURA DA FONTE, PELA TELA, ATÉ O 401 E O 200.
 *
 * O que esta spec prova e nenhum teste de unidade alcança: o segredo que a TELA
 * mostrou é o mesmo que o SERVIDOR confere. Ela lê o valor da tela — não de um
 * seed, não de uma variável — assina o corpo com ele e manda de verdade no
 * endereço público da fonte. As três respostas que importam, na ordem:
 *
 *   sem segredo           → 200  (controle: sem ele a fonte aceita qualquer envio)
 *   com segredo, sem assinar  → 401
 *   com segredo, assinatura errada → 401
 *   com segredo, assinado com o valor DA TELA → 200
 *
 * O controle no topo é o que impede o verde falso: sem ele, uma fonte que
 * recusasse tudo passaria nos três 401 e ninguém veria.
 *
 * Jornada de quem instala: Automações › Receber dados → criar fonte → gerar o
 * segredo → copiar → ligar no sistema que envia. A parte que o leigo mais erra
 * é achar que o "Enviar lead de teste" continua servindo depois de ligar a
 * assinatura; a tela tira o botão de cena e diz por quê.
 */
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page, type Locator } from "./helpers/test";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "assinatura-da-fonte-de-captacao");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const ts = Date.now();
const SOURCE_NAME = `E2E Assinatura ${ts}`;

function cardOf(locator: Locator): Locator {
  return locator.locator(
    "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' border-border ')][1]",
  );
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

async function selectFirstOption(page: Page, combobox: Locator): Promise<void> {
  await combobox.click();
  await page.getByRole("option").first().click();
}

/** O HMAC que o integrador teria de calcular do lado dele. */
function assinar(corpo: string, segredo: string): string {
  return createHmac("sha256", segredo).update(corpo).digest("hex");
}

test.describe("fonte de captação — assinatura pela tela", () => {
  test.setTimeout(180_000);
  test.use({ actionTimeout: 10_000 });

  test("gera o segredo na tela, e o endereço passa a recusar quem não assina", async ({
    page,
    request,
  }) => {
    let sourceId: string | undefined;
    fs.mkdirSync(EVIDENCIA, { recursive: true });

    try {
      await login(page, creds.users.manager!.email);
      await page.goto(`${APP_URL}/app/webhooks`);

      // --- cria a fonte, como o guia de instalação manda ---
      await page.getByRole("button", { name: /Nova fonte|Criar primeira fonte/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.locator("#src-name").fill(SOURCE_NAME);
      const dialog = page.getByRole("dialog");
      await selectFirstOption(page, dialog.getByRole("combobox").nth(0));
      await selectFirstOption(page, dialog.getByRole("combobox").nth(1));

      const [createRes] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/v1/webhook-sources") && r.request().method() === "POST",
        ),
        page.getByRole("button", { name: "Criar fonte" }).click(),
      ]);
      const criada = (await createRes.json()) as { data: { id: string; path_token: string } };
      sourceId = criada.data.id;
      const sourceUrl = `${APP_URL}/api/v1/webhooks/in/${criada.data.path_token}`;

      const sheet = page.getByRole("dialog").filter({ hasText: SOURCE_NAME });
      await expect(sheet).toBeVisible();

      // --- CONTROLE: sem assinatura configurada, a fonte aceita qualquer envio ---
      const semNada = await request.post(sourceUrl, {
        data: { nome: `Controle ${ts}`, telefone: "11987650001" },
      });
      expect(
        semNada.status(),
        "controle: fonte recém-criada tem de aceitar envio sem assinatura — " +
          "sem este 200, os 401 abaixo não provam nada",
      ).toBe(200);

      // --- a seção nasce desligada, e o botão de teste está disponível ---
      await expect(sheet.getByText("Assinatura (HMAC)")).toBeVisible();
      await expect(sheet.getByText("Desligada")).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Enviar lead de teste" })).toBeEnabled();
      await page.screenshot({ path: path.join(EVIDENCIA, "1-assinatura-desligada.png") });

      // --- gera: o valor aparece UMA vez ---
      await sheet.getByRole("button", { name: "Gerar segredo" }).click();
      await expect(sheet.getByText("Guarde agora. Ele não será mostrado de novo.")).toBeVisible();
      await expect(sheet.getByText("Ligada")).toBeVisible();

      // O segredo LIDO DA TELA — é isto que faz esta spec provar a tela, e não
      // um valor que o teste mesmo escolheu.
      const segredo = (
        await sheet.locator("code").filter({ hasText: /^[0-9a-f]{64}$/ }).innerText()
      ).trim();
      expect(segredo).toMatch(/^[0-9a-f]{64}$/);
      await page.screenshot({ path: path.join(EVIDENCIA, "2-segredo-uma-vez.png") });

      // --- com a assinatura ligada, o teste da tela sai de cena ---
      await expect(sheet.getByRole("button", { name: "Enviar lead de teste" })).toBeDisabled();
      await expect(
        sheet.getByText("Com assinatura ativa, teste a partir do sistema que envia os dados."),
      ).toBeVisible();

      // --- 401 sem assinar ---
      const corpo = JSON.stringify({ nome: `Sem assinar ${ts}`, telefone: "11987650002" });
      const semAssinatura = await request.post(sourceUrl, {
        headers: { "Content-Type": "application/json" },
        data: corpo,
      });
      expect(semAssinatura.status(), "envio sem assinatura tem de ser recusado").toBe(401);

      // --- 401 com assinatura errada ---
      const assinaturaErrada = await request.post(sourceUrl, {
        headers: {
          "Content-Type": "application/json",
          "X-Deskcomm-Signature": assinar(corpo, "segredo-que-nao-e-o-da-tela"),
        },
        data: corpo,
      });
      expect(assinaturaErrada.status(), "assinatura de outro segredo tem de ser recusada").toBe(401);

      // --- 200 assinado com o valor QUE A TELA MOSTROU ---
      const corpoBom = JSON.stringify({ nome: `Assinado ${ts}`, telefone: "11987650003" });
      const assinado = await request.post(sourceUrl, {
        headers: {
          "Content-Type": "application/json",
          "X-Deskcomm-Signature": assinar(corpoBom, segredo),
        },
        data: corpoBom,
      });
      expect(
        assinado.status(),
        "o segredo que a TELA mostrou tem de ser o que o servidor confere",
      ).toBe(200);

      // --- fecha e reabre: estado sim, valor não ---
      await page.keyboard.press("Escape");
      await cardOf(page.getByText(SOURCE_NAME, { exact: true })).click();
      const reaberto = page.getByRole("dialog").filter({ hasText: SOURCE_NAME });
      await expect(reaberto.getByText("Ligada")).toBeVisible();
      await expect(reaberto.getByText(segredo)).toHaveCount(0);
      await expect(
        reaberto.getByText("Guarde agora. Ele não será mostrado de novo."),
      ).toHaveCount(0);
      await page.screenshot({ path: path.join(EVIDENCIA, "3-reaberto-sem-valor.png") });

      // --- remover devolve a fonte ao estado sem assinatura ---
      await reaberto.getByRole("button", { name: "Remover segredo" }).click();
      await page.getByRole("button", { name: "Remover", exact: true }).click();
      await expect(reaberto.getByText("Desligada")).toBeVisible();

      const depoisDeRemover = await request.post(sourceUrl, {
        data: { nome: `Depois de remover ${ts}`, telefone: "11987650004" },
      });
      expect(
        depoisDeRemover.status(),
        "removida a assinatura, a fonte volta a aceitar envio sem ela",
      ).toBe(200);
      await page.screenshot({ path: path.join(EVIDENCIA, "4-assinatura-removida.png") });
    } finally {
      try {
        if (sourceId) {
          await page.goto(`${APP_URL}/app/webhooks`);
          const titulo = page.getByText(SOURCE_NAME, { exact: true });
          const visivel = await titulo
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
          if (visivel) {
            await cardOf(titulo).click();
            await page.getByRole("button", { name: "Excluir fonte" }).click();
            await page.getByRole("button", { name: "Excluir", exact: true }).click();
          }
        }
      } catch (erroDeLimpeza) {
        console.error("[cleanup] falhou (não mascara o erro do teste):", erroDeLimpeza);
      }
    }
  });
});
