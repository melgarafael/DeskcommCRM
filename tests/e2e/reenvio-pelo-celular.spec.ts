import { randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Locator, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

/**
 * REENVIAR UMA MENSAGEM QUE FALHOU — F2 da ADR-0006, pelo celular, como o atendente faz.
 *
 * Celular de 390x844 com toque, login como `agent`, uma conversa só deste
 * arquivo. Medidas por ferramenta (`getBoundingClientRect`, `elementFromPoint`).
 *
 *   C-1  a bolha que falhou diz o motivo em frase legível (sem código do canal,
 *        sem endereço) e "Tentar de novo" tem 44px e cabe na tela;
 *   C-2  tocar em "Tentar de novo" muda a MESMA bolha (a contagem não muda) para
 *        "Não enviada — sem conexão" (e não "Aguardando conexão": ninguém
 *        reenvia a mensagem do atendente sozinho quando o número volta); o
 *        botão continua lá, e como nada saiu a bolha mantém o lugar no fio;
 *   C-3  no caso em que a mensagem pode ter chegado, o toque abre a confirmação;
 *        "Cancelar" mantém "Falhou" e "Enviar de novo" reenvia;
 *   C-4  mensagem da IA que falhou mostra o motivo e não tem botão.
 *
 * ─── De onde vem cada falha, e o que é feito à mão ───────────────────────────
 *
 * C-1/C-2: pelo EMISSOR DE PRODUÇÃO. O canal da conversa nasce desativado
 * (`metadata.disabled`), o agente envia pelo composer e o handler grava
 * `failed/channel_disabled`. Para reenviar, o canal é reativado pelo service
 * role, mas em `STARTING` (fora de WORKING, e fora dos status que acendem a
 * faixa de conexão caída): o reenvio passa pelas guardas e o handler deixa a
 * linha `queued` com motivo, que a tela mostra como "Não enviada — sem conexão".
 *
 * C-3: o `sending` é posto À MÃO (o handler nunca grava `sending`, e o CI não
 * tem canal de verdade): uma linha outbound do agente é inserida em `sending`
 * com `created_at` de 10 min atrás. Daí em diante é produção: o cron
 * `recover-stuck-messages`, chamado com o segredo interno como o scheduler
 * chama, grava `failed/send_timeout`. O aviso que o cron abre na Central é
 * apagado no fim (é da conversa deste arquivo).
 *
 * C-4: a linha da IA é inserida à mão; o que se mede é só a tela não oferecer
 * reenvio humano para ela.
 *
 * O QUE ISTO NÃO PROVA: que o canal de verdade entrega o reenvio (o CI não tem
 * WhatsApp). Ver a J50 em `docs/testing/user-journey-map.md`.
 */

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.describe.configure({ mode: "serial", timeout: 120_000 });

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
const EVIDENCE = path.join(process.cwd(), "evidence", "reenvio-pelo-celular-20261021");
fs.mkdirSync(EVIDENCE, { recursive: true });

const LARGURA = 390;

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

const SUFIXO = randomUUID().slice(0, 8);
const TEXTO_HUMANO = `Seu pedido sai amanhã ${SUFIXO}`;
const TEXTO_PARADO = `Confirma o endereço? ${SUFIXO}`;
const TEXTO_IA = `Resposta automática que falhou ${SUFIXO}`;
let orgId = "";
let canal = "";
let contato = "";
let conversa = "";

async function insere(tabela: string, valores: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valores).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

test.beforeAll(async () => {
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
    waha_session_name: `reenvio-${SUFIXO}`,
    display_name: `Canal reenvio ${SUFIXO}`,
    status: "WORKING",
    metadata: { disabled: true },
    webhook_secret_encrypted: "\\x00",
  });
  contato = await insere("contacts", {
    organization_id: orgId,
    name: `Cliente reenvio ${SUFIXO}`,
    phone_number: `+5511${randomInt(100000000, 1000000000)}`,
  });
  conversa = await insere("conversations", {
    organization_id: orgId,
    contact_id: contato,
    channel_session_id: canal,
    status: "open",
    last_message_at: new Date().toISOString(),
  });
  const base = { organization_id: orgId, contact_id: contato, conversation_id: conversa, channel_session_id: canal, type: "text" };
  await insere("messages", {
    ...base,
    direction: "inbound",
    status: "received",
    body: `Oi, quando chega meu pedido? ${SUFIXO}`,
    sent_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    external_id: `reenvio-${SUFIXO}-entrada`,
  });
  await insere("messages", {
    ...base,
    direction: "outbound",
    status: "failed",
    sent_via: "ai",
    error_code: "channel_disabled",
    error_message: "Este canal está desativado.",
    body: TEXTO_IA,
    sent_at: new Date(Date.now() - 19 * 60_000).toISOString(),
  });
});

