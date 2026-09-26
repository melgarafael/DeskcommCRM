/**
 * IA 360 W4 — o agente organiza a operação, e o humano VÊ que foi ele.
 *
 * O que este teste prova, pela tela e pelo caminho real de um cliente MCP:
 *   1. o agente cria uma etapa de funil → ela aparece no funil, marcada como
 *      mudança do assistente;
 *   2. o agente liga uma regra automática que estava pausada → a tela mostra
 *      "Ativa" **com a autoria dele**;
 *   3. a regra que o agente ligou dispara de verdade e o egress externo continua
 *      passando pelo guard anti-SSRF — provado com um receiver HTTP REAL, que
 *      recebe zero requisições.
 *
 * ⚠️ O ITEM 3 É O QUE IMPEDE ESTA WAVE DE ABRIR UM BURACO. Ligar automação é a
 * capacidade mais perigosa que o agente ganhou: a regra passa a rodar sozinha,
 * para sempre, e uma das ações possíveis manda dados para fora da empresa. Provar
 * só que "a tela mostra Ativa" deixaria em aberto a pergunta que importa — se
 * ligar POR AQUI contorna a proteção que existe quando um humano liga. Mock não
 * responderia isso: o guard roda antes do `fetch`, e um mock do `fetch` já teria
 * passado por ele.
 *
 * ⚠️ O TOKEN USA `role:manager`, E ISSO NÃO É UM ATALHO DO TESTE. As seis
 * escritas de configuração são `apenasHumano` por PARIDADE: as rotas HTTP que
 * elas espelham exigem `manager`, e nem um atendente humano configura a operação
 * pela tela. Um agente PUBLICADO (papel `agent`) não as alcança **de propósito**,
 * e o gate `tests/unit/capacidade-alcancavel-pelo-agente.test.ts` cobra que essa
 * restrição continue declarada. O que este spec exercita é o caminho de um
 * cliente MCP server-to-server com `actor:ai_agent` — real, suportado, e o único
 * por onde uma escrita de configuração chega ao banco vinda de um ator agente.
 * A autoria gravada é `ai` pelo scope `actor:ai_agent`, não pelo papel.
 *
 * Self-contido: nomes com sufixo de timestamp, e o que foi criado é removido no
 * final para reruns ficarem verdes num banco compartilhado com outras sessões.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import { test, expect, type Locator, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const AGENTE_PATH = path.join(process.cwd(), ".e2e-agente-mcp.json");
/**
 * As capturas vão para `evidence/`, que é VERSIONADO — não para a pasta de
 * trabalho. `tests/unit/evidencia-citada.test.ts` reprova documento que aponta
 * para imagem fora do `git ls-files`: num projeto aberto, prova citada e não
 * entregue é uma afirmação sem lastro para quem clona.
 */
const EVIDENCIA = path.join(process.cwd(), "evidence", "ia-360-w4");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}
interface TokenDoAgente {
  organization_id: string;
  token_id: string;
  bearer: string;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function tokenDoAgente(): TokenDoAgente {
  // Sempre reemite: o token tem validade curta e o seed é idempotente.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-agente-mcp.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(AGENTE_PATH, "utf8")) as TokenDoAgente;
}

function internalSecret(): string {
  const envDeTeste = carregarEnvLocal();
  const secret = envDeTeste.INTERNAL_SECRET;
  if (!secret) throw new Error("INTERNAL_SECRET não encontrado em .env.local");
  return secret;
}

const creds = loadCreds();
const ts = Date.now();
const ETAPA = `Retorno do agente ${ts}`;
const REGRA = `Regra do agente ${ts}`;
const FONTE = `Entrada do agente ${ts}`;

/**
 * Chama uma capacidade pelo MCP como um cliente externo faria.
 *
 * ⚠️ PELO HTTP, não pelo handler em processo: é o transporte que carrega o
 * Bearer, e é o Bearer que carrega `actor:ai_agent`. Chamar o handler direto
 * pularia justamente a etapa que decide a autoria que a tela vai mostrar.
 */
async function agenteChama(
  bearer: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${APP_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e6),
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`MCP ${tool} → HTTP ${res.status}: ${texto.slice(0, 400)}`);

  // O transporte MCP responde JSON puro OU SSE conforme o Accept negociado — e a
  // resposta SSE abre com `event: message`, não com `data:`. Ancorar no começo
  // do corpo (a primeira versão fazia isso) quebra justamente no caminho que o
  // servidor de fato usa; procurar a LINHA `data:` funciona nos dois formatos.
  const linhaDeDados = texto.split("\n").find((l) => l.startsWith("data:"));
  const json = JSON.parse(linhaDeDados ? linhaDeDados.slice(5).trim() : texto);

  if (json.error) throw new Error(`MCP ${tool} → ${JSON.stringify(json.error)}`);
  const conteudo = json.result?.content?.[0]?.text;
  if (json.result?.isError) throw new Error(`MCP ${tool} devolveu erro: ${conteudo}`);
  return conteudo ? (JSON.parse(conteudo) as Record<string, unknown>) : {};
}

