/**
 * JUNTAR CONTATOS DUPLICADOS — provado PELA TELA, e com o rigor que a
 * irreversibilidade cobra.
 *
 * O motor (`fn_mesclar_contatos`, migration 0215) já tem invariante contra
 * Postgres real. O que este spec guarda é a outra metade, que `curl` não
 * alcança: a porta existe na tela de contatos, o operador escolhe QUEM FICA com
 * os dois cadastros na frente, a fusão só acontece depois de uma confirmação
 * explícita, as mensagens das DUAS pontas ficam com o vencedor, o perdedor some
 * da lista — e quem não é gerente não consegue fundir.
 *
 * ─── A metade que este spec trava PORQUE ela surpreende ────────────────────
 * A CONVERSA do perdedor NÃO acompanha as mensagens dela.
 * `uniq_conversations_1to1_per_contact_session` é único por (org, contato,
 * sessão), e duas duplicatas de WhatsApp chegam pela MESMA sessão — repontar
 * colidiria, então a conversa fica na lápide e a função reporta em
 * `nao_repontado`. É comportamento previsto pela migration 0215, mas é o
 * caminho dominante do recurso, não um canto raro. O spec trava as duas
 * coisas: o desfecho e o fato de que o produto o ANUNCIA com o número.
 *
 * ─── Por que a confirmação é asserção de teste, e não detalhe de estilo ─────
 * A fusão não tem desfazer. O produto já trata como irreversível a EXCLUSÃO de
 * um contato (`ContactsTable` abre um `AlertDialog` "Excluir contato?"), que é
 * a ação menos grave das duas — a exclusão some com um cadastro, a fusão
 * reescreve o histórico de dois. Um clique único que funde e pronto seria a
 * única ação sem retorno do produto sem porteiro. Medido nesta sessão: antes do
 * conserto, um clique em "Juntar" mesclava direto.
 *
 * ─── O que se mede, e como ─────────────────────────────────────────────────
 * Contagem de linhas no BANCO antes/depois (conversas, mensagens, negócios),
 * `el.checked` do rádio, texto lido do DOM, `document.scrollWidth` para o
 * transbordo — nunca "parece certo". Toast é sinal de intenção, não de
 * persistência: toda asserção de efeito é relida depois de `reload()`.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/juntar-contatos-duplicados.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA =
  process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), ".superpowers/evidence/juntar-contatos");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;

/**
 * Sufixo único por execução. O banco de e2e é COMPARTILHADO entre frentes e
 * `contacts.phone_number` tem índice único parcial por organização — dois runs
 * com o mesmo número colidiriam no INSERT, e o vermelho leria como bug de tela.
 */
const SUFIXO = `${Date.now()}`.slice(-7);
/**
 * As duas grafias do MESMO celular: 12 dígitos (como o `wa_id` do inbound às
 * vezes chega) e 13 (como o brasileiro digita). Strings distintas para o
 * Postgres — por isso o índice único não as barra — e a mesma pessoa para
 * `canonicalPhoneBR`, que é o que a detecção usa.
 */
const LOCAL_8 = `9${SUFIXO}`; // 8 dígitos, faixa de celular (começa em 9)
const TELEFONE_12 = `+5531${LOCAL_8}`; // 55 + 31 + 8 = 12
const TELEFONE_13 = `+55319${LOCAL_8}`; // 55 + 31 + 9 + 8 = 13

const NOME_PRINCIPAL = `Duplicado Fica ${SUFIXO}`;
const NOME_ABSORVIDO = `Duplicado Absorvido ${SUFIXO}`;

