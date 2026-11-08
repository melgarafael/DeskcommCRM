import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { processarCadencias } from "@/lib/cadencias/worker";
import { POST } from "@/app/api/v1/cadencias/[id]/inscricoes/route";
import { PATCH } from "@/app/api/v1/cadencias/[id]/route";
import { configuracaoPadrao } from "@/lib/cadencias/exemplos";
import { GOV_ORG, GOV_CONTACT_1, GOV_LEAD, GOV_MANAGER, seedGov, sql } from "./gov-helpers";
import { adminEmConexao, ateCondicao, barreira, esperarBarreira, novaConexaoDeCadencias } from "../support/cadencias-pg";

const estado = vi.hoisted(() => ({ admin: null as unknown, receiver: "" }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => estado.admin }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: async () => ({ ok: true, user: { id: "cccccccc-1111-4000-8000-000000000004", idioma: "pt-BR" }, org: { orgId: "cccccccc-0000-4000-8000-000000000001", role: "manager" } }) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, count: 1 }) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://synthetic.test", CADENCIA_LIMITE_EMAILS_POR_DIA: 60 } }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: async (args: { subject: string }) => {
  const res = await fetch(estado.receiver, { method: "POST", body: JSON.stringify({ assunto: args.subject }) });
  if (!res.ok) throw new Error("receiver_sintetico_falhou");
  return { ok: true, via: "smtp" };
} }));
const CAD = "ca173801-0000-4000-8000-000000000001";
const CADB = "ca173801-0000-4000-8000-000000000002";
const INS = "ca173801-0000-4000-8000-000000000003";
const ORG_OFF = "ca173801-0000-4000-8000-000000000004";
const OFF_CAD = "ca173801-0000-4000-8000-000000000005";
const a = novaConexaoDeCadencias(); const b = novaConexaoDeCadencias();
const assuntos: string[] = [];
const receiver = createServer(async (req, res) => { let corpo = ""; for await (const chunk of req) corpo += chunk; assuntos.push((JSON.parse(corpo) as { assunto: string }).assunto); res.end("aceito-sintetico"); });
const config = { ...configuracaoPadrao(), janela: { inicio: "00:00", fim: "23:59", dias: ["seg", "ter", "qua", "qui", "sex", "sab", "dom"] }, fuso: "UTC" };
const passos = [1, 2].map((n) => ({ id: `email-${n}`, tipo: "email", assunto: `Assunto ${n}`, corpo: "Texto sintético", mesmaConversa: false }));
const agora = () => new Date();
async function inserir(origem = INS, cadencia = CAD) { await a.query(`insert into public.email_cadence_enrollments(id,organization_id,cadence_id,lead_id,contact_id,proximo_em,inscrito_por) values($1,$2,$3,$4,$5,'2020-01-01',$6)`, [origem, GOV_ORG, cadencia, GOV_LEAD, GOV_CONTACT_1, GOV_MANAGER]); }
function pedido(corpo: unknown, method = "PATCH") { return new Request("http://synthetic.test/api", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) }) as NextRequest; }
const params = () => ({ params: Promise.resolve({ id: CAD }) });

