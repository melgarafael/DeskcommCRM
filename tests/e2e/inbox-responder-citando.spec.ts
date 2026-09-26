import { randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

/**
 * RESPONDER "EM CIMA" DE UMA MENSAGEM — pela tela, como o atendente faz.
 *
 * O canal intermediado aceita citação (`replyTo`, recebendo o `wamid`), e o
 * WhatsApp mostra a resposta pendurada na original. Todo o caminho novo é
 * VISUAL — escolher a mensagem, ver a faixa, cancelar, enviar — e nada disso é
 * alcançável por teste de unidade: eles provam que a função existe, não que dá
 * para clicá-la.
 *
 * ─── O que este arquivo cobre, e por que cada caso ──────────────────────────
 *
 * 1. o botão APARECE (é `opacity-0` até o hover; um `hidden` teria feito o
 *    layout pular, e um seletor que só olha o DOM passaria mesmo invisível);
 * 2. escolher mostra a faixa com o trecho citado;
 * 3. o `×` desfaz — sem saída, quem clica por engano fica preso citando;
 * 4. trocar de conversa LIMPA a citação. Este é o caso que mais importa: sem
 *    ele, a resposta sairia citando a mensagem de OUTRO cliente.
 *
 * Não cobre o que sai na rede: se o `replyTo` chegou ao provider é assunto do
 * adapter, e o teste de tela não deve fingir que mede isso.
 */

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
const EVIDENCE = path.join(process.cwd(), ".superpowers/evidence");

/**
 * Login simples — e por isso o usuário é o `agent`, nunca o `admin`.
 *
 * `admin` tem MFA obrigatório (doutrina de Auth), então o login dele para em
 * `/login/mfa` e este `waitForURL` nunca resolve. O repo tem um helper próprio
 * para esse caso (`helpers/login-admin.ts`), e ele existe justamente porque a
 * armadilha já pegou gente antes. As demais specs de inbox usam `agent`, que
 * tem o acesso que estes casos precisam.
 */
async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

/**
 * ─── POR QUE ESTE ARQUIVO SEMEIA O PRÓPRIO DADO (issue #1318) ───────────────
 *
 * Os dois casos abaixo saíam como **skip** no CI, e verde por skip é o pior
 * estado que existe: a lista de checks fica toda em ordem e a cobertura é
 * zero. O helper antigo perguntava ao ambiente "existe alguma conversa com
 * mensagens?" e pulava quando não existia — e o ambiente do CI nunca semeou
 * nenhuma, então a feature de responder citando não era medida por ninguém.
 *
 * Pior: a pergunta era feita por APARÊNCIA (`[class*='rounded-2xl']`), então o
 * painel flutuante, que fica no DOM mesmo fechado, respondia "sim" por meses —
 * o caso não pulava, morria em 30s no hover de um elemento escondido. Tirar o
 * painel (#963) não consertou o vermelho: trocou o disfarce dele por silêncio.
 *
 * Agora o dado é DESTE arquivo: duas conversas com mensagens de entrada, na
 * organização do próprio usuário de teste, criadas no `beforeAll` e apagadas no
 * `afterAll`. Se a semeadura falhar, os casos FALHAM — trocar "skip" por "verde
 * que não mediu nada" seria a mesma doença com outro nome.
 *
 * E a bolha passa a ser achada por `data-testid="message-bubble"`: identidade,
 * não aparência. Enquanto o seletor fosse uma classe utilitária, qualquer
 * componente novo com ela voltava a mentir.
 */

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

const SUFIXO = randomUUID().slice(0, 8);
/** As duas conversas semeadas: a primeira é onde se cita, a segunda é a troca. */
const conversas: string[] = [];
const contatos: string[] = [];
let canal = "";
let orgId = "";

async function insere(tabela: string, valores: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valores).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

/** Uma conversa com uma mensagem de entrada — o que a citação precisa existir. */
async function conversaComMensagem(nome: string, texto: string): Promise<string> {
  const contato = await insere("contacts", {
    organization_id: orgId,
    name: nome,
    phone_number: `+5511${randomInt(100000000, 1000000000)}`,
  });
  const conversa = await insere("conversations", {
    organization_id: orgId,
    contact_id: contato,
    channel_session_id: canal,
    status: "open",
    last_message_at: new Date().toISOString(),
  });
  await insere("messages", {
    organization_id: orgId,
    contact_id: contato,
    conversation_id: conversa,
    channel_session_id: canal,
    direction: "inbound",
    type: "text",
    status: "received",
    body: texto,
    sent_at: new Date().toISOString(),
    external_id: `citacao-${SUFIXO}-${randomUUID()}`,
  });
  contatos.push(contato);
  conversas.push(conversa);
  return conversa;
}

/**
 * Abre UMA conversa pelo id — não "a primeira da lista".
 *
 * `/app/inbox/<id>` redireciona para `/app/inbox?id=<id>`; esperar a URL final
 * é o que torna determinístico. Depender da ordem da lista faria este arquivo
 * medir a conversa que outra spec semeou primeiro.
 */
async function abrirConversa(page: Page, conversaId: string): Promise<void> {
  await page.goto(`/app/inbox/${conversaId}`);
  await page.waitForURL(new RegExp(`/app/inbox\\?id=${conversaId}`), { timeout: 60_000 });
  await expect(
    bolhas(page).first(),
    "a conversa semeada abriu sem nenhuma bolha de mensagem — a semeadura falhou",
  ).toBeVisible({ timeout: 30_000 });
}

/** A bolha por IDENTIDADE (`data-testid`), nunca por classe de aparência. */
const bolhas = (page: Page) => page.getByTestId("message-bubble");

test.beforeAll(async () => {
  // A organização é a do próprio usuário de teste: conversa semeada noutra org
  // não apareceria para ele, e o caso falharia por RLS parecendo defeito de tela.
  const { data, error } = await db
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", creds.users.agent!.id)
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(`organização do agente: ${error?.message ?? "não achei"}`);
  orgId = (data as { organization_id: string }).organization_id;

  canal = await insere("channel_sessions", {
    organization_id: orgId,
    waha_session_name: `citacao-${SUFIXO}`,
    display_name: `Canal citação ${SUFIXO}`,
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  await conversaComMensagem(`Cliente citação A ${SUFIXO}`, `Bom dia, queria saber do orçamento ${SUFIXO}`);
  await conversaComMensagem(`Cliente citação B ${SUFIXO}`, `Olá, é sobre outro assunto ${SUFIXO}`);
});

test.afterAll(async () => {
  if (conversas.length) await db.from("conversations").delete().in("id", conversas);
  if (contatos.length) await db.from("contacts").delete().in("id", contatos);
  if (canal) await db.from("channel_sessions").delete().eq("id", canal);
});

test.describe("responder citando", () => {
  test("o botão de responder revela a faixa, e o × a desfaz", async ({ page }) => {
    await login(page, creds.users.agent!.email);
    await abrirConversa(page, conversas[0]!);

    // Desde o #1626 responder é um item do menu da mensagem. O gatilho vive em
    // `opacity-0` até o hover. `toBeVisible` do Playwright considera opacidade 0
    // como visível, então o hover é o que prova de verdade que ele é alcançável
    // — e o clique, que é clicável.
    const opcoes = bolhas(page).first().getByRole("button", { name: /Opções da mensagem/i });
    await bolhas(page).first().hover();
    await expect(opcoes).toBeVisible();
    await opcoes.click();
    const responder = page.getByRole("menuitem", { name: /Responder a esta mensagem/i });
    await expect(responder).toBeVisible();
    await responder.click();

    // A faixa aparece acima do campo, com o botão de cancelar.
    const cancelar = page.getByRole("button", { name: /Cancelar resposta/i });
    await expect(cancelar).toBeVisible();
    await page.screenshot({
      path: path.join(EVIDENCE, "responder-citando-faixa.png"),
      fullPage: false,
    });

    await cancelar.click();
    await expect(cancelar).toHaveCount(0);
  });

  test("trocar de conversa LIMPA a citação", async ({ page }) => {
    // Sem isto a resposta sairia citando a mensagem de outro cliente — o pior
    // desfecho possível desta feature, e invisível até acontecer com alguém.
    await login(page, creds.users.agent!.email);
    await abrirConversa(page, conversas[0]!);

    await bolhas(page).first().hover();
    await bolhas(page).first().getByRole("button", { name: /Opções da mensagem/i }).click();
    await page.getByRole("menuitem", { name: /Responder a esta mensagem/i }).click();
    await expect(page.getByRole("button", { name: /Cancelar resposta/i })).toBeVisible();

    // Entra em OUTRA conversa semeada — pelo id, não pela lista: "a segunda da
    // lista" depende de quem semeou por último e faria este caso medir outra
    // coisa em cada rodada.
    await abrirConversa(page, conversas[1]!);

    await expect(
      page.getByRole("button", { name: /Cancelar resposta/i }),
      "a citação sobreviveu à troca de conversa",
    ).toHaveCount(0);
  });
});
