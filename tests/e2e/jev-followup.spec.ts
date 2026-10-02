/**
 * A RESPOSTA AO FOLLOW-UP, PELO JEV — o que o admin vê no cartão, pela tela.
 *
 * A tarefa `followup` ("Ler a resposta ao follow-up") SÓ OBSERVA nesta versão, e
 * só roda onde a IA de sempre escolhe a saída de um passo "Classificar (IA)":
 * um follow-up publicado (ou uma inscrição que ainda anda numa versão) com esse
 * passo e DUAS saídas ou mais. Com uma saída só não há escolha — a IA de sempre
 * e o Jev só poderiam devolver ela, e cada resposta seria uma concordância paga
 * e vazia (`saidasCabemNaPergunta`, `lib/ai/decisao/tarefas.ts`). O cartão diz:
 *
 *  - sem esse passo: "Não roda", o porquê e a porta para Follow-ups;
 *  - com um classificar de UMA saída só: continua "Não roda" (o controle);
 *  - com um classificar de duas saídas: "Só observa", a frase de por que só
 *    observa, a concordância ainda vazia — e nunca "Deixar o Jev decidir".
 *
 * O controle de uma saída roda ANTES do de duas: é a mesma organização, no
 * mesmo estado, e a única diferença entre os dois cartões é o número de saídas.
 *
 * Os follow-ups são publicados pelo CAMINHO DE PRODUÇÃO — as rotas que o
 * construtor chama (criar, gravar o rascunho, publicar), com a sessão do admin,
 * como a `followup-dossie` (`montaCenario`). Um INSERT à mão provaria a tela e
 * mentiria sobre o validador de publicar. A chave do dublê e o "ligar" vão pela
 * API, como na `jev-roteador`; a jornada deles pela tela é a
 * `jev-decisoes-rapidas`.
 *
 * ⚠️ O BANCO É COMPARTILHADO, e a `followup-builder` (mesma parte, roda antes:
 * a ordem é por caminho) deixa publicado um classificar de DUAS saídas. Antes de
 * medir o "Não roda", esta spec desativa, pela rota de desativar, todo follow-up
 * ativo com classificar de duas saídas ou mais, e cancela, pela rota de
 * cancelar, toda inscrição viva numa versão com ele — é a pré-condição DESTA
 * spec, e não de quem rodou antes. Nenhuma spec depois dela na parte depende
 * de follow-up. Os dois que ela publica são desativados no `afterAll`.
 *
 * O e2e do CI não sobe o agent-worker: nenhuma resposta de cliente chega ao
 * Jev aqui (o caminho do turno é `tests/invariants/jev-followup-no-turno.test.ts`),
 * e a concordância é a vazia — as observações da tarefa são apagadas antes, para
 * que ela seja vazia por construção, e não por sorte.
 *
 * Precondições: `pnpm e2e:env` (JEV_API_BASE_URL apontando para a porta do
 * dublê, que esta spec sobe e derruba sozinha) e o app buildado.
 *
 *   pnpm e2e:build && pnpm exec playwright test tests/e2e/jev-followup.spec.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

import { abrirOCartao, credsDoJev, limparOJev } from "./helpers/jev";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const BASE_DO_JEV = process.env.JEV_API_BASE_URL ?? "";
/** A chave que o dublê aceita. Não é segredo: só vale para ele. */
const CHAVE_DO_DUBLE = "apikey_e2e_duble_do_jev_0123456789abcdef";
const ARQUIVO_DE_CHAMADAS = path.join(os.tmpdir(), `duble-jev-followup-${process.pid}.json`);
const sufixo = String(Date.now()).slice(-6);

/** Os textos da tela, em pt-BR, como o admin os lê (`CartaoDoJev.tsx` e `TAREFA_DO_FOLLOWUP`). */
const NAO_RODA_SEM_FLUXO =
  "Não roda agora: nenhum follow-up publicado tem o passo “Classificar (IA)” com duas saídas ou mais. O Jev só lê a resposta do cliente onde a sua IA de sempre escolhe entre saídas — publique, em Follow-ups, um fluxo com esse passo.";