beforeAll(async () => {
  vi.stubEnv("INTERNAL_SECRET", "segredo-sintetico-da-bancada-de-corridas");
  seedGov(); sql("select public.fn_cadencias_provisionar(); insert into public.modulos_instalados(modulo,estado) values('cadencias','ativo') on conflict(modulo) do update set estado='ativo';");
  await a.connect(); await b.connect();
  expect((await a.query("select pg_backend_pid() id")).rows[0]!.id).not.toBe((await b.query("select pg_backend_pid() id")).rows[0]!.id);
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  estado.receiver = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterAll(async () => { receiver.closeAllConnections(); await new Promise<void>((resolve) => receiver.close(() => resolve())); await a.end(); await b.end(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  assuntos.length = 0;
  await a.query("delete from public.email_cadences");
  await a.query(`update public.organizations set settings='{"cadencias":{"enabled":true}}' where id=$1`, [GOV_ORG]);
  await a.query("update public.contacts set name='Pessoa Sintética',email='pessoa@synthetic.test',is_anonymized=false,is_blocked=false,is_personal=false where id=$1", [GOV_CONTACT_1]);
  await a.query("update public.crm_leads set contact_id=$1,owner_user_id=null,status='open' where id=$2", [GOV_CONTACT_1, GOV_LEAD]);
  for (const id of [CAD, CADB]) await a.query("insert into public.email_cadences(id,organization_id,name,status,configuracao,passos) values($1,$2,'Sequência sintética','ativa',$3,$4)", [id, GOV_ORG, JSON.stringify(config), JSON.stringify(passos)]);
  estado.admin = adminEmConexao(a);
});

describe("corridas reais: duas conexões, worker/handlers reais e receiver HTTP", () => {
  it("snapshot atrasado não repete email1 nem regride o contador", async () => {
    await inserir(); const capturou = barreira(); const liberar = barreira(); let usado = false;
    const adminB = adminEmConexao(b, {
      antes: async (q) => { if (!usado && q.includes('"fn_cadencias_reivindicar"')) { usado = true; capturou.liberar(); await liberar.promessa; } },
      depois: async (q) => { if (!usado && q.startsWith("select") && q.includes('from public."email_cadence_enrollments"') && q.includes('"passo_atual_id"')) { usado = true; capturou.liberar(); await liberar.promessa; } },
    });
    const tick = agora(); let erroB: unknown;
    const rodadaB = processarCadencias(adminB, tick, "b-sintetico").then(() => { if (!usado) erroB = new Error("claim_nao_alcancado"); capturou.liberar(); }).catch((erro) => { erroB = erro; capturou.liberar(); });
    try { await esperarBarreira(capturou); if (erroB) throw erroB; await processarCadencias(adminEmConexao(a), tick, "a-sintetico"); }
    finally { liberar.liberar(); }
    await rodadaB; if (erroB) throw erroB;
    expect(assuntos).toEqual(["Assunto 1", "Assunto 2"]);
    const row = (await a.query("select emails_enviados,status,passo_atual_id from public.email_cadence_enrollments where id=$1", [INS])).rows[0]!;
    expect(row.emails_enviados).toBe(2); expect(row.status).toBe("concluida"); expect(row.passo_atual_id).toBeNull();
  });

  it("claim expirado não autoriza o dono antigo depois de outro worker avançar", async () => {
    await inserir(); const pronto = barreira(); const liberar = barreira(); let usado = false;
    const adminA = adminEmConexao(a, { depois: async (q) => {
      if (!usado && (q.includes('"fn_cadencias_reivindicar"') || (q.startsWith('update public."email_cadence_enrollments"') && q.includes('set "processando_ate" =')))) {
        usado = true; pronto.liberar(); await liberar.promessa;
      }
    } });
    const tick = agora(); let erroA: unknown;
    const rodadaA = processarCadencias(adminA, tick, "a-expirado").then(() => { pronto.liberar(); }).catch((e) => { erroA = e; pronto.liberar(); });
    try { await esperarBarreira(pronto); expect(usado).toBe(true); if (erroA) throw erroA; await processarCadencias(adminEmConexao(b), new Date(tick.getTime() + 4 * 60_000), "b-reivindicou"); }
    finally { liberar.liberar(); }
    await rodadaA; if (erroA) throw erroA;
    expect(assuntos).toEqual(["Assunto 1"]);
    const row = (await a.query("select emails_enviados,passo_atual_id from public.email_cadence_enrollments where id=$1", [INS])).rows[0]!;
    expect(row.emails_enviados).toBe(1); expect(row.passo_atual_id).toBe("email-2");
  });

  it("inscrição atrasada não nasce após descadastro confirmado", async () => {
    await inserir(); const pronto = barreira(); const liberar = barreira(); let usado = false;
    estado.admin = adminEmConexao(b, {
      antes: async (q) => { if (!usado && q.includes('"fn_cadencia_inscrever"')) { usado = true; pronto.liberar(); await liberar.promessa; } },
      depois: async (q, v) => { if (!usado && q.startsWith("select") && q.includes('email_cadence_enrollments') && v.includes("descadastro")) { usado = true; pronto.liberar(); await liberar.promessa; } },
    });
    const resposta = POST(pedido({ lead_id: GOV_LEAD }, "POST"), { params: Promise.resolve({ id: CADB }) }).then((r) => { pronto.liberar(); return r; });
    try { await esperarBarreira(pronto); expect(usado).toBe(true); await a.query("select public.fn_cadencia_descadastrar($1,$2)", [INS, GOV_ORG]); }
    finally { liberar.liberar(); }
    expect((await resposta).status).toBe(409);
    expect(Number((await a.query("select count(*) n from public.email_cadence_enrollments where organization_id=$1 and contact_id=$2 and status='ativa'", [GOV_ORG, GOV_CONTACT_1])).rows[0]!.n)).toBe(0);
  });

  it("RPC de inscrição realmente espera a mesma trava do contato e revalida supressão", async () => {
    await inserir(); const pidA = (await a.query("select pg_backend_pid() id")).rows[0]!.id; const pidB = (await b.query("select pg_backend_pid() id")).rows[0]!.id;
    await a.query("begin"); await a.query("select id from public.contacts where organization_id=$1 and id=$2 for update", [GOV_ORG, GOV_CONTACT_1]);
    const inscricao = b.query("select public.fn_cadencia_inscrever($1,$2,$3,$4,false)", [GOV_ORG, CADB, GOV_LEAD, GOV_MANAGER]).then(() => "inseriu", (e: Error) => e.message);
    try {
      await ateCondicao(async () => (await a.query("select $1::int=any(pg_blocking_pids($2)) bloqueada", [pidA, pidB])).rows[0]!.bloqueada === true, "inscrição não esperou a trava do contato");
      await a.query("select public.fn_cadencia_descadastrar($1,$2)", [INS, GOV_ORG]); await a.query("commit");
    } finally { await a.query("rollback"); }
    expect(await inscricao).toContain("cadencia_descadastrado");
  });

  it("50 linhas de empresa desligada não impedem o trabalho da empresa ativa", async () => {
    await a.query("insert into public.organizations(id,slug,legal_name,display_name,settings) values($1,'cadencias-off','Off sintética','Off','{}') on conflict(id) do nothing", [ORG_OFF]);
    await a.query("insert into public.email_cadences(id,organization_id,name,status,configuracao,passos) values($1,$2,'Off','ativa',$3,$4)", [OFF_CAD, ORG_OFF, JSON.stringify(config), JSON.stringify(passos)]);
    const offContato = "ca173801-0000-4000-8000-000000000006";
    const offPipeline = "ca173801-0000-4000-8000-000000000007";
    const offEtapa = "ca173801-0000-4000-8000-000000000008";
    await a.query("insert into public.contacts(id,organization_id,display_name,email) values($1,$2,'Off sintético','off@synthetic.test') on conflict(id) do nothing", [offContato, ORG_OFF]);
    await a.query("insert into public.crm_pipelines(id,organization_id,name,slug) values($1,$2,'Off sintético','off-sintetico') on conflict(id) do nothing", [offPipeline, ORG_OFF]);
    await a.query("insert into public.crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Off','off',1000) on conflict(id) do nothing", [offEtapa, ORG_OFF, offPipeline]);
    await a.query(`with negocios as (insert into public.crm_leads(organization_id,pipeline_id,stage_id,contact_id,title)
      select $1,$2,$3,$4,'Off sintético '||n from generate_series(1,50) n returning id)
      insert into public.email_cadence_enrollments(organization_id,cadence_id,lead_id,contact_id,proximo_em)
      select $1,$5,id,$4,'2020-01-01' from negocios`, [ORG_OFF, offPipeline, offEtapa, offContato, OFF_CAD]);
    await inserir(); await processarCadencias(adminEmConexao(a), agora(), "ativos-sintetico");
    expect(assuntos).toEqual(["Assunto 1"]);
  });

  it("supressão de outra inscrição também é revalidada no ponto de envio", async () => {
    await inserir();
    await a.query("update public.email_cadence_enrollments set status='parada',motivo_parada='descadastro' where id=$1", [INS]);
    await inserir("ca173801-0000-4000-8000-000000000021", CADB); // simula linha legada antes da correção
    await processarCadencias(adminEmConexao(a), agora(), "supressao-legada");
    expect(assuntos).toEqual([]);
  });

  it("tarefa com variável real não duplica quando falha o avanço após o INSERT", async () => {
    const tarefa = { id: "tarefa-1", tipo: "tarefa", titulo: "Ligar para {{primeiro_nome}}", prazoDias: 1 };
    await a.query("update public.email_cadences set passos=$2 where id=$1", [CAD, JSON.stringify([tarefa, passos[0]])]);
    await inserir(); const totalAntes = Number((await a.query("select count(*) n from public.crm_tasks where organization_id=$1", [GOV_ORG])).rows[0]!.n);
    let falhou = false;
    const admin = adminEmConexao(a, { antes: async (q, valores) => {
      if (!falhou && q.startsWith('update public."email_cadence_enrollments"') && q.includes('"passo_atual_id"') && valores.includes("email-1")) { falhou = true; throw new Error("falha_sintetica_apos_tarefa"); }
    } });
    const tick = agora(); await processarCadencias(admin, tick, "tarefa-primeira");
    expect(falhou).toBe(true);
    await processarCadencias(admin, new Date(tick.getTime() + 10 * 60_000), "tarefa-repetida");
    const totalDepois = Number((await a.query("select count(*) n from public.crm_tasks where organization_id=$1", [GOV_ORG])).rows[0]!.n);
    expect(totalDepois - totalAntes).toBe(1);
    const tarefaCriada = (await a.query("select metadata->>'task_id' id from public.email_cadence_events where enrollment_id=$1 and tipo='tarefa_criada'", [INS])).rows;
    expect(tarefaCriada).toHaveLength(1);
    expect((await a.query("select title from public.crm_tasks where id=$1", [tarefaCriada[0]!.id])).rows[0]!.title).toBe("Ligar para Pessoa");
    expect((await a.query("select passo_atual_id from public.email_cadence_enrollments where id=$1", [INS])).rows[0]!.passo_atual_id).toBe("email-1");
    expect(assuntos).toEqual([]);
  });

  for (const caso of [{ sinal: "2026-10-21T12:05:00Z", contador: 1, lado: "lado-nao" }, { sinal: "2026-10-21T11:55:00Z", contador: 0, lado: "lado-sim" }]) it(`sinal ${caso.sinal} decide pelo instante do evento, não pelo atraso do cron ou contador`, async () => {
    const ramo = { id: "ramo-1", tipo: "ramo", condicao: { tipo: "abriu", vezes: 1, dentroDeDias: 1 }, sim: [{ id: "lado-sim", tipo: "espera", diasUteis: 1 }], nao: [{ id: "lado-nao", tipo: "espera", diasUteis: 1 }] };
    await a.query("update public.email_cadences set passos=$2 where id=$1", [CAD, JSON.stringify([passos[0], ramo])]);
    await inserir();
    await a.query("update public.email_cadence_enrollments set rastreio_consentido=true,passo_atual_id='ramo-1',ultimo_email_em='2026-10-20T12:00:00Z',ultimo_email_passo_id='email-1',aberturas=1,aberturas_ultimo_email=$2 where id=$1", [INS, caso.contador]);
    await a.query("insert into public.email_cadence_events(organization_id,cadence_id,enrollment_id,lead_id,tipo,passo_id,created_at) values($1,$2,$3,$4,'aberto','email-1',$5)", [GOV_ORG, CAD, INS, GOV_LEAD, caso.sinal]);
    await processarCadencias(adminEmConexao(a), new Date("2026-10-21T12:15:00Z"), "cron-atrasado");
    expect((await a.query("select passo_atual_id from public.email_cadence_enrollments where id=$1", [INS])).rows[0]!.passo_atual_id).toBe(caso.lado);
  });

  for (const primeira of ["editar", "ativar"] as const) it(`revisão impede ${primeira} atrasado de gravar depois do outro caminho`, async () => {
    await a.query("update public.email_cadences set status='pausada' where id=$1", [CAD]);
    const pronto = barreira(); const liberar = barreira(); let usado = false;
    estado.admin = adminEmConexao(b, { antes: async (q) => { if (!usado && q.startsWith('update public."email_cadences"')) { usado = true; pronto.liberar(); await liberar.promessa; } } });
    const atrasada = PATCH(pedido(primeira === "editar" ? { passos: [] } : { status: "ativa" }), params()).then((r) => { pronto.liberar(); return r; });
    try { await esperarBarreira(pronto); expect(usado).toBe(true); estado.admin = adminEmConexao(a); const outra = await PATCH(pedido(primeira === "editar" ? { status: "ativa" } : { passos: [] }), params()); expect(outra.status).toBe(200); }
    finally { liberar.liberar(); }
    expect((await atrasada).status).toBe(409);
    const row = (await a.query("select status,passos from public.email_cadences where id=$1", [CAD])).rows[0]!;
    expect(row.status === "ativa" && row.passos.length === 0).toBe(false);
  });
});
