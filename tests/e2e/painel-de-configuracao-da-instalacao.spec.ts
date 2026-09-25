/**
 * O PAINEL DE CONFIGURAÇÃO DA INSTALAÇÃO, PELA TELA — como o dono da VPS usa.
 *
 * O produto deste repositório é a experiência de quem instala numa VPS. Até a
 * migration 0341, trocar a chave do serviço de e-mail exigia SSH no servidor,
 * editar o `.env` e recriar os contêineres — o que, para o público do kit, é o
 * mesmo que não ser configurável. Esta bateria prova a jornada inteira pela
 * tela, na ordem em que a pessoa a vive.
 *
 * O QUE ELA PROVA:
 *
 *  1. **A porta existe e é ACHÁVEL.** Antes desta mudança só se chegava ao
 *     painel digitando `/admin`, ou por um item chamado "Gerenciar organizações"
 *     escondido no seletor de organização — que leva a UMA tela e não anuncia
 *     que existe um painel. O caso 1 clica pelo caminho do usuário, sem navegar
 *     por URL, porque "a tela existe" e "alguém chega nela" são coisas
 *     diferentes, e a segunda é o produto.
 *  2. **Sem a chave, a tela DIZ.** É o estado de TODA instalação nova: a
 *     doutrina de QA do repo manda testar com os envs opcionais AUSENTES, "o
 *     estado real de um primeiro deploy, e é onde moram os piores bugs de
 *     primeira impressão".
 *  3. **Configurar pela tela vale NA HORA**, sem reiniciar nada.
 *  4. **O segredo NÃO volta ao navegador.** Só `••••` + 4 caracteres. Este caso
 *     varre o HTML servido inteiro, não só o campo — um segredo vazado numa
 *     propriedade de componente não aparece na tela e aparece no código-fonte.
 *  5. **O que não dá para editar não finge que dá.** Nenhum campo de texto para
 *     chave de partida; no lugar, o motivo em português. Controle decorativo é
 *     pior que ausência, e este projeto já pagou isso (PR #295, cinco deles).
 *  6. **Voltar ao padrão devolve a palavra ao arquivo de instalação.**
 *  7. **A tela é usável de verdade:** sem rolagem horizontal, sem botão fora da
 *     área visível, alvos de toque com tamanho mínimo. Medido por ferramenta
 *     (`getBoundingClientRect`), nunca a olho — a olho tudo parece bem.
 *
 * O QUE ELA **NÃO** PROVA:
 *
 *  - Que o `worker` (o segundo processo) enxerga a troca. Ele lê do banco no
 *    momento do uso (`lib/instalacao/config.ts`, sem memo, de propósito), mas
 *    provar isso pela tela exigiria disparar um envio real e observar o
 *    processo de segundo plano — fica para a bateria do worker.
 *  - Que o e-mail chega. A chave gravada aqui é de teste; provar entrega exigiria
 *    credencial real de provedor, que não vive em repositório público.
 */
import * as os from "node:os";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin, loginComoDono } from "./helpers/login-admin";
import { afirmarDonoDoServidor } from "./utils/precondicao";

const CHAVE_DE_TESTE = "re_teste_do_painel_9f3a2b";

