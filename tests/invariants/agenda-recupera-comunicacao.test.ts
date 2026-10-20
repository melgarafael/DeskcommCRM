import { INSTRUCAO_ENVIO_AGENDA } from "@/lib/agenda/pedido";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type * as Contexto from "@/lib/agent-engine/agent/contexto-do-atendimento";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/** Handler real/queue/guardrails; provedor e recibo factual são doubles explícitos.
 * Mede ordem de lote paralelo, uma recuperação sem ferramentas de escrita,
 * resposta antes de instruções dependentes e recusa persistente sem laço.
 * O harness oficial fornece o banco; não mede acurácia de modelo ou Google real.
 */

const observacao=vi.hoisted(()=>({ativa:false,revisao:3,estado:'confirmed',cancelamentos:0}));
vi.mock('@/lib/agent-engine/edge/crm/mcp-tools', async()=>{
 const {tool}=await import('ai'); const {z}=await import('zod');
 return {buildMcpTurnTools:async()=>({toolIds:['crm_cancel_appointment'],cleanup:async()=>{},tools:{
  crm_cancel_appointment:tool({description:'Cancelamento fictício',inputSchema:z.object({appointment_id:z.string()}),execute:async()=>{
   observacao.cancelamentos++;observacao.revisao++;observacao.estado='cancelled';
   return {cancelado:true,compromisso:{id:'ee101601-0000-4000-8000-000000000009',revision:observacao.revisao}};
  }}),
 }})};
});

