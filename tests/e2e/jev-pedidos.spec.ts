/**
 * OS PEDIDOS DO CLIENTE, PELO JEV — pela tela e pelo caminho de produção.
 *
 * Duas tarefas novas do Jev acompanham uma REGRA sem IA: pedir para falar com
 * uma pessoa e pedir para parar de receber mensagens. O Jev só é perguntado
 * onde a regra de hoje disse NÃO (a cascata), numa chamada própria do worker de
 * clima, e só observa: o cartão conta os pedidos que ele percebeu e leva às
 * conversas. A prova de que ele foi perguntado — e do QUÊ — é o dublê
 * (`scripts/duble-jev-e2e.mjs`), que grava cada chamada; a resposta dele é
 * forçada por `DUBLE_JEV_RESPOSTAS` (pessoa 0,97; parar 0,02).
 *
 * As mensagens chegam pelo webhook do WhatsApp (a mesma porta da
 * `jev-decisoes-rapidas`), de três clientes diferentes:
 *
 *  - "PARAR": a regra de descadastro pega (e bloqueia o contato na entrada) —
 *    a pergunta de parar de receber NUNCA sai para esta mensagem;
 *  - a frase natural ("alguém de verdade, não com robô"): a regra não pega
 *    nenhum dos dois, as duas perguntas saem, o Jev percebe o pedido de pessoa,
 *    e o cartão mostra "percebeu 1 pedido" com o link para a conversa — que
 *    segue do jeito que estava (o Jev não passa nem bloqueia nada);
 *  - "me deixa em paz": a regra pega só como PROVÁVEL (não bloqueia o contato),
 *    e a chamada sai só com a pergunta de pessoa — a cascata vista com controle
 *    positivo na mesma mensagem, que "PARAR" não dá: com o contato bloqueado o
 *    turno nem rodaria, e nada seria perguntado de qualquer forma;
 *  - com o pedido de pessoa em "Avisar a equipe" (bloco 3.2), a frase natural
 *    de um quarto cliente abre UM aviso na Central, com "Abrir a conversa"
 *    levando a ela — e a conversa segue sem dono, sem silêncio e sem bloqueio,
 *    no mesmo estado da conversa que o Jev só observou.
 *
 * O turno do agente só roda com um agente no ar no número: esta spec publica um
 * agente SÓ dela no número da entrada de mensagens, pelo service role, e o apaga
 * no fim — com a maior prioridade, para ser ele (sem palavras de passagem) quem
 * atende. O agent-worker não sobe no CI; quem pergunta ao Jev é o worker de
 * clima, no dreno do event_log.
 *
 * Precondições: `pnpm e2e:env` (JEV_API_BASE_URL apontando para a porta do
 * dublê, que esta spec sobe e derruba sozinha) e o app buildado.
 *
 *   pnpm e2e:build && pnpm exec playwright test tests/e2e/jev-pedidos.spec.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

import {
  abrirOCartao,
  clicarEEsperarAMudanca,
  credsDoJev,
  drenar,
  escoarAFila,
  limparOJev,
  mandarMensagemDoCliente,
} from "./helpers/jev";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const BASE_DO_JEV = process.env.JEV_API_BASE_URL ?? "";
/** A chave que o dublê aceita. Não é segredo: só vale para ele. */
const CHAVE_DO_DUBLE = "apikey_e2e_duble_do_jev_0123456789abcdef";
const ARQUIVO_DE_CHAMADAS = path.join(os.tmpdir(), `duble-jev-pedidos-${process.pid}.json`);
/** A resposta do Jev, forçada no dublê: ele percebe o pedido de pessoa, e não o de parar. */
const RESPOSTAS_DO_JEV = {
  humano: { type: "noul", noul: 0.97 },
  opt_out: { type: "noul", noul: 0.02 },
};

/** Um cliente por mensagem: "PARAR" bloqueia o contato, e o bloqueio valeria para as seguintes. */
const base = String(Date.now()).slice(-5);
const CLIENTE_QUE_PARA = `${base}1`;
const CLIENTE_QUE_PEDE_PESSOA = `${base}2`;
const CLIENTE_EM_PAZ = `${base}3`;
const CLIENTE_AVISADO = `${base}4`;
const FRASE_NATURAL = `Quero falar com alguém de verdade aí, não com robô (${CLIENTE_QUE_PEDE_PESSOA})`;
const FRASE_EM_PAZ = `Me deixa em paz (${CLIENTE_EM_PAZ})`;
const FRASE_AVISADA = `Chama alguém de verdade pra mim, por favor, não quero robô (${CLIENTE_AVISADO})`;
/** O título do aviso na Central (`AVISOS_DOS_PEDIDOS.humano.titulo`), em pt-BR. */
const TITULO_DO_AVISO = "Um cliente parece pedir para falar com uma pessoa";