test.afterAll(async () => {
  if (conversa) {
    await db.from("agent_inbox_items").delete().eq("organization_id", orgId).eq("ref_id", conversa);
    await db.from("conversations").delete().eq("id", conversa);
  }
  if (contato) await db.from("contacts").delete().eq("id", contato);
  if (canal) await db.from("channel_sessions").delete().eq("id", canal);
});

/** Login do `agent` (o `admin` para no MFA) e a sonda do toque. */
async function entrar(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.agent!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
  const toque = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  expect(toque, "o navegador do teste não emula toque — nada aqui mediria o celular").toBe(true);
}

/** Por id: canal desativado tira a conversa da lista, mas o acesso direto continua. */
async function abrir(page: Page): Promise<void> {
  await page.goto(`/app/inbox/${conversa}`);
  await page.waitForURL(new RegExp(`/app/inbox\\?id=${conversa}`), { timeout: 60_000 });
  await expect(bolhas(page).first()).toBeVisible({ timeout: 30_000 });
}

const bolhas = (page: Page) => page.getByTestId("message-bubble");
const bolha = (page: Page, texto: string) => bolhas(page).filter({ hasText: texto });
const tentarDeNovo = (b: Locator) => b.getByRole("button", { name: "Tentar de novo" });

async function medir(l: Locator) {
  return l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, height: r.height };
  });
}