const POR_QUE_SO_OBSERVA =
  "Nesta versão, o Jev só observa esta tarefa: quem escolhe a saída do fluxo é sempre a sua IA de sempre, e não há como deixar o Jev decidir. A saída escolhida muda o caminho do cliente no fluxo, então primeiro se mede, com respostas de verdade, o quanto os dois concordam.";
const CONCORDANCIA_VAZIA =
  "Ainda não há mensagens medidas pelos dois. A comparação aparece aqui assim que houver.";

const { url, serviceRole } = credenciaisSupabaseDeTeste();
const admin = createClient(url, serviceRole, { auth: { persistSession: false } });

let duble: ChildProcess | null = null;
let creds: CredsE2E;
let orgId = "";
/** Os follow-ups que esta spec publicou — desativados no fim. */
const publicados: string[] = [];

async function ok<T>(p: PromiseLike<{ error: { message: string } | null; data?: T }>, oQue: string): Promise<void> {
  const { error } = await p;
  if (error) throw new Error(`${oQue}: ${error.message}`);
}

/**
 * A versão (`{ graph }`) tem o passo "Classificar (IA)" com duas saídas ou mais? É o que tira a
 * tarefa do "Não roda". ponytail: só conta as saídas; o produto também recusa
 * saída em branco ou repetida — aqui, desativar a mais não muda o que se mede.
 */
function classificaEntreSaidas(versao: unknown): boolean {
  type Grafo = { nodes?: Array<{ type?: string; config?: { classes?: unknown } }> };
  const nos = (versao as { graph?: Grafo } | null)?.graph?.nodes;
  return (nos ?? []).some((n) => n.type === "ai_classify" && Array.isArray(n.config?.classes) && n.config.classes.length >= 2);
}

/**
 * Trigger → Classificar (IA) → um fim por saída, mais "sem resposta" e "outros
 * casos": as arestas que o validador de publicar exige (`validate-publish.ts`).
 */
function grafoQueClassifica(saidas: readonly string[]): object {
  const P = { x: 0, y: 0 };
  return {
    nodes: [
      { id: "trigger-1", type: "trigger", label: "Início", position: P, config: {} },
      {
        id: "classify-1",
        type: "ai_classify",
        label: "Classificar resposta",
        position: P,
        config: { classes: [...saidas], grace_timeout_ms: 86_400_000 },
      },
      ...saidas.map((s) => ({ id: `end-${s}`, type: "end", label: s, position: P, config: { outcome: "converted" } })),
      { id: "end-sem-resposta", type: "end", label: "Sem resposta", position: P, config: { outcome: "exhausted" } },
      { id: "end-outros", type: "end", label: "Outros", position: P, config: { outcome: "exhausted" } },
    ],
    edges: [
      { id: "edge-inicio", source: "trigger-1", target: "classify-1", priority: 0, condition: { type: "always" } },
      ...saidas.map((s) => ({
        id: `edge-${s}`,
        source: "classify-1",
        target: `end-${s}`,
        priority: 0,
        condition: { type: "class_match", value: s },
      })),
      {
        id: "edge-sem-resposta",
        source: "classify-1",
        target: "end-sem-resposta",
        priority: 0,
        condition: { type: "class_match", value: "no_reply" },
      },
      { id: "edge-outros", source: "classify-1", target: "end-outros", priority: 0, condition: { type: "always" } },
    ],
  };
}

