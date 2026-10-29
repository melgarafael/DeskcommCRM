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
const EVIDENCE = path.join(process.cwd(), "evidence");

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
  test("a barra de respostas rápidas preserva o rascunho e volta a funcionar ao apagar (#3354)", async ({
    page,
  }) => {
    await login(page, creds.users.agent!.email);
    // Precondição pela rota real: recurso pessoal, na mesma sessão que atende.
    const titulo = `Rascunho ${SUFIXO}`;
    const corpo = `Resposta preparada ${SUFIXO}`;
    const criada = await page.request.post("/api/v1/message-templates", {
      data: { title: titulo, body: corpo, mostrar_na_barra: true },
    });
    expect(criada.status()).toBe(201);
    const { data: recurso } = (await criada.json()) as { data: { id: string } };
    try {
      await abrirConversa(page, conversas[0]!);
      const barra = page.getByRole("toolbar", { name: "Respostas rápidas" });
      const botao = barra.getByRole("button", { name: titulo, exact: true });
      const campo = page.getByRole("textbox", { name: "Mensagem", exact: true });
      await page.getByRole("button", { name: "Assumir", exact: true }).click();
      await expect(campo).toBeEditable();
      await expect(botao).toBeEnabled();
      const rascunho = "Já confirmo o horário com a equipe";
      await campo.fill(rascunho);
      await expect(botao).toBeDisabled();
      await expect(botao).toHaveAttribute("title", /Envie ou apague o rascunho/);
      // Clique físico no botão desligado: dispatchEvent/force contornariam a UX.
      const caixa = await botao.boundingBox();
      expect(caixa).not.toBeNull();
      await page.mouse.click(caixa!.x + caixa!.width / 2, caixa!.y + caixa!.height / 2);
      await expect(campo).toHaveValue(rascunho);
      fs.mkdirSync("evidence/lote-bugfixes-01a178b3", { recursive: true });
      await page.screenshot({ path: "evidence/lote-bugfixes-01a178b3/rascunho-preservado.png" });

      await campo.fill("");
      await expect(botao).toBeEnabled();
      await botao.click();
      await expect(campo).toHaveValue(corpo);
      // O comando em andamento continua sendo substituível, como no menu /.
      await campo.fill("/rascunho");
      await expect(botao).toBeEnabled();
      await page.getByRole("listbox", { name: "Templates de script" })
        .getByRole("button", { name: new RegExp(titulo) }).click();
      await expect(campo).toHaveValue(corpo);
      // O mesmo recurso passa a ter imagem real no Storage pela rota de upload.
      const upload = await page.request.post(`/api/v1/message-templates/${recurso.id}/midias`, {
        multipart: { file: { name: "controle.png", mimeType: "image/png", buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=", "base64",
        ) } },
      });
      expect(upload.status()).toBe(200);
      await page.reload();
      await expect(botao).toBeEnabled();
      const quantidadeAntes = await db.from("messages").select("id", { count: "exact", head: true })
        .eq("organization_id", orgId).eq("conversation_id", conversas[0]!);
      expect(quantidadeAntes.error).toBeNull();
      await botao.click();
      const previa = page.getByRole("dialog", { name: "Enviar anexo", exact: true });
      await expect(previa).toBeVisible();
      await expect(previa.getByRole("img").first()).toBeVisible();
      await expect.poll(() => previa.getByRole("img").first().evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect(previa.getByRole("textbox", { name: "Legenda", exact: true })).toHaveValue(corpo);
      const quantidadeDepois = await db.from("messages").select("id", { count: "exact", head: true })
        .eq("organization_id", orgId).eq("conversation_id", conversas[0]!);
      expect(quantidadeDepois.error).toBeNull();
      expect(quantidadeDepois.count).toBe(quantidadeAntes.count);
      await page.screenshot({ path: "evidence/lote-bugfixes-01a178b3/resposta-com-imagem-sem-enviar.png" });
      await previa.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(previa).not.toBeVisible();
    } finally {
      const removida = await page.request.delete(`/api/v1/message-templates/${recurso.id}`);
      expect(removida.ok(), "limpeza da resposta rápida do próprio caso").toBe(true);
    }
  });

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


