/**
 * A PROVA EM TELA DA FRENTE 3 (Google Calendar BYO) — ainda NÃO escrita, e por
 * isso existe como `skip` com motivo em vez de como promessa num relatório.
 *
 * ─── Por que este arquivo nasce vazio, e por que nasce AGORA ──────────────
 *
 * A frente 3 é OAuth e worker: ela não tem pixel próprio. O botão "Conectar
 * Google" e a faixa de estado da conexão moram na tela da Agenda, que é da
 * frente 2. A DECISÃO 21 deixa uma frente sem tela fechar com prova de caminho
 * real DESDE QUE declare quem a prova em tela — e a 21.3 fechou o furo dessa
 * declaração: o endereço não é citado num relatório que alguém precisa reler,
 * concordar e lembrar. É criado aqui, e passa a existir para
 * `tests/unit/e2e-cobertura-completa.test.ts` como qualquer outra spec.
 *
 * Eu tinha proposto o nome e escrito "se o VPS preferir outro, a escolha é
 * dele". O diagnóstico estava certo e o remédio era fraco: nome combinado por
 * mensagem é exatamente a transferência que evapora. Quem for dono da tela pode
 * renomear, mover ou reescrever isto à vontade — o que ele não consegue é fazer
 * a obrigação sumir em silêncio.
 *
 * ─── A ORDEM DOS DOIS CASOS NÃO É ACIDENTAL ───────────────────────────────
 *
 * O caso SEM CHAVE vem primeiro de propósito. Ele não é borda: é a primeira
 * tela que 100% dos self-hosters vê, porque `GOOGLE_CALENDAR_CLIENT_ID` e
 * `GOOGLE_CALENDAR_CLIENT_SECRET` são opcionais (DECISÃO 3.1) e nenhuma
 * instalação nova as tem. Uma spec que só cobrisse o caminho feliz deixaria sem
 * prova justamente o estado que todo mundo encontra no dia 1.
 *
 * ─── O que estas specs vão provar quando existirem ────────────────────────
 *
 * 1. SEM CHAVE NA INSTALAÇÃO: a tela da Agenda abre inteira, o botão "Conectar
 *    Google" NÃO aparece, e no lugar dele há uma linha dizendo o que falta e
 *    onde obter. O que se prova aqui é que a ausência de configuração degrada
 *    com explicação em vez de derrubar o módulo — `configuracaoDoGoogle()`
 *    devolve `null` justamente para isto, e há teste unitário de que ela não
 *    lança. O que falta é a tela consumir esse `null`.
 *
 * 2. COM CHAVE: clicar "Conectar Google" leva ao consentimento (o destino é
 *    `accounts.google.com`, com `access_type=offline` e um `prompt` que contém
 *    `consent` (refresh_token) e `select_account` (seletor de contas) — sem
 *    `offline` + `consent` a reconexão volta sem `refresh_token` e a
 *    integração morre em uma hora); voltar do consentimento grava a conexão; e
 *    a faixa da Agenda passa a dizer que a agenda está conectada, com o e-mail
 *    da conta.
 *
 * ─── O que falta para deixarem de ser `skip` ──────────────────────────────
 *
 * Da minha frente: nada nas rotas — `connect` e `callback` existem e têm 17
 * casos unitários, incluindo sabotagem da guarda que separa organizações.
 * Falta da frente 2: a tela da Agenda renderizar o botão e a faixa de estado.
 * Enquanto não houver botão, não há clique para dirigir.
 *
 * E falta, para o caso 2 rodar em CI de verdade, uma conta Google de teste com
 * consentimento pré-aprovado — que é o motivo de ele ser `test.skip`, e não de
 * a spec ficar sem existir. O `skip` é do CASO; a SPEC roda no CI, e é o caso 1
 * que a sustenta lá.
 *
 * Esta frase já afirmou, aqui mesmo, que `vps-fresh-onboarding` era a única
 * entrada de `FORA_DO_CI` — e era falso no instante em que foi escrito (a
 * variável listava três). `CLAUDE.md` registra o mesmo erro cometido e
 * corrigido na própria doutrina. Por isso não há mais afirmação de estado
 * nestas linhas: quem precisa da resposta roda o comando, que não envelhece.
 * `grep` no arquivo inteiro não serve — ele conta quem é CITADO, não quem é
 * INVOCADO, e a `FORA_DO_CI` é uma variável YAML como as outras. O probe abaixo
 * é o de `CLAUDE.md`, de propósito: uma linha só, para sobreviver ao copiar-colar
 * daqui de dentro (bloco python indentado vira `IndentationError` quando o
 * prefixo do comentário vem junto — medido).
 *
 *     f=.github/workflows/e2e.yml
 *     python3 -c "import re;y=open('$f').read();print('fora:',sorted({s for _,c in re.findall(r'(FORA_DO_CI):\s*>-\n((?:[ ]{8,}.*\n)+)',y) for s in re.findall(r'[a-z0-9-]+\.spec\.ts',c)}))"
 *     python3 -c "import re;y=open('$f').read();print('roda:','agenda-conectar-google.spec.ts' in {s for _,c in re.findall(r'(SPECS_PARTE_\d+):\s*>-\n((?:[ ]{8,}.*\n)+)',y) for s in re.findall(r'[a-z0-9-]+\.spec\.ts',c)})"
 *
 */
