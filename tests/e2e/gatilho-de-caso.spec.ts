/**
 * O GATILHO DE CASO ABERTO, provado pela tela — e o laço fechando.
 *
 * O que esta spec prova, na ordem em que um dono de clínica faria: ele arma o
 * follow-up escolhendo "Agente pediu ajuda" no seletor, publica, e depois o
 * agente abre um caso. O follow-up aparece sozinho na aba Fila. Quando alguém
 * resolve o caso, ele sai da fila sozinho — sem ninguém apertar nada.
 *
 * ⚠️ AS DUAS METADES SÃO A MESMA FEATURE. Provar só a abertura seria provar meio
 * mecanismo: um follow-up nascido de caso e nunca cancelado cobra o cliente
 * sobre um problema já resolvido, e o caso de referência fechou em SEIS
 * SEGUNDOS. Por isso o passo 6 desta spec não é extra — é o que impede a feature
 * de ser um defeito.
 *
 * ⚠️ O QUE É REAL AQUI. O produtor é event-driven: um trigger Postgres (0148)
 * emite `ai.case_opened`/`ai.case_closed` no `event_log`, e o dreno consome. Em
 * produção o dreno é um cron de um minuto; a spec chama a MESMA rota com o
 * segredo interno em vez de esperar o relógio. Mecanismo de produção acionado à
 * mão, não atalho que pula o mecanismo.
 *
 * ⚠️ POR QUE ABRIR O CASO NÃO É PELA TELA. Não existe rota de criação de caso —
 * `app/api/v1/ai/cases` só expõe leitura e resposta. Quem abre é o agente,
 * dentro do turno, o que exigiria modelo e WAHA no CI. O helper insere na
 * tabela, e o INSERT passa pelo MESMO trigger que o turno do agente dispararia:
 * o caminho ATÉ o gatilho é encurtado, o gatilho não.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { afirmarAdminDeTenantPuro } from "./utils/precondicao";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const ARTIFACTS_DIR = path.join(process.cwd(), "evidence", "gatilho-de-caso");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

/** Esta máquina roda saturada; os 5s do default viram vermelho por azar, e
 *  suíte que falha por azar desliga o gate inteiro. */
const ESPERA = 60_000;

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
  admin_totp?: { factor_id: string; secret: string };
  followup_agent_fixtures?: { credential_id: string; channel_session_id: string };
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(
      "Faltam credenciais de E2E. Copie as do maestro e NÃO rode seed-e2e-credentials.ts " +
        "(ele rotaciona o TOTP do admin e derruba o run das outras frentes).",
    );
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

let creds = loadCreds();

// ── Precondição de identidade ────────────────────────────────────────────────
// Esta spec dirige o produto como ADMIN DE TENANT (`creds.users.admin`), o
// usuário compartilhado por 10 arquivos — e que `seed-e2e-system-update.ts`
// promovia a dono do servidor sem revogar, num banco que o job `e2e` não reseta
// entre as duas partes.
//
// ⚠️ Medido, e a diferença importa: com rank `admin` (5, o teto), a promoção NÃO
// muda a navegação nem os gates `!is_platform_admin && ROLE_RANK < X` — muda só
// as superfícies exclusivas do dono. Nenhuma asserção deste arquivo abre uma
// delas hoje. A precondição existe para que a primeira que abrir não passe
// medindo o escape. O raciocínio inteiro está em `utils/precondicao.ts`.
test.beforeAll(async () => {
  await afirmarAdminDeTenantPuro(creds.users.admin!.email);
});

function helper<T>(...args: string[]): T {
  const saida = execFileSync("npx", ["tsx", "scripts/e2e-followup-journey-helpers.ts", ...args], {
    encoding: "utf8",
  });
  // O helper imprime JSON na última linha não-vazia.
  const linha = saida.trim().split("\n").filter(Boolean).pop()!;
  return JSON.parse(linha) as T;
}

function segredoInterno(): string {
  const secret = carregarEnvLocal().INTERNAL_SECRET?.trim();
  if (!secret) throw new Error("INTERNAL_SECRET não encontrado no ambiente");
  return secret;
}

async function loginComTotp(page: Page, email: string, secret: string): Promise<void> {
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible({ timeout: ESPERA });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/login\/mfa/, { timeout: ESPERA });

  for (let tentativa = 0; tentativa < 3; tentativa++) {
    if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(secret), { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 20_000 });
      return;
    } catch {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA falhou depois de 2 tentativas de TOTP");
}

/** Fluxo mínimo publicável: gatilho → fim. O nó de espera não entra porque o
 *  que esta spec prova é o GATILHO; a espera é escolha de quem monta o fluxo. */