/** Cria, grava o rascunho e publica — as três rotas que o construtor chama. */
async function publicarFollowup(page: Page, nome: string, saidas: readonly string[]): Promise<void> {
  const criou = await page.request.post("/api/v1/ai/followup-flows", { data: { name: nome } });
  expect(criou.status(), "o follow-up não foi criado").toBe(201);
  const { id } = ((await criou.json()) as { data: { id: string } }).data;
  publicados.push(id);
  const gravou = await page.request.patch(`/api/v1/ai/followup-flows/${id}`, {
    data: { draft_graph: grafoQueClassifica(saidas) },
  });
  expect(gravou.status(), "o rascunho não foi gravado").toBe(200);
  const publicou = await page.request.post(`/api/v1/ai/followup-flows/${id}/publish`, { data: {} });
  expect(publicou.status(), `o publicar recusou: ${await publicou.text()}`).toBe(200);
}

/**
 * A pré-condição "nenhum follow-up com classificar de duas saídas": desativa os
 * ativos e cancela as inscrições vivas numa versão com ele, pelas rotas da tela.
 */
async function semClassificarNaOrganizacao(page: Page): Promise<void> {
  const ativos = await admin
    .from("followup_flow_pointers")
    .select("id, versao:followup_flow_versions!followup_flow_pointers_active_version_id_fkey(graph)")
    .eq("organization_id", orgId)
    .eq("status", "active");
  if (ativos.error) throw new Error(`ler os follow-ups ativos: ${ativos.error.message}`);
  for (const f of (ativos.data ?? []) as Array<{ id: string; versao: unknown }>) {
    if (!classificaEntreSaidas(f.versao)) continue;
    const r = await page.request.post(`/api/v1/ai/followup-flows/${f.id}/disable`, { data: {} });
    expect(r.status(), `desativar o follow-up ${f.id}`).toBe(200);
  }

  // O mesmo filtro da rota do Jev (`INSCRICAO_ENCERRADA`): fora destes, ela anda.
  const vivas = await admin
    .from("followup_enrollments")
    .select("id, status, versao:followup_flow_versions(graph)")
    .eq("organization_id", orgId)
    .not("status", "in", "(completed,cancelled,dead)");
  if (vivas.error) throw new Error(`ler as inscrições vivas: ${vivas.error.message}`);
  for (const e of (vivas.data ?? []) as Array<{ id: string; status: string; versao: unknown }>) {
    if (!classificaEntreSaidas(e.versao)) continue;
    const r = await page.request.post(`/api/v1/ai/followups/enrollments/${e.id}/cancel`, { data: {} });
    expect(r.status(), `cancelar a inscrição ${e.id} (status ${e.status})`).toBe(200);
  }
}

