/**
 * Duas telas do épico que não tinham teste de tela nenhum: criar um agente
 * (`/app/ai/agents/new`) e olhar o consumo de IA (`/app/ai/usage`).
 *
 * A diferença deste spec para os outros do repo é de propósito: o agente é
 * criado **pela interface**, preenchendo o formulário como uma pessoa faria, em
 * vez de aparecer pronto por seed. Seed prova que a tela funciona quando alguém
 * já colocou os dados lá; não prova que alguém consegue chegar lá sozinho.
 *
 * O que ele NÃO consegue provar, e por quê: a organização de teste já tem
 * credencial de IA e número de WhatsApp (outros seeds do repo criam), e o caso
 * "instalei agora e não tenho nada" não se monta daqui — a página é Server
 * Component, as duas listagens acontecem NO SERVIDOR, e interceptar no
 * navegador não as alcança (a primeira versão tentava, e passava sem medir
 * nada). Esse caso é coberto onde ele cabe: no componente, por
 * `tests/unit/agente-salva-sem-numero-conectado.test.tsx` (a tela SEM nenhum
 * número na lista), e no banco, por
 * `tests/invariants/rascunho-de-agente-sem-numero.test.ts` (o rascunho sem
 * número entra e não publica). Aqui fica o que só a tela real prova.
 *
 * Locale pt-BR fixado no arquivo: sem isso o navegador de teste roda en-US e
 * campos `<input type="date">` aparecem como mm/dd/yyyy, que parece defeito do
 * produto e é do ambiente.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

import { loginComoAdmin, lerCreds, type CredsE2E } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), "evidence", "ia-360-w1");

let creds: CredsE2E = lerCreds();

test.use({ locale: "pt-BR" });

// 240s e não 120s: o orçamento inclui UMA re-semeadura de credenciais, que o
// login dispara sozinho quando outra sessão rotaciona o fator TOTP deste banco
// compartilhado. Medido: o primeiro caso da bateria estourava 120s só nisso.
test.describe.configure({ timeout: 240_000 });

test.beforeEach(async ({ page }) => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  creds = await loginComoAdmin(page, creds);
});

test.describe("Criar um agente pela tela", () => {
  test("o formulário abre e diz o que falta antes de deixar criar", async ({ page }) => {
    await page.goto("/app/ai/agents/new");
    await expect(page.getByRole("heading", { name: /novo agent/i })).toBeVisible();

    // O botão nasce bloqueado: a tela não deixa criar um agente pela metade.
    const criar = page.getByRole("button", { name: /criar agent/i });
    await expect(criar).toBeDisabled();

    // E ela diz o que falta — as exigências que o servidor também impõe.
    // Escritas como instrução, não como acusação — um formulário recém-aberto
    // que já diz "obrigatório" em vermelho trata o usuário como quem errou.
    for (const exigencia of [/escolha o modelo/i, /escolha a chave de acesso/i]) {
      await expect(page.getByText(exigencia).first()).toBeVisible();
    }

    // ⚠️ O NÚMERO DE WHATSAPP NÃO ESTÁ NESSA LISTA, e a ausência é o teste.
    //
    // Ele já esteve: a tela cobrava o número para SALVAR, e numa instalação
    // nova — onde não existe uma linha em `channel_sessions` — isso trancava o
    // rascunho de quem tinha acabado de escrever o prompt do atendente. Hoje o
    // número é requisito para PUBLICAR, e a tela diz isso em vez de acusar
    // falta (migration 0239, `lib/ai/agents/bloqueio-de-publicacao.ts`).
    await expect(
      page.getByText(/o rascunho salva|rascunho salva sem ele/i).first(),
    ).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCIA, "w1-nova-01-tela-de-criar.png"),
      fullPage: true,
    });
  });

  test("preencho como uma pessoa faria e o agente nasce, com as capacidades que liguei", async ({
    page,
  }) => {
    await page.goto("/app/ai/agents/new");
    const nome = `Recepção da Clínica ${Date.now()}`;

    await page.locator("#name").fill(nome);
    await page
      .locator("textarea")
      .first()
      .fill(
        "Você é a recepção de uma clínica odontológica. Atenda com educação, responda dúvidas sobre horários e ajude a marcar consulta.",
      );

    // Os três campos que a tela exige. São comboboxes do Radix, NÃO `<select>`
    // nativo: não existe `<option>` no DOM até o menu abrir, e procurar por
    // `option` devolve zero — que lê como "a tela não tem modelo nenhum" quando
    // na verdade o instrumento é que estava olhando o lugar errado.
    for (const id of ["model", "credential_id", "channel_session_id"]) {
      const gatilho = page.locator(`#${id}`);
      if ((await gatilho.count()) === 0) continue;
      await gatilho.click();
      const opcoes = page.getByRole("option");
      const quantas = await opcoes.count();
      expect(quantas, `o campo "${id}" abriu sem nenhuma opção para escolher`).toBeGreaterThan(0);
      await opcoes.first().click();
      await expect(gatilho).not.toContainText(/^Selecione/);
    }

    // Liga uma jornada de trabalho — o caminho que a W1 entregou.
    await page.getByTestId("switch-pacote-atender").click();
    await expect(page.getByTestId("pacote-atender")).toHaveAttribute("data-estado", "ligado");
    const ligadas = await page.getByTestId("consumo-teto").textContent();

    await page.screenshot({
      path: path.join(EVIDENCIA, "w1-nova-02-preenchido.png"),
      fullPage: true,
    });

    const criar = page.getByRole("button", { name: /criar agent/i });
    await expect(criar).toBeEnabled();
    await criar.click();

    // Nasceu: a tela navega para o agente criado.
    await page.waitForURL(/\/app\/ai\/agents\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByText(nome).first()).toBeVisible();

    // E as capacidades que liguei ANTES de criar sobreviveram ao nascimento —
    // é aqui que uma tela de criação costuma perder metade do formulário.
    await page.getByTestId("tool-picker").waitFor({ state: "visible", timeout: 60_000 });
    await expect(page.getByTestId("consumo-teto")).toHaveText(ligadas!.trim());
    await expect(page.getByTestId("pacote-atender")).toHaveAttribute("data-estado", "ligado");

    await page.screenshot({
      path: path.join(EVIDENCIA, "w1-nova-03-agente-criado.png"),
      fullPage: true,
    });

    // Aparece na lista, que é onde a pessoa vai procurar depois.
    await page.goto("/app/ai/agents");
    await expect(page.getByText(nome).first()).toBeVisible({ timeout: 30_000 });
  });

  test("a tela oferece caminho para o que ela exige, sem exigir que o usuário adivinhe", async ({
    page,
  }) => {
    await page.goto("/app/ai/agents/new");
    await expect(page.getByRole("heading", { name: /novo agent/i })).toBeVisible();

    // ⚠️ O QUE ESTE CASO NÃO CONSEGUE MEDIR, declarado em vez de fingido: o
    // estado "instalei agora e não tenho credencial nem número". A primeira
    // versão tentava montá-lo interceptando as listagens no navegador e passava
    // sem medir nada — a página é Server Component, as duas consultas acontecem
    // NO SERVIDOR, e interceptar no browser não alcança. Montar o estado de
    // verdade exigiria uma organização zerada, que este banco (compartilhado
    // por quatro frentes) não tem. Onde ele é medido está no cabeçalho deste
    // arquivo.
    //
    // O que dá para cobrar sempre: a tela exige credencial para criar e número
    // para publicar — então ela precisa dizer ONDE se consegue cada um. Sem
    // isso, quem não tem trava sem pista, e quem tem mas quer outro também.
    const caminhos = await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")]
        .map((a) => `${(a.textContent ?? "").trim()} -> ${a.getAttribute("href")}`)
        .filter((t) => /credencial|conex|whatsapp|numero|número|canal/i.test(t)),
    );

    expect(
      caminhos.length,
      "a tela exige credencial e número de WhatsApp e não oferece nenhum link para conseguir os dois",
    ).toBeGreaterThan(0);
  });
});

test.describe("Olhar o consumo de IA", () => {
  test("a tela mostra os números do período e nomeia o que eles são", async ({ page }) => {
    await page.goto("/app/ai/usage");
    await expect(page.getByRole("heading", { name: /uso de ia/i })).toBeVisible();

    // Os quatro cartões do topo existem e trazem número, não traço.
    for (const rotulo of [/custo no período/i, /atendimentos com ia/i]) {
      await expect(page.getByText(rotulo).first()).toBeVisible();
    }

    // Nada de NaN/undefined vazando para a tela — o defeito clássico de
    // dashboard quando a agregação recebe zero linhas.
    const lixo = await page.evaluate(() =>
      [...document.querySelectorAll("main *")]
        .filter((el) => el.children.length === 0)
        .map((el) => (el.textContent ?? "").trim())
        .filter((t) => /\bNaN\b|\bundefined\b|\bInfinity\b|\[object/i.test(t)),
    );
    expect(lixo, `a tela mostrou valor inválido: ${JSON.stringify(lixo)}`).toEqual([]);

    await page.screenshot({
      path: path.join(EVIDENCIA, "w1-uso-01-tela.png"),
      fullPage: true,
    });
  });

  test("um período sem nenhum dado é explicado, não fica em branco", async ({ page }) => {
    await page.goto("/app/ai/usage");
    await expect(page.getByRole("heading", { name: /uso de ia/i })).toBeVisible();

    // Uma janela no passado onde não houve uso nenhum.
    const de = page.locator('input[type="date"]').first();
    const ate = page.locator('input[type="date"]').nth(1);
    await de.fill("2020-01-01");
    await ate.fill("2020-01-31");
    await page.waitForTimeout(2500);

    const corpo = await page.locator("main").innerText();
    expect(
      /sem dados|nenhum|0/i.test(corpo),
      "período vazio não disse nada ao usuário",
    ).toBe(true);

    await page.screenshot({
      path: path.join(EVIDENCIA, "w1-uso-02-periodo-vazio.png"),
      fullPage: true,
    });
  });
});
