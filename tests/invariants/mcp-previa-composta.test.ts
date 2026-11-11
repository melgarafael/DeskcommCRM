/**
 * #3564: motor INPROCESS real → pick → wrappers do inbound → policy → SDK MCP
 * e socket HTTP reais. Só o fornecedor e o provider do modelo são sintéticos.
 * O adaptador pgComoSupabase usa PG real, sem PostgREST/Auth/RLS/rota HTTP/UI.
 * Não executar fora do harness de banco reservado pelo mantenedor.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.hoisted(() => { process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY="; });

import { createAdminClient } from "@/lib/supabase/admin";
import { pgComoSupabase } from "../pg-como-supabase";
import { GOV_AGENT_A, seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { abrirMcpDaPrevia } from "../support/mcp-previa-http";
import * as carga from "@/lib/mcp/servidor-externo/carregar";
import * as ponte from "@/lib/ai/runtime/tools";
import * as politica from "@/lib/agent-engine/agent/preview";
import { ehLeituraRemota } from "@/lib/mcp/servidor-externo/leitura-remota";
import { cifrarChaveMcpExterno } from "@/lib/mcp/servidor-externo/segredo";
import { toolIdRemoto } from "@/lib/mcp/servidor-externo/ids";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { runAgentPreview, type InboundTurnDeps } from "@/lib/agent-engine/agent/inbound-turn";
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { loadEnv } from "@/lib/agent-engine/env";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";
import { createLogger } from "@/lib/agent-engine/obs/logger";

const url = `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`;
const limites = { connectionString: url, max: 2, connectionTimeoutMillis: 5_000,
  query_timeout: 10_000, statement_timeout: 10_000, lock_timeout: 3_000 };
const pool = new pg.Pool(limites);
// PostgREST representa bytea por \\xHEX. Só o pool do instrumento mantém esse
// formato; o pool do motor continua com o parser normal (Buffer).
const poolDoAdapter = new pg.Pool({ ...limites, max: 1, types: {
  getTypeParser: (oid, formato) => oid === 17 ? (valor: string) => valor : pg.types.getTypeParser(oid, formato),
} });
const base = pgComoSupabase(poolDoAdapter);
const admin = { ...base, from(tabela: string) {
  const builder = base.from(tabela);
  if (tabela !== "api_tokens") return builder;
  const insert = builder.insert.bind(builder);
  // Segunda tradução, estreita: scopes é jsonb, não text[]. O pg precisa do
  // JSON que o SDK/PostgREST serializaria. Nenhum token/resultado é fabricado.
  builder.insert = ((valor: Record<string, unknown>) => insert({ ...valor,
    ...(Array.isArray(valor.scopes) ? { scopes: JSON.stringify(valor.scopes) } : {}),
  })) as typeof builder.insert;
  return builder;
} } as SupabaseClient;

const NOME = "consulta_sintetica";
const orgs: string[] = [];
let fornecedor: Awaited<ReturnType<typeof abrirMcpDaPrevia>> | undefined;
let copiando = false;
let contatoMontado: string | undefined;
let nomeDoCaso = NOME;
let picked: ReturnType<typeof ponte.pickToolsFromMcp> = {};
let recebido: Parameters<typeof politica.applyPreviewPolicy>[0] = {};
let ultimaPrevia: politica.TurnPreview | undefined;
const pickReal = ponte.pickToolsFromMcp;
const policyReal = politica.applyPreviewPolicy;
const carregarReal = carga.carregarServidorMcpExternoDoTurno;

beforeAll(async () => {
  seedGov();
  vi.mocked(createAdminClient).mockReturnValue(admin as ReturnType<typeof createAdminClient>);
  await pool.query(`with v as(insert into playbook_versions(organization_id,layer,content)
    select null,'platform','## Identidade: Assistente sintético.'
    where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id)
    insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`);
  // A decoração só injeta o transporte na junta EXISTENTE. A carga, cifra,
  // organização/contato e descoberta usam as implementações reais.
  vi.spyOn(carga, "carregarServidorMcpExternoDoTurno").mockImplementation(async (db, org, ids, opcoes) => {
    const montado = await carregarReal(db, org, ids, { ...opcoes, fetch: fornecedor!.fetch });
    return montado ? { ...montado, fetch: fornecedor!.fetch,
      ...(contatoMontado ? { contato: contatoMontado } : {}) } : null;
  });
  vi.spyOn(ponte, "pickToolsFromMcp").mockImplementation((entrada) => {
    picked = pickReal(entrada); return picked;
  });
  vi.spyOn(politica, "applyPreviewPolicy").mockImplementation((tools, p, ...resto) => {
    recebido = tools; ultimaPrevia = p;
    // Sabotagem do instrumento: cópia perde a marca ANTES da política real.
    const entrada = { ...tools };
    if (copiando && tools[nomeDoCaso]) entrada[nomeDoCaso] = Object.assign({}, tools[nomeDoCaso]);
    return policyReal(entrada, p, ...resto);
  });
});
beforeEach(() => {
  copiando = false; contatoMontado = undefined; picked = {}; recebido = {};
  ultimaPrevia = undefined; nomeDoCaso = NOME;
});
afterAll(async () => {
  try {
    if (fornecedor) await fornecedor.fechar();
    if (orgs.length) await pool.query("delete from organizations where id=any($1::uuid[])", [orgs]);
  } finally { vi.restoreAllMocks(); await Promise.all([pool.end(), poolDoAdapter.end()]); }
});

function dependencias(): InboundTurnDeps {
  const knobs = turnKnobsFromEnv(loadEnv({ NODE_ENV: "test", SUPABASE_DB_URL: url,
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "fixture-pg-sem-postgrest" }));
  delete knobs.stageClassifier; delete knobs.jailbreak; delete knobs.promiseSemantic;
  return { crmCfg: { supabase: admin }, llmCfg: { anthropicApiKey: "provider-sintetico" }, knobs,
    log: createLogger(), clock: () => new Date("2026-09-07T15:00:00Z"),
    embed: async () => ({ embedding: Array(1536).fill(0.1), promptTokens: 0, model: "text-embedding-3-small" }),
    registry: createFakeRegistry(async (opcoes) => {
      const results = opcoes.prompt.filter((m) => m.role === "tool").flatMap((m) => m.content);
      const resultado = results.find((r) => "toolName" in r && r.toolName === nomeDoCaso);
      const enviou = results.some((r) => "toolName" in r && r.toolName === "send_message");
      const tem = opcoes.tools?.some((t) => t.type === "function" && t.name === nomeDoCaso);
      const conteudo = !opcoes.tools?.length
        ? [{ type: "text" as const, text: JSON.stringify({ rolling_summary: "Fechamento sintético", commitments: [], objections: [], next_action: null }) }]
        : tem && !resultado
          ? [{ type: "tool-call" as const, toolCallId: randomUUID(), toolName: nomeDoCaso, input: JSON.stringify({ consulta: "controle sintético" }) }]
          : resultado && JSON.stringify(resultado).includes("O catálogo sintético está disponível.") && !enviou
            ? [{ type: "tool-call" as const, toolCallId: randomUUID(), toolName: "send_message",
                input: JSON.stringify({ body: "O catálogo sintético está disponível." }) }]
            : [{ type: "text" as const, text: "Concluído sem consulta adicional." }];
      return { content: conteudo,
        finishReason: { unified: conteudo[0]?.type === "tool-call" ? "tool-calls" : "stop", raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    }) };
}
async function estadoDoCliente(org: string) {
  return (await pool.query(`select jsonb_build_object(
    'outbounds',(select count(*) from messages where organization_id=$1 and direction='outbound'),
    'notas',(select count(*) from lead_notes where organization_id=$1),
    'ledger',(select count(*) from send_ledger where organization_id=$1),
    'jobs',(select count(*) from job_queue where organization_id=$1),
    'contato',(select jsonb_agg(to_jsonb(c)) from contacts c where organization_id=$1),
    'conversa',(select jsonb_agg(to_jsonb(c)) from conversations c where organization_id=$1)) estado`, [org])).rows[0].estado;
}
async function executar(kind: politica.TurnPreview["kind"], opcoes: {
  hint?: boolean; adminLeitura?: boolean; semEscolha?: boolean; semAtendimento?: boolean;
  nome?: string; outraIdentidade?: boolean; recusar?: boolean;
} = {}) {
  if (fornecedor) await fornecedor.fechar();
  nomeDoCaso = opcoes.nome ?? NOME;
  fornecedor = await abrirMcpDaPrevia([{ name: nomeDoCaso, leitura: "hint" in opcoes ? opcoes.hint : true }]);
  if (opcoes.recusar) fornecedor.recusar();
  const f = await replyFixture(pool); orgs.push(f.org);
  const cifrada = cifrarChaveMcpExterno(fornecedor.chave);
  await pool.query(`update organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{mcp_externo}',jsonb_build_object('endpoint',$2::text)),
    mcp_externo_chave_encrypted=$3::bytea,mcp_externo_chave_iv=$4::bytea,mcp_externo_chave_tag=$5::bytea
    where id=$1`, [f.org, fornecedor.endpoint, cifrada.mcp_externo_chave_encrypted,
    cifrada.mcp_externo_chave_iv, cifrada.mcp_externo_chave_tag]);
  // Medir o instrumento antes da carga real: mesmos bytes, formatos distintos.
  const raw = (await pool.query("select mcp_externo_chave_encrypted b from organizations where id=$1", [f.org])).rows[0].b as Buffer;
  const wire = (await poolDoAdapter.query("select mcp_externo_chave_encrypted b from organizations where id=$1", [f.org])).rows[0].b as string;
  expect(Buffer.isBuffer(raw)).toBe(true);
  expect(Buffer.from(wire.slice(2), "hex").equals(raw)).toBe(true);
  const agent = (await loadAgentVersionConfig(pool, f.org, f.agent, f.version))!;
  agent.toolIds = opcoes.semEscolha ? [] : [toolIdRemoto(nomeDoCaso, opcoes.adminLeitura === false ? "escrita" : "leitura")];
  agent.mcpExternoNoAtendimento = !opcoes.semAtendimento;
  agent.versionCreatedBy = GOV_AGENT_A;
  if (opcoes.outraIdentidade) contatoMontado = randomUUID();
  if (kind === "assisted") {
    await pool.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,sent_at)
      values($1,$2,$3,$4,'inbound','text','received','Consulte o catálogo sintético.','2026-09-07T14:00:00Z')`, [f.org,f.contact,f.conversation,f.channel]);
  }
  const antes = await estadoDoCliente(f.org);
  if (kind === "sandbox") {
    await runAgentPreview(dependencias(), pool, { kind, organizationId: f.org, runId: randomUUID(), agent,
      context: politica.scenarioContext([{ direction: "inbound", body: "Consulte o catálogo sintético.", sent_at: "2026-09-07T14:00:00Z" }]),
      contactId: null, channelId: f.channel, result: politica.newPreviewResult() });
  } else {
    await generateReplyDraft(pool, dependencias(), { organizationId: f.org, contactId: f.contact,
      conversationId: f.conversation, channelId: f.channel, boundary: f.boundary, agent });
  }
  expect(ultimaPrevia, "o motor real precisa ter alcançado a policy").toBeDefined();
  expect(await estadoDoCliente(f.org)).toEqual(antes);
  return { f, preview: ultimaPrevia!, chamadas: fornecedor.chamadas };
}

describe("MCP na prévia — composição inprocess com PG real", () => {
  it.each(["sandbox", "assisted"] as const)("%s mantém identidade do objeto até a policy e recebe saída real do socket", async (kind) => {
    const { f, preview, chamadas } = await executar(kind);
    expect(recebido[NOME]).toBe(picked[NOME]);
    expect(ehLeituraRemota(recebido[NOME])).toBe(true);
    expect(preview.result.impediments.some((i) => i.code === "unknown_preview_tool")).toBe(false);
    expect(preview.result.candidates.some((c) => c.body.includes("O catálogo sintético está disponível."))).toBe(true);
    const calls = chamadas.filter((c) => c.metodo === "tools/call");
    expect(calls).toHaveLength(1);
    expect(chamadas.every((c) => c.autenticada)).toBe(true);
    expect(calls[0]?.contato).toBe(kind === "assisted" ? f.contact : undefined);
    const tokens = await pool.query("select scopes,revoked_at from api_tokens where organization_id=$1", [f.org]);
    expect(tokens.rows.length).toBeGreaterThan(0);
    expect(tokens.rows.every((r) => Array.isArray(r.scopes) && r.scopes.includes("mcp:read") && !r.scopes.includes("mcp:write"))).toBe(true);
    expect(tokens.rows.every((r) => r.revoked_at !== null)).toBe(true);
    await expect.poll(async () => Number((await pool.query(`select count(*) n from api_audit_log
      where organization_id=$1 and action='mcp.tool_called' and metadata->>'tool_name'=$2
      and metadata->>'success'='true'`, [f.org, NOME])).rows[0].n), { timeout: 2_000, interval: 20 }).toBe(1);
  });
  it.each([{ hint: undefined, adminLeitura: true }, { hint: false, adminLeitura: true }, { hint: true, adminLeitura: false }])(
    "hint=$hint/admin=$adminLeitura fica fechado até o fornecedor", async (opcoes) => {
      const { preview, chamadas } = await executar("sandbox", opcoes);
      expect(preview.result.impediments).toContainEqual({ code: "unknown_preview_tool", message: NOME });
      expect(chamadas.filter((c) => c.metodo === "tools/call")).toEqual([]);
    },
  );
  it("clone deliberado antes da policy não ganha autoridade pelo nome", async () => {
    copiando = true;
    const { preview, chamadas } = await executar("sandbox");
    expect(ehLeituraRemota(picked[NOME])).toBe(true);
    expect(preview.result.impediments).toContainEqual({ code: "unknown_preview_tool", message: NOME });
    expect(chamadas.filter((c) => c.metodo === "tools/call")).toEqual([]);
  });
  it("nome nativo do inbound vence o objeto remoto marcado", async () => {
    const { chamadas } = await executar("sandbox", { nome: "get_lead_context" });
    expect(ehLeituraRemota(picked.get_lead_context)).toBe(true);
    expect(recebido.get_lead_context).not.toBe(picked.get_lead_context);
    expect(ehLeituraRemota(recebido.get_lead_context)).toBe(false);
    expect(chamadas.filter((c) => c.metodo === "tools/call")).toEqual([]);
  });
  it.each([{ semEscolha: true }, { semAtendimento: true }])("sem escolha/opção não abre descoberta no atendimento: %j", async (opcoes) => {
    const { chamadas } = await executar("assisted", opcoes);
    expect(chamadas).toEqual([]);
  });
  it("identidade montada divergente não oferece consulta ao atendimento", async () => {
    const { chamadas } = await executar("assisted", { outraIdentidade: true });
    expect(picked[NOME]).toBeUndefined();
    expect(chamadas.filter((c) => c.metodo === "tools/call")).toEqual([]);
  });
  it("carregador real recusa contato da outra organização antes de abrir o socket", async () => {
    const { f } = await executar("sandbox");
    const outra = await replyFixture(pool); orgs.push(outra.org);
    fornecedor!.chamadas.splice(0);
    const resultado = await carregarReal(admin, f.org, [toolIdRemoto(NOME, "leitura")], {
      contatoDoTurno: outra.contact, noAtendimento: true, fetch: fornecedor!.fetch,
    });
    expect(resultado).toBeNull();
    expect(fornecedor!.chamadas).toEqual([]);
  });
  it("recusa do MCP não vira candidato de consulta bem-sucedida", async () => {
    const { preview, chamadas } = await executar("sandbox", { recusar: true });
    expect(chamadas.filter((c) => c.metodo === "tools/call")).toHaveLength(1);
    expect(preview.result.candidates).toEqual([]);
  });
});
