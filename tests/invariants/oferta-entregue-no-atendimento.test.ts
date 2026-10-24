import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mensagemDoAtendimentoSql } from '@/lib/atendimento/historico-mensagens';
import { getLeadContext } from '@/lib/agent-engine/edge/crm/get-lead-context';
import { readCurrentServiceBoundary } from '@/lib/atendimento/fronteira-server';
import { criarRevisorDePedidoDeAgenda } from '@/lib/agent-engine/guardrails/promise/agenda-pedido';
import type { CrmEdgeConfig } from '@/lib/agent-engine/edge/crm/mcp-client';
import type { LlmEdgeConfig } from '@/lib/agent-engine/edge/llm/run-model-call';

const provider = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent-engine/guardrails/promise/semantic', () => ({ classifyPromise: provider }));
if (!process.env.TEST_DB_CONTAINER) throw new Error('rode via pnpm test:db');
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 2 });
const org = randomUUID(), other = randomUUID(), contact = randomUUID(), conv = randomUUID(), session = randomUUID();
const offer = randomUUID(), choice = randomUUID(), sendJob = randomUUID(), requestJob = randomUUID();
const started = '2026-10-19T09:00:00Z', sent = '2026-10-19T10:00:00Z';
beforeAll(async () => {
  for (const id of [org, other]) await pool.query(`insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::uuid::text,'Fixture','Fixture','America/Sao_Paulo')`, [id]);
  await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Fixture','+5511999990321')`, [contact, org]);
  await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::uuid::text,'WORKING',$3)`, [session, org, Buffer.from([0])]);
  await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group,service_started_at) values($1,$2,$3,$4,'ai_handling',false,$5)`, [conv, org, contact, session, started]);
  const boundary = await readCurrentServiceBoundary(pool, org, conv);
  await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,sent_via) values($1,$2,$3,$4,$5,'text','outbound','read','Consultei a modalidade para amanhã: 14h e 20h. Qual prefere?',$6,'ai')`, [offer, org, conv, session, contact, sent]);
  await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,service_revision,demanda_id) values($1,$2,$3,$4,$5,'text','inbound','received','14','2026-10-19T10:01:00Z',$6,$7)`, [choice, org, conv, session, contact, boundary!.service_revision, boundary!.demanda_id]);
  // A origem deve existir antes do job: o trigger nativo deriva a fronteira dela.
  for (const id of [sendJob, requestJob]) await pool.query(`insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'inbound_turn','pending',$4)`, [id, org, contact, { conversation_id: conv, inbound_message_id: choice, service_boundary: boundary }]);
  await pool.query(`insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,1,'fixture','accepted',$4)`, [org, contact, sendJob, offer]);
});
afterAll(() => pool.end());
async function scoped(db: pg.PoolClient) {
  return (await db.query(`select m.id from messages m join conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id where m.organization_id=$1 and m.contact_id=$2 and m.conversation_id=$3 and ${mensagemDoAtendimentoSql('m')} order by m.sent_at,m.id`, [org, contact, conv])).rows.map((r: { id: string }) => r.id);
}
async function transaction(run: (db: pg.PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try { await db.query('begin'); await run(db); } finally { await db.query('rollback'); db.release(); }
}
describe('oferta entregue e escolha curta permanecem no mesmo atendimento', () => {
  it('carimba saídas de agente, operador e caminho alternativo na origem, sem metadata como autoridade', async () => transaction(async db => {
    for (const via of ['agent', 'operator', 'echo']) {
      const id = randomUUID();
      const r = await db.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,metadata) values($1,$2,$3,$4,$5,'text','outbound','sent',$6,$7,$8) returning service_revision,demanda_id,demanda_revision`, [id, org, conv, session, contact, via, sent, { service_revision: 999, demanda_id: randomUUID() }]);
      const boundary = await readCurrentServiceBoundary(db, org, conv);
      expect(Number(r.rows[0].service_revision)).toBe(boundary!.service_revision);
      expect(r.rows[0].demanda_id).toBe(boundary!.demanda_id);
      expect(r.rows[0].demanda_revision === null ? null : Number(r.rows[0].demanda_revision)).toBe(boundary!.demanda_revision);
    }
  }));
  it('recusa fronteira explícita ultrapassada antes de inserir', async () => transaction(async db => {
    await expect(db.query(`insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,service_revision) values($1,$2,$3,$4,'text','outbound','sent','Não enviar',$5,999)`, [org, conv, session, contact, sent])).rejects.toMatchObject({ code: 'PT409' });
  }));
  it('não atribui saída anterior à abertura atual nem grupo', async () => transaction(async db => {
    const prior = randomUUID();
    await db.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at) values($1,$2,$3,$4,$5,'text','outbound','read','Antiga','2026-10-18T10:00:00Z')`, [prior, org, conv, session, contact]);
    expect((await db.query('select service_revision from messages where id=$1', [prior])).rows[0].service_revision).toBeNull();
    expect(await scoped(db)).not.toContain(prior);
    await db.query('update conversations set is_group=true where id=$1', [conv]);
    expect(await scoped(db)).toEqual([]);
  }));
  it('lê legado sem regravar registro apenas com recibo accepted e job da fronteira atual', async () => transaction(async db => {
    await db.query('update messages set service_revision=null,demanda_id=null,demanda_revision=null where id=$1', [offer]);
    expect(await scoped(db)).toEqual([offer, choice]);
    const context = await getLeadContext(db, {} as CrmEdgeConfig, { tenantId: org, leadId: contact, conversationId: conv, fuso: 'America/Sao_Paulo' }, { historyLimit: 20, maxTokens: 5000 });
    expect(context.ok).toBe(true);
    if (!context.ok) throw new Error(context.error.code);
    expect(context.context.messages.map(m => m.id)).toEqual([offer, choice]);
    expect(context.context.messages.map(m => m.direction)).toEqual(['outbound', 'inbound']);
    expect(context.context.messages.map(m => m.author)).toEqual(['agent', 'client']);
    expect((await db.query('select service_revision from messages where id=$1', [offer])).rows[0].service_revision).toBeNull();
    provider.mockReset().mockResolvedValue({ agendaCompativel: true });
    const review = criarRevisorDePedidoDeAgenda({ pool: db as unknown as pg.Pool, cfg: {} as LlmEdgeConfig, tenantId: org, leadId: contact, conversationId: conv, jobId: requestJob, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    expect(await review({ acao: 'criar', servico: 'Modalidade', inicio: '2026-10-20T17:00:00Z', fuso: 'America/Sao_Paulo', dia: '2026-10-20', horario: '14:00', quando: '20/10 às14h', beneficiarios: ['contato_atendido'] })).toBe(true);
    const packet = provider.mock.calls[0]![3];
    expect(packet.candidate).toBe('');
    expect(packet.serviceContext.pedido.mensagem.text).toBe('14');
    expect(JSON.stringify(packet.conversationContext)).toContain('Consultei a modalidade');
    expect(JSON.stringify(packet.conversationContext)).toContain('14');
    expect(packet.conversationContext.mensagens[0].autoria).toBe('agent');
  }));
  it('a conversa fornecida não traz mensagens de outro contato da mesma empresa', async () => transaction(async db => {
    const another = randomUUID();
    await db.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Outro','+5511999990322')`, [another, org]);
    const context = await getLeadContext(db, {} as CrmEdgeConfig, { tenantId: org, leadId: another, conversationId: conv, fuso: 'America/Sao_Paulo' }, { historyLimit: 20, maxTokens: 5000 });
    expect(context.ok).toBe(true);
    if (!context.ok) throw new Error(context.error.code);
    expect(context.context.messages).toEqual([]);
  }));
  it('saída nova preserva também a demanda atual aberta pelo caminho nativo', async () => transaction(async db => {
    await db.query('update messages set service_revision=null where id=$1', [choice]);
    await db.query('select fn_service_inbound($1)', [choice]);
    const boundary = await readCurrentServiceBoundary(db, org, conv);
    expect(boundary!.demanda_id).not.toBeNull();
    const r = await db.query(`insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at) values($1,$2,$3,$4,'text','outbound','sent','Nova oferta',$5) returning service_revision,demanda_id,demanda_revision`, [org, conv, session, contact, '2026-10-19T10:02:00Z']);
    expect(r.rows[0].demanda_id).toBe(boundary!.demanda_id);
    expect(Number(r.rows[0].demanda_revision)).toBe(boundary!.demanda_revision);
    expect(Number(r.rows[0].service_revision)).toBe(boundary!.service_revision);
  }));
  it.each(['failed', 'queued', 'requested', 'vetoed'])('não usa legado com recibo %s', async status => transaction(async db => {
    await db.query('update messages set service_revision=null where id=$1', [offer]);
    await db.query('update send_ledger set status=$1 where job_id=$2', [status, sendJob]);
    expect(await scoped(db)).toEqual([choice]);
  }));
  it('não aceita legado de outro atendimento/revisão, conversa, contato ou organização', async () => transaction(async db => {
    await db.query('update messages set service_revision=null where id=$1', [offer]);
    for (const [key, value] of [['service_revision', 2], ['conversation_id', randomUUID()], ['contact_id', randomUUID()], ['organization_id', other], ['demanda_id', randomUUID()]]) {
      await db.query(`update job_queue set payload=jsonb_set(payload,array['service_boundary',$1],to_jsonb($2::text)) where id=$3`, [key, value, sendJob]);
      expect(await scoped(db)).toEqual([choice]);
      const b = await readCurrentServiceBoundary(db, org, conv);
      await db.query(`update job_queue set payload=jsonb_set(payload,'{service_boundary}',$1::jsonb) where id=$2`, [JSON.stringify(b), sendJob]);
    }
    await db.query('update conversations set service_revision=service_revision+1 where id=$1', [conv]);
    expect(await scoped(db)).toEqual([]);
  }));
  it('mesmo carimbada, saída recusada/pendente não vira oferta entregue', async () => transaction(async db => {
    for (const status of ['failed', 'queued']) {
      await db.query('update messages set status=$1 where id=$2', [status, offer]);
      expect(await scoped(db)).toEqual([choice]);
    }
  }));
});
