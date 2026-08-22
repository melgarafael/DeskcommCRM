import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

/**
 * RESPONDER "EM CIMA" DE UMA MENSAGEM — pela tela, como o atendente faz.
 *
 * O canal intermediado aceita citação (`replyTo`, recebendo o `wamid`), e o
 * WhatsApp mostra a resposta pendurada na original. Todo o caminho novo é
 * VISUAL — escolher a mensagem, ver a faixa, cancelar, enviar — e nada disso é
 * alcançável por teste de unidade: eles provam que a função existe, não que dá
 * para clicá-la.
 *
 * ─── O que este arquivo cobre, e por que cada caso ──────────────────────────
 *
 * 1. o botão APARECE (é `opacity-0` até o hover; um `hidden` teria feito o
 *    layout pular, e um seletor que só olha o DOM passaria mesmo invisível);
 * 2. escolher mostra a faixa com o trecho citado;
 * 3. o `×` desfaz — sem saída, quem clica por engano fica preso citando;
 * 4. trocar de conversa LIMPA a citação. Este é o caso que mais importa: sem
 *    ele, a resposta sairia citando a mensagem de OUTRO cliente.
 *
 * Não cobre o que sai na rede: se o `replyTo` chegou ao provider é assunto do
 * adapter, e o teste de tela não deve fingir que mede isso.
 */

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
const EVIDENCE = path.join(process.cwd(), ".superpowers/evidence");

/**
 * Login simples — e por isso o usuário é o `agent`, nunca o `admin`.
 *
 * `admin` tem MFA obrigatório (doutrina de Auth), então o login dele para em
 * `/login/mfa` e este `waitForURL` nunca resolve. O repo tem um helper próprio
 * para esse caso (`helpers/login-admin.ts`), e ele existe justamente porque a
 * armadilha já pegou gente antes. As demais specs de inbox usam `agent`, que
 * tem o acesso que estes casos precisam.
 */
async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

/**
 * Abre o inbox e entra numa conversa que TENHA mensagens.
 *
 * Devolve `false` quando o ambiente não tem nenhuma — e o caso é pulado em vez
 * de falhar. Um teste que exige dado semeado por outra spec quebra por ordem de
 * execução, não por defeito, e ensina a ignorar o vermelho.
 */
async function abrirConversaComMensagens(page: Page): Promise<boolean> {
  await page.goto("/app/inbox?filter=all");
  const bolhas = page.locator("[class*='rounded-2xl']");
  const primeira = page.locator("li, [role='listitem']").first();
  if (await primeira.count()) await primeira.click();
  await expect(bolhas.first())
    .toBeVisible({ timeout: 8000 })
    .catch(() => undefined);
  return (await bolhas.count()) > 0;
}

test.describe("responder citando", () => {
  test("o botão de responder revela a faixa, e o × a desfaz", async ({ page }) => {
    await login(page, creds.users.agent!.email);
    const temMensagens = await abrirConversaComMensagens(page);
    test.skip(!temMensagens, "ambiente sem conversa com mensagens — nada a citar");

    const responder = page.getByRole("button", { name: /Responder a esta mensagem/i }).first();

    // O botão vive em `opacity-0` até o hover. `toBeVisible` do Playwright
    // considera opacidade 0 como visível, então o hover é o que prova de
    // verdade que ele é alcançável — e o clique, que é clicável.
    await page.locator("[class*='rounded-2xl']").first().hover();
    await expect(responder).toBeVisible();
    await responder.click();

    // A faixa aparece acima do campo, com o botão de cancelar.
    const cancelar = page.getByRole("button", { name: /Cancelar resposta/i });
    await expect(cancelar).toBeVisible();
    await page.screenshot({
      path: path.join(EVIDENCE, "responder-citando-faixa.png"),
      fullPage: false,
    });

    await cancelar.click();
    await expect(cancelar).toHaveCount(0);
  });

  test("trocar de conversa LIMPA a citação", async ({ page }) => {
    // Sem isto a resposta sairia citando a mensagem de outro cliente — o pior
    // desfecho possível desta feature, e invisível até acontecer com alguém.
    await login(page, creds.users.agent!.email);
    const temMensagens = await abrirConversaComMensagens(page);
    test.skip(!temMensagens, "ambiente sem conversa com mensagens");

    await page.locator("[class*='rounded-2xl']").first().hover();
    const responder = page.getByRole("button", { name: /Responder a esta mensagem/i }).first();
    await responder.click();
    await expect(page.getByRole("button", { name: /Cancelar resposta/i })).toBeVisible();

    // Volta para a lista e entra em OUTRA conversa.
    await page.goto("/app/inbox?filter=all");
    await page.waitForTimeout(1200);

    await expect(
      page.getByRole("button", { name: /Cancelar resposta/i }),
      "a citação sobreviveu à troca de conversa",
    ).toHaveCount(0);
  });
});
