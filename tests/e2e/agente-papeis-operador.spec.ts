/**
 * A aba do papel OPERADOR na tela do agente (spec 16 §6).
 *
 * ═══ O QUE ESTE SPEC PROVA QUE O TESTE DE COMPONENTE NÃO PROVA ═══
 *
 * `tests/unit/painel-do-operador.test.tsx` monta o componente com props e
 * verifica o que ele renderiza. Isso mede o componente, não o produto: entre a
 * escolha do usuário e o banco existem o formulário, a server action, o Zod, o
 * `VERSION_COLUMNS` de seis arquivos e o `SELECT` que relê tudo. Cada um deles
 * pode perder um campo sem quebrar nenhum teste de unidade.
 *
 * O caso `salvar → RECARREGAR → conferir` é o coração daqui, e não é zelo
 * genérico: é o sintoma exato que `tests/unit/agent-version-columns-drift.test.ts`
 * descreve — *"um campo que se desmarca sozinho depois do refresh, e o save
 * seguinte grava o valor errado por cima"*. Aconteceu com `cases_enabled`
 * (entrou em 2 dos 7 arquivos) e eu repeti o padrão com `operator_*` nesta
 * mesma série, com 1 de 6. O teste que teria pego é este.
 *
 * ⚠️ Roda contra o Supabase LOCAL. O `playwright.config.ts` injeta o `.env.e2e`
 * e recusa subir sem ele — antes disso, esta suíte escrevia em produção.
 */
import { execFileSync } from "node:child_process";

import { test, expect, type Browser, type Page } from "./helpers/test";

import { loginComoAdmin, lerCreds, type CredsE2E } from "./helpers/login-admin";

import { CONFERENCIAS_DE_SAIDA, CONFERENCIA_DE_ENTRADA } from "@/lib/ai/guardrails/lista-de-conferencia";
let creds: CredsE2E = lerCreds();

test.use({ locale: "pt-BR" });

// Mesmo orçamento dos vizinhos: o login pode disparar uma re-semeadura de
// credenciais quando outra sessão rotaciona o fator TOTP deste banco.
test.describe.configure({ timeout: 240_000 });

/**
 * A tela de papéis é do agente `mcp_agent`. O `default_agent_id` do seed de
 * credenciais é um `rag_bot` — outro tipo, outra tela — e apontar para ele fazia
 * o spec falhar como se a aba não existisse. Medido ao escrever este arquivo.
 *
 * A precondição é semeada AQUI, e não pressuposta: depender de um `mcp_agent`
 * que outra spec deixou é depender da ordem alfabética dos arquivos, que já
 * mordeu este repo antes (ver o comentário do `.github/workflows/e2e.yml` sobre
 * `agente-novo-e-uso` vir antes de `followup-builder`).
 */
test.beforeAll(() => {
  execFileSync("npx", ["tsx", "scripts/seed-e2e-capacidades.ts"], { stdio: "inherit" });
  creds = lerCreds();
});

/**
 * UM login para a bateria inteira, numa página compartilhada.
 *
 * O padrão `beforeEach` + login custava 7 logins para exercitar uma aba, e o
 * produto tem teto de 60 logins por IP a cada 5 minutos (o mesmo que protege a
 * conta de um cliente real). Medido: com um login por teste, a bateria estourava
 * o teto no 3º caso e a falha aparecia como "campo de MFA não apareceu" —
 * parecendo defeito de produto onde havia limite de ambiente.
 *
 * `mode: "serial"` porque os casos passam a compartilhar estado de navegação:
 * um deles salva rascunho, e rodar em paralelo faria um pisar no outro.
 */
test.describe.configure({ mode: "serial" });

let pagina: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const contexto = await browser.newContext({ locale: "pt-BR" });
  pagina = await contexto.newPage();
  creds = await loginComoAdmin(pagina, creds);
});

test.afterAll(async () => {
  await pagina?.context().close();
});

/**
 * O agente da organização de teste. Falha ALTO se o seed não o deixou: sem isto
 * a navegação iria para `/app/ai/agents/undefined` e o erro apareceria como
 * "elemento não encontrado", mandando quem lê procurar um defeito de UI que não
 * existe.
 */
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

/** Abre o agente semeado e vai para a aba do papel que organiza o sistema. */
async function abrirAbaDoOperador(): Promise<void> {
  await pagina.goto(`/app/ai/agents/${agenteDeTeste()}`);
  await pagina.getByTestId("papel-operacao").click();
}

