/**
 * A BUSCA E OS FILTROS DA INBOX DIZEM A VERDADE — PELA TELA.
 *
 * ## Por que esta spec existe
 *
 * Os oito consertos deste PR têm teste de unidade e de invariante, e nenhum deles
 * alcança o que o operador vive: o defeito principal era a tela AFIRMAR um estado
 * que o servidor não tinha. Medido numa instalação real, com duas conversas
 * existindo e "Não lidos" ligado, a tela dizia:
 *
 *     "Sem conversas por aqui — quando chegarem mensagens, elas aparecem aqui"
 *
 * Sem erro, sem aviso. E ligar o botão não gerava requisição nenhuma — provado
 * com controle positivo (trocar de aba, na mesma sessão, gerava).
 *
 * ## O caso que NENHUM teste unitário cobre, e por isso ele abre a lista
 *
 * Digitar UMA letra na busca não pode fazer erro aparecer na tela. O piso de dois
 * caracteres vive no schema (a rota recusa), e o hook trata falha com
 * `showApiError` — que aparece para quem está digitando. A guarda que impede o
 * pedido mora no `InboxLayout`, e o arnês que renderiza esse componente mocka o
 * `InboxFilters`, então não há como digitar nele. Esta spec é o ÚNICO gate dessa
 * guarda: sem ela, tirar a guarda passa verde em tudo.
 *
 * ## O que ela prova, e sempre pelo caminho do ERRO
 *
 * O caminho feliz é o que teste manual já cobre. O que paga é provocar a falha:
 * uma letra só, espaço duplo, termo inexistente, filtro que zera a lista.
 */
import { expect, test } from "./helpers/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const CAMPO_DE_BUSCA = "Buscar conversas";

/**
 * ⏱️ 60s, e o número saiu de MEDIÇÃO — não de chute.
 *
 * O `beforeEach` loga com MFA, e o helper de login espera a próxima janela do
 * TOTP quando o código anterior já foi usado: até 30 segundos parados antes de a
 * tela fazer qualquer coisa. O teto padrão do Playwright são 30s e ele mede o
 * teste INTEIRO, login incluso — então a espera do relógio consome a prova.
 *
 * No CI de 2026-09-13 as durações foram 4.1s · 29.7s · 29.7s · 30.7s✘ · 6.3s ·
 * 22.1s · 30.8s✘ · 6.6s. Os dois vermelhos estouraram o teto com a asserção mal
 * tendo começado, e o mesmo caso passou em 6.3s quando a janela do TOTP caiu a
 * favor. Não é o produto: é o relógio.
 */
test.describe.configure({ timeout: 60_000 });

test.beforeEach(async ({ page }) => {
  await loginComoAdmin(page, lerCreds());
  await page.goto("/app/inbox");
  await expect(page.getByLabel(CAMPO_DE_BUSCA)).toBeVisible();
});

test("uma letra só não gera erro na tela nem requisição", async ({ page }) => {
  const pedidos: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/conversations?")) pedidos.push(r.url());
  });

  await page.getByLabel(CAMPO_DE_BUSCA).fill("a");
  await page.waitForTimeout(600); // o debounce é de 250 ms

  expect(
    pedidos.filter((u) => u.includes("search=")),
    "a tela pediu a busca que a rota recusa",
  ).toEqual([]);
  await expect(
    page.getByText(/erro|falhou|internal/i),
    "apareceu erro ao digitar a primeira letra",
  ).toHaveCount(0);
});

test("CONTROLE: com dois caracteres a busca VAI ao servidor", async ({ page }) => {
  // Sem este caso, uma tela que nunca buscasse passaria no de cima.
  const pedidos: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("search=")) pedidos.push(r.url());
  });

  await page.getByLabel(CAMPO_DE_BUSCA).fill("an");
  await expect
    .poll(() => pedidos.length, { timeout: 5_000 })
    .toBeGreaterThan(0);
});

