/**
 * A JORNADA INTEIRA DO CONHECIMENTO, PELA TELA.
 *
 * Não havia nenhuma spec de RAG neste repo — 54 arquivos em `tests/e2e/` e
 * nenhum tocava o acervo. É por isso que o defeito central sobreviveu tanto: o
 * indexador resolvia o agente pela ORGANIZAÇÃO (`is_default desc, created_at
 * asc, limit 1`) e ignorava o `agent_id` que os três emissores mandavam no
 * payload; numa organização com dois assistentes, o material do segundo nunca
 * virava trecho e ninguém via erro nenhum.
 *
 * O que esta bateria prova, na ordem em que a pessoa vive:
 *
 *  1. **Sem chave, a tela DIZ.** Era o silêncio mais caro do fluxo: numa
 *     instalação sem `OPENAI_API_KEY` — o estado de todo primeiro deploy, já que
 *     o campo do instalador é pulável com Enter — a tela prometia "a indexação
 *     começa em instantes", o material subia, e nada acontecia nunca.
 *  2. **A chave se cadastra ALI**, sem sair da tela, e a indexação recomeça.
 *  3. **Cada categoria funciona**: perguntas/respostas coladas e documento
 *     enviado como arquivo, os dois virando trecho buscável de verdade.
 *  4. **O assistente escolhe o que lê**, e a marcação vale para o assistente
 *     marcado — não para o primeiro da organização.
 *  5. **O que o agente aprendeu é auditável na tela**, e não só uma contagem.
 *
 * ⚠️ Esta spec usa a chave REAL da OpenAI (`OPENAI_API_KEY_E2E`), porque
 * embedding com dublê provaria que o código chama a função, não que o material
 * fica buscável. Sem a chave no ambiente, os casos que dependem dela são
 * PULADOS com motivo escrito — nunca passam por omissão.
 *
 * ═══ O QUE O CI **NÃO** PROVA (leia antes de confiar no `e2e` verde) ═══
 *
 * O CI não tem `OPENAI_API_KEY_E2E` — é uma chave paga, e segredo de repositório
 * público não é lugar para ela. Então **4 dos 6 casos PULAM lá**, e é medido, não
 * suposto: a parte 2 do `e2e` tinha `73 passed / 0 skipped` na main sem esta spec
 * e passou a `75 passed / 4 skipped` com ela (run 33020704572 × 33017042426).
 *
 * O que o CI prova, portanto, são os dois casos que não dependem da chave: a tela
 * DIZ que falta chave, e o material cadastrado sem chave fica esperando em vez de
 * mentir. **Que o material vira trecho buscável de verdade — o produto — só é
 * provado rodando esta spec com a chave**, como está em
 * `evidence/acervo-de-conhecimento/prova-de-tela-pos-merge.txt`.
 *
 * É o mesmo formato do aviso que a doutrina já dá sobre `vps-fresh-onboarding`
 * (o `e2e` verde não prova a jornada de instalação fresca). Um `skip` silencioso
 * é indistinguível de um `pass` no placar agregado; por isso o número está aqui.
 *
 * Para rodar a prova inteira, localmente:
 *
 *     OPENAI_API_KEY_E2E=sk-... E2E_BASE_URL=http://localhost:3011 \
 *       pnpm exec playwright test tests/e2e/acervo-de-conhecimento.spec.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type BrowserContext, type Page } from "./helpers/test";

import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const APP_URL = process.env.E2E_BASE_URL ?? "http://localhost:3011";
const SEGREDO_CRON = process.env.INTERNAL_SECRET ?? "e2e-placeholder-nao-e-segredo";
const CHAVE_OPENAI = process.env.OPENAI_API_KEY_E2E ?? "";

const NOME_FAQ = `E2E FAQ ${Date.now()}`;
const NOME_DOC = `E2E Documento ${Date.now()}`;

const CONTEUDO_FAQ = [
  "## Pergunta: Qual o prazo de entrega para Belo Horizonte?",
  "## Resposta: De 2 a 3 dias úteis após a confirmação do pagamento.",
  "",
  "## Pergunta: Vocês aceitam Pix?",
  "## Resposta: Sim, com 5% de desconto no valor total.",
].join("\n");

const CONTEUDO_DOC = [
  "# Política de troca",
  "",
  "Aceitamos troca em até 30 dias corridos a partir da entrega, com o produto",
  "sem uso e na embalagem original. O frete da devolução é por nossa conta",
  "quando o defeito for de fábrica.",
].join("\n");

interface CredsAcervo {
  acervo?: { agente_a: string; agente_b: string };
}

let creds: CredsE2E = lerCreds();

/**
 * UMA SESSÃO PARA A JORNADA INTEIRA — e não um login por caso.
 *
 * Duas razões, e a segunda é a que derrubou a bateria:
 *
 *  1. **É o que a pessoa faz.** Ninguém entra seis vezes para cadastrar um
 *     material, ver os trechos e marcar num assistente. Um login por caso
 *     mediria uma jornada que não existe.
 *  2. **O produto limita login por IP** (60 por 300 s, e no teste todos vêm do
 *     mesmo 127.0.0.1). Seis logins deste arquivo, somados aos das execuções
 *     anteriores, estouram o teto — e o sintoma é a tela de MFA que nunca
 *     renderiza, que se lê como bug do segundo fator. Medido aqui: o último
 *     caso caiu em `input[aria-label="Dígito 1"]` sem nunca aparecer.
 *
 * A sessão vive no `beforeAll`; cada caso reusa a MESMA aba. Em `mode: serial`
 * com um worker, isso é seguro e é o que o Playwright recomenda para jornada.
 */