const { url, serviceRole } = credenciaisSupabaseDeTeste();
const admin = createClient(url, serviceRole, { auth: { persistSession: false } });

interface Chamada {
  metodo: string;
  caminho: string;
  corpo: { state?: unknown; questions?: Record<string, { type?: string }> } | null;
}

let duble: ChildProcess | null = null;
let creds: CredsE2E;
let orgId = "";
const semeado = { agente: randomUUID(), versao: randomUUID() };

function chamadasAoJev(): Chamada[] {
  if (!fs.existsSync(ARQUIVO_DE_CHAMADAS)) return [];
  return (JSON.parse(fs.readFileSync(ARQUIVO_DE_CHAMADAS, "utf8")) as Chamada[]).filter(
    (c) => c.metodo === "POST" && c.caminho === "/v1/systemone",
  );
}

/** As perguntas das chamadas sobre a mensagem que contém `trecho` — a do clima e a dos pedidos são duas. */
function perguntasSobre(trecho: string): string[][] {
  return chamadasAoJev()
    .filter((c) => String(c.corpo?.state ?? "").includes(trecho))
    .map((c) => Object.keys(c.corpo?.questions ?? {}));
}

const dosPedidos = (trecho: string) => perguntasSobre(trecho).filter((q) => !q.includes("clima"));

async function ok<T>(p: PromiseLike<{ error: { message: string } | null; data?: T }>, oQue: string): Promise<void> {
  const { error } = await p;
  if (error) throw new Error(`${oQue}: ${error.message}`);
}

/**
 * Um agente no ar no número da entrada de mensagens: sem ele, o turno do agente
 * não rodaria, e o Jev não é perguntado (o denominador da cascata).
 */
async function publicarUmAgenteNoNumero(sessao: string): Promise<void> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("waha_session_name", sessao)
    .single();
  if (error) throw new Error(`achar o número da entrada: ${error.message}`);
  const numero = (data as { id: string }).id;
  await ok(
    admin.from("ai_agents").insert({
      id: semeado.agente,
      organization_id: orgId,
      name: `Atende os pedidos ${base}`,
      system_prompt: "você atende",
      kind: "mcp_agent",
      // O primeiro da fila do número: é ele, sem palavras de passagem, quem atende.
      priority: 1000,
    } as never),
    "semear o agente",
  );
  await ok(
    admin.from("ai_agent_versions").insert({
      id: semeado.versao,
      organization_id: orgId,
      agent_id: semeado.agente,
      version_number: 1,
      system_prompt: "você atende",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      channel_session_id: numero,
      status: "published",
      published_at: new Date().toISOString(),
    } as never),
    "publicar o agente",
  );
  await ok(
    admin.from("ai_agents").update({ published_version_id: semeado.versao } as never).eq("id", semeado.agente),
    "apontar o agente para a versão publicada",
  );
}

/**
 * As observações e os avisos dos pedidos desta organização: o "1 pedido" do
 * cartão e o "UM aviso" da Central não podem herdar a rodada de antes.
 */
async function limparOsPedidos(): Promise<void> {
  await ok(
    admin.from("jev_observacoes").delete().eq("organization_id", orgId).in("tarefa", ["humano", "opt_out"]),
    "limpar as observações dos pedidos",
  );
  await ok(
    admin
      .from("agent_inbox_items")
      .delete()
      .eq("organization_id", orgId)
      .in("kind", ["jev_pedido_de_humano", "jev_parar_de_receber"]),
    "limpar os avisos dos pedidos",
  );
}

async function conversaDaMensagem(corpo: string): Promise<string> {
  const { data, error } = await admin
    .from("messages")
    .select("conversation_id")
    .eq("organization_id", orgId)
    .eq("body", corpo)
    .single();
  if (error) throw new Error(`achar a conversa da mensagem: ${error.message}`);
  return (data as { conversation_id: string }).conversation_id;
}

async function esperarAPerguntaSobre(page: Page, trecho: string): Promise<void> {
  await expect(async () => {
    await drenar(page);
    expect(dosPedidos(trecho), `o dublê ainda não recebeu a pergunta dos pedidos sobre "${trecho}"`).not.toEqual([]);
  }).toPass({ timeout: 90_000, intervals: [2_000, 3_000, 5_000] });
}

