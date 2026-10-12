import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { runBeforeSend, casePromiseGate, type RunBeforeSendArgs } from '@/lib/agent-engine/guardrails/before-send';

function fixture(states: Array<'valid'|'stale'|'not_eligible'>) {
  const events:string[]=[];
  let open=false;
  const client={query:vi.fn(async(sql:string)=>{
    if(sql==='begin')open=true;
    if(sql==='commit'||sql==='rollback')open=false;
    if(['begin','commit','rollback'].includes(sql))events.push(sql);
    return {rows:[]};
  }),release:vi.fn(()=>events.push('release'))};
  const pool={connect:vi.fn(async()=>client),query:vi.fn(async()=>({rows:[]}))} as unknown as pg.Pool;
  const classify=vi.fn(async()=>{
    expect(open).toBe(false);events.push('review');
    return {isPromise:false,suspectPhrase:null,prometeuRetornoHumano:true,retornoSoDoAssistente:false,repasseConcluidoFiel:true};
  });
  const validate=vi.fn(async()=>{expect(open).toBe(true);return states.shift()??'stale';});
  const send=vi.fn(async()=>{events.push('send');return {kind:'already_sent' as const,idempotencyKey:'proof',messageId:'proof'};});
  const args:RunBeforeSendArgs={pool,log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()},tenantId:'org',leadId:'lead',channelSessionId:'session',
    body:'A equipe confirmou a sessão de Ana.',optedOutThisTurn:false,crmDailyLimit:null,now:new Date(),casesEnabled:true,hasOpenCase:false,
    gates:[casePromiseGate],classifyPromiseSemantic:classify,validateHumanDecision:validate,send,sleep:async()=>{}};
  return {args,events,send,classify,validate,client};
}
describe('T08 fotografia da decisão até o efeito',()=>{
  it('contexto mudou antes do gate: refaz fora do lock e só envia a segunda fotografia',async()=>{
    const f=fixture(['stale','valid','valid']);
    expect((await runBeforeSend(f.args)).status).toBe('sent');
    expect(f.classify).toHaveBeenCalledTimes(2);expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['review','begin','rollback','release','review','begin','send','commit','release']);
  });
  it('mudança imediatamente antes do efeito também refaz uma única vez',async()=>{
    const f=fixture(['valid','stale','valid','valid']);
    expect((await runBeforeSend(f.args)).status).toBe('sent');
    expect(f.classify).toHaveBeenCalledTimes(2);expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.validate).toHaveBeenCalledTimes(4);
  });
  it('segunda mudança permanece pendente, sem loop ou envio',async()=>{
    const f=fixture(['stale','stale']);
    expect(await runBeforeSend(f.args)).toMatchObject({status:'vetoed',code:'human_decision_context_changed'});
    expect(f.classify).toHaveBeenCalledTimes(2);expect(f.send).not.toHaveBeenCalled();expect(f.client.release).toHaveBeenCalledTimes(2);
  });
  it('sem prova positiva não cria retry nem exceção',async()=>{
    const f=fixture(['not_eligible']);
    expect(await runBeforeSend(f.args)).toMatchObject({status:'vetoed',code:'case_promise_without_case'});
    expect(f.classify).toHaveBeenCalledTimes(1);expect(f.send).not.toHaveBeenCalled();
  });
  it('fonte muda antes do efeito sem exceção de Caso: reavalia fora do lock',async()=>{
    const f=fixture(['not_eligible','stale','not_eligible','not_eligible']);
    f.args.body='Consultei o plano solicitado.';
    f.classify.mockImplementation(async()=>{
      f.events.push('review');
      return {isPromise:false,suspectPhrase:null,prometeuRetornoHumano:false,retornoSoDoAssistente:false,repasseConcluidoFiel:false};
    });
    expect((await runBeforeSend(f.args)).status).toBe('sent');
    expect(f.classify).toHaveBeenCalledTimes(2);expect(f.validate).toHaveBeenCalledTimes(4);expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['review','begin','rollback','release','review','begin','send','commit','release']);
  });
});