test.describe("Jev — a resposta ao follow-up, pela tela", () => {
  test.describe.configure({ timeout: 180_000 });

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
    // Pelo service role: o `afterAll` não tem a sessão do admin. É o mesmo
    // `status` que a rota de desativar grava.
    if (publicados.length > 0) {
      await ok(
        admin.from("followup_flow_pointers").update({ status: "disabled" } as never).in("id", publicados),
        "desativar os follow-ups da spec",
      );
    }
    if (orgId) await limparOJev(orgId);
  });

  test("[P1] a tarefa do follow-up só roda com um Classificar de duas saídas — e aí só observa, sem o botão de decidir", async ({
    page,
  }) => {
    creds = await loginComoAdmin(page, creds);
    orgId = credsDoJev().orgId;
    await limparOJev(orgId);
    await ok(
      admin.from("jev_observacoes").delete().eq("organization_id", orgId).eq("tarefa", "followup"),
      "limpar as observações da tarefa do follow-up",
    );
    await semClassificarNaOrganizacao(page);

    await test.step("a chave do dublê, testada, e o Jev ligado com o aceite", async () => {
      const criou = await page.request.post("/api/v1/ai/credentials", {
        data: { provider: "typesafe", label: "Jev do follow-up", api_key: CHAVE_DO_DUBLE },
      });
      expect(criou.status(), "a chave não foi cadastrada").toBe(201);
      // O teste da chave roda depois da resposta: espera ele passar.
      await expect(async () => {
        const r = await page.request.get("/api/v1/ai/jev");
        expect(((await r.json()) as { data: { chave: { validada: boolean } } }).data.chave.validada).toBe(true);
      }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });
      const ligou = await page.request.patch("/api/v1/ai/jev", { data: { ligado: true, aceite_lgpd: true } });
      expect(ligou.status(), "o Jev não ligou").toBe(200);
    });

    /** Os dois cartões "Não roda" dizem a mesma coisa: o porquê, a porta, e nada de decidir. */
    async function esperarNaoRoda(): Promise<void> {
      const cartao = await abrirOCartao(page);
      // Ligado e medindo — sem a IA de sempre do seed validada, "sozinho" no clima.
      await expect(cartao).toHaveAttribute("data-estado", /^(observando|sozinho)$/);
      const linha = cartao.getByTestId("jev-tarefa-followup");
      await expect(linha).toContainText("Ler a resposta ao follow-up");
      // Não é pausa: o estado é o de observar, e quem a para é a falta do passo.
      await expect(linha).toHaveAttribute("data-estado", "observando");
      // O selo (a frase abaixo também começa com "Não roda agora").
      await expect(linha.getByText("Não roda", { exact: true })).toBeVisible();
      await expect(linha).not.toContainText("Só observa");
      await expect(cartao.getByTestId("jev-sem-fluxo-followup")).toContainText(NAO_RODA_SEM_FLUXO);
      await expect(
        cartao.getByTestId("jev-sem-fluxo-followup").getByRole("link", { name: "Abrir os follow-ups" }),
      ).toHaveAttribute("href", "/app/ai/followups");
      // Parada, ela não observa nada: sem a frase de só observar e sem concordância.
      await expect(cartao.getByTestId("jev-so-observa-followup")).toHaveCount(0);
      await expect(cartao.getByTestId("jev-concordancia-followup")).toHaveCount(0);
      // Controle: a linha tem botões (a pessoa pode editar) — a ausência abaixo não é da tela inteira.
      await expect(linha.getByRole("button", { name: "Pausar esta tarefa" })).toBeVisible();
      await expect(linha.getByRole("button", { name: "Deixar o Jev decidir" })).toHaveCount(0);
    }

    await test.step("sem follow-up com Classificar: 'Não roda', o porquê e a porta para Follow-ups", async () => {
      await esperarNaoRoda();
      await page.screenshot({ path: "evidence/jev/followup-nao-roda.png", fullPage: true });
    });

    await test.step("controle: um Classificar de UMA saída publicado não tira a tarefa do 'Não roda'", async () => {
      await publicarFollowup(page, `Jev follow-up uma saída ${sufixo}`, ["quer"]);
      await esperarNaoRoda();
    });

    await test.step("com um Classificar de duas saídas publicado: 'Só observa', o porquê, e sem decidir", async () => {
      await publicarFollowup(page, `Jev follow-up duas saídas ${sufixo}`, ["quer", "nao_quer"]);
      const cartao = await abrirOCartao(page);
      const linha = cartao.getByTestId("jev-tarefa-followup");
      await expect(linha).toHaveAttribute("data-estado", "observando");
      await expect(linha.getByText("Só observa", { exact: true })).toBeVisible();
      await expect(linha).not.toContainText("Não roda");
      await expect(cartao.getByTestId("jev-sem-fluxo-followup")).toHaveCount(0);
      await expect(cartao.getByTestId("jev-so-observa-followup")).toHaveText(POR_QUE_SO_OBSERVA);
      // "Nova" sem prometer o botão que não há.
      await expect(cartao.getByTestId("jev-nova-followup")).toHaveText(
        "Começou sozinha, só observando: nada muda para o cliente.",
      );
      await expect(cartao.getByTestId("jev-concordancia-followup")).toHaveText(CONCORDANCIA_VAZIA);
      await expect(linha.getByRole("button", { name: "Pausar esta tarefa" })).toBeVisible();
      await expect(linha.getByRole("button", { name: "Deixar o Jev decidir" })).toHaveCount(0);
      await page.screenshot({ path: "evidence/jev/followup-so-observa.png", fullPage: true });
    });
  });
});