test.describe("Jev — os pedidos do cliente, pela tela", () => {
  // Três esperas pelo dreno (até 90 s cada, no pior caso) e a Central: 6 min de teto.
  test.describe.configure({ timeout: 360_000 });

  test.beforeAll(async () => {
    let alvo: URL;
    try {
      alvo = new URL(BASE_DO_JEV);
    } catch {
      throw new Error("JEV_API_BASE_URL ausente no ambiente do teste. Rode `pnpm e2e:env`.");
    }
    expect(alvo.hostname, "o Jev da suíte tem de apontar para o dublê local").toBe("127.0.0.1");

    fs.rmSync(ARQUIVO_DE_CHAMADAS, { force: true });
    duble = spawn(process.execPath, ["scripts/duble-jev-e2e.mjs"], {
      env: {
        ...process.env,
        DUBLE_JEV_PORTA: alvo.port,
        DUBLE_JEV_HOST: alvo.hostname,
        DUBLE_JEV_CHAVE: CHAVE_DO_DUBLE,
        DUBLE_JEV_ARQUIVO: ARQUIVO_DE_CHAMADAS,
        DUBLE_JEV_RESPOSTAS: JSON.stringify(RESPOSTAS_DO_JEV),
      },
      stdio: "inherit",
    });
    await expect
      .poll(
        async () => {
          try {
            const r = await fetch(`${BASE_DO_JEV}/__duble/saude`);
            return ((await r.json()) as { arquivo?: string }).arquivo ?? null;
          } catch {
            return null;
          }
        },
        { timeout: 15_000, message: "o dublê do Jev não subiu (porta ocupada?)" },
      )
      .toBe(ARQUIVO_DE_CHAMADAS);
    creds = lerCreds();
  });

  test.afterAll(async () => {
    duble?.kill("SIGTERM");
    fs.rmSync(ARQUIVO_DE_CHAMADAS, { force: true });
    if (orgId) {
      // O agente leva a versão junto (cascade); o número é o da entrada, e fica.
      await ok(admin.from("ai_agents").delete().eq("id", semeado.agente), "apagar o agente");
      await limparOsPedidos();
      await limparOJev(orgId);
    }
  });

  test("[P1] o Jev percebe o pedido de pessoa que a regra não pegou — só onde ela disse não, e sem mexer na conversa", async ({
    page,
  }) => {
    creds = await loginComoAdmin(page, creds);
    const { orgId: org, sessao } = credsDoJev();
    orgId = org;
    await limparOJev(orgId);
    await limparOsPedidos();
    await publicarUmAgenteNoNumero(sessao);

    await test.step("a fila escoa ANTES de ligar: mensagem de outra spec não vira pedido percebido", async () => {
      await escoarAFila(page);
    });

    await test.step("a chave do dublê, testada, e o Jev ligado com o aceite", async () => {
      const criou = await page.request.post("/api/v1/ai/credentials", {
        data: { provider: "typesafe", label: "Jev dos pedidos", api_key: CHAVE_DO_DUBLE },
      });
      expect(criou.status(), "a chave não foi cadastrada").toBe(201);
      await expect(async () => {
        const r = await page.request.get("/api/v1/ai/jev");
        expect(((await r.json()) as { data: { chave: { validada: boolean } } }).data.chave.validada).toBe(true);
      }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });
      const ligou = await page.request.patch("/api/v1/ai/jev", { data: { ligado: true, aceite_lgpd: true } });
      expect(ligou.status(), "o Jev não ligou").toBe(200);
    });

    await test.step("o cartão: as duas tarefas novas, só observando, e sem o botão de decidir", async () => {
      const cartao = await abrirOCartao(page);
      for (const [id, rotulo] of [
        ["humano", "Perceber pedido para falar com uma pessoa"],
        ["opt_out", "Perceber pedido para parar de receber mensagens"],
      ] as const) {
        const linha = cartao.getByTestId(`jev-tarefa-${id}`);
        await expect(linha).toHaveAttribute("data-estado", "observando");
        await expect(linha).toContainText(rotulo);
        await expect(linha).toContainText("Só observa");
        await expect(linha).toContainText("Nova");
        await expect(linha.getByRole("button", { name: "Deixar o Jev decidir" })).toHaveCount(0);
      }
      await expect(cartao.getByTestId("jev-percebidos-humano")).toContainText("percebeu 0 pedidos de falar com uma pessoa");
    });

    await test.step("PARAR e a frase natural chegam pelo WhatsApp; só a natural leva as perguntas", async () => {
      await mandarMensagemDoCliente(page, "PARAR", CLIENTE_QUE_PARA, 1);
      await mandarMensagemDoCliente(page, FRASE_NATURAL, CLIENTE_QUE_PEDE_PESSOA, 1);
      await esperarAPerguntaSobre(page, FRASE_NATURAL);
      // A regra de hoje não pegou nenhum dos dois: as duas perguntas, numa
      // chamada só e separada da do clima.
      // (Toda chamada: um retry do dreno pergunta de novo sobre a mesma mensagem.)
      expect(dosPedidos(FRASE_NATURAL).map((q) => q.join())).toContain("humano,opt_out");
      expect(dosPedidos(FRASE_NATURAL).every((q) => q.join() === "humano,opt_out")).toBe(true);
      // Tudo o que a fila tinha, inclusive o "PARAR", já passou pelo worker.
      await escoarAFila(page);
      const sobreParar = chamadasAoJev().filter((c) => String(c.corpo?.state ?? "").trim() === "PARAR");
      expect(
        sobreParar.filter((c) => "opt_out" in (c.corpo?.questions ?? {})),
        "a regra pegou o PARAR: a pergunta de parar de receber não podia sair",
      ).toEqual([]);
    });

    const conversa = await test.step("o cartão mostra 1 pedido percebido, com a conversa", async () => {
      const { data, error } = await admin
        .from("messages")
        .select("conversation_id")
        .eq("organization_id", orgId)
        .eq("body", FRASE_NATURAL)
        .single();
      expect(error).toBeNull();
      const id = (data as { conversation_id: string }).conversation_id;

      await expect(async () => {
        const cartao = await abrirOCartao(page);
        await expect(cartao.getByTestId("jev-percebidos-humano")).toContainText(
          "percebeu 1 pedido de falar com uma pessoa que a regra de hoje não pegou.",
          { timeout: 3_000 },
        );
      }).toPass({ timeout: 30_000, intervals: [1_000, 2_000, 3_000] });
      const cartao = page.getByTestId("cartao-do-jev");
      await expect(cartao.getByTestId("jev-percebidos-conversas-humano").getByRole("link")).toHaveAttribute(
        "href",
        `/app/inbox/${id}`,
      );
      await expect(cartao.getByTestId("jev-percebidos-opt_out")).toContainText("percebeu 0 pedidos");
      await page.screenshot({ path: ".superpowers/evidence/jev/cartao-pedidos-percebidos.png", fullPage: true });
      return id;
    });

    await test.step("o Jev não mexeu na conversa: nem passou, nem calou, nem bloqueou", async () => {
      const { data: conv, error: convErr } = await admin
        .from("conversations")
        .select("bot_silenced_until, assignee_kind, contact_id")
        .eq("id", conversa)
        .single();
      expect(convErr).toBeNull();
      const c = conv as { bot_silenced_until: string | null; assignee_kind: string | null; contact_id: string };
      expect(c.bot_silenced_until).toBeNull();
      expect(c.assignee_kind).not.toBe("user");
      const { data: contato, error: contatoErr } = await admin
        .from("contacts")
        .select("is_blocked, force_human")
        .eq("id", c.contact_id)
        .single();
      expect(contatoErr).toBeNull();
      expect(contato).toEqual({ is_blocked: false, force_human: false });
    });

    await test.step("'me deixa em paz': a regra pega o provável, e só a pergunta de pessoa sai", async () => {
      await mandarMensagemDoCliente(page, FRASE_EM_PAZ, CLIENTE_EM_PAZ, 1);
      await esperarAPerguntaSobre(page, FRASE_EM_PAZ);
      expect(dosPedidos(FRASE_EM_PAZ).every((q) => q.join() === "humano"), "a pergunta de parar de receber saiu").toBe(true);
      // O dublê diz 0,97 a toda pergunta de pessoa: agora são dois — e o plural.
      await expect(async () => {
        const cartao = await abrirOCartao(page);
        await expect(cartao.getByTestId("jev-percebidos-humano")).toContainText("percebeu 2 pedidos de falar com uma pessoa", {
          timeout: 3_000,
        });
      }).toPass({ timeout: 30_000, intervals: [1_000, 2_000, 3_000] });
    });

    await test.step("Execuções mostra a chamada com o nome dela, e não crua", async () => {
      await expect(async () => {
        await page.goto("/app/ai/runs?provider=typesafe");
        await expect(page.getByTestId("execucoes-de-ia")).toBeVisible({ timeout: 15_000 });
        await expect(
          page.locator('[data-testid^="execucao-"]', { hasText: "Perceber pedidos do cliente" }).first(),
        ).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 3_000] });
      await expect(page.getByText("jev_pedidos", { exact: true })).toHaveCount(0);
    });

    await test.step("'Avisar a equipe' no pedido de pessoa: o diálogo diz o efeito antes de valer", async () => {
      const cartao = await abrirOCartao(page);
      const linha = cartao.getByTestId("jev-tarefa-humano");
      await expect(linha.getByRole("button", { name: "Deixar o Jev decidir" })).toHaveCount(0);
      await linha.getByRole("button", { name: "Avisar a equipe" }).click();
      const dialogo = page.getByRole("alertdialog");
      await expect(dialogo).toHaveAttribute("data-tarefa", "humano");
      await expect(dialogo).toContainText("Avisar a equipe?");
      await expect(dialogo).toContainText("abre um aviso na Central para alguém da equipe decidir. Ele nunca passa a conversa sozinho.");
      await clicarEEsperarAMudanca(page, dialogo.getByRole("button", { name: "Avisar a equipe" }));
      // O cartão se relê sozinho depois do clique — é a tela, e não a rota, que se prova.
      await expect(page.getByTestId("jev-tarefa-humano")).toHaveAttribute("data-estado", "decidindo", { timeout: 15_000 });
      await expect(page.getByTestId("jev-tarefa-humano")).toContainText("Avisa a equipe");
      // O pedido de parar de receber segue só observando: cada tarefa, a sua escolha.
      await expect(page.getByTestId("jev-tarefa-opt_out")).toHaveAttribute("data-estado", "observando");
    });

    await test.step("a frase natural de outro cliente abre UM aviso na Central, que leva à conversa", async () => {
      await mandarMensagemDoCliente(page, FRASE_AVISADA, CLIENTE_AVISADO, 1);
      await esperarAPerguntaSobre(page, FRASE_AVISADA);
      const avisada = await conversaDaMensagem(FRASE_AVISADA);

      const item = page.getByTestId("inbox-item").filter({ hasText: TITULO_DO_AVISO });
      await expect(async () => {
        await page.goto("/app/ai/inbox");
        await expect(item).toHaveCount(1, { timeout: 5_000 });
      }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 3_000] });
      await expect(item).toContainText("Pedido para falar com uma pessoa, percebido pelo Jev");
      await expect(item).toContainText("o Jev não passa a conversa sozinho");
      // A Central é lida pela empresa inteira: o que o cliente escreveu fica na conversa.
      await expect(item).not.toContainText("robô");
      await expect(item.getByRole("link", { name: "Abrir a conversa" })).toHaveAttribute("href", `/app/inbox/${avisada}`);
      await page.screenshot({ path: ".superpowers/evidence/jev/central-aviso-do-pedido.png", fullPage: true });
    });

    await test.step("a conversa avisada segue como a observada: sem dono, sem silêncio, sem bloqueio", async () => {
      const avisada = await conversaDaMensagem(FRASE_AVISADA);
      const { data, error } = await admin
        .from("conversations")
        .select("id, status, assigned_to_user_id, assignee_kind, bot_silenced_until, contact_id")
        .in("id", [avisada, conversa]);
      expect(error).toBeNull();
      type Conversa = {
        id: string;
        status: string;
        assigned_to_user_id: string | null;
        assignee_kind: string | null;
        bot_silenced_until: string | null;
        contact_id: string;
      };
      const linhas = (data ?? []) as Conversa[];
      const a = linhas.find((c) => c.id === avisada)!;
      const o = linhas.find((c) => c.id === conversa)!;
      expect(a.assigned_to_user_id).toBeNull();
      expect(a.assignee_kind).not.toBe("user");
      expect(a.bot_silenced_until).toBeNull();
      // O mesmo caminho, a mesma mensagem natural — só o aviso de diferença.
      expect(a.status).toBe(o.status);
      const { data: contato, error: contatoErr } = await admin
        .from("contacts")
        .select("is_blocked, force_human")
        .eq("id", a.contact_id)
        .single();
      expect(contatoErr).toBeNull();
      expect(contato).toEqual({ is_blocked: false, force_human: false });
      // Nenhuma passagem: o único aviso da conversa é o do Jev.
      const { data: avisos, error: avisosErr } = await admin
        .from("agent_inbox_items")
        .select("kind, status")
        .eq("organization_id", orgId)
        .eq("ref_id", avisada);
      expect(avisosErr).toBeNull();
      expect(avisos).toEqual([{ kind: "jev_pedido_de_humano", status: "open" }]);
    });
  });
});
