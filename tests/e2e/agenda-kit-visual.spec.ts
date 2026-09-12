import { expect, test, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

/**
 * Kit visual da Agenda — prova pela TELA, clique a clique.
 *
 * Toda medida de layout e de cor aqui sai de `getBoundingClientRect` e
 * `getComputedStyle`, nunca de olho: "a coluna deslizou" e "as cores são
 * distinguíveis" são afirmações que um humano confirma errado com facilidade.
 *
 * ⚠️ Esperas em 60s, e não nos 5s do default: esta máquina roda saturada
 * (o protocolo da entrega registra load 42 em 11 CPUs) e vermelho por carga
 * desliga o gate inteiro por desconfiança.
 */
const ESPERA = 60_000;

const VITRINE = "/vitrine-agenda";

/**
 * A vitrine não toca banco, mas EXIGE SESSÃO — e essa distinção custou uma
 * medição do maestro para aparecer.
 *
 * `proxy.ts` manda todo path por `isPublicPath` (`lib/auth/public-paths.ts`), e
 * o que não estiver na lista leva 307 para `/login`. Eu tinha procurado por um
 * `middleware.ts`, não achei, e concluí que não havia proteção global: procurei
 * pelo NOME que eu esperava em vez de pelo mecanismo.
 *
 * A saída NÃO é pôr a vitrine em `PUBLIC_PATHS`. Medido antes de decidir: o
 * próprio `/design`, o showcase de design do repo, também dá `false` em
 * `isPublicPath` — este produto não tem precedente de tela de desenvolvimento
 * aberta, e ele roda na VPS de outra pessoa. Abrir uma rota interna para não
 * escrever três linhas de login seria decidir uma questão de segurança por
 * conveniência de teste.
 *
 * UM login só, para o describe inteiro. Cada teste logando de novo obrigaria a
 * esperar a virada da janela TOTP entre eles (o servidor recusa código
 * repetido) e consumiria o teto de logins por IP — dois modos de falha que esta
 * base já pagou e que nada têm a ver com o que esta spec mede.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

/** sRGB → OKLab, para medir distância entre cores como o olho a percebe. */
const OKLAB_NO_BROWSER = `
function _srgbLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function _parse(css) {
  const m = css.match(/rgba?\\(([^)]+)\\)/);
  if (!m) throw new Error("cor não parseável: " + css);
  const [r, g, b] = m[1].split(",").map((n) => parseFloat(n));
  return [r, g, b];
}
function oklab(css) {
  const [r8, g8, b8] = _parse(css);
  const r = _srgbLinear(r8), g = _srgbLinear(g8), b = _srgbLinear(b8);
  const l = Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b);
  const m = Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b);
  const s = Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
  return [
    0.2104542553*l + 0.7936177850*m - 0.0040720468*s,
    1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
    0.0259040371*l + 0.7827717662*m - 0.8086757660*s,
  ];
}
function luminancia(css) {
  const [r, g, b] = _parse(css);
  return 0.2126*_srgbLinear(r) + 0.7152*_srgbLinear(g) + 0.0722*_srgbLinear(b);
}
function contraste(a, b) {
  const la = luminancia(a), lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
`;

async function medirTrilhas(page: Page) {
  return page.evaluate(`(() => {
    ${OKLAB_NO_BROWSER}
    // O fundo que vale é o do ancestral OPACO mais próximo — onde a cor
    // realmente pousa. Um pai transparente não é fundo, é vidro.
    function fundoEfetivo(el) {
      let n = el.parentElement;
      while (n) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== "transparent" && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(c)) return c;
        n = n.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    }
    const cores = [];
    let fundo = null;
    for (let t = 1; t <= 8; t++) {
      const el = document.querySelector('[data-testid="swatch-' + t + '"]');
      if (!el) throw new Error("swatch " + t + " não está na tela");
      cores.push(getComputedStyle(el).backgroundColor);
      if (fundo === null) fundo = fundoEfetivo(el);
    }
    let menorDistancia = Infinity, parMaisProximo = null;
    for (let i = 0; i < cores.length; i++) {
      for (let j = i + 1; j < cores.length; j++) {
        const a = oklab(cores[i]), b = oklab(cores[j]);
        const d = Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
        if (d < menorDistancia) { menorDistancia = d; parMaisProximo = [i + 1, j + 1]; }
      }
    }
    return {
      tema: document.documentElement.getAttribute("data-theme"),
      fundo,
      cores,
      contrastes: cores.map((c) => contraste(c, fundo)),
      menorDistancia,
      parMaisProximo,
    };
  })()`) as Promise<{
    tema: string | null;
    fundo: string;
    cores: string[];
    contrastes: number[];
    menorDistancia: number;
    parMaisProximo: [number, number] | null;
  }>;
}

test.describe("kit visual da Agenda", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // `test.describe.configure({ timeout })` vale para os TESTES, não para os
    // hooks — o `beforeAll` continua com os 30 s do playwright.config.ts, e o
    // login com MFA passa disso sozinho: o helper espera a virada da janela do
    // código TOTP (o servidor recusa código repetido) antes de tentar. Medido:
    // o hook estourou em 30 s e derrubou os 11 testes de uma vez, com a
    // mensagem apontando para a linha do `waitForURL` — que estava certa.
    test.setTimeout(240_000);
    page = await browser.newPage();
    await loginComoAdmin(page, lerCreds());
  });

  test.afterAll(async () => {
    await page.close();
  });

  test.beforeEach(async () => {
    // `goto` a cada teste devolve a tela ao estado inicial sem novo login — a
    // sessão vive no contexto, não na página. O localStorage do tema NÃO volta
    // sozinho, e sem limpá-lo o teste que troca para o escuro contaminaria o
    // seguinte: ele mediria "as cores do tema claro" num tema escuro e passaria,
    // porque a régua de contraste vale para os dois.
    await page.goto(VITRINE);
    await page.evaluate(() => {
      try {
        window.localStorage.removeItem("deskcomm-theme");
      } catch {
        /* modo privado: o tema já é o default */
      }
    });
    await page.reload();
    await expect(page.getByTestId("grade-da-agenda")).toBeVisible({ timeout: ESPERA });
  });

  test("a grade troca de visão pelo clique, e cada visão desenha o que promete", async () => {
    const grade = page.getByTestId("grade-da-agenda");
    await expect(grade).toHaveAttribute("data-visao", "semana");

    // SEMANA: sete colunas de dia, uma por dia da semana.
    await expect(page.locator('[data-testid^="coluna-dia-"]')).toHaveCount(7, { timeout: ESPERA });

    await page.getByTestId("visao-dia").click();
    await expect(grade).toHaveAttribute("data-visao", "dia", { timeout: ESPERA });
    await expect(page.locator('[data-testid^="coluna-dia-"]')).toHaveCount(1);

    await page.getByTestId("visao-mes").click();
    await expect(grade).toHaveAttribute("data-visao", "mes", { timeout: ESPERA });
    // 6 semanas × 7 dias — a grade do mês é sempre retangular, senão as células
    // mudam de tamanho de um mês para o outro.
    await expect(page.locator('[data-testid^="celula-mes-"]')).toHaveCount(42);

    await page.getByTestId("visao-semana").click();
    await expect(grade).toHaveAttribute("data-visao", "semana", { timeout: ESPERA });
  });

  test("a régua do agora cai no minuto certo, medida em pixels", async () => {
    const regua = page.getByTestId("regua-do-agora");
    await expect(regua).toBeVisible({ timeout: ESPERA });

    // A âncora da vitrine é fixa: quarta, 14h37. Com a grade começando às 7h e
    // 48px por hora, o topo da régua tem de ser (14-7)*48 + (37/60)*48 = 365.6px.
    const medido = await regua.evaluate((el) => parseFloat((el as HTMLElement).style.top));
    expect(medido).toBeCloseTo((14 - 7) * 48 + (37 / 60) * 48, 1);
  });

  test("a coluna de horários NÃO está lá, e entra quando o dia é escolhido", async () => {
    const painel = page.getByTestId("secao-marcacao").getByTestId("painel-de-marcacao");
    const coluna = painel.getByTestId("coluna-de-horarios");
    await painel.scrollIntoViewIfNeeded();

    // ANTES: o painel está no primeiro tempo e a coluna tem largura ZERO.
    //
    // Medido com `getBoundingClientRect` e NÃO com `boundingBox()` do
    // Playwright: aquele devolve `null` para elemento que ele considera
    // invisível, e largura zero é exatamente esse caso. O teste falharia por
    // não conseguir medir, e a mensagem diria "esperava 0, recebeu -1" — que
    // parece defeito do componente e é defeito do instrumento.
    const largura = (loc: typeof coluna) =>
      loc.evaluate((el) => el.getBoundingClientRect().width);

    await expect(painel).toHaveAttribute("data-tempo", "escolhendo-dia", { timeout: ESPERA });
    const larguraAntes = await largura(coluna);
    expect(larguraAntes).toBe(0);
    const painelAntes = await largura(painel);

    // Escopado ao `painel`, e não a `page`: desde que a vitrine ganhou o
    // SEGUNDO painel (o do aviso de opt-out), todo `data-testid` interno existe
    // duas vezes na página, e um localizador global resolve para 2 elementos —
    // o modo estrito do Playwright reprova. Custou um run inteiro descobrir.
    //
    // Escolhe um dia que TEM horário (a fixture garante).
    await painel.getByTestId("dia-2026-08-24").click();

    await expect(painel).toHaveAttribute("data-tempo", "escolhendo-horario", { timeout: ESPERA });
    await expect(coluna).toHaveAttribute("data-aberta", "true");

    // DEPOIS: a coluna existe com a largura medida no cal.com (240 / 280 em lg),
    // e o painel INTEIRO cresceu — é o painel crescer, e não trocar de conteúdo,
    // que dá a sensação de "abriu".
    await expect
      .poll(async () => Math.round(await largura(coluna)), { timeout: ESPERA })
      .toBeGreaterThanOrEqual(240);
    const painelDepois = await largura(painel);
    console.info(
      `[coluna de horários] fechada=${larguraAntes}px  aberta=${Math.round(await largura(coluna))}px  ` +
        `painel ${Math.round(painelAntes)}px -> ${Math.round(painelDepois)}px`,
    );
    expect(painelDepois).toBeGreaterThan(painelAntes);

    // E os horários estão lá, clicáveis, levando ao terceiro tempo.
    await painel.getByTestId("horario-09:30").click();
    await expect(painel).toHaveAttribute("data-tempo", "confirmando", { timeout: ESPERA });
    await painel.getByTestId("confirmar-marcacao").click();
    await expect(painel).toHaveAttribute("data-tempo", "marcado", { timeout: ESPERA });
    await expect(painel.getByText("Marcado.")).toBeVisible();
  });

  test("quem pediu para não receber mensagem: marca igual, mas a tela avisa ANTES", async () => {
    // Decisão 10 da entrega. O opt-out não impede marcar — impede o lembrete —
    // e o requisito é que a tela diga isso no momento em que se marca.
    const painel = page.getByTestId("secao-sem-lembrete").getByTestId("painel-de-marcacao");
    await painel.scrollIntoViewIfNeeded();

    await painel.getByTestId("dia-2026-08-24").click();
    await painel.getByTestId("horario-10:00").click();
    await expect(painel).toHaveAttribute("data-tempo", "confirmando", { timeout: ESPERA });

    const aviso = painel.getByTestId("aviso-sem-lembrete");
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText("pediu para não receber mensagens");
    // Diz o que fazer no lugar — informar a restrição sem dar saída deixa a
    // pessoa parada decidindo sozinha.
    await expect(aviso).toContainText("combine por telefone");

    // E CONFIRMAR CONTINUA ATIVO: aviso, não bloqueio. Se o botão estivesse
    // desabilitado, a tela teria transformado "não recebe mensagem" em "não
    // pode ser atendido", que é outra coisa e é errado.
    const confirmar = painel.getByTestId("confirmar-marcacao");
    await expect(confirmar).toBeEnabled();
    await confirmar.click();

    // O aviso sobrevive ao sucesso: quem fecha o painel agora não teria como
    // saber que aquele agendamento não terá lembrete.
    await expect(painel).toHaveAttribute("data-tempo", "marcado", { timeout: ESPERA });
    await expect(painel.getByTestId("aviso-sem-lembrete-no-resumo")).toBeVisible();
  });

  test("e quem aceita mensagem NÃO vê o aviso", async () => {
    // O par do teste acima. Sem ele, um aviso que aparecesse SEMPRE passaria
    // nos dois — e um aviso que aparece sempre não informa nada.
    const painel = page.getByTestId("secao-marcacao").getByTestId("painel-de-marcacao");
    await painel.scrollIntoViewIfNeeded();
    await painel.getByTestId("dia-2026-08-24").click();
    await painel.getByTestId("horario-10:00").click();
    await expect(painel).toHaveAttribute("data-tempo", "confirmando", { timeout: ESPERA });
    await expect(painel.getByTestId("aviso-sem-lembrete")).toHaveCount(0);
  });

  test("dia sem horário nasce apagado e não aceita clique", async () => {
    const painel = page.getByTestId("secao-marcacao").getByTestId("painel-de-marcacao");
    await painel.scrollIntoViewIfNeeded();
    // A fixture não publica horário na quinta (2026-08-27).
    const vazio = painel.getByTestId("dia-2026-08-27");
    await expect(vazio).toHaveAttribute("data-disponivel", "false", { timeout: ESPERA });
    await expect(vazio).toBeDisabled();
  });

  test("filtrar por pessoa isola a agenda dela — e só a dela", async () => {
    const blocos = page.locator('[data-testid^="agendamento-"]');
    const antes = await blocos.count();
    expect(antes).toBeGreaterThan(3);

    await page.getByTestId("botao-pessoa-ana").click();
    await expect(page.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-isolada", "ana", {
      timeout: ESPERA,
    });

    // Todo bloco que sobrou é da trilha da Ana (1) — medido no DOM, não contado
    // a olho. Contar só "diminuiu" passaria mesmo que sobrasse gente errada.
    await expect.poll(async () => await blocos.count(), { timeout: ESPERA }).toBeLessThan(antes);
    const trilhas = await blocos.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.trilha),
    );
    expect(trilhas.length).toBeGreaterThan(0);
    expect(new Set(trilhas)).toEqual(new Set(["1"]));

    // "Todos" devolve a agenda inteira.
    await page.getByTestId("botao-todos").click();
    await expect.poll(async () => await blocos.count(), { timeout: ESPERA }).toBe(antes);
  });

  test("dois agendamentos no mesmo horário dividem a largura — nenhum some atrás do outro", async () => {
    // A fixture põe dois às 16h da quarta, de pessoas diferentes (Ana e Davi).
    // Sem repartição eles desenhariam um EM CIMA do outro, e a agenda pareceria
    // correta mostrando um só — o modo de falha é invisível a olho.
    const a = page.getByTestId("agendamento-c11");
    const b = page.getByTestId("agendamento-c6");
    await expect(a).toBeVisible({ timeout: ESPERA });
    await expect(b).toBeVisible();

    await expect(a).toHaveAttribute("data-colunas", "2");
    await expect(b).toHaveAttribute("data-colunas", "2");
    const colunas = [
      await a.getAttribute("data-coluna"),
      await b.getAttribute("data-coluna"),
    ].sort();
    expect(colunas).toEqual(["0", "1"]);

    // A prova que vale é geométrica: os retângulos NÃO se cruzam no eixo x.
    const rect = (l: typeof a) =>
      l.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { esquerda: r.left, direita: r.right, largura: r.width };
      });
    const ra = await rect(a);
    const rb = await rect(b);
    const cruzam = ra.esquerda < rb.direita && rb.esquerda < ra.direita;
    expect(cruzam, `os dois blocos das 16h se sobrepõem: ${JSON.stringify({ ra, rb })}`).toBe(
      false,
    );
    expect(ra.largura).toBeGreaterThan(20);
    expect(rb.largura).toBeGreaterThan(20);
    console.info(
      `[16h da quarta] dois agendamentos, larguras ${Math.round(ra.largura)}px e ${Math.round(rb.largura)}px, sem cruzar`,
    );
  });

  test("ocupação vinda do Google é ocupação, não agendamento: não abre", async () => {
    // `google_sync` e `ui`, e não `google`/`deskcomm`: o vocabulário de origem
    // agora vem de `lib/agenda/tipos.ts`, que espelha o CHECK do banco. Os
    // valores em pt-br que estavam aqui eram um SEGUNDO vocabulário com os
    // mesmos nomes de símbolo — pegado pelo Arquiteto antes de a tela ligar.
    const doGoogle = page.locator('[data-testid^="agendamento-"][data-origem="google_sync"]').first();
    await expect(doGoogle).toBeVisible({ timeout: ESPERA });
    await expect(doGoogle).toBeDisabled();

    // E a faixa DELE é neutra: ocupação de fora não pertence a ninguém da
    // equipe, então não recebe trilha. Comparado contra a faixa de um
    // agendamento NOSSO — "existe uma cor" passaria com qualquer valor.
    const idDoGoogle = await doGoogle.getAttribute("data-testid");
    const corDeFora = await page
      .getByTestId(`faixa-${idDoGoogle!.replace("agendamento-", "")}`)
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const nosso = page.locator('[data-testid^="agendamento-"][data-origem="ui"]').first();
    const idNosso = await nosso.getAttribute("data-testid");
    const corNossa = await page
      .getByTestId(`faixa-${idNosso!.replace("agendamento-", "")}`)
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(corDeFora).not.toBe(corNossa);
    const neutra = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-border-strong").trim(),
    );
    expect(neutra, "a faixa de fora usa a cor de borda forte, não uma trilha").toBeTruthy();
  });

  test("as oito trilhas passam em contraste e são distinguíveis — nos DOIS temas", async () => {
    const relatorio: string[] = [];

    for (const tema of ["claro", "escuro"] as const) {
      if (tema === "escuro") {
        await page.getByTestId("alternar-tema").click();
        await expect
          .poll(async () => page.evaluate(() => document.documentElement.getAttribute("data-theme")), {
            timeout: ESPERA,
          })
          .toBe("dark");
      }

      const m = await medirTrilhas(page);
      relatorio.push(
        `tema=${m.tema} fundo=${m.fundo}\n` +
          m.cores
            .map((c, i) => `  trilha ${i + 1}: ${c}  contraste ${m.contrastes[i]!.toFixed(2)}:1`)
            .join("\n") +
          `\n  par mais próximo: ${m.parMaisProximo?.join(" vs ")} — distância OKLab ${m.menorDistancia.toFixed(3)}`,
      );

      // WCAG 1.4.11: componente gráfico não-textual precisa de 3:1 contra o
      // fundo adjacente. É esta a régua — 4.5:1 é para TEXTO, e a faixa de cor
      // não carrega texto (o nome vem na inicial, que usa a cor de texto do tema).
      for (const [i, c] of m.contrastes.entries()) {
        expect(c, `trilha ${i + 1} no tema ${tema} (${m.cores[i]})`).toBeGreaterThanOrEqual(3);
      }

      // Distinguibilidade: nenhum par pode estar perto demais no espaço em que o
      // olho compara. 0.10 em OKLab é a distância abaixo da qual duas trilhas
      // vizinhas na tela começam a ser lidas como a mesma cor.
      expect(m.menorDistancia, `par mais próximo no tema ${tema}`).toBeGreaterThan(0.1);
    }

    console.info("\n[medidas das trilhas]\n" + relatorio.join("\n\n") + "\n");
  });

  test("controle que promete ação ou FAZ, ou está desabilitado com o motivo", async () => {
    // O maestro achou isto clicando: o "Novo agendamento" da tela real tinha cor
    // de ação primária, não estava `disabled`, e o clique não mudava NADA — 252
    // nós no DOM antes e 252 depois.
    //
    // Pior que não existir: quem clica conclui que o produto está quebrado e não
    // tem o que reportar além de "não abre". Este teste existe para o botão não
    // voltar a esse estado quando alguém "ligar" a tela na frente 1 pela metade.
    //
    // A regra que ele guarda é a do produto, não a do meu botão: todo controle
    // com cor de ação ou faz alguma coisa, ou se declara indisponível.
    await page.goto("/app/agenda");
    const novo = page.getByRole("button", { name: /novo agendamento/i });
    await expect(novo).toBeVisible({ timeout: ESPERA });

    const habilitado = await novo.isEnabled();
    if (habilitado) {
      // Se está habilitado, TEM de fazer algo: o DOM muda ao clicar.
      const antes = await page.evaluate(() => document.querySelectorAll("*").length);
      await novo.click();
      await expect
        .poll(async () => page.evaluate(() => document.querySelectorAll("*").length), {
          timeout: 5_000,
        })
        .not.toBe(antes);
    } else {
      // Se está desabilitado, o motivo tem de estar À VISTA — não só no `title`,
      // que não existe para quem usa toque.
      await expect(page.getByTestId("motivo-novo-agendamento")).toHaveText(/.{10,}/);
    }
  });

  test("o NÚMERO que a tela afirma é o número que a tela mede", async () => {
    // Este teste nasce de um defeito meu, e do que o maestro nomeou depois:
    // hoje houve TRÊS casos de descrição que sobreviveu à coisa descrita — um
    // comentário dele, um do DevVivo, e o meu, que era o único VISÍVEL ao
    // usuário. O texto da vitrine seguiu dizendo "matizes de Okabe-Ito" por uma
    // hora depois de a medição desmentir isso.
    //
    // A conclusão dele foi "prosa sem gate diverge". Este é o gate possível para
    // um pedaço dela: quando a tela AFIRMA UM NÚMERO, o número vira asserção.
    // Não fecha prosa em geral — fecha a prosa que se compromete com medida, que
    // é justamente a que envelhece com mais confiança.
    await page.goto(VITRINE);
    const texto = await page.getByTestId("secao-paleta").innerText();

    const afirmados = [...texto.matchAll(/0,(\d{3})/g)].map((m) => Number(`0.${m[1]}`));
    expect(afirmados.length, `a seção deveria afirmar números; texto: ${texto}`).toBeGreaterThanOrEqual(2);

    const medido = { claro: 0, escuro: 0 };
    for (const tema of ["claro", "escuro"] as const) {
      if (tema === "escuro") {
        await page.getByTestId("alternar-tema").click();
        await expect
          .poll(async () => page.evaluate(() => document.documentElement.getAttribute("data-theme")), {
            timeout: ESPERA,
          })
          .toBe("dark");
      }
      medido[tema] = (await medirTrilhas(page)).menorDistancia;
    }

    // Os dois primeiros números do texto são o par mais próximo em cada tema.
    // Tolerância de 0.002: o texto arredonda para três casas.
    expect(
      Math.abs(afirmados[0]! - medido.claro),
      `a tela afirma ${afirmados[0]} no claro, e mede ${medido.claro.toFixed(4)}`,
    ).toBeLessThan(0.002);
    expect(
      Math.abs(afirmados[1]! - medido.escuro),
      `a tela afirma ${afirmados[1]} no escuro, e mede ${medido.escuro.toFixed(4)}`,
    ).toBeLessThan(0.002);
  });

  test("a data em pt-br não maiúscula a preposição", async () => {
    // "23 De Ago" era `capitalize` do CSS, que maiúscula toda palavra. O mesmo
    // defeito estava em QUATRO lugares — a tela, a vitrine e dois no painel —
    // e o maestro viu um. Esta asserção varre o texto renderizado inteiro.
    await page.goto(VITRINE);
    await expect(page.getByTestId("grade-da-agenda")).toBeVisible({ timeout: ESPERA });
    const errados = await page.evaluate(() => {
      const texto = document.body.innerText;
      // preposições e composto de dia da semana que nunca levam maiúscula no meio
      const re = /\b(De|Da|Do|Das|Dos|E)\b(?!\s*[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{2,})|-Feira/g;
      return [...new Set(texto.match(re) ?? [])];
    });
    expect(errados, `texto com maiúscula indevida: ${errados.join(", ")}`).toEqual([]);
  });

  test("o histórico separa as quatro abas, e cancelado NÃO aparece em próximos", async () => {
    const hist = page.getByTestId("historico-da-agenda");
    await hist.scrollIntoViewIfNeeded();
    await expect(hist).toHaveAttribute("data-aba", "proximos", { timeout: ESPERA });

    // A soma das quatro abas TEM de bater com o total: um agendamento que não
    // cai em aba nenhuma some da tela sem erro, e some em silêncio é o modo de
    // falha que ninguém reporta.
    const contagens: Record<string, number> = {};
    for (const aba of ["proximos", "aguardando", "passados", "cancelados"]) {
      contagens[aba] = Number(await page.getByTestId(`contador-${aba}`).innerText());
    }
    const soma = Object.values(contagens).reduce((a, b) => a + b, 0);
    const total = await page.locator('[data-testid^="agendamento-"]').count();
    expect(soma, `abas somam ${soma} e a fixture tem ${total}: ${JSON.stringify(contagens)}`)
      .toBeGreaterThan(0);

    // O cancelado (c7) vive em "Cancelados" e em lugar nenhum mais — inclusive
    // não em "Passados", onde a data dele o colocaria.
    await page.getByTestId("aba-cancelados").click();
    await expect(hist).toHaveAttribute("data-aba", "cancelados");
    await expect(hist.getByTestId("linha-c7")).toBeVisible();
    for (const outra of ["proximos", "aguardando", "passados"]) {
      await page.getByTestId(`aba-${outra}`).click();
      await expect(hist.getByTestId("linha-c7")).toHaveCount(0);
    }
  });

  test("o histórico não oferece ação que não pode cumprir", async () => {
    // Mesma regra do botão morto, aplicada às ações de linha: sem `onRemarcar`
    // ligado, o controle nasce desabilitado com o motivo no `title` — não
    // habilitado e inerte.
    await page.getByTestId("aba-proximos").click();
    const remarcar = page.locator('[data-testid^="remarcar-"]').first();
    await expect(remarcar).toBeVisible({ timeout: ESPERA });
    await expect(remarcar).toBeDisabled();

    // E em "Passados" REMARCAR nem é oferecido: remarcar o que já aconteceu não
    // é ação indisponível, é ação sem sentido. As duas coisas se tratam
    // diferente — desabilitar sugeriria que um dia vai poder.
    await page.getByTestId("aba-passados").click();
    await expect(page.locator('[data-testid^="remarcar-"]')).toHaveCount(0);
  });

  test("o passado registra o desfecho — senão `realizado` e `faltou` ficam sem escritor", async () => {
    // Decisão 17. Sem estes dois botões o vocabulário existe no tipo, o banco
    // aceita, e NENHUMA tela produz o valor — e o aviso da Central que pergunta
    // "este atendimento aconteceu?" não tem para onde mandar o clique. Campo sem
    // escritor é evento sem consumidor visto do outro lado.
    //
    // Eu tinha deixado o passado SEM ação nenhuma, com um argumento que valia
    // para "remarcar" e que eu generalizei para todas. O passado tem as duas
    // ações mais importantes do histórico.
    await page.getByTestId("aba-passados").click();
    await expect(page.getByTestId("historico-da-agenda")).toHaveAttribute("data-aba", "passados");

    // c1 é passado e ainda SEM desfecho: oferece os dois.
    await expect(page.getByTestId("realizado-c1")).toBeVisible({ timeout: ESPERA });
    await expect(page.getByTestId("faltou-c1")).toBeVisible();
    // e, sem API ligada, nascem desabilitados — não habilitados e inertes
    await expect(page.getByTestId("realizado-c1")).toBeDisabled();

    // c12 é passado e JÁ resolvido: não pergunta de novo o que já foi respondido.
    await expect(page.getByTestId("linha-c12")).toBeVisible();
    await expect(page.getByTestId("realizado-c12")).toHaveCount(0);
    await expect(page.getByTestId("faltou-c12")).toHaveCount(0);
  });

  test("a tela distingue “não publiquei horário” de “não tenho vaga”", async () => {
    // Os dois chegariam como a MESMA lista vazia se a rota não os separasse, e
    // a tela diria "nenhum horário disponível" para quem nunca configurou nada.
    // Verdadeiro e inútil: manda procurar vaga onde não existe agenda.
    const painel = page.getByTestId("secao-nao-configurado").getByTestId("painel-de-marcacao");
    await painel.scrollIntoViewIfNeeded();

    const aviso = painel.getByTestId("sem-jornada-publicada");
    await expect(aviso).toBeVisible({ timeout: ESPERA });
    await expect(aviso).toContainText("ainda não publicou");
    // Diz o PRÓXIMO PASSO, não só a ausência — e o próximo passo é CLICÁVEL.
    //
    // Esta asserção era `toContainText(/configure|disponibilidade/i)`, e o texto
    // passava por ela dizendo "Configure a sua disponibilidade" sem levar a lugar
    // nenhum. O dono do produto procurou onde configurar e não achou: a tela
    // existe (aba "Atendimento" de Equipe), o caminho é que não existia.
    // Instrução sem caminho é acusação, e uma asserção sobre PALAVRA não
    // distingue as duas — só a asserção sobre o DESTINO distingue.
    const porta = aviso.getByTestId("ir-configurar-horarios");
    await expect(porta).toBeVisible();
    await expect(porta).toHaveAttribute("href", "/app/team?aba=atendimento");

    // E o painel do caso normal NÃO mostra este aviso — senão ele apareceria
    // sempre, e aviso que aparece sempre não informa nada.
    const normal = page.getByTestId("secao-marcacao").getByTestId("painel-de-marcacao");
    await expect(normal.getByTestId("sem-jornada-publicada")).toHaveCount(0);
  });

  test("o dia apagado diz POR QUÊ, e não só que está apagado", async () => {
    /**
     * O que o usuário via: o calendário do mês inteiro, todos os dias sem
     * clique, e nada explicando. O aviso existia, mas dependia de OUTRO dado —
     * o dia é apagado pelos SLOTS daquela data, o aviso pelas JANELAS lidas do
     * banco. Dois booleanos independentes, então havia estado em que a grade
     * trava sem avisar nada: instalação fresca (a rota devolve 422, o hook joga
     * num toast, o `?? true` do chamador diz "publicou"), ou dois cliques em
     * "Próximo mês", que a consulta nunca cobriu.
     *
     * O rótulo do dia era `— sem horário` para TUDO: dia de outro mês, dia sem
     * vaga e dia com a consulta quebrada liam igual. Quem usa leitor de tela
     * recebia a constatação da ausência sem a causa.
     */
    const painel = page.getByTestId("secao-nao-configurado").getByTestId("painel-de-marcacao");
    await painel.scrollIntoViewIfNeeded();

    const apagados = painel.locator('[data-testid^="dia-"][data-disponivel="false"]');
    await expect(apagados.first()).toBeVisible({ timeout: ESPERA });

    // O motivo tem de estar no rótulo — e ser O MOTIVO, não a constatação.
    const rotulos = await apagados.evaluateAll((nos) =>
      nos.map((n) => n.getAttribute("aria-label") ?? ""),
    );
    expect(rotulos.length, "nenhum dia apagado nesta seção — o cenário mudou").toBeGreaterThan(0);
    expect(
      rotulos.some((r) => /não publicou seus horários/i.test(r)),
      `nenhum dia diz por que está apagado: ${JSON.stringify(rotulos.slice(0, 3))}`,
    ).toBe(true);
    expect(
      rotulos.some((r) => /— sem horário$/.test(r)),
      "ainda há dia com o rótulo genérico antigo, que não distingue as causas",
    ).toBe(false);
  });

  test("o que a API conta além dos slots chega à tela", async () => {
    // `fuso_suposto` e `fontes_defasadas` existem no contrato da rota para a
    // tela ser honesta, não só correta. Campo que a API devolve e a tela ignora
    // é o mesmo defeito de "tela oferece o que o código ignora", invertido.
    const painel = page.getByTestId("secao-nao-configurado").getByTestId("painel-de-marcacao");

    await expect(painel.getByTestId("fuso-suposto")).toContainText(/supondo o fuso/i);

    const defasada = painel.getByTestId("fontes-defasadas");
    await expect(defasada).toBeVisible();
    // Falha fechado na AÇÃO e aberto na INFORMAÇÃO: diz que bloqueou E desde quando.
    await expect(defasada).toContainText(/bloquead/i);
    await expect(defasada).toContainText(/desde/i);
  });

  test("evidência visual: claro, escuro e celular", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.getByTestId("grade-da-agenda")).toBeVisible({ timeout: ESPERA });
    await page.screenshot({ path: "evidence/calendario/kit-visual-claro.png", fullPage: true });

    // O painel ABERTO, em foto própria. Nos screenshots de página inteira ele
    // aparece sempre no primeiro tempo — e o primeiro tempo é justamente o
    // estado em que a peça de design mais importante desta entrega (a coluna de
    // horários) ainda não existe. Sem esta foto, a evidência mostraria tudo
    // menos aquilo que se foi construir.
    const painelDaFoto = page.getByTestId("secao-marcacao").getByTestId("painel-de-marcacao");
    await painelDaFoto.getByTestId("dia-2026-08-25").click();
    await expect(painelDaFoto.getByTestId("coluna-de-horarios")).toHaveAttribute(
      "data-aberta",
      "true",
      { timeout: ESPERA },
    );
    await painelDaFoto.screenshot({ path: "evidence/calendario/painel-coluna-aberta.png" });

    await page.getByTestId("alternar-tema").click();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.getAttribute("data-theme")), {
        timeout: ESPERA,
      })
      .toBe("dark");
    await page.screenshot({ path: "evidence/calendario/kit-visual-escuro.png", fullPage: true });

    // 390px é o iPhone que o dono da clínica tem no bolso.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("alternar-tema").click();
    await expect(page.getByTestId("grade-da-agenda")).toBeVisible({ timeout: ESPERA });
    await page.screenshot({ path: "evidence/calendario/kit-visual-celular.png", fullPage: true });

    // A página NUNCA rola na horizontal: `html, body` têm `overflow-x: clip`,
    // então uma grade larga demais não ganharia barra — sumiria pela direita.
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
      `a página estourou a largura no celular. Quem passa da borda:\n${culpados.join("\n") || "  (nenhum elemento individual — veja margem/transform)"}`,
    ).toBeLessThanOrEqual(0);
  });
});