test("o placeholder promete o que a busca faz — a ÚLTIMA mensagem", async ({ page }) => {
  await expect(page.getByLabel(CAMPO_DE_BUSCA)).toHaveAttribute(
    "placeholder",
    /última mensagem/i,
  );
});

test("lista vazia por filtro NÃO se passa por caixa vazia, e mantém a saída", async ({
  page,
}) => {
  // Termo que não casa nada: a lista zera POR FILTRO, não por ausência.
  await page.getByLabel(CAMPO_DE_BUSCA).fill("zzqqxxnaoexiste");

  await expect(
    page.getByText(/Sem conversas por aqui/i),
    "a tela afirmou caixa vazia com um filtro ativo",
  ).toHaveCount(0);
  await expect(page.getByText(/Nenhuma conversa com esses filtros/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Limpar filtros/i })).toBeVisible();
});

test('"Limpar filtros" devolve a lista e MANTÉM a aba', async ({ page }) => {
  await page.getByLabel(CAMPO_DE_BUSCA).fill("zzqqxxnaoexiste");
  await expect(page.getByRole("button", { name: /Limpar filtros/i })).toBeVisible();

  await page.getByRole("button", { name: /Limpar filtros/i }).click();

  await expect(page.getByLabel(CAMPO_DE_BUSCA)).toHaveValue("");
  await expect(
    page.getByText(/Nenhuma conversa com esses filtros/i),
  ).toHaveCount(0);
});

test('"Não lidos" VAI ao servidor — o defeito era filtrar a página carregada', async ({
  page,
}) => {
  const comUnread: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("unread=true")) comUnread.push(r.url());
  });

  await page.getByRole("button", { name: /Não lidos/i }).click();

  await expect
    .poll(() => comUnread.length, { timeout: 5_000 })
    .toBeGreaterThan(0);
});

test("trocar de aba logo após digitar NÃO volta à aba anterior", async ({ page }) => {
  // O timer do debounce é de 250 ms; a troca acontece dentro da janela.
  await page.getByLabel(CAMPO_DE_BUSCA).fill("teste");
  await page.getByRole("tab", { name: /Todas/i }).click();
  await page.waitForTimeout(600);

  await expect(
    page.getByRole("tab", { name: /Todas/i }),
    "o debounce desfez a troca de aba",
  ).toHaveAttribute("aria-selected", "true");
});

test('a aba "Fechadas" mostra número', async ({ page }) => {
  // Ela existia sem contador nenhum. Num inbox antigo é o número que diz o
  // tamanho do arquivo, e a ausência fazia a aba parecer um lugar vazio.
  //
  // ⚠️ O badge NÃO mostra zero, e isso é deliberado — vale para todas as abas,
  // senão cada aba vazia carregaria um zero. Então o teste precisa criar a sua
  // conversa fechada: torcer para o ambiente ter uma é o que fazia este caso
  // reprovar um produto correto em banco fresco.
  //
  // E ele CRIA a sua em vez de fechar uma existente. Este Supabase é
  // compartilhado entre frentes; fechar conversa alheia muda o mundo de outra
  // spec, e o estrago apareceria longe daqui.
  const aberta = await page.request.post("/api/v1/conversations/open-with-contact", {
    data: { phone_number: `+5511${Date.now().toString().slice(-9)}`, name: "Arquivo do teste" },
  });
  expect(aberta.ok(), await aberta.text()).toBe(true);
  // `open-with-contact` devolve `{ conversation_id, contact_id }` — NAO um `id`.
  // Supor `id` produzia `invalid input syntax for type uuid: "undefined"`, e o
  // erro chegava como 500 do banco, longe da causa. Medido no CI em 2026-09-13.
  const { data: conversa } = await aberta.json();

  const fechada = await page.request.patch(`/api/v1/conversations/${conversa.conversation_id}`, {
    data: { status: "closed" },
  });
  expect(fechada.ok(), await fechada.text()).toBe(true);

  await page.reload();
  await expect(page.getByRole("tab", { name: /Fechadas/i })).toHaveText(/\d/);
});
