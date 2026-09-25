import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * QUEM SÓ LÊ NÃO RECEBE OS GESTOS DE ESCRITA DA AGENDA (PR #1013).
 *
 * O piso da rota que cria compromisso é `requireRole("agent")`
 * (`app/api/v1/agenda/agendamentos/route.ts`). Antes do #1013 a TELA não sabia
 * disso: `app/app/agenda/_client.tsx` renderizava o botão "Novo agendamento"
 * sem gate nenhum (só `disabled={!tipo}`) e passava `onMarcarEm` sempre, então
 * o `viewer` — e o acompanhamento só-de-leitura, que `resolveActiveOrg` resolve
 * como `viewer` — via as três portas de escrita e levava **403 depois do
 * gesto**. Recusar no fim do gesto é o defeito; esconder o gesto é a cortesia.
 * Quem decide segue sendo a rota.
 *
 * ─── Por que esta spec existe, se já há teste de unidade ──────────────────
 *
 * `tests/unit/agenda-viewer-nao-ganha-novo-agendamento.test.tsx` monta o
 * `AgendaClient` com `podeMarcar={false}` e prova o COMPONENTE. Ele não prova
 * que `app/app/agenda/page.tsx` calcula a prop a partir do papel REAL da sessão
 * (`ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent`) — que é a metade que um
 * usuário exercita ao logar. É por isso que o caso do `agent` está aqui junto:
 * um gate que esconde de TODO MUNDO também passaria no teste do viewer, e só o
 * par distingue "escondeu de quem não pode" de "sumiu com o botão".
 *
 * ─── A terceira asserção não é decorativa ────────────────────────────────
 *
 * "PRIMEIRA PORTA" é texto de COMENTÁRIO do `_client.tsx`. Ele já esteve NA
 * TELA: no primeiro corte do #1013 as três linhas `// ...` entraram como filhos
 * JSX do cabeçalho e apareciam para todo papel (o `verify` do PR reprovou por
 * `i18n-espanhol-cobre-a-tela`, não por ninguém ter olhado). Comentário que
 * vira texto de produto é o modo de falha que esta linha vigia.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/agenda-papel-de-leitura.spec.ts
 */

const ESPERA = 30_000;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), "evidence/triagem-17set-37-agenda");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: { tipo_nome: string };
}

/**
 * ⚠️ O SEED DA AGENDA É PRECONDIÇÃO DO CONTROLE, não conveniência.
 *
 * O caso do `agent` exige que a organização tenha ao menos UM tipo de
 * agendamento: sem tipo, `_client.tsx` deixa `tipo` nulo, a grade não monta a
 * camada de blocos e `[data-testid^="bloco-"]` daria **zero para os dois
 * papéis** — a asserção do viewer passaria por vacuidade, medindo o banco vazio
 * em vez do papel. O seed é idempotente.
 */
function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

/** Login por senha. `viewer` e `agent` do seed não têm MFA — o admin tem, e não é o ator aqui. */
async function entrar(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: ESPERA });
}

test.describe.configure({ mode: "serial" });

test("quem só lê abre a Agenda e não encontra nenhuma porta de escrita", async ({ page }) => {
  const creds = lerCreds();
  const viewer = creds.users.viewer;
  if (!viewer) throw new Error(".e2e-creds.json sem o usuário `viewer`");

  await entrar(page, viewer.email, creds.password);
  await page.goto("/app/agenda");

  // A tela é DELE — o papel de leitura VÊ a agenda; o que ele não tem é o gesto.
  // Sem esta asserção, um 403 na página inteira faria as contagens abaixo darem
  // zero e a spec passaria medindo a tela errada.
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: ESPERA });
  await expect(page.getByRole("heading", { name: "Agenda", exact: true })).toBeVisible();

  // PRIMEIRA PORTA — o botão do cabeçalho.
  await expect(
    page.getByTestId("novo-agendamento"),
    'o papel de leitura recebeu "Novo agendamento" — o clique dele termina em 403',
  ).toHaveCount(0);

  // E o motivo que acompanha o botão desabilitado some junto: para quem não tem
  // o gesto, explicar por que ele está desabilitado é conversa sobre algo que
  // não está na tela. `podeMarcar` vem ANTES de `!tipo` no `_client.tsx`.
  await expect(
    page.getByTestId("motivo-novo-agendamento"),
    "sem botão na tela, o motivo do botão desabilitado ficou falando sozinho",
  ).toHaveCount(0);

  // SEGUNDA PORTA — cada meia hora da grade é um `<button data-testid="bloco-…">`
  // quando `onMarcarEm` existe. Sem a prop, `AgendaInterativa` não monta a
  // `interacao` e a grade volta a ser leitura.
  await expect(
    page.locator('[data-testid^="bloco-"]'),
    "a grade continuou clicável para quem só lê — cada bloco é um POST que vai virar 403",
  ).toHaveCount(0);

  // O comentário que já foi texto de produto.
  await expect(
    page.getByText("PRIMEIRA PORTA"),
    "um comentário do código vazou para a tela do usuário",
  ).toHaveCount(0);
  const corpo = (await page.locator("body").innerText()).toUpperCase();
  expect(corpo.includes("PRIMEIRA PORTA"), "“PRIMEIRA PORTA” está no texto da página").toBe(false);

  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByTestId("tela-agenda")).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "1013-agenda-papel-de-leitura.png"), fullPage: true });
});

test("o atendente abre a MESMA tela e as portas estão lá — o controle do caso acima", async ({
  page,
}) => {
  const creds = lerCreds();
  const agente = creds.users.agent;
  if (!agente) throw new Error(".e2e-creds.json sem o usuário `agent`");

  await entrar(page, agente.email, creds.password);
  await page.goto("/app/agenda");

  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: ESPERA });
  await expect(page.getByRole("heading", { name: "Agenda", exact: true })).toBeVisible();

  await expect(
    page.getByTestId("novo-agendamento"),
    "o piso da rota é `agent` e o atendente ficou sem o botão — o gate passou do ponto",
  ).toBeVisible({ timeout: ESPERA });

  // O CONTROLE DE DISCRIMINÂNCIA da contagem de blocos. Zero para o viewer só
  // significa alguma coisa se para o atendente NÃO for zero na mesma tela e no
  // mesmo banco.
  const blocos = await page.locator('[data-testid^="bloco-"]').count();
  expect(
    blocos,
    "a grade não montou blocos nem para o atendente — a contagem zero do viewer " +
      "mediria a ausência de tipo de agendamento, não o papel",
  ).toBeGreaterThan(0);

  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByTestId("tela-agenda")).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "1013-agenda-papel-de-atendente.png"), fullPage: true });
});