/**
 * O CARD inteiro a partir de um texto dentro dele.
 *
 * ⚠️ `filter({ hasText }).last()` NÃO SERVE, e isso custou uma rodada: o
 * `.last()` devolve o `<div>` MAIS INTERNO que casa — o próprio título — e a
 * asserção passa a procurar "Ativa" dentro de um elemento que só tem o nome.
 * Subir pelo ancestral com a borda do Card é o que devolve a peça que o usuário
 * enxerga como um cartão. Mesmo recurso do spec irmão de SSRF.
 */
function cardDe(locator: Locator): Locator {
  return locator.locator(
    "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' border-border ')][1]",
  );
}

async function login(page: Page, quem: "manager"): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.getByLabel(/e-?mail/i).fill(creds.users[quem]!.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

/**
 * Drena o `event_log` — o motor de automação é worker, não trigger.
 *
 * Três passadas com folga, como o spec irmão de webhooks: o `lead.created` só
 * nasce depois que o evento da captação é consumido, e o batch é de até 50
 * eventos com round-trips de banco em cada um.
 */
async function drenar(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${APP_URL}/api/v1/cron/event-log-drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${internalSecret()}` },
    });
    if (!res.ok) throw new Error(`drain → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 700));
  }
}

test.describe("o agente organiza a operação e a tela conta quem foi", () => {
  test("cria etapa, liga automação, e o egress externo continua barrado", async ({ page }) => {
    // O default de 30s do config é para uma jornada de tela. Este teste espera o
    // worker de automação: são três drenagens com folga (o `lead.created` só
    // nasce depois que a captação é consumida), mais duas navegações e um
    // receiver HTTP. Sem isto, o vermelho seria "o relógio", não "quebrou".
    test.setTimeout(180_000);
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    const agente = tokenDoAgente();

    // ---- receiver HTTP REAL: quem prova o que saiu (ou não saiu) da máquina ----
    const recebidas: Array<{ url: string; corpo: string }> = [];
    const receiver = http.createServer((req, res) => {
      let corpo = "";
      req.on("data", (c) => (corpo += c));
      req.on("end", () => {
        recebidas.push({ url: req.url ?? "", corpo });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    const porta = (receiver.address() as AddressInfo).port;
    const urlDoReceiver = `http://127.0.0.1:${porta}/recebido`;

    let stageId: string | null = null;
    let funilId: string | null = null;
    let ruleId: string | null = null;
    let sourceId: string | null = null;

    try {
      await login(page, "manager");

      // ---- 1) o agente cria uma etapa ----
      const funis = (await agenteChama(agente.bearer, "crm_list_pipelines", {})) as {
        pipelines: Array<{ id: string; name: string; is_default: boolean }>;
      };
      const funil = funis.pipelines.find((p) => p.is_default) ?? funis.pipelines[0]!;
      expect(funil, "a org de E2E precisa de ao menos um funil").toBeTruthy();
      funilId = funil.id;

      const criada = (await agenteChama(agente.bearer, "crm_create_stage", {
        pipeline_id: funil.id,
        name: ETAPA,
      })) as { stage_id: string; etapas: Array<{ id: string; name: string }> };
      stageId = criada.stage_id;
      expect(criada.etapas.map((e) => e.name)).toContain(ETAPA);

      // ---- a etapa aparece NA TELA, marcada como mudança do assistente ----
      await page.goto(`${APP_URL}/app/settings/tenant/pipelines`);
      const linhaDaEtapa = page.getByTestId(`etapa-${stageId}`);
      await expect(linhaDaEtapa).toBeVisible({ timeout: 15_000 });
      // O nome mora num campo editável (clique para renomear), então `toContainText`
      // olharia rótulo e placeholder e nunca veria o nome. O valor do input é o
      // que o dono da clínica lê na coluna.
      await expect(page.getByTestId(`nome-${stageId}`)).toHaveValue(ETAPA);
      // O selo é o ponto: sem ele, o dono da clínica vê uma coluna nova no quadro
      // e não tem como saber de onde ela veio.
      const seloDaEtapa = linhaDaEtapa.locator('[data-autoria="ai"]');
      await expect(seloDaEtapa).toBeVisible();
      await expect(seloDaEtapa).toContainText(/alterado pelo assistente/i);
      await page.screenshot({
        path: path.join(EVIDENCIA, "w4-etapa-criada-pelo-agente.png"),
        fullPage: true,
      });

      // ---- 2) uma regra automática, criada por HUMANO, ligada pelo AGENTE ----
      // A regra nasce pausada (o schema de criação nem aceita is_active) e aponta
      // para o receiver real. Quem a escreve é o humano — de propósito: o agente
      // não escolhe para onde a empresa manda dados.
      const criacao = await page.request.post(`${APP_URL}/api/v1/automation-rules`, {
        data: {
          name: REGRA,
          trigger_event: "lead.created",
          conditions: [],
          actions: [{ type: "call_webhook", config: { url: urlDoReceiver } }],
        },
      });
      expect(criacao.status(), await criacao.text()).toBe(201);
      ruleId = ((await criacao.json()) as { data: { id: string } }).data.id;

      const antes = (await agenteChama(agente.bearer, "crm_list_automation_rules", {})) as {
        regras: Array<{ id: string; is_active: boolean; acoes: string[] }>;
      };
      const vistaPeloAgente = antes.regras.find((r) => r.id === ruleId)!;
      expect(vistaPeloAgente.is_active).toBe(false);
      expect(vistaPeloAgente.acoes).toEqual(["call_webhook"]);
      // O agente vê O QUE a regra faz, nunca PARA ONDE ela manda.
      expect(JSON.stringify(vistaPeloAgente)).not.toContain("127.0.0.1");

      await agenteChama(agente.bearer, "crm_set_automation_rule_active", {
        rule_id: ruleId,
        is_active: true,
      });

      // ---- a tela mostra "Ativa" COM a autoria do assistente ----
      await page.goto(`${APP_URL}/app/webhooks`);
      await page.getByRole("tab", { name: "Automações" }).click();
      const tituloDaRegra = page.getByText(REGRA, { exact: true }).first();
      await expect(tituloDaRegra).toBeVisible({ timeout: 15_000 });
      const cardDaRegra = cardDe(tituloDaRegra);
      await expect(cardDaRegra).toContainText("Ativa", { timeout: 15_000 });
      const seloDaRegra = cardDaRegra.locator('[data-autoria="ai"]').first();
      await expect(seloDaRegra).toBeVisible();
      await expect(seloDaRegra).toContainText(/alterado pelo assistente/i);
      await page.screenshot({
        path: path.join(EVIDENCIA, "w4-regra-ligada-pelo-agente.png"),
        fullPage: true,
      });

      // ---- 3) a regra ligada pelo agente dispara: o egress continua barrado ----
      const fonte = (await agenteChama(agente.bearer, "crm_create_webhook_source", {
        name: FONTE,
        default_pipeline_id: funil.id,
        default_stage_id: criada.etapas[0]!.id,
      })) as { id: string; path_token: string };
      sourceId = fonte.id;

      const entrega = await fetch(`${APP_URL}/api/v1/webhooks/in/${fonte.path_token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Lead W4 ${ts}`, phone: `+5511${String(ts).slice(-9)}` }),
      });
      expect(entrega.ok, `entrada automática recusou o POST: ${await entrega.text()}`).toBe(true);

      await drenar();

      // O receiver REAL é a testemunha. O guard anti-SSRF recusa 127.0.0.1 antes
      // do fetch, então o correto aqui é ZERO — e é isso que prova que a
      // capacidade nova do agente não abriu caminho por fora da proteção.
      expect(
        recebidas,
        "o guard de egress deixou passar um POST para endereço privado",
      ).toEqual([]);

      // E a tentativa TEM que estar registrada: barrar em silêncio seria pior.
      await page.goto(`${APP_URL}/app/webhooks`);
      await page.getByRole("tab", { name: "Atividade" }).click();
      const execucao = page.getByText(REGRA, { exact: true }).first();
      await expect(execucao).toBeVisible({ timeout: 20_000 });
      // A tentativa barrada TEM que aparecer como falha: barrar em silêncio
      // deixaria o dono achando que o outro sistema recebeu.
      await expect(cardDe(execucao)).toContainText(/falhou|parcial/i, { timeout: 20_000 });
      await page.screenshot({
        path: path.join(EVIDENCIA, "w4-egress-barrado-com-registro.png"),
        fullPage: true,
      });
    } finally {
      await new Promise<void>((r) => receiver.close(() => r()));
      // Limpeza pelo caminho do produto — o banco é compartilhado com outras
      // sessões e um rerun tem que encontrar a casa como a deixou.
      if (ruleId) await page.request.delete(`${APP_URL}/api/v1/automation-rules/${ruleId}`);
      if (sourceId) await page.request.delete(`${APP_URL}/api/v1/webhook-sources/${sourceId}`);
      // A etapa sai do quadro pela própria capacidade que o teste entregou —
      // limpar por dentro do banco deixaria a operação de arquivamento sem
      // exercício e o quadro do E2E crescendo uma coluna por rodada.
      if (stageId && funilId) {
        await agenteChama(agente.bearer, "crm_archive_stage", {
          pipeline_id: funilId,
          stage_id: stageId,
          move_leads_to_stage_id: null,
        }).catch((err: unknown) => {
          // Falha aqui não invalida o que já foi provado — mas some em silêncio
          // seria deixar a próxima rodada tropeçar sem saber por quê.
          console.error("[e2e] limpeza da etapa falhou:", err);
        });
      }
    }
  });
});