let idPrincipal = "";
let idAbsorvido = "";
let sessaoId = "";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/**
 * O cartão do grupo deste run, dentro do diálogo.
 *
 * ⚠️ Ancorar só pelos dois NOMES não serve: o `div` mais interno que contém os
 * dois é a GRADE dos dois cadastros, e o motivo ("Agrupados por: …") e o botão
 * "Juntar" ficam FORA dela — irmãos, não descendentes. Medido: com aquele
 * seletor, `getByRole("button", { name: /juntar/ })` devolvia zero e um teste
 * de permissão passou por AUSÊNCIA do botão, que é um verde pelo motivo errado.
 * Ancorar no nome + no botão pega o cartão inteiro.
 */
function grupoDoRun(page: Page, dialogo: Locator): Locator {
  return dialogo
    .locator("div")
    .filter({ hasText: NOME_PRINCIPAL })
    .filter({ has: page.getByRole("button", { name: /^juntar$/i }) })
    .last();
}

/** Conta linhas de uma tabela que apontam para um contato. Lê do BANCO. */
async function contarPor(tabela: string, coluna: string, contatoId: string): Promise<number> {
  const { count, error } = await admin
    .from(tabela)
    .select("id", { count: "exact", head: true })
    .eq(coluna, contatoId);
  if (error) throw new Error(`contagem ${tabela}.${coluna}: ${error.message}`);
  return count ?? 0;
}

/**
 * `messages.contact_id` é NOT NULL e aponta DIRETO para o contato — não é
 * derivado da conversa. Contar por ele mede o que a fusão precisa repontar:
 * uma fusão que movesse só a conversa deixaria as mensagens penduradas na
 * lápide, e a tela do contato vencedor abriria vazia.
 */
async function contarMensagensDoContato(contatoId: string): Promise<number> {
  return contarPor("messages", "contact_id", contatoId);
}

async function criarContato(nome: string, telefone: string): Promise<string> {
  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: creds.org_id,
      display_name: nome,
      name: nome,
      phone_number: telefone,
    })
    .select("id")
    .single();
  if (error) throw new Error(`contato ${nome}: ${error.message}`);
  return (data as { id: string }).id;
}

/** Uma conversa com N mensagens, para o histórico ter o que atravessar a fusão. */
async function criarConversaCom(contatoId: string, quantas: number): Promise<string> {
  const { data, error } = await admin
    .from("conversations")
    .insert({
      organization_id: creds.org_id,
      contact_id: contatoId,
      channel_session_id: sessaoId,
      status: "open",
    })
    .select("id")
    .single();
  if (error) throw new Error(`conversa de ${contatoId}: ${error.message}`);
  const conversaId = (data as { id: string }).id;
  for (let i = 0; i < quantas; i++) {
    const { error: erroMsg } = await admin.from("messages").insert({
      organization_id: creds.org_id,
      conversation_id: conversaId,
      channel_session_id: sessaoId,
      contact_id: contatoId,
      direction: "inbound",
      type: "text",
      body: `mensagem ${i + 1} de ${contatoId.slice(0, 8)}`,
      external_id: `e2e-merge-${SUFIXO}-${contatoId.slice(0, 8)}-${i}`,
      status: "delivered",
    });
    if (erroMsg) throw new Error(`mensagem: ${erroMsg.message}`);
  }
  return conversaId;
}

/**
 * Apaga a fixture deste spec — TODA ela, por prefixo de nome, e não só os ids
 * desta execução.
 *
 * O Playwright REINICIA o processo do worker depois de um teste vermelho, e o
 * módulo é reavaliado: `SUFIXO` muda, o `beforeAll` roda de novo e cria um
 * segundo par. Medido nesta sessão: uma rodada com 3 vermelhos deixou 3 pares
 * de contatos no banco compartilhado, porque o `afterAll` do worker morto nunca
 * rodou. Limpar por prefixo recolhe o que ficou para trás.
 */
