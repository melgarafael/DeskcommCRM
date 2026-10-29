/**
 * MCP real → fila real → revisão no dossiê. O texto extraído é controlado;
 * este teste não mede o modelo lendo PDF. Não há mock de HTTP, DOM ou banco.
 * As decisões humanas são cliques na interface canônica, com usuários reais.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { credenciaisSupabaseDeTeste, destinoEhLocal } from "../../scripts/lib/env-de-teste";
import { vencePropostasDeCampo } from "../../lib/leads/proposta-de-campos-por-documento";
import { pgComoSupabase } from "../pg-como-supabase";
import { test, expect, type Locator, type Page } from "./helpers/test";

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string }>;
}

const arquivo = join(process.cwd(), ".e2e-creds.json");
let creds: Creds;
let bearer: string;
let pipelineId: string;
let stageId: string;
// ReturnType direto da função GENÉRICA perde a inferência da chamada e produz
// tabelas never; esta fábrica conserva o mesmo tipo que createClient devolve.
function clienteDaProva(url: string, chave: string) {
  return createClient(url, chave, { auth: { autoRefreshToken: false, persistSession: false } });
}
let admin: ReturnType<typeof clienteDaProva>;
let pool: pg.Pool;
const campos = [
  { key: "medida", label: "Medida do documento", type: "number" },
  { key: "localizador", label: "Localizador do documento", type: "text" },
];

test.describe.configure({ timeout: 90_000 });

test.beforeAll(async () => {
  const ambiente = credenciaisSupabaseDeTeste();
  // A recusa vem ANTES dos seeds: eles escrevem no destino configurado.
  if (!destinoEhLocal(ambiente.url)) throw new Error("A prova exige Supabase local de teste.");
  if (!ambiente.dbUrl || !destinoEhLocal(ambiente.dbUrl)) throw new Error("A corrida exige Postgres local de teste.");
  if (!existsSync(arquivo)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  creds = JSON.parse(readFileSync(arquivo, "utf8")) as Creds;
  pool = new pg.Pool({ connectionString: ambiente.dbUrl, max: 3 });
  admin = clienteDaProva(ambiente.url, ambiente.serviceRole);
  execFileSync("npx", ["tsx", "scripts/seed-e2e-agente-mcp.ts"], { stdio: "inherit" });
  bearer = (JSON.parse(readFileSync(".e2e-agente-mcp.json", "utf8")) as { bearer: string }).bearer;
  const stamp = Date.now();
  const { data: pipeline, error } = await admin.from("crm_pipelines").insert({
    organization_id: creds.org_id, name: `Propostas documento ${stamp}`,
    slug: `propostas-doc-${stamp}`, settings: { fields: campos },
  }).select("id").single();
  if (error) throw new Error(`Funil da prova: ${error.message}`);
  pipelineId = pipeline!.id as string;
  const { data: stage, error: stageError } = await admin.from("crm_stages").insert({
    organization_id: creds.org_id, pipeline_id: pipelineId,
    name: "Entrada", slug: "entrada", position: 1000,
  }).select("id").single();
  if (stageError) throw new Error(`Etapa da prova: ${stageError.message}`);
  stageId = stage!.id as string;
});

test.afterAll(async () => {
  if (!pipelineId) { await pool?.end(); return; }
  // Somente a fixture desta execução; nunca varre os funis de outros specs.
  await admin.from("crm_leads").delete().eq("organization_id", creds.org_id).eq("pipeline_id", pipelineId);
  await admin.from("crm_stages").delete().eq("organization_id", creds.org_id).eq("pipeline_id", pipelineId);
  await admin.from("crm_pipelines").delete().eq("organization_id", creds.org_id).eq("id", pipelineId);
  await pool.end();
});

async function login(page: Page, role: "manager" | "viewer"): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users[role]!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/);
}

async function cenario(page: Page, valor = "1,234") {
  const titulo = `Documento sintético ${Date.now()} ${Math.random().toString(36).slice(2, 6)}`;
  const { data: lead, error } = await admin.from("crm_leads").insert({
    organization_id: creds.org_id, pipeline_id: pipelineId, stage_id: stageId,
    title: titulo,
    custom_fields: { medida: 0, localizador: "ANTES" },
  }).select("id").single();
  if (error) throw new Error(`Negócio da prova: ${error.message}`);
  const leadId = lead!.id as string;
  const response = await page.request.post("/api/mcp", {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/json, text/event-stream" },
    data: {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "crm_propose_lead_fields_from_document", arguments: {
        lead_id: leadId,
        campos: [
          { campo: "medida", valor, trecho: `Medida no documento sintético: ${valor}` },
          { campo: "localizador", valor: "NOVO123", trecho: "Localizador no documento sintético: NOVO123" },
        ],
      } },
    },
  });
  expect(response.status()).toBe(200);
  const text = await response.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const envelope = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
  expect(envelope.error).toBeUndefined();
  expect(envelope.result.isError).not.toBe(true);
  const result = JSON.parse(envelope.result.content[0].text) as {
    propostas_criadas: { id: string; campo: string; valorProposto: unknown }[];
  };
  expect(result.propostas_criadas).toHaveLength(2);
  const medida = result.propostas_criadas.find((p) => p.campo === "medida")!;
  // A metade direta e a tela observam o MESMO texto cru. O card ainda não mudou.
  expect(medida.valorProposto).toBe(1.234);
  await expect.poll(async () => {
    const { data } = await admin.from("crm_leads").select("custom_fields").eq("id", leadId).single();
    return data?.custom_fields;
  }).toEqual({ medida: 0, localizador: "ANTES" });
  return { leadId, titulo, medidaId: medida.id };
}

async function abrir(page: Page, titulo: string): Promise<Locator> {
  await page.goto(`/app/pipelines/${pipelineId}`);
  const card = page.getByRole("group", { name: `Lead: ${titulo}` });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: titulo, exact: true }).click();
  const dialog = page.getByRole("dialog");
  const secao = dialog.getByRole("button", { name: /Dados do negócio/ });
  if (await secao.getAttribute("aria-expanded") === "false") await secao.click();
  await expect(dialog.locator('[data-peca="revisao-do-documento"]')).toBeVisible();
  return dialog;
}

async function gravado(leadId: string): Promise<unknown> {
  const { data, error } = await admin.from("crm_leads").select("custom_fields")
    .eq("organization_id", creds.org_id).eq("id", leadId).single();
  if (error) throw new Error(error.message);
  return data!.custom_fields;
}

test("manager confere origem, salva o número mostrado e descarta o outro campo", async ({ page }) => {
  await login(page, "manager");
  const c = await cenario(page);
  const dialog = await abrir(page, c.titulo);
  const numero = dialog.locator('[data-proposta="medida"]');
  const campoDoCard = dialog.getByRole("spinbutton", { name: "Medida do documento", exact: true });
  await expect(campoDoCard).toHaveValue("0");
  await expect(numero).toContainText("Medida no documento sintético: 1,234");
  await expect(numero.getByRole("textbox", { name: "Corrigir Medida do documento" })).toHaveValue("1.234");
  await page.screenshot({ path: "evidence/propostas-3476/01-revisao-sintetica.png", fullPage: true });
  await numero.getByRole("button", { name: "Está certo, salvar", exact: true }).click();
  await expect(numero).toHaveCount(0);
  await expect.poll(() => gravado(c.leadId)).toEqual({ medida: 1.234, localizador: "ANTES" });
  // Não basta o banco mudar: o campo que o atendente vê precisa acompanhar.
  await expect(campoDoCard).toHaveValue("1.234");
  await dialog.locator('[data-proposta="localizador"]').getByRole("button", { name: "Descartar", exact: true }).click();
  await expect(dialog.locator('[data-peca="revisao-do-documento"]')).toHaveCount(0);
  await expect.poll(() => gravado(c.leadId)).toEqual({ medida: 1.234, localizador: "ANTES" });
  await campoDoCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "evidence/propostas-3476/02-decidida-sintetica.png", fullPage: true });
});

test("correção digitada é confirmada pelo formulário real", async ({ page }) => {
  await login(page, "manager");
  const c = await cenario(page);
  const dialog = await abrir(page, c.titulo);
  const numero = dialog.locator('[data-proposta="medida"]');
  await numero.getByRole("textbox", { name: "Corrigir Medida do documento" }).fill("9,876");
  await numero.getByRole("button", { name: "Está certo, salvar", exact: true }).click();
  await expect.poll(() => gravado(c.leadId)).toEqual({ medida: 9.876, localizador: "ANTES" });
});

test("viewer lê a proposta, sem ação na tela nem autorização para decidir", async ({ page }) => {
  await login(page, "viewer");
  const c = await cenario(page);
  const dialog = await abrir(page, c.titulo);
  const revisao = dialog.locator('[data-peca="revisao-do-documento"]');
  await expect(revisao).toContainText("NOVO123");
  await expect(revisao.getByRole("button", { name: "Está certo, salvar", exact: true })).toHaveCount(0);
  const r = await page.request.post(`/api/v1/leads/${c.leadId}/field-proposals/${c.medidaId}`, {
    data: { decision: "accept" },
  });
  expect(r.status()).toBe(403);
  await expect.poll(() => gravado(c.leadId)).toEqual({ medida: 0, localizador: "ANTES" });
  await page.screenshot({ path: "evidence/propostas-3476/03-leitura-sintetica.png", fullPage: true });
});

test("revisão antiga recebe 409 após outra pessoa decidir e preserva o card", async ({ page }) => {
  await login(page, "manager");
  const c = await cenario(page);
  const dialog = await abrir(page, c.titulo);
  // Outra sessão da operação decide depois da carga da tela. O pedido usa a
  // rota real; a primeira página continua com a revisão antiga à vista.
  const r = await page.request.post(`/api/v1/leads/${c.leadId}/field-proposals/${c.medidaId}`, {
    data: { decision: "dismiss" },
  });
  expect(r.status()).toBe(200);
  await dialog.locator('[data-proposta="medida"]').getByRole("button", { name: "Está certo, salvar", exact: true }).click();
  await expect(dialog).toContainText("Esta sugestão já foi decidida.");
  await expect.poll(() => gravado(c.leadId)).toEqual({ medida: 0, localizador: "ANTES" });
});

async function aguardarPedidosBloqueados(quantidade: number, trava: pg.PoolClient): Promise<void> {
  const { rows: conexao } = await trava.query<{ pid: number }>("select pg_backend_pid() as pid");
  const pid = conexao[0]!.pid;
  await expect.poll(async () => {
    // Inclui quem espera pelo dono da linha e quem espera atrás dele na fila;
    // uma sessão alheia bloqueada noutra proposta não antecipa a liberação.
    const { rows } = await pool.query<{ total: string }>(`with recursive bloqueados(pid) as (
      select a.pid from pg_stat_activity a where $1=any(pg_blocking_pids(a.pid))
      union
      select a.pid from pg_stat_activity a
        join bloqueados b on b.pid=any(pg_blocking_pids(a.pid))
    )
    select count(*)::text as total from pg_stat_activity a
      join bloqueados b on b.pid=a.pid
      where a.wait_event_type='Lock' and a.query ilike '%lead_field_proposals%'`, [pid]);
    return Number(rows[0]!.total);
  }, { timeout: 20_000 }).toBeGreaterThanOrEqual(quantidade);
}

test("duas decisões que leram pending disputam a mesma linha: só uma grava", async ({ page }) => {
  await login(page, "manager");
  const c = await cenario(page);
  const trava = await pool.connect();
  let respostas: Promise<Awaited<ReturnType<typeof page.request.post>>[]> | undefined;
  try {
    await trava.query("begin");
    await trava.query("select id from public.lead_field_proposals where id=$1 for update", [c.medidaId]);
    respostas = Promise.all(["accept", "dismiss"].map((decision) =>
      page.request.post(`/api/v1/leads/${c.leadId}/field-proposals/${c.medidaId}`, { data: { decision } })));
    // Os dois pedidos já leram pending e chegaram ao UPDATE antes da liberação.
    // Remover o predicado pending faria ambos vencerem, mesmo com essa trava.
    await aguardarPedidosBloqueados(2, trava);
    await trava.query("commit");
    const recebidas = await respostas;
    expect(recebidas.map((r) => r.status()).sort()).toEqual([200, 409]);
    const { data } = await admin.from("lead_field_proposals").select("status").eq("id", c.medidaId).single();
    expect(await gravado(c.leadId)).toEqual({
      medida: data!.status === "accepted" ? 1.234 : 0, localizador: "ANTES",
    });
  } finally {
    await trava.query("rollback");
    trava.release();
    await respostas?.catch(() => undefined);
  }
});

test("expiração vence entre a leitura e a gravação da confirmação", async ({ page }) => {
  await login(page, "manager");
  const c = await cenario(page);
  const trava = await pool.connect();
  let resposta: ReturnType<typeof page.request.post> | undefined;
  try {
    await trava.query("begin");
    // Só o relógio da fixture muda. A leitura HTTP ainda enxerga a versão
    // anterior, viva, enquanto a varredura real encerra a sua versão na transação.
    await trava.query(`update public.lead_field_proposals set
      proposed_at=now()-interval '8 days', expires_at=now()-interval '1 day' where id=$1`, [c.medidaId]);
    const transporte = pgComoSupabase({ query: trava.query.bind(trava) } as pg.Pool);
    expect((await vencePropostasDeCampo(transporte, creds.org_id, new Date())).vencidas).toBe(1);
    resposta = page.request.post(`/api/v1/leads/${c.leadId}/field-proposals/${c.medidaId}`, {
      data: { decision: "accept" },
    });
    await aguardarPedidosBloqueados(1, trava);
    await trava.query("commit");
    expect((await resposta).status()).toBe(409);
    expect(await gravado(c.leadId)).toEqual({ medida: 0, localizador: "ANTES" });
    const { data } = await admin.from("lead_field_proposals").select("status").eq("id", c.medidaId).single();
    expect(data!.status).toBe("expired");
  } finally {
    await trava.query("rollback");
    trava.release();
    await resposta?.catch(() => undefined);
  }
});