const GRAFO_MINIMO = {
  nodes: [
    { id: "trigger-1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    { id: "end-1", type: "end", label: "Fim", position: { x: 0, y: 200 }, config: { outcome: "exhausted" } },
  ],
  edges: [{ id: "edge-1", source: "trigger-1", target: "end-1", priority: 0, condition: { type: "always" } }],
};

async function drena(page: Page, secret: string): Promise<void> {
  const r = await page.request.post("/api/v1/cron/event-log-drain", {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(r.status(), "o dreno tem que responder 200").toBe(200);
  // O 200 diz que o dreno RODOU, não que os handlers deram certo: `consumed_by`
  // só acumula quem terminou ok, e handler que estourou vira `failed` com o
  // motivo em `last_error`. Sem cobrar isto, um erro de INSERT vira "timeout" e
  // a mensagem acusa o motor.
  const resumo = ((await r.json()) as { data: { failed: number; dead: number } }).data;
  expect(resumo.failed + resumo.dead, "nenhum handler pode ter falhado no dreno").toBe(0);
}

test.describe("gatilho de caso aberto", () => {
  test.beforeAll(() => {
    if (!creds.followup_agent_fixtures) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-followup-agent.ts"], { stdio: "inherit" });
      creds = loadCreds();
    }
    // O seed cria a credential SEM `validated_at` e a sessão em 'STARTING'; o
    // publish do agente EXIGE os dois. Explícito aqui em vez de herdado do run
    // de outra spec — num ambiente fresco isso daria 422 acusando o gate.
    execFileSync("npx", ["tsx", "scripts/e2e-followup-journey-helpers.ts", "prepare-agent-fixtures"], {
      stdio: "inherit",
    });
  });

  test("o caso aberto pelo agente arma o follow-up, e resolvê-lo o cancela", async ({ page }) => {
    test.setTimeout(240_000);
    expect(creds.admin_totp?.secret, "seed deve gravar admin_totp").toBeTruthy();

    await loginComTotp(page, creds.users.admin!.email, creds.admin_totp!.secret);
    const secret = segredoInterno();

    const marca = Date.now();
    let flowId = "";
    let agentId = "";

    try {
      // ---- cenário: contato + conversa (o caso precisa de uma conversa) ----
      const cenario = helper<{ contactId: string; contactName: string; conversationId: string }>(
        "seed-silent-contact",
        "5",
        `caso-${marca}`,
      );

      // ---- 1. o fluxo, e o gatilho armado PELA TELA ----
      const criaFluxo = await page.request.post("/api/v1/ai/followup-flows", {
        data: { name: `E2E Gatilho Caso ${marca}` },
      });
      expect(criaFluxo.status()).toBe(201);
      flowId = ((await criaFluxo.json()) as { data: { id: string } }).data.id;
      expect(
        (await page.request.patch(`/api/v1/ai/followup-flows/${flowId}`, { data: { draft_graph: GRAFO_MINIMO } }))
          .status(),
      ).toBe(200);

      await page.goto(`/app/ai/followups/${flowId}`);
      await expect(page.getByTestId("flow-builder-shell")).toBeVisible({ timeout: ESPERA });

      const botaoDoGatilho = page.getByTestId("trigger-config-button");
      await expect(botaoDoGatilho).toHaveText("Gatilho: Manual", { timeout: ESPERA });
      await botaoDoGatilho.click();

      const painel = page.getByTestId("trigger-config-panel");
      await expect(painel).toBeVisible({ timeout: ESPERA });
      await painel.getByRole("combobox").first().click();
      await page.getByRole("option", { name: "Agente pediu ajuda", exact: true }).click({ timeout: ESPERA });

      // A tela tem que EXPLICAR o que o gatilho faz, e avisar do risco de duas
      // vozes. Se algum dia essa orientação sumir, é esta linha que reprova —
      // o aviso é a defesa principal contra o agente e o fluxo falarem juntos.
      await expect(painel.getByText(/Comece o fluxo por uma espera/i)).toBeVisible({ timeout: ESPERA });

      await page.screenshot({ path: path.join(ARTIFACTS_DIR, "caso-01-gatilho-armado.png"), fullPage: true });

      await painel.getByTestId("trigger-config-save").click();
      await expect(botaoDoGatilho).toHaveText("Gatilho: quando o agente pede ajuda", { timeout: ESPERA });

      // O rótulo prova o que a tela mostra; o kind persistido prova o que foi
      // gravado. Se um dia divergirem, é esta linha que reprova.
      const salvo = await page.request.get(`/api/v1/ai/followup-flows/${flowId}`);
      expect(
        ((await salvo.json()) as { data: { trigger_config: { kind: string } } }).data.trigger_config.kind,
      ).toBe("case_opened");

      // ---- 2. publica pela tela (o selo vira "Ativo"; não existe "Publicado") ----
      await page.getByRole("button", { name: /^Publicar$/ }).click();
      await expect(page.getByText("Fluxo publicado.").first()).toBeVisible({ timeout: ESPERA });
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, "caso-02-publicado.png"), fullPage: true });

      // ---- 3. cenário: o agente publicado que ARMA o fluxo (o gate) ----
      const fixtures = creds.followup_agent_fixtures!;
      const criaAgente = await page.request.post("/api/v1/ai/agents", {
        data: {
          name: `E2E Agente Caso ${marca}`,
          version: {
            system_prompt: "Agente de teste E2E do gatilho de caso.",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            credential_id: fixtures.credential_id,
            channel_session_id: fixtures.channel_session_id,
            followup: { enabled: true, flow_pointer_ids: [flowId] },
          },
        },
      });
      expect(criaAgente.status()).toBe(201);
      const criado = (await criaAgente.json()) as { data: { agent: { id: string }; version: { id: string } } };
      agentId = criado.data.agent.id;
      expect(
        (await page.request.post(`/api/v1/ai/agents/${agentId}/publish`, { data: { version_id: criado.data.version.id } })).status(),
        "o gate só libera com agente PUBLICADO",
      ).toBe(200);

      // ---- 4. O AGENTE ABRE O CASO (trigger 0148 emite ai.case_opened) ----
      const caso = helper<{ caseId: string }>("abrir-caso", cenario.conversationId, "agent");
      expect(caso.caseId).toBeTruthy();

      // ---- 5. o dreno, e o follow-up aparece na fila sozinho ----
      await expect
        .poll(
          async () => {
            await drena(page, secret);
            const fila = await page.request.get("/api/v1/ai/followups/queue?limit=100");
            const { data } = (await fila.json()) as {
              data: { items?: Array<{ contact: { id: string } }> } | Array<{ contact: { id: string } }>;
            };
            const itens = Array.isArray(data) ? data : (data.items ?? []);
            return itens.some((i) => i.contact.id === cenario.contactId);
          },
          { timeout: 60_000, message: "o follow-up tem que nascer do caso aberto" },
        )
        .toBe(true);

      await page.goto("/app/ai/followups");
      await page.getByRole("tab", { name: "Fila" }).click();
      const linha = page.getByTestId("queue-row").filter({ hasText: cenario.contactName });
      await expect(linha).toHaveCount(1, { timeout: ESPERA });
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, "caso-03-fila-com-o-followup.png"), fullPage: true });

      // ---- 6. O LAÇO FECHA: resolver o caso cancela o follow-up ----
      //
      // ⚠️ A LINHA NÃO SOME DA FILA, E ISSO É O CERTO. A primeira versão desta
      // spec cobrava desaparecimento e reprovou — mas o mecanismo estava certo e
      // a asserção errada: a fila mostra TODOS os status com um selo, porque
      // linha que evapora não deixa o operador saber o que houve. O que muda é
      // o ESTADO, e é ele que esta spec cobra.
      helper("fechar-caso", caso.caseId);
      await expect
        .poll(
          async () => {
            await drena(page, secret);
            const fila = await page.request.get("/api/v1/ai/followups/queue?limit=100");
            const { data } = (await fila.json()) as {
              data:
                | { items?: Array<{ contact: { id: string }; status: string }> }
                | Array<{ contact: { id: string }; status: string }>;
            };
            const itens = Array.isArray(data) ? data : (data.items ?? []);
            return itens.find((i) => i.contact.id === cenario.contactId)?.status ?? "(sumiu da fila)";
          },
          {
            timeout: 60_000,
            message:
              "resolver o caso tem que CANCELAR o follow-up — sem isto o cliente é cobrado sobre um problema já resolvido",
          },
        )
        .toBe("cancelled");

      await page.reload();
      await page.getByRole("tab", { name: "Fila" }).click();
      // ⚠️ BUSCAR, E NÃO CONFIAR NA PRIMEIRA PÁGINA. Cancelar zera o
      // `next_eval_at`, e a linha afunda na ordenação da fila — numa conta com
      // dezenas de follow-ups ela sai da primeira página. Medido: a asserção sem
      // busca reprovou com 0 linhas num banco com 52 enrollments, sendo que a
      // API devolvia a linha corretamente. É também o que o operador faria.
      await page.getByLabel("Buscar contato").fill(cenario.contactName);
      const linhaCancelada = page.getByTestId("queue-row").filter({ hasText: cenario.contactName });
      await expect(linhaCancelada).toHaveCount(1, { timeout: ESPERA });
      // Pela TELA, e em português: o operador tem que conseguir ler que aquele
      // follow-up foi cancelado, não deduzir pela ausência.
      await expect(linhaCancelada.getByText("Cancelado", { exact: true })).toBeVisible({ timeout: ESPERA });
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, "caso-04-cancelado-apos-resolver.png"), fullPage: true });
    } finally {
      if (flowId) await page.request.post(`/api/v1/ai/followup-flows/${flowId}/disable`, { data: {} });
      if (agentId) await page.request.delete(`/api/v1/ai/agents/${agentId}`);
    }
  });
});
