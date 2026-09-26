/**
 * EM QUE FUNIS O ASSISTENTE MEXE — provado PELA TELA (spec 17 passos 3 e 4).
 *
 * O que só a tela prova:
 *  1. a marcação SOBREVIVE ao salvar e recarregar (o defeito clássico do campo
 *     que "se desmarca sozinho" — foi o que aconteceu com `cases_enabled`, que
 *     entrou em 2 dos 7 arquivos que copiam a lista de colunas);
 *  2. o estado vazio é EXPLICADO, não deixado em branco;
 *  3. a lacuna de tradução aparece no funil MARCADO e some no não marcado.
 *
 * ⚠️ Duas coisas que a primeira versão errou, e que valem para quem escrever o
 * próximo spec desta tela:
 *
 *  - **A aba se abre por `data-testid`, não por texto.** O botão diz "Organiza o
 *    sistema", não "Operação" — a tela fala a linguagem do dono do negócio.
 *    Procurar por /opera(ç|c)ão/ fez os dois casos estourarem por timeout.
 *  - **Só ADMIN edita agente** (`page.tsx`: `readOnly` quando a role é menor que
 *    admin). Logado como manager, a tela abre e os campos vêm `disabled` — o
 *    sintoma é `check()` estourando em elemento que existe, que lê como bug de
 *    UI e é regra de permissão funcionando.
 *
 * ⚠️ O spec do papel Operador (`agente-papeis-operador.spec.ts`) confessa no
 * cabeçalho que não rodava em CI nenhum. Este entra na lista do workflow no
 * mesmo commit — prova nova fora do gate é repetir o defeito que ele registra.
 */
import { execFileSync } from "node:child_process";

import { test, expect, type Browser, type Page } from "./helpers/test";

import { loginComoAdmin, lerCreds, type CredsE2E } from "./helpers/login-admin";

let creds: CredsE2E = lerCreds();

test.use({ locale: "pt-BR" });

// Mesmo orçamento dos vizinhos: o login pode disparar uma re-semeadura de
// credenciais quando outra sessão rotaciona o fator TOTP deste banco.
test.describe.configure({ timeout: 240_000 });

/**
 * UM login para a bateria, e `serial` porque o segundo caso salva rascunho —
 * rodar em paralelo faria um pisar no outro. O teto de 60 logins por IP a cada
 * 5 minutos é o mesmo que protege a conta de um cliente real, e estourá-lo faz
 * a falha aparecer como "campo de MFA não apareceu".
 */
test.describe.configure({ mode: "serial" });

let pagina: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  // `describe.configure({ timeout })` alcança os TESTES, não os hooks — estes
  // ficam nos 30 s padrão. O seed sobe um agente inteiro e o login pode esperar
  // a próxima janela TOTP; ambos estouram 30 s com folga, e a falha aparece
  // como "hook timeout", que não diz nada sobre a tela.
  test.setTimeout(180_000);
  const contexto = await browser.newContext({ locale: "pt-BR" });
  pagina = await contexto.newPage();

  // ⚠️ ORDEM. O login vem PRIMEIRO porque, quando o fator TOTP em disco não
  // vale mais, `loginComoAdmin` chama `seed-e2e-credentials`, que reescreve o
  // `.e2e-creds.json` INTEIRO — levando junto o bloco `capacidades` que um seed
  // anterior tivesse escrito. Semear capacidades antes do login é semear para
  // um arquivo que o login pode apagar; o sintoma é "sem capacidades.agent_id"
  // logo depois de um seed que imprimiu sucesso.
  creds = await loginComoAdmin(pagina, creds);

  // A precondição é semeada AQUI, não pressuposta: a tela é do `mcp_agent`, e o
  // `default_agent_id` do seed de credenciais é um `rag_bot` — outro tipo,
  // outra tela. Depender de um `mcp_agent` que outra spec deixou é depender da
  // ordem alfabética dos arquivos.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-capacidades.ts"], { stdio: "inherit" });
  creds = lerCreds();
});

test.afterAll(async () => {
  await pagina?.context().close();
});

function agenteDeTeste(): string {
  const id = creds.capacidades?.agent_id;
  if (id === undefined || id === "") {
    throw new Error(
      "`.e2e-creds.json` sem `capacidades.agent_id` — o beforeAll deveria ter semeado. " +
        "Rode `pnpm exec tsx scripts/seed-e2e-capacidades.ts` com o ambiente do e2e.",
    );
  }
  return id;
}

/** Abre a aba do Operador, onde a marcação de funis vive. */
async function abrirOperacao(): Promise<void> {
  await pagina.goto(`/app/ai/agents/${agenteDeTeste()}`);
  await pagina.getByTestId("papel-operacao").click();
  await expect(pagina.getByText(/em que neg(ó|o)cios ele pode mexer/i)).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("a marcação de funis do assistente", () => {
  test("nasce FECHADA e a tela explica o que isso significa", async () => {
    await abrirOperacao();

    // Falha fechada: o agente do seed nunca marcou funil nenhum.
    const semFunil = pagina.getByTestId("agente-sem-funil");
    await expect(semFunil).toBeVisible();
    await expect(semFunil).toContainText(/não mexe em negócio/i);

    // Controle de que o caso mede o estado vazio, e não uma tela que não
    // carregou: os funis da organização estão listados ao lado do aviso.
    await expect(
      pagina.getByTestId("agente-funis").locator('input[type="checkbox"]').first(),
    ).toBeVisible();

    await pagina.screenshot({
      path: "evidence/spec-17/escopo-nasce-fechado.png",
      fullPage: true,
    });
  });

  test("marcar um funil SOBREVIVE ao salvar e recarregar", async () => {
    await abrirOperacao();

    const caixas = pagina.getByTestId("agente-funis").locator('input[type="checkbox"]');
    const quantos = await caixas.count();
    expect(quantos, "a organização de teste precisa ter funil para marcar").toBeGreaterThan(0);

    // Controle: antes de marcar, nenhuma está marcada. E a caixa está
    // habilitada — logado como admin, que é a única role que edita agente.
    await expect(caixas.first()).not.toBeChecked();
    await expect(caixas.first()).toBeEnabled();

    await caixas.first().check();
    // O aviso de "nenhum funil" some assim que algo é marcado.
    await expect(pagina.getByTestId("agente-sem-funil")).toHaveCount(0);

    await pagina.getByRole("button", { name: /salvar rascunho/i }).first().click();

    // ⚠️ RECARREGAR é o ponto do teste. O defeito que o gate de colunas existe
    // para pegar aparece exatamente aqui: o campo salva, a tela mostra certo, e
    // depois do refresh ele volta desmarcado — porque um dos 7 arquivos que
    // copiam a lista de colunas não recebeu o campo.
    // Espera o SUCESSO, não o botão desabilitar: ele desabilita durante o
    // salvamento também, então recarregar nesse sinal correria contra a
    // gravação e o teste falharia como se o campo não persistisse.
    await expect(pagina.getByText(/rascunho v\d+ salvo/i)).toBeVisible({ timeout: 30_000 });
    await abrirOperacao();

    const depois = pagina.getByTestId("agente-funis").locator('input[type="checkbox"]');
    await expect(depois.first(), "a marcação não sobreviveu ao reload").toBeChecked({
      timeout: 20_000,
    });

    await pagina.screenshot({
      path: "evidence/spec-17/escopo-sobrevive-ao-reload.png",
      fullPage: true,
    });
  });
});
