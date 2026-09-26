/**
 * A GUARDA DO PORTÃO DE HIDRATAÇÃO — prova que ele DISTINGUE, não que ele
 * espera.
 *
 * `aguardarGradeHidratada` (em `helpers/agenda-semana-integra.ts`) existe para
 * impedir que as specs de agenda leiam e cliquem no HTML que o servidor
 * desenhou, antes de o React assumir a página. Uma espera que nunca reprova é
 * decorativa: ela fica verde tanto na página viva quanto no desenho morto, e
 * ninguém percebe até o vermelho voltar com outro nome.
 *
 * Então esta spec sabota a hidratação de propósito — bloqueia os pacotes de
 * JavaScript da aplicação depois do login, deixando a Agenda exatamente como o
 * servidor a mandou — e exige que o portão REPROVE, com a mensagem dele.
 *
 * É o caso irmão do vermelho de 2026-09-20 (`agenda-google-sync.spec.ts:229`,
 * quatro rodadas com `Expected: not "2026-09-20"`): lá a leitura pré-hidratação
 * pegou a semana que o servidor calculou no fuso DELE, e a comparação do fim
 * ficou impossível de passar.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

import { aguardarGradeHidratada } from "./helpers/agenda-semana-integra";

// Mesmo fuso das irmãs: o portão não depende disso, mas o ambiente da guarda
// tem de ser o mesmo em que o defeito apareceu.
test.use({ timezoneId: "America/Sao_Paulo" });

const RAIZ = path.resolve(__dirname, "../..");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: { tipo_nome: string; tipo_slug: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p))
    throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

async function entrar(page: Page, creds: Creds) {
  // `manager` e não `admin`: o admin do seed tem MFA com challenge, e esta spec
  // não é sobre login. Mesmo molde das irmãs.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test("na agenda viva, o portão passa — e sem custo perceptível", async ({ page }) => {
  // O outro lado da guarda. Sem ele, trocar o portão por `expect(false)` deixaria
  // o caso da sabotagem verde e ninguém veria: um portão que reprova SEMPRE
  // também "distingue" no papel, e quebraria toda spec de agenda.
  const creds = lerCreds();
  await entrar(page, creds);
  await page.goto("/app/agenda");
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 20_000 });

  await aguardarGradeHidratada(page);
});

test("sem o JavaScript da aplicação, o portão REPROVA em vez de medir o HTML do servidor", async ({
  page,
}) => {
  const creds = lerCreds();
  await entrar(page, creds); // o login precisa da página viva; a sabotagem vem depois

  // A partir daqui a aplicação não recebe mais JavaScript: o que chegar na tela
  // é o que o servidor desenhou, e só.
  await page.route("**/_next/static/chunks/**", (rota) => rota.abort());

  await page.goto("/app/agenda");

  // O HTML do servidor JÁ traz as colunas — é por isso que `toBeAttached`
  // sozinho não servia de portão. Este `expect` não é preparação: é a metade da
  // guarda que prova que a sabotagem deixou a página no estado certo (desenhada
  // e morta), e não simplesmente vazia.
  await expect(
    page.locator('[data-testid^="coluna-dia-"]').first(),
    "a sabotagem deixou a página SEM colunas — então o caso abaixo reprovaria por " +
      "ausência de grade, não por ausência de hidratação, e não mediria o portão",
  ).toBeAttached({ timeout: 25_000 });

  // Teto curto de propósito: o que se mede aqui é a DISTINÇÃO, não a paciência.
  // Com o teto de produção (25 s) este caso custaria meio minuto de CI para
  // provar a mesma coisa.
  await expect(aguardarGradeHidratada(page, 4_000)).rejects.toThrow(/não hidratou/i);
});
