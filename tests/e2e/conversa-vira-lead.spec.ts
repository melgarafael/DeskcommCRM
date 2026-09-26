/**
 * A CONVERSA VIRA LEAD — provado PELA TELA (spec 17 passo 1, DoD 12).
 *
 * O invariante `tests/invariants/nascimento-do-lead.test.ts` prova a REGRA.
 * Ele não prova o que interessa a quem instalou numa VPS: **que o card aparece
 * no quadro**. Uma peça pode estar correta e invisível — e invisível, para o
 * dono do negócio, é igual a inexistente (invariante 3 do sistema vivo).
 *
 * A mensagem entra pelo CAMINHO DE PRODUÇÃO: `POST /api/v1/webhooks/waha/[token]`,
 * a mesma rota que o WAHA chama. Sem header de assinatura — que é como o WAHA
 * Core real chega (`lib/waha/webhook-auth.ts`). Nada de `insert` direto em
 * `crm_leads`: insert à mão mente sobre a origem e provaria só que a tela sabe
 * desenhar uma linha que alguém pôs no banco.
 *
 * Cobre:
 *  1. mensagem nova de contato desconhecido ⇒ card no funil de entrada, com o
 *     nome de quem escreveu;
 *  2. a timeline explica de onde ele veio ("Entrou pelo WhatsApp");
 *  3. a segunda mensagem do MESMO contato não abre um segundo card.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { email: string }>;
  nascimento?: { webhook_token: string; session_name: string; pipeline_default_id: string };
}

function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.users?.manager) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  if (!c.nascimento?.webhook_token) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-nascimento-do-lead.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = lerCreds();

/**
 * Telefone único por execução. O banco de e2e é COMPARTILHADO entre frentes: um
 * número fixo faria a segunda rodada cair em "já existe lead aberto" e o teste
 * reprovaria por sujeira de fixture, não por defeito — e pior, poderia PASSAR
 * pelo motivo errado ao reencontrar o card da rodada anterior.
 */
const sufixo = String(process.pid).padStart(6, "0").slice(-6);
const TELEFONE = `55319${sufixo}`;
const NOME = `Cliente Nascimento ${sufixo}`;

/** Manager: vê todos os leads da organização e não exige MFA. */
async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

/** Um inbound de texto, como o WAHA o entrega. */
async function mandarMensagem(page: Page, texto: string, id: string): Promise<number> {
  const r = await page.request.post(`/api/v1/webhooks/waha/${creds.nascimento!.webhook_token}`, {
    data: {
      event: "message",
      session: creds.nascimento!.session_name,
      payload: {
        id,
        from: `${TELEFONE}@c.us`,
        fromMe: false,
        body: texto,
        timestamp: Math.floor(Date.now() / 1000),
        _data: { notifyName: NOME },
      },
    },
  });
  return r.status();
}

test.describe("a conversa vira lead", () => {
  test("mensagem de quem nunca escreveu vira card no funil de entrada", async ({ page }) => {
    const status = await mandarMensagem(page, "Oi, vi o anúncio de vocês. Como funciona?", `e2e-nasc-${sufixo}-1`);
    expect(status, "o webhook precisa ACEITAR — 4xx aqui e o resto do teste mede o vazio").toBe(200);

    await login(page);
    await page.goto(`/app/pipelines/${creds.nascimento!.pipeline_default_id}`);

    // O card, com o nome de quem escreveu. Não um id técnico: `Contato 543134@lid`
    // na tela do atendente é a doença que a spec 16 mediu em 30% dos turnos.
    const card = page.getByText(NOME, { exact: false }).first();
    await expect(card, "o card tem de aparecer no quadro do funil de entrada").toBeVisible({
      timeout: 20_000,
    });

    await expect(page.getByText(/@c\.us|@lid/)).toHaveCount(0);

    // Evidência versionada: `.superpowers/` é gitignored, e há gate que reprova
    // doc citando imagem que não está no repo.
    await page.screenshot({ path: "evidence/spec-17/card-nascido-da-conversa.png", fullPage: true });
  });

  test("a timeline explica de onde o card veio", async ({ page }) => {
    await login(page);
    await page.goto(`/app/pipelines/${creds.nascimento!.pipeline_default_id}`);

    await page.getByText(NOME, { exact: false }).first().click();

    // "Entrou pelo WhatsApp" é o rótulo de `lead_created`. Card que aparece sem
    // explicação é como se perde a confiança num automatismo — o dono não sabe
    // se foi ele, a IA, ou um erro.
    await expect(page.getByText(/entrou pelo whatsapp/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test("a segunda mensagem do mesmo contato NÃO abre um segundo card", async ({ page }) => {
    const status = await mandarMensagem(page, "Ainda estou aguardando, pode me ajudar?", `e2e-nasc-${sufixo}-2`);
    expect(status).toBe(200);

    await login(page);
    await page.goto(`/app/pipelines/${creds.nascimento!.pipeline_default_id}`);

    await expect(page.getByText(NOME, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    // Um lead por DEMANDA, não um por mensagem. Sem esta regra o quadro vira
    // uma lista de mensagens e para de significar qualquer coisa.
    await expect(
      page.getByText(NOME, { exact: false }),
      "duas mensagens, um card",
    ).toHaveCount(1);
  });
});
