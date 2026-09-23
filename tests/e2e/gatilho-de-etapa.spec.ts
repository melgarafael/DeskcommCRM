/**
 * O GATILHO DE ETAPA DO FUNIL, provado pela tela.
 *
 * O que esta spec prova, na ordem em que um dono de clínica faria: ele arma o
 * follow-up escolhendo uma etapa PELO NOME (nunca um uuid), publica o fluxo,
 * e depois move um negócio para aquela etapa no quadro — com o teclado, que é
 * o mesmo arrasto do mouse pela via acessível do `@hello-pangea/dnd`. O
 * follow-up então aparece sozinho na aba Fila, sem ninguém apertar nada.
 *
 * ⚠️ O QUE É REAL AQUI. O produtor (`lib/followup/gatilho-etapa.ts`) é
 * event-driven: a rota de movimento emite `lead.stage_changed` no `event_log` e
 * o dreno consome. Em produção esse dreno é um cron de um minuto; a spec chama
 * a MESMA rota (`/api/v1/cron/event-log-drain`) com o segredo interno, em vez de
 * esperar o relógio. É o mecanismo de produção acionado à mão, não um atalho
 * que pula o mecanismo.
 *
 * ⚠️ O QUE É SETUP, e por que não é pela tela. Criar o funil, o contato, o
 * negócio e o agente publicado é o cenário, não a feature — e cada um desses
 * caminhos já tem spec própria. O que esta spec dirige pela tela é exatamente o
 * que a frente de gatilhos entregou: o controle de gatilho e o efeito dele.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { afirmarAdminDeTenantPuro } from "./utils/precondicao";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
// `evidence/` é VERSIONADO. `e2e-artifacts/` está no .gitignore, e evidência
// citada que não entra no repo é evidência que ninguém consegue conferir depois.
const ARTIFACTS_DIR = path.join(process.cwd(), "evidence", "gatilho-de-etapa");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

/** Esta máquina roda saturada (medido: load average acima de 40 em 11 CPUs, com
 *  login chegando a 15s). Os 5s do default do Playwright viram vermelho por
 *  azar — e suíte que falha por azar desliga o gate inteiro. */
const ESPERA = 60_000;

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  admin_totp?: { factor_id: string; secret: string };
  followup_agent_fixtures?: { credential_id: string; channel_session_id: string };
}

/**
 * ⚠️ ESTA SPEC NUNCA SEMEIA CREDENCIAIS, e isso é protocolo do time, não
 * preguiça. `scripts/seed-e2e-credentials.ts` **rotaciona o fator TOTP do
 * admin** e reescreve a senha da organização de teste, que é COMPARTILHADA por
 * todas as frentes desta missão. Rodá-lo derruba o login de quem estiver no meio
 * de um run — e o sintoma que a pessoa vê é "MFA falhou", que não aponta para a
 * causa. O dono do seed é o maestro; aqui a gente copia o arquivo dele.
 */
