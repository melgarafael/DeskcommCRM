import { expect, test, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

/**
 * A PROVA NA TELA DO PRODUTO — e ela existe porque a outra estava na tela errada.
 *
 * `agenda-kit-visual.spec.ts` prova os componentes na VITRINE
 * (`/vitrine-agenda`), com dado sintético. Isso foi a decisão certa enquanto a
 * API não existia: o desenho precisava ser julgável antes de haver o que exibir.
 *
 * Mas o efeito líquido era que TUDO estava provado na tela que o cliente nunca
 * abre. Medido pelo maestro: dez dos dez itens do pedido, parciais, por essa
 * única razão. Esta spec é a outra metade — o que o dono do produto realmente vê.
 *
 * A diferença que mais importa está no primeiro caso: chegar em `/app/agenda`
 * **clicando no menu**, não por `goto`. `goto` prova que a rota responde;
 * clicar prova que a tela é ALCANÇÁVEL, que é outra coisa e é a que o usuário
 * exercita. Ter tela e ter porta são propriedades diferentes — o repo já tem um
 * gate para isso no nível do registro, e aqui ela é exercida pelo clique.
 */
const ESPERA = 60_000;
test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe("a Agenda como o dono do produto a usa", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    page = await browser.newPage();
    await loginComoAdmin(page, lerCreds());
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("chego na Agenda CLICANDO no menu, não digitando a URL", async () => {
    await page.goto("/app");
    // O item vive no grupo "Atendimento", junto do Inbox — decisão registrada
    // no `registry.ts`: a Agenda é onde o dia acontece, não onde se configura.
    const item = page.getByRole("link", { name: "Agenda", exact: true }).first();
    await expect(item).toBeVisible({ timeout: ESPERA });
    await item.click();

    await expect(page).toHaveURL(/\/app\/agenda/, { timeout: ESPERA });
    await expect(page.getByTestId("tela-agenda")).toBeVisible();
    // `exact` NÃO é adorno aqui, e a linha do link acima já sabia disso. Sem ele
    // o nome casa por substring e o estado VAZIO da agenda ("Sua agenda está
    // livre esta semana") vira um segundo heading — dois elementos, strict mode,
    // vermelho. E o estado vazio é justamente o da INSTALAÇÃO FRESCA: esta spec
    // passava só porque outra spec deixava agendamentos no banco antes dela.
    // Medido nas duas direções: com 3 linhas passa, com 0 linhas falha.
    await expect(page.getByRole("heading", { name: "Agenda", exact: true })).toBeVisible();
  });

  test("as pessoas da equipe são REAIS — o filtro deixou de ser invisível", async () => {
    // `FiltroDePessoas` devolve `null` com menos de duas pessoas. Enquanto a
    // tela do produto passava lista vazia, o filtro existia, estava provado na
    // vitrine, e NINGUÉM o via aqui. Componente provado e não montado é o mesmo
    // que componente ausente, do ponto de vista de quem usa.
    await page.goto("/app/agenda");
    await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: ESPERA });

    const filtro = page.getByTestId("filtro-de-pessoas");
    const avatares = page.locator('[data-testid^="avatar-pessoa-"]');

    // O seed do E2E tem admin, manager, agent, viewer e dono — mais de uma
    // pessoa, então o filtro TEM de aparecer.
    await expect(filtro).toBeVisible({ timeout: ESPERA });
    const quantas = await avatares.count();
    expect(quantas, "o filtro apareceu mas sem avatares").toBeGreaterThan(1);

    // Cada pessoa tem trilha de cor, e trilhas diferentes entre si: a cor vem do
    // `user_id` e não de um índice, então duas pessoas não colidem por estarem
    // na mesma posição da lista.
    const trilhas = await avatares.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.trilha),
    );
    expect(trilhas.every((t) => t && Number(t) >= 1 && Number(t) <= 8)).toBe(true);

    // ⚠️ O INTERVALO SOZINHO É PARCIALMENTE VÁCUO, e o comentário acima já
    // AFIRMAVA o que ele não media: "trilhas diferentes entre si". Se
    // `trilhaPadraoDoMembro` devolvesse 1 para todo mundo, o `every` acima
    // passaria — e a agenda desenharia a equipe inteira na mesma cor, que é
    // exatamente o que o sistema de cores existe para impedir.
    // ⚠️ POR PESSOA, e não por ELEMENTO — minha primeira versão comparou
    // `new Set(trilhas).size` com `trilhas.length` e reprovou dizendo "19 contra
    // 4". Medido: a organização tem CINCO pessoas e o locator casa 19 avatares,
    // porque a mesma pessoa aparece no filtro E em cada card da grade. Repetir a
    // trilha ali é o comportamento CERTO — é a mesma pessoa.
    //
    // A propriedade que importa é: duas pessoas DIFERENTES não compartilham
    // trilha. O `data-testid` carrega o id, então dá para parear.
    const porPessoa = await avatares.evaluateAll((els) =>
      els.map((e) => ({
        pessoa: (e as HTMLElement).dataset.testid?.replace("avatar-pessoa-", "") ?? "",
        trilha: (e as HTMLElement).dataset.trilha ?? "",
      })),
    );
    const trilhaDe = new Map<string, string>();
    const colisoes: string[] = [];
    for (const { pessoa, trilha } of porPessoa) {
      for (const [outra, t] of trilhaDe) {
        if (outra !== pessoa && t === trilha) colisoes.push(`${outra} e ${pessoa} → trilha ${t}`);
      }
      trilhaDe.set(pessoa, trilha);
    }
    expect(
      trilhaDe.size,
      "o filtro tem menos de duas pessoas distintas — o teste de colisão mede o vazio",
    ).toBeGreaterThan(1);
    expect(
      [...new Set(colisoes)],
      "duas pessoas DIFERENTES ganharam a mesma trilha de cor — na grade elas viram " +
        "uma só, e quem olha não distingue de quem é o compromisso",
    ).toEqual([]);
  });

  test("o histórico está NA TELA DO PRODUTO, com as quatro abas", async () => {
    // Estava provado só na vitrine. Aqui ele aparece mesmo sem dado: as abas com
    // contador zero respondem "não há nada" sem gastar um clique.
    const hist = page.getByTestId("historico-da-agenda");
    await expect(hist).toBeVisible({ timeout: ESPERA });
    for (const aba of ["proximos", "aguardando", "passados", "cancelados"]) {
      await expect(page.getByTestId(`aba-${aba}`)).toBeVisible();
    }
  });

  test("a tela declara de onde veio o que ela mostra — e nunca de mentira", async () => {
    // ESTE TESTE JÁ FOI UM DESLIGADOR. Ele cobrava `data-fonte="vazio-ate-a-api"`,
    // o marcador de quando a leitura não existia. A leitura passou a existir
    // (`_client.tsx` emite "api" / "api-sem-dado"), a dívida foi paga — e a
    // asserção ficou, cobrando um estado que o produto já tinha superado. Só não
    // reprovou antes porque a falha do teste anterior abortava o bloco.
    //
    // O que importa NÃO é o valor de ontem: é que a tela declare uma fonte REAL
    // e jamais dado de mentira (decisão 18 — o relato de quem vê não é "tem dado
    // de teste na tela", é "estou vendo paciente de outra clínica na minha
    // agenda", e o time queima horas caçando um furo de RLS que não existe).
    const fonte = await page.getByTestId("tela-agenda").getAttribute("data-fonte");
    expect(fonte, "a tela precisa declarar sua fonte no DOM").not.toBeNull();
    expect(
      fonte,
      `data-fonte="${fonte}" não é fonte real — a tela do cliente lê o banco, ` +
        "e qualquer outro valor aqui significa que ela voltou a inventar",
    ).toMatch(/^api(-sem-dado)?$/);

    // O par que o valor sozinho não prova: sem dado, a grade não pode exibir
    // NOME nenhum. É o formato do defeito da decisão 18, medido em vez de suposto.
    if (fonte === "api-sem-dado") {
      await expect(page.getByText("Marina Alves")).toHaveCount(0);
      await expect(page.getByText("Pedro Lima")).toHaveCount(0);
    }
  });

  test("as três visões desenham, e a régua do agora existe — NO PRODUTO", async () => {
    // ⚠️ Isto estava provado só em `agenda-kit-visual`, que roda contra
    // `/vitrine-agenda` — página de demonstração com dado de mentira. A vitrine
    // prova o DESENHO; ela não prova que a tela que o cliente abre desenha.
    await expect(page.getByTestId("grade-da-agenda")).toBeVisible({ timeout: ESPERA });

    const alternador = page.getByTestId("alternador-de-visao");
    for (const visao of ["Dia", "Mês", "Semana"]) {
      await alternador.getByRole("button", { name: visao, exact: true }).click();
      await expect(
        page.getByTestId("grade-da-agenda"),
        `a grade sumiu ao trocar para "${visao}"`,
      ).toBeVisible({ timeout: ESPERA });
      await expect(
        alternador.getByRole("button", { name: visao, exact: true }),
        `"${visao}" foi clicado e não ficou marcado como a visão atual`,
      ).toHaveAttribute("aria-pressed", "true");
    }

    // A régua do agora só existe quando o instante cabe na faixa desenhada
    // (07h–21h). Fora dela a ausência é CORRETA, e exigir presença faria a spec
    // ficar vermelha de madrugada — que é o defeito que este repo já pagou nos
    // invariantes de turno.
    const hora = new Date().getHours();
    const regua = page.getByTestId("regua-do-agora");
    if (hora >= 7 && hora <= 21) {
      await expect(regua, "dentro da faixa 07h–21h e sem régua do agora").toBeVisible();
    } else {
      await expect(regua, "fora da faixa e a régua apareceu mesmo assim").toHaveCount(0);
    }
  });

  test("o filtro por pessoa ISOLA de verdade — clicando, no produto", async () => {
    // O isolamento era assertado só na vitrine. Aqui o teste é sobre o efeito:
    // clicar numa pessoa muda o que a grade mostra, e "Todos" desfaz.
    const filtro = page.getByTestId("filtro-de-pessoas");
    await expect(filtro).toBeVisible({ timeout: ESPERA });

    const cartoes = () => page.getByTestId("grade-da-agenda").getByRole("button", { name: /\d{2}:\d{2} às \d{2}:\d{2}/ });
    const todos = await cartoes().count();

    const primeira = filtro.getByRole("button").first();
    await primeira.click();
    const isolado = await cartoes().count();
    expect(
      isolado,
      "isolar uma pessoa não pode mostrar MAIS do que a agenda inteira",
    ).toBeLessThanOrEqual(todos);
    await expect(primeira, "cliquei na pessoa e ela não ficou marcada").toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByTestId("botao-todos").click();
    await expect
      .poll(() => cartoes().count(), { message: "\"Todos\" não desfez o isolamento" })
      .toBe(todos);
  });

  test("evidência visual da tela do produto", async () => {
    // As três fotos que existiam eram todas da VITRINE. Esta é a primeira da
    // tela que o cliente abre.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/app/agenda");
    await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: ESPERA });
    await page.screenshot({ path: "evidence/calendario/tela-do-produto-claro.png", fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("tela-agenda")).toBeVisible();
    await page.screenshot({ path: "evidence/calendario/tela-do-produto-celular.png", fullPage: true });

    const estouro = await page.evaluate(
      // ⚠️ `body.scrollWidth`, NÃO `documentElement`. `app/globals.css` põe
      // `overflow-x: clip` em `html` E em `body` (com `hidden` ANTES, como reserva
      // para motor sem `clip` — Safari < 16). Sob `hidden` puro, que quebra
      // o sticky da barra), o `scrollWidth` do `documentElement` era GRAMPEADO
      // no `clientWidth`: a conta dava zero mesmo com um filho de 3000px.
      // Medido com o chromium do repo, viewport 390x844, filho de 3000px —
      // `visible` → 2610, `hidden` → 0, e `body.scrollWidth` = 3000 nos DOIS
      // casos. A medida fica no `body` para não voltar a ser incapaz de falhar.
      //
      // A asserção existia e era incapaz de falhar. Trocar a medida é o conserto;
      // o caso de sabotagem ao lado é o que prova que a nova consegue.
      () => document.body.scrollWidth - document.documentElement.clientWidth,
    );
    // Quem estoura, nomeado. Uma asserção que só diz "67" manda a próxima pessoa
    // caçar o elemento na mão — e essa caçada já custou uma sessão.
    const culpados = await page.evaluate(() => {
      const limite = document.documentElement.clientWidth;
      const fora: string[] = [];
      document.querySelectorAll("*").forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.right > limite + 1 && b.width > 0) {
          const e = el as HTMLElement;
          const id = e.getAttribute("data-testid");
          fora.push(
            `${e.tagName.toLowerCase()}${id ? `[${id}]` : ""} right=${Math.round(b.right)} w=${Math.round(b.width)} cls=${String(e.className).slice(0, 60)}`,
          );
        }
      });
      return fora.slice(0, 5);
    });
    expect(
      estouro,
      `a tela do produto estourou a largura no celular. Quem passa da borda:\n${culpados.join("\n") || "  (nenhum elemento individual — veja margem/transform)"}`,
    ).toBeLessThanOrEqual(0);
  });
});