let contexto: BrowserContext;
let page: Page;

function agentes(): { a: string; b: string } {
  const p = path.join(process.cwd(), ".e2e-creds.json");
  const atual = JSON.parse(fs.readFileSync(p, "utf8")) as CredsAcervo;
  if (!atual.acervo) {
    throw new Error("rode `npx tsx scripts/seed-e2e-acervo.ts` antes desta spec");
  }
  return { a: atual.acervo.agente_a, b: atual.acervo.agente_b };
}

/**
 * Roda o dreno do event_log — é ele que acorda o indexador.
 *
 * Cobra `failed + dead === 0` porque o 200 diz que o dreno RODOU, não que os
 * handlers deram certo: sem esta metade, um erro do indexador viraria "timeout"
 * mais adiante e a mensagem acusaria a tela.
 */
async function drenar(page: Page): Promise<void> {
  const r = await page.request.post("/api/v1/cron/event-log-drain", {
    headers: { authorization: `Bearer ${SEGREDO_CRON}` },
  });
  expect(r.status(), "o dreno tem que responder 200").toBe(200);
  const resumo = ((await r.json()) as { data: { failed: number; dead: number } }).data;
  expect(resumo.failed + resumo.dead, "nenhum handler pode ter falhado no dreno").toBe(0);
}

/** Cadastra a chave da OpenAI pela própria tela de conhecimento. */
async function cadastrarChavePelaTela(page: Page): Promise<void> {
  await page.getByTestId("conhecimento-cadastrar-chave").click();
  await page.getByTestId("conhecimento-chave-input").fill(CHAVE_OPENAI);
  await page.getByTestId("conhecimento-chave-salvar").click();
  // A validação com o provedor é assíncrona: a tela só pode prometer indexação
  // depois que ela volta.
  await expect(page.getByTestId("conhecimento-chave-ok")).toBeVisible({ timeout: 30_000 });
}

