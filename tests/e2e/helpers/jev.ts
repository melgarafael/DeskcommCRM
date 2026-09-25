/**
 * A jornada do Jev pela tela, em passos que as duas specs dele repetem:
 * `jev-decisoes-rapidas` (contra o dublê, no CI) e `jev-chave-real` (contra a
 * TypeSafe AI de verdade, fora do CI). O que muda entre elas é para onde o
 * servidor manda a pergunta, não o que a pessoa faz na tela.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const SEGREDO_DO_DRENO = process.env.INTERNAL_SECRET ?? "e2e-placeholder-nao-e-segredo";

interface CredsDoJev {
  org_id: string;
  nascimento?: { webhook_token: string; session_name: string };
}

/**
 * A organização do admin e a porta de entrada de mensagens (a mesma da
 * `conversa-vira-lead`). Lida DEPOIS do login: o login pode re-semear o
 * `.e2e-creds.json` inteiro e levar junto o bloco `nascimento`.
 */
export function credsDoJev(): { orgId: string; webhookToken: string; sessao: string } {
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as CredsDoJev;
  if (!c.nascimento?.webhook_token) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-nascimento-do-lead.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as CredsDoJev;
  }
  return { orgId: c.org_id, webhookToken: c.nascimento!.webhook_token, sessao: c.nascimento!.session_name };
}

/**
 * Devolve a organização ao estado de quem nunca ouviu falar do Jev: sem a chave
 * dele e sem `settings.jev`. Roda antes (uma rodada que caiu no meio deixa o
 * Jev ligado) e depois (as specs seguintes da parte usam o mesmo banco).
 */
export async function limparOJev(orgId: string): Promise<void> {
  const { url, serviceRole } = credenciaisSupabaseDeTeste();
  const admin = createClient(url, serviceRole, { auth: { persistSession: false } });
  const apagou = await admin
    .from("ai_provider_credentials")
    .delete()
    .eq("organization_id", orgId)
    .eq("provider", "typesafe");
  if (apagou.error) throw new Error(`apagar a chave do Jev: ${apagou.error.message}`);

  const lido = await admin.from("organizations").select("settings").eq("id", orgId).single();
  if (lido.error) throw new Error(`ler settings: ${lido.error.message}`);
  const settings = { ...((lido.data.settings as Record<string, unknown> | null) ?? {}) };
  if (!("jev" in settings)) return;
  delete settings.jev;
  const gravou = await admin.from("organizations").update({ settings }).eq("id", orgId);
  if (gravou.error) throw new Error(`limpar settings.jev: ${gravou.error.message}`);
}

/** O cartão, lido do servidor a cada chamada — é a rota que o worker obedece. */
export async function abrirOCartao(page: Page): Promise<Locator> {
  await page.goto("/app/ai/providers");
  const cartao = page.getByTestId("cartao-do-jev");
  await expect(cartao).toBeVisible({ timeout: 30_000 });
  return cartao;
}

/**
 * Espera o cartão chegar a um dos estados RELENDO a página. Só serve onde o
 * cartão não tem como saber sozinho — a chave cadastrada pela API, fora da tela.
 * Logo depois de um clique, NUNCA: o `goto` aborta o pedido que o clique
 * disparou, e o cartão fica no estado de antes para sempre (medido: o POST da
 * chave saiu com status -1 e o cartão ficou em "sem_chave").
 */
export async function esperarEstado(page: Page, estados: string[], timeout = 30_000): Promise<string> {
  let atual = "";
  await expect(async () => {
    const cartao = await abrirOCartao(page);
    atual = (await cartao.getAttribute("data-estado")) ?? "";
    expect(estados, `o cartão está em "${atual}"`).toContain(atual);
  }).toPass({ timeout, intervals: [1_000, 2_000, 3_000] });
  return atual;
}

/**
 * Espera o cartão mudar SEM recarregar, como a pessoa vê: depois de um clique
 * ele se relê sozinho. Uma recarga aqui provaria a rota, não a tela.
 */
export async function esperarNoCartao(page: Page, estados: string[], timeout = 30_000): Promise<string> {
  const cartao = page.getByTestId("cartao-do-jev");
  await expect(cartao).toHaveAttribute("data-estado", new RegExp(`^(${estados.join("|")})$`), { timeout });
  return (await cartao.getAttribute("data-estado")) ?? "";
}

/** Clica num botão do cartão e espera a mudança chegar ao servidor — o `PATCH` respondido, e com sucesso. */
export async function clicarEEsperarAMudanca(page: Page, botao: Locator): Promise<void> {
  const [resposta] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/v1/ai/jev") && r.request().method() === "PATCH"),
    botao.click(),
  ]);
  expect(resposta.status(), "a mudança do Jev foi recusada pelo servidor").toBe(200);
}

/**
 * Liga com o aceite de LGPD e deixa o Jev DECIDINDO. Em observação a IA de
 * sempre decide — e, no ambiente de teste, a chave dela é falsa. A escolha de
 * deixar o Jev decidir é o passo que a pessoa dá depois de comparar.
 */
