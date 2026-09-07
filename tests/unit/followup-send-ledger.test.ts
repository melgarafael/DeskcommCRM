import { expect, it, vi } from "vitest";
import { sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
type Store=Parameters<typeof sendWithLedger>[0];
const intent={tenantId:'org',leadId:'contact',jobId:'job',seq:1,body:'Retomar consulta'};
function store(status='requested',message:{id:string;status:string}|null=null):Store{
 return {create:vi.fn(async()=>{throw {code:'23505'};}),find:vi.fn(async()=>({id:'ledger-original',status:status as 'requested',crm_message_id:message?.id??null})),rotate:vi.fn(async()=> 'new-ledger'),message:vi.fn(async()=>message),update:vi.fn(async()=>{})};
}
it('executor novo reconhece aceito sem chamar transporte novamente',async()=>{
 const db=store('accepted',{id:'message',status:'sent'}),send=vi.fn();
 expect(await sendWithLedger(db,intent,send)).toEqual({kind:'already_sent',idempotencyKey:'ledger-original',crmMessageId:'message'});expect(send).not.toHaveBeenCalled();
});
it('crash depois do transporte reconcilia mensagem aceita mesmo com ledger requested',async()=>{
 const db=store('requested',{id:'message',status:'delivered'}),send=vi.fn();
 expect((await sendWithLedger(db,intent,send)).kind).toBe('sent');expect(send).not.toHaveBeenCalled();expect(db.update).toHaveBeenCalledWith('org','ledger-original','accepted','message',null);
});
it('queued retorna ao handler com MESMAS identidades; sending não reenvia em voo',async()=>{
 const db=store('queued',{id:'legacy-message',status:'queued'}),send=vi.fn(async()=>({id:'legacy-message',status:'sent'}));
 expect((await sendWithLedger(db,intent,send)).kind).toBe('sent');expect(send).toHaveBeenCalledWith('ledger-original','legacy-message');
 const busy=store('requested',{id:'message',status:'sending'}),again=vi.fn();
 expect((await sendWithLedger(busy,intent,again)).kind).toBe('queued');expect(again).not.toHaveBeenCalled();
});
it('falha explícita permite tentativa nova; ausência de recibo após conflito falha fechado',async()=>{
 const db=store('failed'),send=vi.fn(async(_key:string,id:string)=>({id,status:'sent'}));
 expect((await sendWithLedger(db,intent,send)).kind).toBe('sent');expect(send).toHaveBeenCalledWith('new-ledger','new-ledger');
 db.find=vi.fn(async()=>null);await expect(sendWithLedger(db,intent,vi.fn())).rejects.toThrow('send_ledger_missing');
});
it('mensagem failed/queued nunca confirma sent',async()=>{
 for(const status of ['failed','queued']){
  const db=store();const send=vi.fn(async()=>({id:'message',status}));
  expect((await sendWithLedger(db,intent,send)).kind).toBe(status);expect(db.update).not.toHaveBeenCalledWith('org','ledger-original','accepted',expect.anything(),expect.anything());
 }
});