import { expect, test, type Page } from "./helpers/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const ESPERA = 60_000;
test.describe.configure({ mode: "serial", timeout: 180_000 });

/**
 * ─── ATUALIZAÇÃO (@VPS, frente 2) ─────────────────────────────────────────
 *
 * O caso 1 DEIXOU de ser `skip`: a tela agora consome `googleEstaConfigurado()`
 * e `faltaParaConectarOGoogle()`, resolvidos no servidor e passados por prop —
 * a env nunca atravessa para o cliente.
 *
 * E ele roda no CI de graça, sem conta Google nenhuma: o ambiente de teste NÃO
 * tem `GOOGLE_CALENDAR_CLIENT_ID`, então ele já está no estado que 100% dos
 * self-hosters têm no dia 1. O caso mais importante era o mais barato de provar,
 * e por isso ele vinha primeiro no plano do DevGatilhos.
 *
 * O caso 2 continua `skip`, e o motivo não mudou: precisa de conta Google com
 * consentimento pré-aprovado.
 */
test.describe("conectar a agenda do Google", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    page = await browser.newPage();
    await loginComoAdmin(page, lerCreds());
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("sem chave do Google, a Agenda abre e explica o que falta", async () => {
    await page.goto("/app/agenda");

    // 1. A TELA ABRE INTEIRA. Env opcional ausente degrada com explicação, não
    //    derruba o módulo — é o que `configuracaoDoGoogle()` devolvendo `null`
    //    existe para permitir.
    await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: ESPERA });
    // `exact` porque o nome casa por SUBSTRING: com a agenda vazia, o aviso
    // "Sua agenda está livre esta semana" é um segundo heading, e os dois
    // coexistem desde que o vazio deixou de esconder a grade. Sem `exact`, dois
    // elementos → strict mode → vermelho. A spec irmã já tinha pago isto.
    await expect(page.getByRole("heading", { name: "Agenda", exact: true })).toBeVisible();

    // 2. O BOTÃO NÃO APARECE — e não é "aparece desabilitado". Desabilitado
    //    diria "você não pode"; o certo é "esta instalação ainda não tem".
    await expect(page.getByTestId("conectar-google")).toHaveCount(0);

    // 3. E NO LUGAR DELE há explicação, com três propriedades que importam:
    const explicacao = page.getByTestId("google-nao-configurado");
    await expect(explicacao).toBeVisible();
    //    (a) não culpa quem está lendo
    await expect(explicacao).toContainText(/não é nada que você tenha feito/i);
    //    (b) diz QUEM resolve
    await expect(explicacao).toContainText(/quem instalou/i);
    //    (c) diz o que continua funcionando — senão a pessoa acha que a agenda quebrou
    await expect(explicacao).toContainText(/funciona normalmente/i);

    // 4. E o texto NÃO despeja código: nada de nome de variável com underscore
    //    no meio da frase para quem não programa. A exceção é o bloco `o-que-falta`,
    //    que é deliberadamente o nome técnico da chave — quem instalou precisa dele.
    const corpo = await explicacao.innerText();
    const semOBloco = corpo.replace((await page.getByTestId("o-que-falta").innerText().catch(() => "")) || "\u0000", "");
    expect(semOBloco, `código cru na frase: ${semOBloco}`).not.toMatch(/[a-z]+_[a-z]+_[a-z]+/);
  });

  test.skip("conectar a agenda do Google pela tela e ver a faixa mudar", async () => {
    // Continua bloqueada, e NÃO pela frente 2: o botão existe agora. Falta uma
    // conta Google de teste com consentimento pré-aprovado — por isso ESTE CASO
    // é `test.skip`, e não a spec que fica sem existir: ela roda no CI pelo
    // caso 1. (Este comentário dizia "esta spec fica em FORA_DO_CI" — o gêmeo
    // literal da frase corrigida no cabeçalho, 77 linhas acima, e que passou
    // batido porque o conserto foi por instância. `grep -n 'FORA_DO_CI'` neste
    // arquivo fecha a classe.)
  });
});