test.describe("A aba do papel que organiza o sistema", () => {
  test("os TRÊS papéis aparecem, e os nomes dizem o que cada um faz", async () => {
    await pagina.goto(`/app/ai/agents/${agenteDeTeste()}`);

    // Os rótulos são o contrato com quem configura. "Conversador"/"Operador" é
    // vocabulário nosso; quem tem uma clínica pensa em quem fala com o cliente
    // e em quem mantém a casa em ordem.
    await expect(pagina.getByTestId("papel-conversa")).toHaveText(/conversa com o cliente/i);
    await expect(pagina.getByTestId("papel-operacao")).toHaveText(/organiza o sistema/i);
    // O TERCEIRO. O épico se chama "os três papéis" e foi entregue com dois na
    // tela — a cadeia de conferências rodava e ninguém que configura sabia.
    await expect(pagina.getByTestId("papel-seguranca")).toHaveText(/confere antes de enviar/i);
  });

  test("o papel que confere mostra a lista inteira, aberta, e sem interruptor decorativo", async () => {
    await pagina.goto(`/app/ai/agents/${agenteDeTeste()}`);
    await pagina.getByTestId("papel-seguranca").click();

    const painel = pagina.getByTestId("painel-de-seguranca");
    await expect(painel).toBeVisible();

    // MEDIDA POR FERRAMENTA, não a olho: o defeito que este painel substitui era
    // um `<details>` FECHADO dentro do resultado de um teste — presente no DOM e
    // invisível na prática. Altura real > 0 é o que separa "existe" de "aparece".
    const altura = await painel.evaluate((el) => el.getBoundingClientRect().height);
    expect(altura, "o painel está no DOM e não ocupa espaço na tela").toBeGreaterThan(100);

    // Todas as conferências, não uma amostra.
    //
    // O NÚMERO É DERIVADO, NÃO ESCRITO. O painel renderiza as conferências de
    // saída MAIS a de entrada, que é uma só e mora fora do array porque roda
    // antes das outras, sobre o que CHEGA — `PainelDeSeguranca.tsx` a monta
    // assim, e esta é a mesma expressão que `painel-de-seguranca.test.tsx` usa.
    //
    // Era o literal `12` até este conserto, e o literal envelheceu em uma semana:
    // o PR #420 (@automatikpg-ux) acrescentou `agenda_stall`, atualizou o unit —
    // que reprova na hora — e não tinha como saber deste, que só reprova no
    // `e2e`, minutos depois e noutro job. A `main` ficou vermelha por isso.
    // Número escrito à mão envelhece calado; a expressão acompanha a lista.
    const itens = painel.locator('[data-testid^="item-conferencia-"]');
    await expect(itens).toHaveCount([...CONFERENCIAS_DE_SAIDA, CONFERENCIA_DE_ENTRADA].length);

    // EXATAMENTE DOIS interruptores de CONFERÊNCIA — um por camada que custa
    // dinheiro. Este caso já afirmou ZERO, e a mudança é deliberada: enquanto o
    // motor lia só o `.env`, um controle aqui seria a tela gravando o que o
    // código ignora. Depois que a 0142 criou a escolha por organização e os três
    // pontos de consumo passaram a lê-la, o interruptor deixou de ser decorativo.
    //
    // As outras nove seguem sem controle, e é isso que a contagem exata guarda:
    // uma conferência a mais com interruptor é alguém oferecendo desligar o que
    // protege o número do cliente.
    await expect(painel.locator('[data-testid^="conferencia-"][role="switch"]')).toHaveCount(2);

    // E a contagem TOTAL continua cercada, por categoria em vez de por número.
    // Ancorar só nas conferências abriria a porta que este caso existe para
    // fechar: um interruptor solto no painel, de categoria nenhuma, passaria
    // despercebido. Então todo `role="switch"` do painel tem de ser OU uma
    // conferência OU morar num cartão que se declara — e cartão novo entra aqui,
    // conscientemente, em vez de o número virar 3 sem ninguém olhar.
    //
    // O `ajustes-de-estilo` é troca determinística de pontuação, sem chamada de
    // modelo: não é camada paga, e por isso não entra na contagem acima.
    const CARTOES_DECLARADOS = ["ajustes-de-estilo"];
    const soltos = await painel.evaluate(
      (el, cartoes) =>
        Array.from(el.querySelectorAll('[role="switch"]'))
          // O rótulo é do PRÓPRIO interruptor, nunca de um ancestral: a primeira
          // versão desta linha perguntava pelo `closest`, e aí um interruptor
          // embrulhado num cartão `conferencia-*` sem carregar o rótulo escapava
          // das DUAS asserções — nem contava como conferência, nem aparecia como
          // solto. Medido em bancada antes de entrar.
          .filter((s) => !s.getAttribute("data-testid")?.startsWith("conferencia-"))
          .filter((s) => !cartoes.some((c) => s.closest(`[data-testid="${c}"]`)))
          .map((s) => s.getAttribute("data-testid") ?? s.outerHTML.slice(0, 80)),
      CARTOES_DECLARADOS,
    );
    expect(soltos, "interruptor no painel de segurança sem categoria declarada").toEqual([]);
  });

  test("desligado, a tela diz o que CONTINUA acontecendo — não só o que para", async () => {
    await abrirAbaDoOperador();

    const aviso = pagina.getByTestId("operador-consequencia");
    await expect(aviso).toBeVisible();
    // Sem a primeira metade, o usuário conclui que desligar deixa o sistema
    // cego, e liga por medo em vez de escolha. A decisão da spec 16 §2.1 é que
    // o registro básico continua por código determinístico.
    await expect(aviso).toContainText(/continua atendendo/i);
    await expect(aviso).toContainText(/registrado sozinho/i);
    await expect(aviso).toContainText(/decidir sobre a operação/i);
  });

  test("desligado, não oferece configuração que não vai valer", async () => {
    await abrirAbaDoOperador();
    // Convidar alguém a escolher capacidades de um papel desligado produz a
    // conclusão de que o produto quebrou quando nada acontece.
    await expect(pagina.getByTestId("operador-capacidades")).toBeHidden();
  });

  test("ligar revela as escolhas do papel, e elas são SÓ dele", async () => {
    await abrirAbaDoOperador();
    await pagina.getByTestId("operador-liga").click();

    await expect(pagina.getByTestId("operador-capacidades")).toBeVisible();
    // A frase que impede o modelo mental errado: esta lista não é a mesma da
    // aba de conversa.
    await expect(pagina.getByText(/só deste papel/i)).toBeVisible();
    // Sem nada marcado, o papel ainda tem função — e a tela diz qual, senão o
    // usuário liga, não marca nada e conclui que quebrou.
    await expect(pagina.getByTestId("operador-sem-capacidade")).toContainText(/prometer algo/i);
  });

  test("a escolha SOBREVIVE ao recarregar — o caso que pega o campo perdido no meio do caminho", async () => {
    await abrirAbaDoOperador();

    // Estado inicial: desligado (default do banco — migration não liga sozinha
    // um papel que gasta modelo na chave do self-hoster).
    await expect(pagina.getByTestId("operador-consequencia")).toBeVisible();

    await pagina.getByTestId("operador-liga").click();
    await expect(pagina.getByTestId("operador-capacidades")).toBeVisible();

    await pagina.getByRole("button", { name: /salvar rascunho/i }).click();
    await expect(pagina.getByText(/rascunho v\d+ salvo/i)).toBeVisible({ timeout: 20_000 });

    // O RECARREGAMENTO é o teste. Tudo até aqui vive em estado de React; só
    // depois desta linha a resposta vem do banco, atravessando a server action,
    // o Zod, o VERSION_COLUMNS e o SELECT que relê. É onde um campo que ninguém
    // propagou some em silêncio.
    await pagina.reload();
    await pagina.getByTestId("papel-operacao").click();

    await expect(
      pagina.getByTestId("operador-capacidades"),
      "o papel voltou desligado depois do refresh — algum ponto do caminho não " +
        "carrega operator_enabled (ver agent-version-columns-drift.test.ts)",
    ).toBeVisible();
    await expect(pagina.getByTestId("operador-consequencia")).toBeHidden();
  });

  test("o modelo do papel volta a herdar, e isso também sobrevive ao refresh", async () => {
    await abrirAbaDoOperador();
    await pagina.getByTestId("operador-liga").click();

    // Com o papel recém-ligado e sem modelo escolhido, o caminho de volta não
    // faz sentido — não há para onde voltar.
    await expect(pagina.getByTestId("operador-modelo-herdar")).toBeHidden();

    await pagina.getByRole("button", { name: /salvar rascunho/i }).click();
    await expect(pagina.getByText(/rascunho v\d+ salvo/i)).toBeVisible({ timeout: 20_000 });

    await pagina.reload();
    await pagina.getByTestId("papel-operacao").click();
    // `operator_model` NULL = herda o do Conversador. Se o refresh trouxesse
    // uma string vazia virando "modelo escolhido", o botão apareceria — e o
    // usuário veria uma escolha que ele não fez.
    await expect(pagina.getByTestId("operador-modelo-herdar")).toBeHidden();
  });

  test("a tela do papel não fala a NOSSA língua", async () => {
    await abrirAbaDoOperador();
    await pagina.getByTestId("operador-liga").click();

    // O mesmo defeito que a spec 16 existe para matar, um nível acima: se o
    // vocabulário interno vaza para quem CONFIGURA, ele vaza de novo para quem
    // é atendido — o dono do negócio copia o que lê.
    const corpo = (await pagina.locator("main").innerText()).toLowerCase();
    for (const jargao of ["operator_", "tool_ids", "mcp", "payload", "job_queue"]) {
      expect(corpo, `vocabulário interno na tela: ${jargao}`).not.toContain(jargao);
    }
  });
});