vi.mock('@/lib/agent-engine/agent/contexto-do-atendimento', async (original) => {
 const real = await original<typeof Contexto>();
 return {...real, carregarContextoDoAtendimento: async (db:Parameters<typeof real.carregarContextoDoAtendimento>[0],ids:Parameters<typeof real.carregarContextoDoAtendimento>[1]) => {
  if(observacao.ativa){
   const {rows:[m]}=await db.query<{id:string;body:string;at:string}>(`select m.id,m.body,m.sent_at::text at from messages m join job_queue j on j.organization_id=m.organization_id and j.payload->>'inbound_message_id'=m.id::text where j.organization_id=$1 and j.id=$2`,[ids.tenantId,ids.jobId]);
   if(!m)throw new Error('mensagem canônica da fixture não encontrada');
   return {versao:1 as const,fingerprint:`recibo-${observacao.estado}-${observacao.revisao}`,estadoDoJob:'running',perfil:[],decisoes:[],continuidade:[],cobertura:[],
    pedido:{estado:'present' as const,tipoTurno:'inbound_turn',gatilhoEm:m.at,mensagem:{id:m.id,text:m.body,at:m.at,origem:'client_message'}},
    operacoes:[2,observacao.revisao].map((revision,i)=>({id:`ee101601-0000-4000-8000-00000000000${i===0?'8':'9'}`,origem:'agenda_persistida',sujeito:'contato',em:m.at,estado:'verified' as const,revisao:String(revision),
     dados:{estado:i===0?'cancelled':observacao.estado,revisao_reserva:revision,inicio_local:i===0?'2026-07-29T10:00:00-03:00':'2026-07-29T19:20:00-03:00',
      natureza_cancelamento:i===0||observacao.estado==='cancelled'?'cancelamento_sincronizado_no_google':null,publicacao_google:i===0||observacao.estado==='cancelled'?'removed':'synced',revisao_google_local:revision,revisao_google_publicada:revision,publicacao_pendente:false}}))};
  }
  return ({versao:1,fingerprint:'fixture',estadoDoJob:'running',
  perfil:[],decisoes:[],continuidade:[],cobertura:[],
  operacoes:[{id:'reserva-ficticia',origem:'agenda_persistida',sujeito:'contato',em:'2026-07-28T17:00:00Z',estado:'verified',revisao:'1',
   dados:{estado:'confirmed',inicio_local:'2026-07-29T10:00:00-03:00',natureza_confirmacao:'reserva_publicada_sem_aprovacao_humana_exigida'}}]});
 }};
});

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: process.env.TEST_DB_URL ?? `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "ee101601-0000-4000-8000-000000000001";
const CONTACT = "ee101601-0000-4000-8000-000000000002";
const SESSION = "ee101601-0000-4000-8000-000000000003";
const CONV = "ee101601-0000-4000-8000-000000000004";
// Sessão COM casos humanos ligados (agente publicado `cases_enabled=true`) — os
// cenários de falha medem se o caso abre; a sessão base fica sem agente nenhum.
const SESSION_CASOS = "ee101601-0000-4000-8000-000000000005";
const AGENT_CASOS = "ee101601-0000-4000-8000-000000000006";
const VERSION_CASOS = "ee101601-0000-4000-8000-000000000007";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: string[] = [];

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const texto = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const enviar = (body: string) => ({
  content: [
    { type: "tool-call" as const, toolCallId: `c-${Math.random()}`, toolName: "send_message", input: JSON.stringify({ body }) },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const FECHAMENTO = JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "t" });

type Resposta = ReturnType<typeof texto> | ReturnType<typeof enviar>;

async function turno(
  fake: (options: {prompt: unknown; tools?: Array<{name?: string}>}) => Promise<Resposta>,
  opts: { sessao?: string; conversa?: string; pedido?: string } = {},
): Promise<void> {
  const sessao = opts.sessao ?? SESSION;
  const conversa = opts.conversa ?? CONV;
  if (conversa !== CONV) {
    // Conversa própria de cenário: mesma org/contato, sessão com casos ligados.
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
      [conversa, ORG, CONTACT, sessao],
    );
  }
  const msg = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now(),now())`,
    [msg, ORG, conversa, sessao, CONTACT, opts.pedido ?? "Juan Pérez, barrio Centro, portón verde, a las 12"],
  );
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: conversa,
      contact_id: CONTACT,
      channel_session_id: sessao,
      inbound_message_id: msg,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  // Fixture deste handler: claim APENAS do próprio job; não consome fila alheia no QA reutilizado.
  const {rows:[claimed]} = await pool.query(
    `update job_queue set status='running',locked_by='mudo',locked_at=now(),attempts=attempts+1
      where organization_id=$1 and id=$2 and status='pending' returning *,locked_at::text as claim_acquired_at`,[ORG,job.id]);
  expect(claimed?.id).toBe(job.id);
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(fake as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (input: { body: string }) => {
          enviados.push(input.body);
          return { kind: "sent" as const, idempotencyKey: `k${enviados.length}`, messageId: `m${enviados.length}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
  await handler(claimed!, pool, { workerId: "mudo" });
  await m.queue.completeJob(pool, claimed!.id, "mudo");
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'agenda-recupera-gc110','Turno Mudo','Turno Mudo') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'agenda-recupera-gc110-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  // Sessão COM casos humanos ligados: `cases_enabled` vem false por padrão e a
  // régua `casesEnabled` gateia o openCase do desfecho terminal — sem este
  // agente publicado nenhum cenário de falha abre caso (mesmo fixture do
  // agent-config-cases.test.ts).
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'agenda-recupera-gc110-casos-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION_CASOS, ORG],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt)
     values ($1, $2, 'Agente com casos', 'system') on conflict (id) do nothing`,
    [AGENT_CASOS, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, cases_enabled, tool_ids)
     values ($1, $2, $3, 1, 'system', 'anthropic', 'claude-sonnet-4-6', $4, 'published', true, array['crm_cancel_appointment'])
     on conflict (id) do nothing`,
    [VERSION_CASOS, ORG, AGENT_CASOS, SESSION_CASOS],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [
    VERSION_CASOS,
    AGENT_CASOS,
  ]);
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(async () => {
  enviados = [];
  observacao.ativa=false;observacao.revisao=3;observacao.estado="confirmed";observacao.cancelamentos=0;
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Cliente de teste','+5511900010110')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.end();
});


function provedor(recuperar: boolean) {
 const prompts: string[] = []; const ferramentas: string[][] = []; let agenda = 0; let passosDaRecuperacao = 0;
 const fake = async (options: {prompt: unknown; tools?: Array<{name?:string}>}) => {
  const prompt = JSON.stringify(options.prompt); prompts.push(prompt);
  const tools=(options.tools??[]).map(t=>t.name??'');
  if(tools.includes('send_message')) {
   ferramentas.push(tools);
   if(prompt.includes('A mensagem de agenda foi vetada')) {
    passosDaRecuperacao++;
    return enviar(recuperar && passosDaRecuperacao===1?'Sua sessão está reservada para amanhã às 10h.':'Preencha o formulário.');
   }
   return {...enviar('Sua sessão está reservada para amanhã às 10h.'),content:[
    ...enviar('Sua sessão está reservada para amanhã às 10h.').content,...enviar('Preencha o formulário.').content]};
  }
  if(prompt.includes(INSTRUCAO_ENVIO_AGENDA.split('\n')[0]!)) {
   agenda++;
   return texto(JSON.stringify({agendaCompativel:recuperar && agenda>1}));
  }
  if(prompt.includes('afirmouConclusaoHumana') || prompt.includes('suspectPhrase')) return texto(JSON.stringify({isPromise:false,suspectPhrase:null,
    prometeuRetornoHumano:false,retornoSoDoAssistente:false,afirmouConclusaoHumana:false,repasseConcluidoFiel:false}));
  return texto(FECHAMENTO);
 };
 return {fake,prompts,ferramentas};
}

describe('handler real recupera a comunicação vetada, sem repetir operações',()=>{
 it('lote paralelo: confirmação vetada impede formulário; uma reescrita passa pela cadeia',async()=>{
  const p=provedor(true); await turno(p.fake);
  expect(enviados).toEqual(['Sua sessão está reservada para amanhã às 10h.','Preencha o formulário.']);
  expect(p.ferramentas).toHaveLength(3);
  expect(p.ferramentas.slice(1)).toEqual([['send_message'],['send_message']]);
  expect(p.prompts.some(t=>t.includes('comunicacao_agenda_pendente'))).toBe(true);
 });
 it('veto persistente não envia formulário nem cria laço',async()=>{
  const p=provedor(false); await turno(p.fake);
  expect(enviados).toEqual([]);
  expect(p.ferramentas).toHaveLength(2);
  expect(p.ferramentas[1]).toEqual(['send_message']);
 });
});


describe('handler vincula cancelamento da revisão atual à recuperação',()=>{
 it.each([true,false])('revisão4 após duas alterações; só uma escrita e gates preservados: %s',async aceitar=>{
  observacao.ativa=true;let passos=0;let viuVinculo=false;
  const boa='Sua sessão de29/07 às19h20 foi cancelada.';
  const fake=async(options:{prompt:unknown;tools?:Array<{name?:string}>})=>{
   const prompt=JSON.stringify(options.prompt),tools=(options.tools??[]).map(t=>t.name??'');
   if(tools.includes('send_message')){
    if(prompt.includes('A mensagem de agenda foi vetada')){
     viuVinculo=prompt.includes('resultado_agenda_do_turno')&&prompt.includes('acao_observada')&&prompt.includes('fonte_2');
     expect(tools).toEqual(['send_message']);
     return prompt.includes(boa)?texto(FECHAMENTO):enviar(boa);
    }
    passos++;
    if(passos===1)return {...enviar(''),content:[{type:'tool-call' as const,toolCallId:'cancelar',toolName:'crm_cancel_appointment',input:JSON.stringify({appointment_id:'ee101601-0000-4000-8000-000000000009'})}]};
    return enviar('Sua sessão continua confirmada.');
   }
   if(prompt.includes(INSTRUCAO_ENVIO_AGENDA.split('\n')[0]!))return texto(JSON.stringify({agendaCompativel:aceitar&&prompt.includes(boa)}));
   if(prompt.includes('afirmouConclusaoHumana')||prompt.includes('suspectPhrase'))return texto(JSON.stringify({isPromise:false,suspectPhrase:null,prometeuRetornoHumano:false,retornoSoDoAssistente:false,afirmouConclusaoHumana:false,repasseConcluidoFiel:false}));
   return texto(FECHAMENTO);
  };
  await turno(fake,{sessao:SESSION_CASOS,conversa:aceitar?'ee101601-0000-4000-8000-000000000019':'ee101601-0000-4000-8000-000000000020',pedido:'Cancele minha sessão de29/07 às19h20. Não quero remarcar.'});
  expect(viuVinculo).toBe(true);expect(observacao.cancelamentos).toBe(1);expect(observacao.revisao).toBe(4);
  expect(enviados).toEqual(aceitar?[boa]:[]);
  const casos = await pool.query('select id from agent_cases where organization_id=$1 and conversation_id=$2',
    [ORG, aceitar ? 'ee101601-0000-4000-8000-000000000019' : 'ee101601-0000-4000-8000-000000000020']);
  expect(casos.rows).toHaveLength(aceitar ? 0 : 1);

 });
});
