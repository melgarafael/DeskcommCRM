import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createCaseReplyTurnHandler } from '@/lib/agent-engine/agent/case-reply-turn';
import { createFakeRegistry } from '@/lib/agent-engine/edge/llm/providers';
import { createLogger } from '@/lib/agent-engine/obs/logger';
import { claimJobs, completeJob, enqueueJob } from '@/lib/agent-engine/queue/queue';
import { ligarEventoAoJob } from '@/lib/agent-engine/agent/contexto-de-decisao-humana';
import { readCurrentServiceBoundary } from '@/lib/atendimento/fronteira-server';

if (!process.env.TEST_DB_CONTAINER) throw new Error('rode via pnpm test:db');
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 4 });
const org = randomUUID(), actor = randomUUID(), session = randomUUID();
beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder';
  await pool.query(`insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Fixture','Fixture')`, [org]);
  await pool.query(`insert into auth.users(id,email) values($1,$2)`, [actor, actor + '@example.test']);
  await pool.query(`insert into user_organizations(user_id,organization_id,role) values($1,$2,'agent')`, [actor, org]);
  await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00')`, [session, org]);
  await pool.query(`with v as (insert into playbook_versions(organization_id,layer,content)
    select null,'platform','Assistente sintético.' where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id)
    insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`);
});
afterAll(() => pool.end());

describe('devolutiva encerrada conserva decisão com Casos desarmado no agente', () => {
  it.each([false, true])('fonte do Caso resolved chega ao revisor e controla envio fiel=%s', async faithful => {
    const contact = randomUUID(), conversation = randomUUID(), message = randomUUID(), caseId = randomUUID(), event = randomUUID();
    const candidate = `A equipe confirmou a sessão de ${faithful ? 'Ana' : 'Bruno'} em 15/10 às 10h.`;
    await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Sintético',$3)`, [contact, org, '+5511' + (faithful ? '999911111' : '999922222')]);
    await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group) values($1,$2,$3,$4,'ai_handling',false)`, [conversation, org, contact, session]);
    await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at)
      values($1,$2,$3,$4,$5,'text','inbound','received','Pode confirmar a sessão de Ana em 15/10 às 10h?',now())`, [message, org, conversation, session, contact]);
    const boundary = await readCurrentServiceBoundary(pool, org, conversation);
    await pool.query(`insert into agent_cases(id,organization_id,conversation_id,status,title,summary,blocker,context_snapshot)
      values($1,$2,$3,'resolved','Sessão','Confirmação manual','Equipe',$4)`, [caseId, org, conversation, { service_boundary: boundary, request_message_id: message }]);
    await pool.query(`insert into agent_case_events(id,organization_id,case_id,kind,actor_kind,actor_user_id,human_action,body)
      values($1,$2,$3,'human_replied','human',$4,'resolved','Pode comunicar a confirmação da sessão de Ana em 15/10 às 10h.')`, [event, org, caseId, actor]);
    const { job } = await enqueueJob(pool, org, { kind: 'case_reply_turn', leadId: contact,
      payload: { case_id: caseId, action: 'resolved', body: 'Pode comunicar a confirmação da sessão de Ana em 15/10 às 10h.', human_event_id: event }, maxAttempts: 1 });
    await ligarEventoAoJob(pool, { tenantId: org, caseId, eventId: event, jobId: job.id, role: 'agent' });
    const worker = 'closed-case-' + event;
    const claimed = (await claimJobs(pool, { workerId: worker, maxConcurrency: 5 })).find(row => row.id === job.id);
    expect(claimed).toBeDefined();
    const sent: string[] = [], packets: Array<Record<string, unknown>> = []; let calls = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] });
    const registry = createFakeRegistry(async options => {
      const serialized = JSON.stringify(options.prompt);
      if (serialized.includes('classificador auxiliar de compliance')) {
        const parts = options.prompt as Array<{ role: string; content: Array<{ text?: string }> }>;
        const raw = parts.filter(p => p.role === 'user').flatMap(p => p.content).find(p => p.text?.startsWith('{'))?.text;
        if (raw) packets.push(JSON.parse(raw));
        return text(JSON.stringify({ isPromise: false, prometeuRetornoHumano: false, retornoSoDoAssistente: false,
          afirmouConclusaoHumana: true, repasseConcluidoFiel: faithful }));
      }
      if (calls++ === 0) return { content: [{ type: 'tool-call' as const, toolCallId: 'closed-case', toolName: 'send_message', input: JSON.stringify({ body: candidate }) }],
        finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage, warnings: [] };
      return text('{"commitments":[],"objections":[],"next_action":null,"rolling_summary":"Sintético"}');
    });
    const handler = createCaseReplyTurnHandler({ crmCfg: { supabase: {} as never }, llmCfg: { anthropicApiKey: 'controlled' },
      knobs: { historyLimit: 10, maxContextTokens: 4000, notesIndexMaxTokens: 500, maxSteps: 8, queuedRetryDelayMs: 1000,
        promiseSemantic: { enabled: true }, breaker: { exactFailureWarn: 2, exactFailureBlock: 5, sameToolFailureWarn: 3, sameToolFailureHalt: 8, noProgressWarn: 3, noProgressBlock: 5 } },
      log: createLogger(), registry, clock: () => new Date('2026-10-11T15:00:00Z'), sleep: async () => {},
      channel: () => ({ channel: 'captura', send: async (input: { body: string }) => { sent.push(input.body); return { kind: 'sent' as const, idempotencyKey: event, messageId: event }; },
        sessionHealth: async () => ({ healthy: true, status: 'WORKING' }), capabilities: () => ({ freeform: true, media: true, audio: true }), costPerMessage: () => ({ currency: 'BRL', cents: 0 }) }) as never });
    await handler(claimed!, pool, { workerId: worker });
    expect(packets).toHaveLength(1);
    expect(packets[0]?.contexto_decisoes).toMatchObject({ decisoes: [{ acao: 'resolved', elegivel: true,
      nota: 'Pode comunicar a confirmação da sessão de Ana em 15/10 às 10h.' }] });
    expect(sent).toEqual(faithful ? [candidate] : []);
    expect((await pool.query(`select status from agent_cases where id=$1`, [caseId])).rows[0].status).toBe('resolved');
    if (!faithful) expect((await pool.query(`select vetoed_code from before_send_traces where job_id=$1`, [job.id])).rows).toEqual([{ vetoed_code: 'human_decision_unfaithful' }]);
    await completeJob(pool, job.id, worker, undefined, claimed!.claim_acquired_at);
  });
});