test("Só os seus: abrir livre assume e tentativas seguintes não repetem efeitos", async ({ page }) => {
  const anterior = await db.from("organizations").select("settings").eq("id", orgId).single();
  expect(anterior.error).toBeNull();
  expect((await db.from("organizations").update({ settings: { ...anterior.data!.settings, visibility_mode: "own" } }).eq("id", orgId)).error).toBeNull();
  const nome = `Claim próprio ${SUFIXO}`;
  const contato = await insere("contacts", { organization_id: orgId, name: nome, display_name: nome, phone_number: `+55119${randomInt(10_000_000, 100_000_000)}` });
  contatos.push(contato);
  let leadId: string | undefined;
  try {
    // Card do próprio atendente: own conserva sua autoridade; não deve tomar card alheio.
    const etapa = await db.from("crm_stages").select("id,pipeline_id").eq("organization_id", orgId).order("position").limit(1).single();
    expect(etapa.error).toBeNull();
    leadId = await insere("crm_leads", { organization_id: orgId, pipeline_id: etapa.data!.pipeline_id, stage_id: etapa.data!.id,
      title: nome, contact_id: contato, position_in_stage: 0.5, source: "manual", owner_kind: "user", owner_user_id: creds.users.agent!.id });
    await login(page, creds.users.agent!.email);
    const entrada = { contact_id: contato, channel_session_id: canal };
    const abertura = await page.request.post("/api/v1/conversations/open-with-contact", { data: entrada });
    expect(abertura.status()).toBe(200);
    const id = ((await abertura.json()) as { data: { conversation_id: string } }).data.conversation_id;
    conversas.push(id);
    const contagens = async () => {
      const consultas = await Promise.all([
        db.from("conversation_assignment_events").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("conversation_id", id).eq("reason", "claim"),
        db.from("api_audit_log").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("resource_id", id).eq("action", "conversation.claimed"),
        db.from("event_log").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("entity_id", id).eq("event_type", "conversation.claimed"),
        db.from("crm_lead_activities").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("source_id", id).eq("type", "conversation_claimed"),
      ]);
      for (const q of consultas) expect(q.error).toBeNull();
      return consultas.map((q) => q.count);
    };
    await expect.poll(contagens).toEqual([1, 1, 1, 1]);
    const disputas = await Promise.all([
      page.request.post(`/api/v1/conversations/${id}/claim`, { data: {} }),
      page.request.post(`/api/v1/conversations/${id}/claim`, { data: {} }),
    ]);
    expect(disputas.map((r) => r.status())).toEqual([409, 409]);
    expect((await page.request.post("/api/v1/conversations/open-with-contact", { data: entrada })).status()).toBe(200);
    expect(await contagens()).toEqual([1, 1, 1, 1]);
    const dono = await db.from("conversations").select("assigned_to_user_id").eq("organization_id", orgId).eq("id", id).single();
    expect(dono.error).toBeNull();
    expect(dono.data!.assigned_to_user_id).toBe(creds.users.agent!.id);
    const card = await db.from("crm_leads").select("owner_user_id").eq("organization_id", orgId).eq("id", leadId).single();
    expect(card.error).toBeNull();
    expect(card.data!.owner_user_id).toBe(creds.users.agent!.id);
    await page.goto(`/app/inbox?id=${id}`);
    await expect(page.getByRole("textbox", { name: "Mensagem", exact: true })).toBeEditable();
    fs.mkdirSync("evidence/lote-bugfixes-01a178b3", { recursive: true });
    await page.screenshot({ path: "evidence/lote-bugfixes-01a178b3/conversa-propria-aberta.png" });
  } finally {
    expect((await db.from("organizations").update({ settings: anterior.data!.settings }).eq("id", orgId)).error).toBeNull();
    if (leadId) expect((await db.from("crm_leads").delete().eq("organization_id", orgId).eq("id", leadId)).error).toBeNull();
  }
});