export async function ligarOJev(page: Page): Promise<string> {
  const cartao = await abrirOCartao(page);
  await expect(cartao).toHaveAttribute("data-estado", "pronto");
  const ligar = cartao.getByRole("button", { name: "Ligar o Jev" });
  // Sem o aceite, o botão não liga: é a D6 vista pela tela.
  await expect(ligar).toBeDisabled();
  await cartao.locator("#jev-aceite").check();
  await clicarEEsperarAMudanca(page, ligar);

  const estado = await esperarNoCartao(page, ["observando", "decidindo", "sozinho"]);
  if (estado !== "observando") return estado;
  // O laço de retorno da observação (o mapa vivo o nomeia): o cartão mostra a
  // concordância antes de a pessoa deixar o Jev decidir. Aqui a IA de sempre
  // tem chave falsa, então o bloco diz que ainda não há comparação — o que se
  // prova é que ele está na tela, no estado em que a decisão é tomada.
  await expect(cartao.getByTestId("jev-concordancia")).toBeVisible();
  await clicarEEsperarAMudanca(page, cartao.getByRole("button", { name: "Deixar o Jev decidir" }));
  return esperarNoCartao(page, ["decidindo"]);
}

/** "Mensagens medidas" do cartão — o primeiro número da grade. */
export async function mensagensMedidas(page: Page): Promise<number> {
  const cartao = await abrirOCartao(page);
  const texto = await cartao.getByTestId("jev-numeros").locator("dd").first().innerText();
  const n = Number(texto.replace(/\D/g, ""));
  expect(Number.isInteger(n), `"Mensagens medidas" ilegível: ${texto}`).toBe(true);
  return n;
}

/**
 * Uma mensagem de cliente pelo CAMINHO DE PRODUÇÃO — a rota que o WAHA chama.
 * O insert em `messages` dispara o `message.received` que acorda o worker de
 * clima; um insert à mão provaria a tela e mentiria sobre a origem.
 *
 * O `sufixo` escolhe o cliente (a mesma conversa); a `ordem` distingue as
 * mensagens dele — o id é a chave de idempotência do webhook, e repeti-lo
 * faria a segunda mensagem ser descartada como duplicata.
 */
export async function mandarMensagemDoCliente(
  page: Page,
  texto: string,
  sufixo: string,
  ordem = 1,
): Promise<void> {
  const { webhookToken, sessao } = credsDoJev();
  const r = await page.request.post(`/api/v1/webhooks/waha/${webhookToken}`, {
    data: {
      event: "message",
      session: sessao,
      payload: {
        id: `e2e-jev-${sufixo}-${ordem}`,
        from: `55318${sufixo}@c.us`,
        fromMe: false,
        body: texto,
        timestamp: Math.floor(Date.now() / 1000),
        _data: { notifyName: `Cliente Jev ${sufixo}` },
      },
    },
  });
  expect(r.status(), "o webhook precisa ACEITAR — 4xx aqui e o resto mede o vazio").toBe(200);
}

/**
 * Roda o dreno do event_log uma vez. Só o 200 é cobrado: o dreno leva junto o
 * que as specs anteriores da parte deixaram na fila, e a falha de um handler
 * alheio não diz nada sobre o Jev. Quem prova o Jev é a chamada que chegou.
 */
export async function drenar(page: Page): Promise<number> {
  const r = await page.request.post("/api/v1/cron/event-log-drain", {
    headers: { authorization: `Bearer ${SEGREDO_DO_DRENO}` },
  });
  expect(r.status(), "o dreno tem que responder 200").toBe(200);
  return ((await r.json()) as { data: { scanned: number } }).data.scanned;
}

/**
 * Escoa a fila ANTES de ligar o Jev. As specs anteriores da parte usam a mesma
 * organização, e uma mensagem delas ainda na fila seria medida pelo Jev junto
 * com a nossa. O teto de voltas é o que impede um evento que volta sempre de
 * prender a spec aqui — e estourá-lo REPROVA: a prova "o Jev desligado não
 * manda nada" é uma lista vazia, e medida antes de a fila escoar ela afirmaria
 * o vazio sem ter olhado.
 */
export async function escoarAFila(page: Page): Promise<void> {
  for (let volta = 0; volta < 20; volta++) {
    if ((await drenar(page)) === 0) return;
  }
  throw new Error("a fila não escoou em 20 drenos — a prova do Jev desligado mediria o vazio");
}

/** A linha da medição em IA › Execuções, pelo filtro que o cartão oferece. */
export async function esperarMedicaoEmExecucoes(page: Page, modelo: RegExp): Promise<void> {
  await expect(async () => {
    await page.goto("/app/ai/runs?provider=typesafe");
    await expect(page.getByTestId("execucoes-de-ia")).toBeVisible({ timeout: 15_000 });
    const linha = page.locator('[data-testid^="execucao-"]', { hasText: "Jev (TypeSafe AI)" }).first();
    await expect(linha).toBeVisible({ timeout: 5_000 });
    await expect(linha).toContainText(modelo);
    await expect(linha).toContainText("Medir o clima da conversa");
    await expect(linha).not.toContainText("falhou");
  }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 3_000] });
  // O filtro chegou pela URL e a tela diz que está filtrando.
  await expect(page.getByTestId("filtro-jev")).toHaveAttribute("aria-pressed", "true");
}