test.describe("acervo de conhecimento", () => {
  // SERIAL porque a jornada é uma só: o material que o caso 3 cadastra é o que o
  // caso 5 marca no assistente. E o teto de tempo é o REAL, não o default de
  // 30 s: cada caso paga login com MFA, a primeira renderização de uma rota em
  // `next start` (medido: dezenas de segundos), uma rodada do dreno e — nos
  // casos que provam recuperação de verdade — uma ida à OpenAI. Com o default,
  // o que reprovava era o relógio, não o produto.
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async ({ browser }) => {
    contexto = await browser.newContext();
    page = await contexto.newPage();
    // O helper re-semeia quando o fator TOTP foi rotacionado por outra frente
    // no mesmo Supabase local — sem isso, "MFA falhou" acusa a tela de MFA.
    creds = (await loginComoAdmin(page, creds)) as CredsE2E;
  });

  test.afterAll(async () => {
    await contexto?.close();
  });

  test("sem chave de embedding, a tela DIZ — e oferece o conserto ali mesmo", async () => {
    await page.goto("/app/ai/knowledge/sources");

    // Um dos dois tem de estar na tela; qual, depende de a organização já ter
    // chave. Afirmar só o negativo passaria com a tela em branco.
    const semChave = page.getByTestId("conhecimento-sem-chave");
    const comChave = page.getByTestId("conhecimento-chave-ok");
    await expect(semChave.or(comChave)).toBeVisible();

    if (await semChave.isVisible()) {
      // O aviso não é um beco: o conserto abre na própria tela.
      await page.getByTestId("conhecimento-cadastrar-chave").click();
      await expect(page.getByTestId("conhecimento-chave-input")).toBeVisible();
    }
  });

  test("cadastrar material sem chave: ele fica ESPERANDO, e a tela não mente", async () => {
    await page.goto("/app/ai/knowledge/sources");

    // ESPERAR O ESTADO ANTES DE PERGUNTAR POR ELE.
    //
    // `isVisible()` NÃO espera: chamado antes de a tela terminar de renderizar,
    // devolve `false` e o `test.skip` abaixo dispara — o caso some do relatório
    // como "pulado", que se lê igual a "não se aplica aqui". Cobertura parcial
    // silenciosa é o modo de falha que este repo mais persegue, e foi medido
    // exatamente assim nesta bateria.
    const semChaveLoc = page.getByTestId("conhecimento-sem-chave");
    await expect(
      semChaveLoc.or(page.getByTestId("conhecimento-chave-ok")).or(
        page.getByTestId("conhecimento-chave-conferindo"),
      ),
    ).toBeVisible({ timeout: 30_000 });

    const semChave = await semChaveLoc.isVisible();
    test.skip(
      !semChave,
      "esta organização já tem chave de embedding — o estado 'esperando' não é alcançável aqui",
    );

    await page.getByTestId("acervo-adicionar").click();
    // O diálogo AVISA antes de aceitar: descobrir depois de subir é a pior ordem.
    await expect(page.getByTestId("material-aviso-sem-chave")).toBeVisible();

    await page.getByTestId("material-nome").fill(`${NOME_FAQ} espera`);
    await page.getByTestId("material-conteudo").fill(CONTEUDO_FAQ);
    await page.getByTestId("material-criar").click();

    // ESPERAR O MATERIAL APARECER ANTES DE DRENAR.
    //
    // `click()` volta assim que o clique acontece, não quando o POST termina —
    // e o dreno pega só o que JÁ está em `event_log`. Sem esta espera o dreno
    // roda no vazio, o teste falha por "estado não apareceu", e a acusação cai
    // sobre o worker em vez de sobre a corrida do próprio teste. (Medido: o
    // evento ficava `pending` com `attempts=0` e `consumed_by` vazio.)
    await expect(page.getByText(`${NOME_FAQ} espera`)).toBeVisible({ timeout: 15_000 });

    await drenar(page);
    await page.reload();

    // "Esperando a chave" e "Ainda não preparado" são estados DIFERENTES, e a
    // diferença é a única coisa acionável: um pede uma ação, o outro é espera.
    await expect(page.getByText("Esperando a chave").first()).toBeVisible({ timeout: 20_000 });
  });

  test("com a chave cadastrada pela tela, perguntas e respostas viram trecho buscável", async () => {
    test.skip(
      CHAVE_OPENAI.length === 0,
      "OPENAI_API_KEY_E2E ausente: embedding com dublê provaria a chamada, não o material buscável",
    );

    await page.goto("/app/ai/knowledge/sources");

    if (await page.getByTestId("conhecimento-sem-chave").isVisible()) {
      await cadastrarChavePelaTela(page);
    }

    await page.getByTestId("acervo-adicionar").click();
    await page.getByTestId("material-nome").fill(NOME_FAQ);
    await page.getByTestId("material-conteudo").fill(CONTEUDO_FAQ);
    await page.getByTestId("material-criar").click();

    // Ver o material na lista é a prova de que o POST terminou — e só depois
    // dele o evento existe para o dreno pegar.
    await expect(page.getByText(NOME_FAQ, { exact: true })).toBeVisible({ timeout: 15_000 });

    await drenar(page);
    await page.reload();

    const cartao = page.locator('[data-testid^="material-"]').filter({ hasText: NOME_FAQ }).first();
    await expect(cartao.getByText("O agente já sabe")).toBeVisible({ timeout: 30_000 });

    // A contagem não basta: o que a pessoa precisa é ver o QUE ele leu.
    await cartao.getByRole("button", { name: "Ver o que ele aprendeu" }).click();
    await expect(page.getByTestId("material-trechos-lista")).toContainText("2 a 3 dias úteis");
  });

  test("documento enviado como arquivo também vira trecho — não só pergunta e resposta", async () => {
    test.skip(CHAVE_OPENAI.length === 0, "OPENAI_API_KEY_E2E ausente");

    await page.goto("/app/ai/knowledge/sources");

    await page.getByTestId("acervo-adicionar").click();
    await page.getByTestId("material-tipo-documento").click();
    await page.getByTestId("material-nome").fill(NOME_DOC);
    await page.getByTestId("material-arquivo").setInputFiles({
      name: "politica-de-troca.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(CONTEUDO_DOC, "utf8"),
    });
    await page.getByTestId("material-criar").click();

    await expect(page.getByText(NOME_DOC, { exact: true })).toBeVisible({ timeout: 20_000 });

    await drenar(page);
    await page.reload();

    const cartao = page.locator('[data-testid^="material-"]').filter({ hasText: NOME_DOC }).first();
    await expect(cartao.getByText("O agente já sabe")).toBeVisible({ timeout: 30_000 });

    await cartao.getByRole("button", { name: "Ver o que ele aprendeu" }).click();
    await expect(page.getByTestId("material-trechos-lista")).toContainText("30 dias corridos");
  });

  test("o assistente ESCOLHE o que lê, e a escolha é dele — não do primeiro da organização", async () => {
    test.skip(CHAVE_OPENAI.length === 0, "OPENAI_API_KEY_E2E ausente");

    const { a, b } = agentes();


    // O assistente B (que NÃO é o primeiro da organização) marca a FAQ.
    await page.goto(`/app/ai/agents/${b}`);
    const secao = page.getByTestId("agente-bases");
    await expect(secao).toBeVisible();

    const linha = secao.locator("div").filter({ hasText: NOME_FAQ }).first();
    await linha.getByRole("checkbox").check();
    await page.getByRole("button", { name: /Salvar/ }).first().click();
    await expect(page.getByText(/rascunho|salv/i).first()).toBeVisible({ timeout: 15_000 });

    // E o assistente A continua sem material nenhum: a marcação é POR
    // assistente. Enquanto o acervo pertencia ao agente e o indexador resolvia
    // pela organização, esta distinção não existia.
    await page.goto(`/app/ai/agents/${a}`);
    await expect(page.getByTestId("agente-bases")).toBeVisible();
    const marcadosEmA = await page
      .getByTestId("agente-bases")
      .getByRole("checkbox")
      .evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).checked).length);
    expect(marcadosEmA, "o assistente A não deveria ter herdado a marcação do B").toBe(0);
  });

  test("acervo que nenhum assistente lê é DITO — dinheiro gasto sem efeito era invisível", async () => {
    test.skip(CHAVE_OPENAI.length === 0, "OPENAI_API_KEY_E2E ausente");

    await page.goto("/app/ai/knowledge/sources");

    const cartaoDoc = page
      .locator('[data-testid^="material-"]')
      .filter({ hasText: NOME_DOC })
      .first();
    await expect(cartaoDoc.getByText("nenhum assistente ainda")).toBeVisible();
  });
});