function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(
      "Faltam credenciais de E2E. Copie as do maestro — `cp /Users/rafaelmelgaco/fv-integra/.e2e-creds.json .` — " +
        "e NÃO rode scripts/seed-e2e-credentials.ts (ele rotaciona o TOTP do admin e derruba o run das outras frentes).",
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

function segredoInterno(): string {
  const secret = carregarEnvLocal().INTERNAL_SECRET?.trim();
  if (!secret) throw new Error("INTERNAL_SECRET não encontrado em .env.local");
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

const GRAFO_MINIMO = {
  nodes: [
    { id: "trigger-1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    { id: "end-1", type: "end", label: "Fim", position: { x: 0, y: 200 }, config: { outcome: "exhausted" } },
  ],
  edges: [{ id: "edge-1", source: "trigger-1", target: "end-1", priority: 0, condition: { type: "always" } }],
};

test.describe("gatilho de etapa do funil", () => {
  test.beforeAll(() => {
    if (!creds.followup_agent_fixtures) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-followup-agent.ts"], { stdio: "inherit" });
      creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    }
    // ⚠️ A PRECONDIÇÃO DO PUBLISH É EXPLÍCITA AQUI, e não herdada de outra spec.
    // `seed-e2e-followup-agent.ts` cria a credential SEM `validated_at` e a
    // sessão em `'STARTING'` (ele declara isso no cabeçalho: não precisava
    // publicar). Mas `fn_publish_ai_agent_version` EXIGE `validated_at not null`
    // e `status = 'WORKING'`. Esta spec publica — e só passava porque o helper
    // de OUTRA spec tinha validado as fixtures neste banco. Num ambiente fresco
    // (o que a doutrina de QA Visual manda) o publish devolveria 422, e a
    // mensagem acusaria o gate do agente, que não é a causa.
    execFileSync("npx", ["tsx", "scripts/e2e-followup-journey-helpers.ts", "prepare-agent-fixtures"], {
      stdio: "inherit",
    });
  });

  test("o negócio movido no quadro para a etapa escolhida arma o follow-up sozinho", async ({ page }) => {
    test.setTimeout(180_000);
    expect(creds.admin_totp?.secret, "seed deve gravar admin_totp").toBeTruthy();
    expect(creds.followup_agent_fixtures, "seed-e2e-followup-agent.ts deve gravar as fixtures").toBeTruthy();

    await loginComTotp(page, creds.users.admin!.email, creds.admin_totp!.secret);

    const marca = Date.now();
    const nomeDoFluxo = `E2E Gatilho Etapa ${marca}`;
    let flowId = "";
    let agentId = "";
    // Hoistados só para o `finally` alcançá-los na limpeza — ver o teardown no fim.
    let funilId = "";
    let negocioId = "";

    try {
      // ---- cenário: funil novo (nasce com as etapas padrão), contato e negócio ----
      const funilRes = await page.request.post("/api/v1/pipelines", {
        data: { name: `E2E Funil Gatilho ${marca}` },
      });
      expect(funilRes.status()).toBe(201);
      const { data: funis } = (await funilRes.json()) as { data: { pipelines: Array<{ id: string; name: string }> } };
      const funil = funis.pipelines.find((p) => p.name === `E2E Funil Gatilho ${marca}`)!;
      expect(funil, "o funil recém-criado tem que voltar na lista").toBeTruthy();
      funilId = funil.id;

      const etapasRes = await page.request.get(`/api/v1/pipelines/${funil.id}/agent-mapping`);
      expect(etapasRes.status()).toBe(200);
      const { data: mapa } = (await etapasRes.json()) as { data: { etapas: Array<{ id: string; name: string }> } };
      expect(mapa.etapas.length, "funil novo nasce com etapas").toBeGreaterThanOrEqual(2);
      const etapaOrigem = mapa.etapas[0]!;
      const etapaDestino = mapa.etapas[1]!;

      const contatoRes = await page.request.post("/api/v1/contacts", {
        data: { display_name: `Contato Gatilho ${marca}`, phone_number: `+5511${String(marca).slice(-9)}` },
      });
      expect(contatoRes.status()).toBe(201);
      // ⚠️ `data.contact`, e não `data` — o handler devolve `{ contact, action }`.
      // Lendo `data.id` vinha `undefined`, o negócio nascia SEM contato, e o
      // gatilho corretamente não enrollava ninguém (`sem_contato`). O produtor
      // estava certo; o cenário é que estava errado — e o teste falhava lá na
      // frente, na fila vazia, longe da causa.
      const { data: respostaDoContato } = (await contatoRes.json()) as {
        data: { contact: { id: string; display_name: string } };
      };
      const contato = respostaDoContato.contact;
      expect(contato.id, "o contato precisa nascer com id — sem ele o negócio fica sem contato").toBeTruthy();

      const negocioRes = await page.request.post("/api/v1/leads", {
        data: {
          pipeline_id: funil.id,
          stage_id: etapaOrigem.id,
          contact_id: contato.id,
          title: `Negócio Gatilho ${marca}`,
        },
      });
      expect(negocioRes.status()).toBe(201);
      const { data: negocio } = (await negocioRes.json()) as { data: { id: string; title: string } };
      negocioId = negocio.id;

      // ---- 1. o fluxo, e o gatilho armado PELA TELA ----
      const criaFluxo = await page.request.post("/api/v1/ai/followup-flows", { data: { name: nomeDoFluxo } });
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
      await page.getByRole("option", { name: "Etapa do funil", exact: true }).click();

      // A ETAPA É ESCOLHIDA PELO NOME. Se algum dia isto voltar a ser um campo
      // de uuid, esta linha é a que reprova.
      const seletorDeEtapa = page.getByTestId("trigger-stage-select");
      await expect(seletorDeEtapa).toBeEnabled({ timeout: ESPERA });
      await seletorDeEtapa.click();
      // ⚠️ A OPÇÃO É PEDIDA PELO NOME COMPOSTO — «etapa · funil» —, e isso é a
      // asserção que guarda o conserto. Duas etapas podem se chamar «Em
      // andamento» em funis diferentes (todo funil nasce com as mesmas quatro),
      // e por um tempo a tela oferecia as duas com o mesmo nome: o funil vivia
      // só no cabeçalho do grupo, que não entra no nome acessível da opção nem
      // sobrevive ao seletor fechado. Escolher errado armava um fluxo que ficava
      // `active` e nunca disparava, calado.
      //
      // Escopar por grupo também funcionaria, mas provaria menos: passaria igual
      // se alguém tirasse o funil do texto do item. Pedir o nome composto é o
      // que reprova essa regressão.
      // O prazo explícito não é cosmético: o config não define `actionTimeout`,
      // então um clique sem prazo espera até o teto de 180s do teste e morre
      // como "Test timeout exceeded" — apontando para a chamada seguinte, que
      // costuma ser o teardown. Medido: com o funil removido do item, a falha
      // vinha rotulada `apiRequestContext.post`, que não é a causa. Com prazo,
      // ela nomeia o locator que não encontrou.
      await page
        .getByRole("option", { name: `${etapaDestino.name} · ${funil.name}`, exact: true })
        .click({ timeout: ESPERA });
      await page.screenshot({
        path: path.join(ARTIFACTS_DIR, "gatilho-etapa-01-configurado.png"),
        fullPage: true,
      });

      await painel.getByTestId("trigger-config-save").click();
      // O rótulo persistente carrega o funil — é a superfície que o dono lê uma
      // semana depois, sem abrir nada, e sem o funil ela não distinguia qual das
      // homônimas estava armada.
      await expect(botaoDoGatilho).toHaveText(`Gatilho: entrou em «${etapaDestino.name}» em ${funil.name}`, {
        timeout: ESPERA,
      });

      // ⚠️ E MESMO ASSIM O RÓTULO NÃO É O ORÁCULO FINAL: ele prova o que a tela
      // mostra, não o que foi gravado. Quem amarra a escolha à etapa certa é o
      // uuid persistido — se um dia a exibição e a gravação divergirem, é esta
      // linha que reprova, e a de cima que passaria dizendo o contrário.
      const gatilhoSalvo = await page.request.get(`/api/v1/ai/followup-flows/${flowId}`);
      expect(
        ((await gatilhoSalvo.json()) as { data: { trigger_config: { params?: { stage_id?: string } } } }).data
          .trigger_config.params?.stage_id,
        "o gatilho tem que apontar para a etapa DESTE funil, não para a homônima de outro",
      ).toBe(etapaDestino.id);

      // ---- 2. publica o fluxo pela tela ----
      // O rótulo é "Fluxo publicado." e o selo vira "Ativo" — não existe selo
      // "Publicado" nesta tela, e procurá-lo é vermelho garantido.
      await page.getByRole("button", { name: /^Publicar$/ }).click();
      await expect(page.getByText("Fluxo publicado.").first()).toBeVisible({ timeout: ESPERA });
      const depoisDoPublish = await page.request.get(`/api/v1/ai/followup-flows/${flowId}`);
      expect(((await depoisDoPublish.json()) as { data: { status: string } }).data.status).toBe("active");
      await page.screenshot({
        path: path.join(ARTIFACTS_DIR, "gatilho-etapa-02-publicado.png"),
        fullPage: true,
      });

      // ---- 3. cenário: o agente publicado que ARMA o fluxo (o gate) ----
      const fixtures = creds.followup_agent_fixtures!;
      const criaAgente = await page.request.post("/api/v1/ai/agents", {
        data: {
          name: `E2E Agente Gatilho ${marca}`,
          version: {
            system_prompt: "Agente de teste E2E do gatilho de etapa.",
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
      const publicaAgente = await page.request.post(`/api/v1/ai/agents/${agentId}/publish`, {
        data: { version_id: criado.data.version.id },
      });
      expect(publicaAgente.status(), "o gate só libera com agente PUBLICADO").toBe(200);

      // ---- 4. o movimento, no quadro, pelo teclado ----
      await page.goto(`/app/pipelines/${funil.id}`);
      const card = page.getByRole("group", { name: `Lead: ${negocio.title}` });
      await expect(card).toBeVisible({ timeout: ESPERA });
      await page.screenshot({
        path: path.join(ARTIFACTS_DIR, "gatilho-etapa-03-antes-do-movimento.png"),
        fullPage: true,
      });

      // O arrasto acessível do @hello-pangea/dnd: espaço levanta, seta move de
      // coluna, espaço solta. É o MESMO caminho de código do arrasto com o
      // mouse (mesmo `onDragEnd`), e não depende de coordenadas de pixel.
      await card.focus();
      await page.keyboard.press("Space");
      await page.waitForTimeout(400);
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(400);
      await page.keyboard.press("Space");

      await expect
        .poll(
          async () => {
            // O board, e não `GET /api/v1/leads/:id` — essa rota NÃO existe
            // (o arquivo só expõe PATCH), e pedi-la devolvia corpo
            // vazio: o erro que aparecia era "Unexpected end of JSON input",
            // que fala do parser e esconde que a rota não está lá.
            const r = await page.request.get(`/api/v1/pipelines/${funil.id}/board`);
            const { data } = (await r.json()) as { data: { leads: Array<{ id: string; stage_id: string }> } };
            return data.leads.find((l) => l.id === negocio.id)?.stage_id ?? null;
          },
          { timeout: 60_000, message: "o card tem que ter mudado de etapa no banco" },
        )
        .toBe(etapaDestino.id);
      await page.screenshot({
        path: path.join(ARTIFACTS_DIR, "gatilho-etapa-04-depois-do-movimento.png"),
        fullPage: true,
      });

      // ---- 5. o dreno do event_log (o que o cron de 1 minuto faz sozinho) ----
      const secret = segredoInterno();
      await expect
        .poll(
          async () => {
            const r = await page.request.post("/api/v1/cron/event-log-drain", {
              headers: { authorization: `Bearer ${secret}` },
            });
            expect(r.status(), "o dreno tem que responder 200").toBe(200);
            // O 200 diz que o dreno RODOU, não que os handlers deram certo:
            // `consumed_by` só acumula quem terminou ok, e handler que estourou
            // vira `failed` com o motivo em `last_error`. Sem cobrar isto, um
            // erro de INSERT vira "timeout de 60s" e a mensagem acusa o motor —
            // foi exatamente o que já custou um diagnóstico errado aqui.
            const resumo = ((await r.json()) as { data: { failed: number; dead: number } }).data;
            expect(resumo.failed + resumo.dead, "nenhum handler pode ter falhado no dreno").toBe(0);
            const fila = await page.request.get("/api/v1/ai/followups/queue?limit=100");
            const { data } = (await fila.json()) as {
              data: { items?: Array<{ contact: { id: string } }> } | Array<{ contact: { id: string } }>;
            };
            const itens = Array.isArray(data) ? data : (data.items ?? []);
            return itens.some((i) => i.contact.id === contato.id);
          },
          { timeout: 60_000, message: "o follow-up tem que nascer do movimento de etapa" },
        )
        .toBe(true);

      // ---- 6. e o dono vê o follow-up na fila, sem ter apertado nada ----
      await page.goto("/app/ai/followups");
      await page.getByRole("tab", { name: "Fila" }).click();
      const linha = page.getByTestId("queue-row").filter({ hasText: contato.display_name });
      await expect(linha).toHaveCount(1, { timeout: ESPERA });
      await page.screenshot({
        path: path.join(ARTIFACTS_DIR, "gatilho-etapa-05-fila-com-o-followup.png"),
        fullPage: true,
      });
    } finally {
      // ⚠️ A SPEC APAGA O QUE A API DEIXA APAGAR — e isto não é asseio, é
      // correção de causa. Cada execução criava um funil com «Novo / Em
      // andamento / Ganho / Perdido», e era a PRÓPRIA spec que tornava
      // «Em andamento» ambíguo para a execução seguinte: o clique quebrou
      // quando o nome passou a casar 5 opções.
      //
      // Ordem imposta pelas FKs: `crm_leads.pipeline_id` é RESTRICT (o negócio
      // sai primeiro), `crm_stages.pipeline_id` é CASCADE (as 4 etapas vão de
      // graça com o funil).
      //
      // Ficam para trás, declarados em vez de esquecidos: o CONTATO e o FLOW
      // POINTER não têm rota de delete (ambos só expõem GET/PATCH), e o agente
      // some por arquivamento mole. É o mesmo resíduo que as outras specs de
      // follow-up já deixam.
      try {
        if (negocioId) {
          await page.request.post("/api/v1/leads/bulk", { data: { action: "delete", lead_ids: [negocioId] } });
        }
        if (funilId) await page.request.delete(`/api/v1/pipelines/${funilId}?definitivo=1`);
      } catch {
        // Limpeza é best-effort: o vermelho do teste tem que ser o do teste,
        // nunca o do teardown.
      }
      if (flowId) await page.request.post(`/api/v1/ai/followup-flows/${flowId}/disable`, { data: {} });
      if (agentId) await page.request.delete(`/api/v1/ai/agents/${agentId}`);
    }
  });
});