test.describe("Painel de configuração da instalação", () => {
  // ⚠️ As partes do job `e2e` compartilham banco SEM reset, e quem promove o
  // `e2e-dono` a `platform_admins` é `seed-e2e-system-update` — que o CI NÃO
  // roda como passo. Sem esta afirmação, esta bateria passaria ou reprovaria
  // conforme a spec que rodou antes dela, que é medir ordem de execução em vez
  // de produto.
  test.beforeAll(async () => {
    await afirmarDonoDoServidor(lerCreds().users.dono!.email);
  });

  test.describe("como dono do servidor", () => {
    // ⚠️ UM login por arquivo, não um por caso. O login do dono espera a
    // PRÓXIMA janela do TOTP (o código não pode ser reusado), o que custa até
    // 30 s — o teto inteiro de um caso. Com login por caso, "voltar ao padrão"
    // clicava aos 29,8 s e era morto antes de a ação voltar: passava ou falhava
    // conforme a FASE da janela em que começava (runs 35447575926 e
    // 35451492770, lidas primeiro como defeito do botão). Aqui a espera é paga
    // uma vez, no gancho, com teto próprio; os casos reusam a sessão.
    const sessaoDoDono = path.join(os.tmpdir(), `e2e-sessao-dono-${process.pid}.json`);
    test.use({ storageState: sessaoDoDono });

    test.beforeAll(async ({ browser }, testInfo) => {
      test.setTimeout(90_000);
      const contexto = await browser.newContext({
        baseURL: testInfo.project.use.baseURL,
        storageState: undefined,
      });
      const page = await contexto.newPage();
      await loginComoDono(page, lerCreds());
      await contexto.storageState({ path: sessaoDoDono });
      await contexto.close();
    });

    test("a porta do modo administrador é achável sem digitar URL", async ({ page }) => {
      // Caminho do usuário: entra no sistema pela porta de sempre (`/app`, que
      // redireciona para a tela inicial dele, como depois do login) e acha o
      // painel pelo menu do próprio usuário, no canto. Nenhum goto() para /admin.
      // Com a sessão reaproveitada a página nasce em branco: sem esta entrada, o
      // caso procurava o menu numa página vazia (run 35454062082).
      await page.goto("/app");
      await page.waitForURL(/\/app\//);
      await page.getByRole("button", { name: /menu do usuário/i }).click();

      const porta = page.getByTestId("porta-modo-administrador");
      await expect(porta, "a porta do modo administrador não aparece no menu").toBeVisible();
      // O rótulo tem de ANUNCIAR o que é. "Gerenciar organizações" era o defeito.
      await expect(porta).toContainText(/modo administrador/i);
      await expect(porta).toContainText(/configurar este servidor/i);

      await porta.click();
      await expect(page).toHaveURL(/\/admin/);
    });

    test("a tela diz o que falta em vez de fingir que está pronto", async ({ page }) => {
      await page.goto("/admin/configuracao");

      await expect(
        page.getByRole("heading", { name: /configuração da instalação/i }),
      ).toBeVisible();

      // O grupo de e-mail vem PRIMEIRO: é o que falta em toda instalação nova.
      const primeiroGrupo = page.getByRole("heading", { level: 2 }).first();
      await expect(primeiroGrupo).toHaveText(/e-mail/i);

      // ⚠️ A CHAVE DO SERVIÇO EXTERNO NÃO MORA MAIS AQUI (DEC-009, opção A):
      // ela foi para `/admin/email`, ao lado do servidor próprio. O que esta
      // tela deve a quem procurar por ela onde ela esteve é o CAMINHO — sem
      // isso, "sumiu" é o que o operador entende por "não dá mais para
      // configurar".
      await expect(
        page.locator("#config-RESEND_API_KEY"),
        "a chave do serviço externo voltou a aparecer em Credenciais — ela mora em E-mail",
      ).toHaveCount(0);

      const ponteiro = page.getByTestId("ponteiro-email");
      await expect(
        ponteiro,
        "sem o ponteiro, quem procura a chave aqui conclui que ela sumiu",
      ).toBeVisible();
      await ponteiro.click();
      await expect(page).toHaveURL(/\/admin\/email/);
      await expect(
        page.locator("#config-RESEND_API_KEY"),
        "o caminho levou a uma tela que não tem a chave — o ponteiro estaria mentindo",
      ).toBeVisible();
    });

    test("configurar pela tela vale na hora, e o segredo não volta ao navegador", async ({
      page,
    }) => {
      // Na tela de E-MAIL desde o DEC-009 — mesmo campo, mesma ação de servidor,
      // mesma linha do banco; o que mudou foi o lugar.
      await page.goto("/admin/email");

      const campo = page.locator("#config-RESEND_API_KEY");
      await campo.fill(CHAVE_DE_TESTE);
      // ⚠️ PELO TESTID DA CHAVE, e não "o primeiro Salvar da tela". Nesta tela
      // existem DOIS: o do servidor SMTP vem antes no DOM, e `.first()` clicava
      // nele — o caso reprovou salvando a configuração errada, sem dizer isso.
      await page.getByTestId("salvar-RESEND_API_KEY").click();

      // A confirmação é em português de gente, não "operação concluída".
      await expect(page.getByText(/já está valendo/i)).toBeVisible({ timeout: 15_000 });

      // Depois de salvar, a origem passa a dizer que foi definido AQUI.
      await expect(
        page.getByText(/definido aqui nesta tela/i).first(),
        "a tela não passou a declarar a nova origem do valor",
      ).toBeVisible();

      // Os 4 últimos identificam a chave sem revelá-la.
      await expect(page.getByText(new RegExp(`••••${CHAVE_DE_TESTE.slice(-4)}`))).toBeVisible();

      // ⚠️ O CASO QUE MAIS IMPORTA: o segredo inteiro NÃO pode estar no documento.
      // Varre o HTML servido, não o campo — um vazamento por propriedade de
      // componente não aparece na tela e aparece no código-fonte da página.
      const html = await page.content();
      expect(
        html.includes(CHAVE_DE_TESTE),
        "o segredo inteiro apareceu no HTML da página — ele nunca deve voltar ao navegador",
      ).toBe(false);
    });

    test("o que não dá para editar não oferece campo — mostra o motivo", async ({ page }) => {
      await page.goto("/admin/configuracao");

      // Chave de partida: aparece (a pessoa precisa saber que existe), mas sem
      // campo de texto. Campo que aceita e ignora é pior que campo ausente.
      await expect(page.getByText(/endereço do banco de dados/i)).toBeVisible();
      await expect(
        page.locator("#config-NEXT_PUBLIC_SUPABASE_URL"),
        "chave de partida não pode ter campo editável",
      ).toHaveCount(0);

      // E o porquê está a um clique, em português.
      await page
        .getByRole("button", { name: /necessária para o sistema ligar/i })
        .first()
        .click();
      await expect(page.getByText(/trancar a chave dentro do cofre/i)).toBeVisible();
    });

    test("voltar ao padrão devolve a palavra ao arquivo de instalação", async ({ page }) => {
      await page.goto("/admin/email");

      const voltar = page.getByTestId("voltar-RESEND_API_KEY");
      await expect(voltar, "sem valor definido na tela não há o que reverter").toBeVisible();
      await voltar.click();

      // ⚠️ Verifica o EFEITO, não a mensagem. A primeira versão esperava o texto
      // do aviso de sucesso e reprovou por tempo esgotado — um aviso é efêmero
      // (some sozinho) e a tela recarrega logo depois, então a janela para vê-lo é
      // estreita e depende de corrida. O que o operador precisa que seja verdade
      // não é "apareceu um aviso": é que o valor VOLTOU a vir do arquivo de
      // instalação. É isso que se mede aqui.
      await expect(
        page.locator("#config-RESEND_API_KEY"),
        "a tela não recarregou depois de voltar ao padrão",
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText(/definido aqui nesta tela/i),
        "a origem continuou dizendo que o valor foi definido na tela",
      ).toHaveCount(0, { timeout: 15_000 });
    });

    // AS DUAS TELAS, e não só a minha: o campo do serviço externo passou a ser
    // desenhado em `/admin/email` pelo mesmo componente, e um campo que cabe
    // numa tela pode não caber na outra — a de e-mail tem largura própria
    // (`max-w-2xl`) e já vinha com os campos do servidor SMTP.
    for (const tela of ["/admin/configuracao", "/admin/email"]) {
      test(`a tela é usável em ${tela}: sem rolagem lateral, sem botão fora da vista`, async ({
        page,
      }) => {
        await page.goto(tela);
        await page.setViewportSize({ width: 390, height: 844 }); // celular comum

        // Medido por ferramenta, nunca a olho: a olho tudo parece bem.
        const rolagemLateral = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(rolagemLateral, "a tela força rolagem horizontal no celular").toBeLessThanOrEqual(1);

        // Todo botão precisa caber na largura da tela e ter alvo de toque decente.
        const problemas = await page.evaluate(() => {
          const ruins: string[] = [];
          for (const b of Array.from(document.querySelectorAll("button, a[href]"))) {
            const r = b.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue; // fora do fluxo, não conta
            if (r.right > window.innerWidth + 1)
              ruins.push(`fora da vista: ${b.textContent?.trim()}`);
            if (r.height > 0 && r.height < 24) ruins.push(`alvo pequeno: ${b.textContent?.trim()}`);
          }
          return ruins;
        });
        expect(problemas, `controles com problema de layout: ${problemas.join(" | ")}`).toEqual([]);
      });
    }
  });

  test("administrador de ORGANIZAÇÃO não vê a porta — e nem entra digitando a URL", async ({
    page,
  }) => {
    // ⚠️ O CASO QUE PROVA O GATE, e ele nasceu de um erro meu: a primeira versão
    // desta bateria logava como `admin` e concluía que a porta "não aparecia".
    // Ela NÃO deve aparecer para ele. `admin` é administrador de UMA
    // organização; `dono` é o administrador da INSTALAÇÃO. O painel mexe nas
    // credenciais que valem para TODOS os clientes — num revendedor, dar isso ao
    // admin de um cliente entregaria a ele as credenciais dos outros.
    // Único caso que paga login fresco (o papel é outro), então só ele declara
    // teto acima do período do TOTP: o login espera a próxima janela, até 30 s.
    test.setTimeout(90_000);
    const creds = lerCreds();
    await loginComoAdmin(page, creds);

    await page.getByRole("button", { name: /menu do usuário/i }).click();
    await expect(
      page.getByTestId("porta-modo-administrador"),
      "a porta do modo administrador VAZOU para um admin de organização",
    ).toHaveCount(0);

    // E a segunda barreira: digitar a URL também não entra.
    await page.goto("/admin/configuracao");
    await expect(page).not.toHaveURL(/\/admin\/configuracao/);
  });
});
