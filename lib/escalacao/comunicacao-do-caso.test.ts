import {describe,it,expect} from 'vitest';
import {projetarComunicacao} from './comunicacao-do-caso';
const base={event_id:'event',job_id:'job',authenticated:true,invalidated:false,job_status:'done',deferred:false,
  manual_retries:0,trace_id:null,vetoed_code:null,ledger:[]};
describe('Comunicação não é status do Caso',()=>{
  it('job done sem envio fica pendente e pode reavaliar o mesmo job',()=>expect(projetarComunicacao(base)).toMatchObject({state:'pending',delivery:null,can_retry:true}));
  it('sent não vira entregue/lida, nem accepted sem mensagem prova envio',()=>{
    expect(projetarComunicacao({...base,ledger:[{status:'accepted',message_status:'sent',message_id:'m'}]})).toMatchObject({state:'sent',delivery:'sent',can_retry:false});
    expect(projetarComunicacao({...base,ledger:[{status:'accepted',message_status:null,message_id:null}]})).toMatchObject({state:'failed',delivery:null,can_retry:false});
  });
  it.each(['delivered','read'] as const)('%s tem prova própria',status=>expect(projetarComunicacao({...base,ledger:[{status:'accepted',message_status:status,message_id:'m'}]}).delivery).toBe(status));
  it('queued pertence à fila, não ao botão de retry',()=>expect(projetarComunicacao({...base,ledger:[{status:'queued',message_status:'queued',message_id:'m'}]})).toMatchObject({state:'queued',can_retry:false}));
  it('veto, atraso, legado, revogação e limite são distintos',()=>{
    expect(projetarComunicacao({...base,vetoed_code:'case_promise_without_case'}).state).toBe('vetoed');
    expect(projetarComunicacao({...base,job_status:'pending',deferred:true}).state).toBe('deferred');
    expect(projetarComunicacao({...base,authenticated:false})).toMatchObject({state:'unknown_legacy',can_retry:false});
    expect(projetarComunicacao({...base,invalidated:true})).toMatchObject({state:'cancelled_or_stale',can_retry:false,can_rectify:false});
    expect(projetarComunicacao({...base,manual_retries:3}).can_retry).toBe(false);
  });
  it('envio parcial não vira comunicação completa quando a tentativa final foi vetada',()=>expect(projetarComunicacao({...base,vetoed_code:'clinical_claim',ledger:[{status:'accepted',message_status:'sent',message_id:'m'}]})).toMatchObject({state:'vetoed',partial:true,can_retry:false}));
});
