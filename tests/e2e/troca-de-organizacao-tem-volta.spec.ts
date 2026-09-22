import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

/**
 * TROCAR DE ORGANIZAÇÃO TEM VOLTA — mesmo quando a organização de destino
 * ainda não foi configurada.
 *
 * ─── O defeito, e como ele apareceu ──────────────────────────────────────
 *
 * `app/app/layout.tsx` manda para `/onboarding` toda organização ativa sem
 * `onboarded_at`. Então trocar de organização pelo seletor do topo — um clique,
 * a ação mais banal do cabeçalho — podia levar ao wizard de seis passos da
 * organização nova **e tirar o seletor da tela junto**: o layout de `/app` sai
 * inteiro da árvore, e o `TenantSwitcher` mora nele.
 *
 * O que sobrava, medido no snapshot de uma falha do CI (run 33164258175):
 * "Termos de Uso", "Política de Privacidade" e um "Continuar" desabilitado.
 * Três controles, nenhuma saída. Quem foi convidado para uma organização nova e
 * trocou para ver o que era ficava sem caminho de volta — limpar cookie ou
 * adivinhar a URL de logout.
 *
 * O vermelho do CI era outro (dois seeds disputando o mesmo slug deixavam a org
 * B sem onboarding), e essa parte se conserta no harness. Esta spec prende o
 * que o vermelho EXPÔS, que é de produto e sobrevive ao conserto do seed.
 *
 * ─── Por que a organização do seed de funis ──────────────────────────────
 *
 * Depois da separação dos slugs, `e2e-segunda-org` é o único lugar do harness
 * com uma organização legitimamente **não configurada** — e é exatamente o
 * fixture de que este caso precisa. Está escrito lá, no `insert`, para ninguém
 * "consertar" a ausência do `onboarded_at` achando que é descuido.
 */
const RAIZ = path.resolve(__dirname, "../..");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  funis?: { segunda_org_id: string };
  duas_orgs?: { org_a_id: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  // A spec semeia a própria precondição: depender de `pipelines-gestao` ter
  // rodado antes seria depender da ORDEM, que é o defeito que esta suíte já
  // pagou mais de uma vez.
  if (!c.funis || !c.duas_orgs) {
    if (!c.duas_orgs) execFileSync("npx", ["tsx", "scripts/seed-e2e-duas-organizacoes.ts"], { stdio: "inherit" });
    if (!c.funis) execFileSync("npx", ["tsx", "scripts/seed-e2e-funis.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.funis?.segunda_org_id) throw new Error("o seed de funis não gravou `funis.segunda_org_id`");
  if (!c.duas_orgs?.org_a_id) throw new Error("o seed de duas orgs não gravou `duas_orgs.org_a_id`");
  return c;
}

async function entrar(page: Page, creds: Creds) {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test.describe.configure({ timeout: 150_000 });

test("trocar para uma organização não configurada leva ao wizard — e dá para voltar", async ({ page }) => {
  const creds = lerCreds();
  const semOnboarding = creds.funis!.segunda_org_id;
  const orgA = creds.duas_orgs!.org_a_id;

  await entrar(page, creds);
  await page.goto("/app/inbox");

  // Ancora na org A e guarda o nome dela — é para cá que a volta tem de trazer.
  const seletor = page.getByTestId("tenant-switcher");
  await expect(seletor).toBeVisible({ timeout: 20_000 });
  await seletor.click();
  await page.getByTestId(`tenant-switcher-item-${orgA}`).click();
  await expect(seletor).toBeEnabled({ timeout: 60_000 });
  const nomeDaOrgA = (await seletor.textContent())!.trim();
  expect(nomeDaOrgA.length, "o seletor não anuncia o nome da organização ativa").toBeGreaterThan(0);

  // ── a troca que prendia ────────────────────────────────────────────────
  await seletor.click();
  await page.getByTestId(`tenant-switcher-item-${semOnboarding}`).click();

  // O wizard é o destino CORRETO — a organização não está configurada mesmo. O
  // defeito nunca foi vir para cá; foi não ter como sair.
  //
  // ⚠️ A FALHA AQUI TEM DE DIZER A CAUSA. Sem o `catch`, um fixture com
  // `onboarded_at` carimbado por outro seed reprovava com `page.waitForURL:
  // Timeout 60000ms exceeded` — verdadeiro e inútil, porque a causa (a
  // organização do fixture deixou de estar não-configurada) não aparece em
  // lugar nenhum da mensagem. Medido: aconteceu no ambiente de outro terminal
  // antes de `seed-e2e-funis` passar a garantir o próprio fixture.
  try {
    await page.waitForURL(/\/onboarding/, { timeout: 60_000 });
  } catch (erro) {
    throw new Error(
      `troquei para a organização ${semOnboarding} e o produto NÃO mandou para o wizard ` +
        `(fiquei em ${page.url()}). O caso precisa de uma organização SEM \`onboarded_at\`, e ` +
        "quem garante isso é `scripts/seed-e2e-funis.ts` — se aquele seed parou de zerar o " +
        `campo na org que reencontra, é aqui que aparece.\n\n${(erro as Error).message}`,
    );
  }
  await expect(
    page.getByTestId("tenant-switcher"),
    "o seletor de organização sobreviveu ao redirect — se ele está aqui, este caso perdeu o objeto",
  ).toHaveCount(0);

  // ── A SAÍDA ────────────────────────────────────────────────────────────
  const saida = page.getByTestId("sair-do-onboarding");
  await expect(
    saida,
    "o wizard não oferece caminho de volta — quem trocou de organização por engano fica preso aqui",
  ).toBeVisible({ timeout: 15_000 });

  await saida.click();
  // Com mais de uma organização de destino a saída abre um menu; com uma só, o
  // clique já basta. Cobrimos o caminho que este ambiente produz.
  const item = page.getByTestId(`sair-do-onboarding-item-${orgA}`);
  if ((await item.count()) > 0) await item.click();

  // ── e a volta CHEGA: o produto de novo, na organização de antes ────────
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
  const seletorDeVolta = page.getByTestId("tenant-switcher");
  await expect(seletorDeVolta, "voltei para o produto e o seletor não reapareceu").toBeVisible({
    timeout: 20_000,
  });
  await expect(seletorDeVolta).toBeEnabled({ timeout: 60_000 });
  await expect(
    seletorDeVolta,
    `a volta não trouxe para "${nomeDaOrgA}" — trocou de lugar, não desfez a troca`,
  ).toContainText(nomeDaOrgA, { timeout: 20_000 });

  await page.screenshot({ path: "evidence/onboarding/troca-de-org-tem-volta.png" });
});