test.describe("reenvio pelo celular", () => {
  test("C-1 a bolha que falhou diz o motivo e oferece tentar de novo com 44px", async ({ page }) => {
    await entrar(page);
    await abrir(page);
    await page.getByRole("textbox", { name: "Mensagem" }).fill(TEXTO_HUMANO);
    await page.getByRole("button", { name: "Enviar", exact: true }).tap();

    const b = bolha(page, TEXTO_HUMANO);
    await expect(b.getByText("Falhou")).toBeVisible({ timeout: 30_000 });
    const motivo = b.getByTestId("motivo-da-falha");
    await expect(motivo).toHaveText("Este número está desativado. Reative em Conexões para enviar.");
    const textoDaBolha = (await b.innerText()).toLowerCase();
    expect(textoDaBolha, "código do canal à vista").not.toMatch(/channel_disabled|_error/);
    expect(textoDaBolha, "endereço interno à vista").not.toContain("http");

    const botao = tentarDeNovo(b);
    await expect(botao).toBeVisible();
    const r = await medir(botao);
    expect(r.height, `altura ${r.height}`).toBeGreaterThanOrEqual(44);
    expect(r.width, `largura ${r.width}`).toBeGreaterThanOrEqual(44);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(LARGURA);

    // A setinha de opções é o único caminho para "Responder" no toque: a área que
    // pega o dedo vai além do desenho de ~20px.
    const alcancaOpcoes = await b.getByRole("button", { name: "Opções da mensagem" }).evaluate((el) => {
      const s = el.getBoundingClientRect();
      const y = s.top + s.height / 2;
      const pega = (x: number) => document.elementFromPoint(x, y)?.closest('button[aria-label="Opções da mensagem"]') === el;
      return { desenho: s.width, esquerda: pega(s.left - 10), direita: pega(s.right + 10) };
    });
    expect(alcancaOpcoes.esquerda && alcancaOpcoes.direita, JSON.stringify(alcancaOpcoes)).toBe(true);

    await page.screenshot({ path: path.join(EVIDENCE, "c1-bolha-que-falhou.png") });
  });

  test("C-2 tentar de novo muda a mesma bolha, que fica no lugar enquanto nada sai", async ({ page }) => {
    await entrar(page);
    await abrir(page);
    // O cliente escreveu depois da falha: serve de régua para o lugar da bolha.
    const respostaDoCliente = `Alguma novidade? ${SUFIXO}`;
    await insere("messages", {
      organization_id: orgId, contact_id: contato, conversation_id: conversa, channel_session_id: canal,
      type: "text", direction: "inbound", status: "received", body: respostaDoCliente,
      sent_at: new Date().toISOString(), external_id: `reenvio-${SUFIXO}-depois`,
    });
    await expect(bolha(page, respostaDoCliente)).toBeVisible({ timeout: 30_000 });
    // Reativado, mas ainda subindo: o reenvio passa pelas guardas e fica na fila.
    const { error } = await db.from("channel_sessions").update({ metadata: {}, status: "STARTING" }).eq("id", canal);
    expect(error?.message ?? null).toBeNull();

    const b = bolha(page, TEXTO_HUMANO);
    const antes = await bolhas(page).count();
    await tentarDeNovo(b).tap();

    await expect(b.getByText("Não enviada — sem conexão")).toBeVisible({ timeout: 30_000 });
    await expect(b.getByText("Aguardando conexão"), "promete um envio que ninguém faz").toHaveCount(0);
    await expect(b.getByText("Falhou")).toHaveCount(0);
    await expect(tentarDeNovo(b), "a mensagem parada sem conexão ficou sem saída").toBeVisible();
    expect(await bolhas(page).count(), "nasceu uma segunda bolha em vez de mudar a mesma").toBe(antes);
    // Nada saiu (o canal ainda sobe): a bolha mantém a hora e o lugar, antes da
    // mensagem que o cliente mandou depois. Só o envio aceito vai para o fim.
    const ordem = await bolhas(page).allInnerTexts();
    const minha = ordem.findIndex((txt) => txt.includes(TEXTO_HUMANO));
    const doCliente = ordem.findIndex((txt) => txt.includes(respostaDoCliente));
    expect(minha, `a bolha que não saiu mudou de lugar: ${minha} vs ${doCliente}`).toBeLessThan(doCliente);

    await page.screenshot({ path: path.join(EVIDENCE, "c2-nao-enviada-sem-conexao.png") });
  });

  test("C-3 quando pode ter chegado, o toque pede confirmação antes", async ({ page }) => {
    const dezMinutos = new Date(Date.now() - 10 * 60_000).toISOString();
    await insere("messages", {
      organization_id: orgId, contact_id: contato, conversation_id: conversa, channel_session_id: canal,
      type: "text", direction: "outbound", status: "sending", sent_via: "user",
      sent_by_user_id: creds.users.agent!.id, body: TEXTO_PARADO, sent_at: dezMinutos, created_at: dezMinutos,
    });
    const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
    expect(segredo, "sem segredo interno não dá para chamar o cron").toBeTruthy();
    const cron = await page.request.post("/api/v1/cron/recover-stuck-messages", {
      headers: { authorization: `Bearer ${segredo}` },
    });
    expect(cron.status(), await cron.text()).toBe(200);
    const { data: linha } = await db.from("messages").select("status, error_code")
      .eq("conversation_id", conversa).eq("body", TEXTO_PARADO).single();
    expect(linha, "o cron não marcou a linha parada").toEqual({ status: "failed", error_code: "send_timeout" });

    await entrar(page);
    await abrir(page);
    const b = bolha(page, TEXTO_PARADO);
    await expect(b.getByTestId("motivo-da-falha")).toHaveText(
      "O WhatsApp não confirmou o envio a tempo. Pode ser que a mensagem tenha chegado.",
    );

    await tentarDeNovo(b).tap();
    const aviso = page.getByRole("alertdialog");
    await expect(aviso).toContainText("Confira no WhatsApp do cliente antes de enviar de novo.");
    const caixa = await medir(aviso);
    expect(caixa.left).toBeGreaterThanOrEqual(0);
    expect(caixa.right).toBeLessThanOrEqual(LARGURA);
    await page.screenshot({ path: path.join(EVIDENCE, "c3-confirmacao.png") });
    await aviso.getByRole("button", { name: "Cancelar" }).tap();
    await expect(aviso).toHaveCount(0);
    await expect(b.getByText("Falhou")).toBeVisible();

    await tentarDeNovo(b).tap();
    await page.getByRole("alertdialog").getByRole("button", { name: "Enviar de novo" }).tap();
    await expect(b.getByText("Não enviada — sem conexão")).toBeVisible({ timeout: 30_000 });
  });

  test("C-4 mensagem da IA que falhou mostra o motivo e não tem botão", async ({ page }) => {
    await entrar(page);
    await abrir(page);
    const b = bolha(page, TEXTO_IA);
    await expect(b.getByTestId("motivo-da-falha")).toBeVisible();
    await expect(tentarDeNovo(b)).toHaveCount(0);
  });
});