async function limparFixtures(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("display_name", "Duplicado %");
  const ids = ((data ?? []) as { id: string }[]).map((c) => c.id);
  if (ids.length === 0) return;

  const { data: conversas } = await admin.from("conversations").select("id").in("contact_id", ids);
  const idsConversa = ((conversas ?? []) as { id: string }[]).map((c) => c.id);
  if (idsConversa.length > 0) {
    await admin.from("messages").delete().in("conversation_id", idsConversa);
    await admin.from("conversations").delete().in("id", idsConversa);
  }
  await admin.from("messages").delete().in("contact_id", ids);
  // A lápide aponta para o vencedor; apagar o vencedor primeiro esbarraria na
  // FK. Zerar o ponteiro antes desfaz a ordem de dependência.
  await admin.from("contacts").update({ is_merged_into: null }).in("id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

test.describe("Contatos duplicados — juntar pela tela", () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    // Restos de uma execução anterior (worker reiniciado por vermelho) viram
    // grupos extras no diálogo e ruído na medição. Fora antes de semear.
    await limparFixtures();

    const { data: sessaoExistente } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", creds.org_id)
      .limit(1)
      .maybeSingle();
    sessaoId = (sessaoExistente as { id: string } | null)?.id ?? "";
    if (!sessaoId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: creds.org_id,
          waha_session_name: `e2e-merge-${SUFIXO}`,
          webhook_secret_encrypted: "e2e",
        })
        .select("id")
        .single();
      if (error) throw new Error(`channel_sessions: ${error.message}`);
      sessaoId = (data as { id: string }).id;
    }

    idPrincipal = await criarContato(NOME_PRINCIPAL, TELEFONE_13);
    idAbsorvido = await criarContato(NOME_ABSORVIDO, TELEFONE_12);
    await criarConversaCom(idPrincipal, 2);
    await criarConversaCom(idAbsorvido, 3);

    // `last_activity_at` decide o `principal_sugerido`. Deixar o vencedor com a
    // atividade mais recente torna a sugestão determinística — o spec ainda
    // exerce a TROCA do rádio, que é o ponto do controle explícito.
    await admin
      .from("contacts")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", idPrincipal);
    await admin
      .from("contacts")
      .update({ last_activity_at: new Date(Date.now() - 86_400_000).toISOString() })
      .eq("id", idAbsorvido);
  });

  test.afterAll(async () => {
    await limparFixtures();
  });

  test("a porta existe na tela de contatos e mostra os dois cadastros lado a lado", async ({
    page,
  }) => {
    const errosDeConsole: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errosDeConsole.push(m.text());
    });

    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/contacts");

    // 1. A PORTA. Botão presente na barra de ações da tela que já existe.
    const botao = page.getByRole("button", { name: /duplicados/i });
    await expect(botao).toBeVisible({ timeout: 20_000 });
    expect(await botao.count(), "a porta é UMA, não duas").toBe(1);

    await botao.click();

    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible({ timeout: 20_000 });
    await expect(dialogo.getByText(/contatos duplicados/i).first()).toBeVisible();

    // 2. O GRUPO. Os dois cadastros do run aparecem juntos, com o motivo escrito.
    const cartaoPrincipal = dialogo.getByText(NOME_PRINCIPAL, { exact: false });
    const cartaoAbsorvido = dialogo.getByText(NOME_ABSORVIDO, { exact: false });
    await expect(cartaoPrincipal).toBeVisible({ timeout: 20_000 });
    await expect(cartaoAbsorvido).toBeVisible();

    // O grupo do run: o <div> que contém os dois nomes.
    const grupo = grupoDoRun(page, dialogo);
    await expect(grupo.getByText(/mesmo telefone/i)).toBeVisible();

    // 3. A ESCOLHA É EXPLÍCITA. Dois rádios, exatamente um marcado.
    const radios = grupo.locator('input[type="radio"]');
    expect(await radios.count(), "um rádio por cadastro do grupo").toBe(2);
    const marcados = await radios.evaluateAll(
      (els) => els.filter((e) => (e as HTMLInputElement).checked).length,
    );
    expect(marcados, "exatamente um cadastro nasce escolhido").toBe(1);

    // O produto SUGERE o de atividade mais recente — e o rótulo diz qual fica.
    await expect(grupo.getByText(/este fica/i)).toHaveCount(1);
    await expect(grupo.getByText(/ser[áa] absorvido/i)).toHaveCount(1);

    // 4. O AVISO DE IRREVERSIBILIDADE está na frente de quem decide.
    await expect(dialogo.getByText(/n[ãa]o h[áa] como desfazer/i)).toBeVisible();

    await captura(page, "01-dialogo-duplicados");

    // 5. NÃO QUEBRA A TELA: sem transbordo horizontal, sem erro de console novo.
    const transbordo = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(transbordo, "a tela não rola na horizontal").toBeLessThanOrEqual(0);

    const inesperados = errosDeConsole.filter(
      (e) => !/favicon|ResizeObserver|Download the React DevTools/i.test(e),
    );
    expect(inesperados, `erros de console: ${inesperados.join(" | ")}`).toEqual([]);
  });

  test("a escolha de quem fica é do operador — trocar o rádio troca o rótulo", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/contacts");
    await page.getByRole("button", { name: /duplicados/i }).click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo.getByText(NOME_ABSORVIDO, { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    const cartaoDoAbsorvido = dialogo.locator("label").filter({ hasText: NOME_ABSORVIDO });
    const radioDoAbsorvido = cartaoDoAbsorvido.locator('input[type="radio"]');
    expect(
      await radioDoAbsorvido.evaluate((e) => (e as HTMLInputElement).checked),
      "o sugerido é o de atividade mais recente, não este",
    ).toBe(false);

    await radioDoAbsorvido.check();
    expect(await radioDoAbsorvido.evaluate((e) => (e as HTMLInputElement).checked)).toBe(true);
    await expect(cartaoDoAbsorvido.getByText(/este fica/i)).toBeVisible();

    // E volta: o controle não é de mão única.
    const cartaoDoPrincipal = dialogo.locator("label").filter({ hasText: NOME_PRINCIPAL });
    await cartaoDoPrincipal.locator('input[type="radio"]').check();
    await expect(cartaoDoPrincipal.getByText(/este fica/i)).toBeVisible();
    await captura(page, "02-troca-de-principal");
  });

  test("fundir exige confirmação explícita — desistir não funde nada", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/contacts");
    await page.getByRole("button", { name: /duplicados/i }).click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo.getByText(NOME_PRINCIPAL, { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    const grupo = grupoDoRun(page, dialogo);
    await grupo.getByRole("button", { name: /^juntar$/i }).click();

    // O porteiro: um passo a mais, nomeando quem fica e quem é absorvido.
    const confirmacao = page.getByRole("alertdialog");
    await expect(
      confirmacao,
      "a única ação sem desfazer do produto não pode acontecer em um clique",
    ).toBeVisible({ timeout: 10_000 });
    await expect(confirmacao.getByText(NOME_PRINCIPAL, { exact: false })).toBeVisible();
    await expect(confirmacao.getByText(/n[ãa]o h[áa] como desfazer/i)).toBeVisible();
    await captura(page, "03-confirmacao");

    // Desistir tem de significar desistir — e a prova é no BANCO, não na tela.
    await confirmacao.getByRole("button", { name: /cancelar/i }).click();
    await expect(confirmacao).toBeHidden({ timeout: 10_000 });

    const { data } = await admin
      .from("contacts")
      .select("is_merged_into")
      .eq("id", idAbsorvido)
      .single();
    expect(
      (data as { is_merged_into: string | null }).is_merged_into,
      "cancelar deixou o cadastro intacto",
    ).toBeNull();
  });

  test("agent não funde: o pedido é recusado e o banco não muda", async ({ page }) => {
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto("/app/contacts");
    await page.getByRole("button", { name: /duplicados/i }).click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo.getByText(NOME_PRINCIPAL, { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    const grupo = grupoDoRun(page, dialogo);
    const juntar = grupo.getByRole("button", { name: /^juntar$/i });

    // Duas saídas aceitáveis, e o spec mede QUAL delas: ou o controle não é
    // oferecido a quem não pode, ou ele é oferecido e recusa com um 403 legível.
    //
    // Anotar o caminho não é enfeite: um `if` que nunca entra deixa o teste
    // verde por AUSÊNCIA, e um seletor errado produz exatamente essa ausência —
    // foi o que aconteceu na primeira rodada deste arquivo.
    const oferecido = await juntar.count();
    // eslint-disable-next-line no-console
    console.log(`[quem-nao-pode] botão "Juntar" oferecido ao agent: ${oferecido}`);
    if (oferecido > 0) {
      const resposta = page.waitForResponse(
        (r) => r.url().includes("/api/v1/contacts/merge") && r.request().method() === "POST",
      );
      await juntar.click();
      const confirmacao = page.getByRole("alertdialog");
      if (await confirmacao.isVisible().catch(() => false)) {
        await confirmacao.getByRole("button", { name: /juntar|confirmar/i }).click();
      }
      const r = await resposta;
      expect(r.status(), "agent não é gerente — a fusão tem de ser recusada").toBe(403);
      await captura(page, "04-agent-recusado");
    }

    const { data } = await admin
      .from("contacts")
      .select("is_merged_into")
      .eq("id", idAbsorvido)
      .single();
    expect(
      (data as { is_merged_into: string | null }).is_merged_into,
      "a recusa não pode ter mesclado nada",
    ).toBeNull();
  });

  test("juntar de verdade: as mensagens das duas pontas ficam com quem ficou, e o que não coube é anunciado", async ({
    page,
  }) => {
    // ── ANTES: as contagens de origem, lidas do banco ──────────────────────
    const conversasAntesPrincipal = await contarPor("conversations", "contact_id", idPrincipal);
    const conversasAntesAbsorvido = await contarPor("conversations", "contact_id", idAbsorvido);
    const msgsAntesPrincipal = await contarMensagensDoContato(idPrincipal);
    const msgsAntesAbsorvido = await contarMensagensDoContato(idAbsorvido);
    expect(conversasAntesPrincipal, "fixture: o vencedor tem 1 conversa").toBe(1);
    expect(conversasAntesAbsorvido, "fixture: o perdedor tem 1 conversa").toBe(1);
    expect(msgsAntesPrincipal).toBe(2);
    expect(msgsAntesAbsorvido).toBe(3);

    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/contacts");
    await page.getByRole("button", { name: /duplicados/i }).click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo.getByText(NOME_PRINCIPAL, { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    const grupo = grupoDoRun(page, dialogo);
    // Escolha EXPLÍCITA do vencedor, mesmo quando coincide com a sugestão.
    await grupo.locator("label").filter({ hasText: NOME_PRINCIPAL }).locator("input").check();
    await grupo.getByRole("button", { name: /^juntar$/i }).click();

    const confirmacao = page.getByRole("alertdialog");
    await expect(confirmacao).toBeVisible({ timeout: 10_000 });
    const resposta = page.waitForResponse(
      (r) => r.url().includes("/api/v1/contacts/merge") && r.request().method() === "POST",
    );
    await confirmacao.getByRole("button", { name: /juntar|confirmar/i }).click();
    const r = await resposta;
    expect(r.status(), "manager pode fundir").toBe(200);

    // ── DEPOIS, no BANCO. Toast não é persistência. ────────────────────────
    //
    // MENSAGEM é o que não pode se perder, e é o que a fusão move inteiro:
    // `messages.contact_id` não tem índice único por contato, então as três
    // linhas do perdedor passam para o vencedor sem colidir.
    const msgsDepois = await contarMensagensDoContato(idPrincipal);
    expect(msgsDepois, "nenhuma mensagem se perdeu na fusão").toBe(
      msgsAntesPrincipal + msgsAntesAbsorvido,
    );
    expect(
      await contarMensagensDoContato(idAbsorvido),
      "a lápide não segura mais mensagem nenhuma",
    ).toBe(0);

    // ⚠️ CONVERSA é OUTRA HISTÓRIA, e este bloco existe para que ela não passe
    // despercebida. `uniq_conversations_1to1_per_contact_session` é único por
    // (org, contato, sessão de canal) — e duas duplicatas de WhatsApp chegam,
    // por construção, pela MESMA sessão. Repontar a conversa do perdedor
    // colidiria com a que o vencedor já tem, então ela FICA na lápide.
    //
    // Medido nesta fixture: `repontado` = {messages.contact_id: 3,
    // demandas.contact_id: 1}, `nao_repontado` = {conversations.contact_id: 1}.
    // Não é acidente nem bug de tela: é o desfecho previsto pela função, e o
    // caminho DOMINANTE do recurso (a duplicata nasce do mesmo número no mesmo
    // canal). Este spec trava o que o produto entrega hoje E trava que ele DIZ
    // isso — silêncio aqui leria como "juntou tudo".
    const corpoDaResposta = (await r.json()) as {
      data: { repontado: Record<string, number>; nao_repontado: Record<string, number> };
    };
    expect(
      corpoDaResposta.data.repontado["messages.contact_id"],
      "as mensagens do perdedor foram repontadas",
    ).toBe(msgsAntesAbsorvido);
    expect(
      corpoDaResposta.data.nao_repontado["conversations.contact_id"],
      "a conversa do perdedor colide com a do vencedor na mesma sessão de canal",
    ).toBe(conversasAntesAbsorvido);

    const conversasDepois = await contarPor("conversations", "contact_id", idPrincipal);
    expect(conversasDepois, "o vencedor segue com a conversa que já tinha").toBe(
      conversasAntesPrincipal,
    );

    // O PARCIAL TEM VOZ: o operador é avisado de quantas linhas ficaram para
    // trás, com o número. Uma fusão parcial anunciada como "pronto" esconderia
    // exatamente o caso em que alguém precisa olhar.
    const avisos = await page.locator("[data-sonner-toast]").allInnerTexts();
    expect(
      avisos.join(" | "),
      "a fusão parcial precisa dizer quantos registros ficaram no cadastro antigo",
    ).toMatch(/1 registro\(s\) continuaram no cadastro antigo/i);

    const { data: lapide } = await admin
      .from("contacts")
      .select("is_merged_into")
      .eq("id", idAbsorvido)
      .single();
    expect(
      (lapide as { is_merged_into: string | null }).is_merged_into,
      "o absorvido virou lápide apontando para quem ficou",
    ).toBe(idPrincipal);

    // ── DEPOIS, NA TELA, com reload: o perdedor some da lista ──────────────
    await page.reload();
    await page.waitForLoadState("networkidle");
    const busca = page.getByPlaceholder(/buscar|pesquisar|search/i).first();
    await busca.fill(`Duplicado`);
    await page.waitForTimeout(1200);
    const corpo = (await page.locator("body").innerText()).toLowerCase();
    expect(corpo, "quem ficou continua na lista").toContain(NOME_PRINCIPAL.toLowerCase());
    expect(corpo, "o absorvido sai da lista de contatos").not.toContain(
      NOME_ABSORVIDO.toLowerCase(),
    );
    await captura(page, "05-lista-depois-da-fusao");

    // ── E o grupo de duplicados esvazia: o trabalho ficou feito ────────────
    await page.getByRole("button", { name: /duplicados/i }).click();
    const dialogoDepois = page.getByRole("dialog");
    await expect(dialogoDepois).toBeVisible({ timeout: 20_000 });
    await expect(dialogoDepois.getByText(NOME_ABSORVIDO, { exact: false })).toHaveCount(0);
    await captura(page, "06-duplicados-depois");
  });
});
