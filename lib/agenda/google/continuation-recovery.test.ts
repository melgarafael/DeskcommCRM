import { beforeEach, describe, expect, it, vi } from "vitest";
import { resumeGooglePublication } from "./continuation-recovery";
import type * as ServiceWrite from "@/lib/agenda/servicos/escrita";
const native=vi.hoisted(()=>({rpc:vi.fn(),guard:vi.fn(),defer:vi.fn(),job:vi.fn(),execution:vi.fn()}));
vi.mock("@/lib/atendimento/fronteira-server",()=>({guardServiceEffect:native.guard,deferForGooglePublication:native.defer,currentExecutionJob:native.job}));
vi.mock("@/lib/agenda/servicos/escrita",async importOriginal=>({...await importOriginal<typeof ServiceWrite>(),execucaoDoServico:native.execution}));
vi.mock("./sync-store",()=>({googleRpc:native.rpc}));
const row={id:"private-booking",status:"confirmed",revision:3,google_event_id:"private-event",google_local_revision:3,google_synced_local_revision:3,needs_google_push:false};
function database(rows:Record<string,unknown>[]=[row]){
 const query={select:vi.fn(),eq:vi.fn(),in:vi.fn(async()=>({data:rows,error:null}))};query.select.mockReturnValue(query);query.eq.mockReturnValue(query);
 return {from:vi.fn(()=>query),query};
}
beforeEach(()=>{vi.clearAllMocks();native.job.mockReturnValue({kind:"inbound_turn"});native.execution.mockReturnValue({native:"execution"});native.rpc.mockResolvedValue({resumed:true,deferred:false,state:"inline"});});
describe("observação da recuperação nativa da publicação",()=>{
 it.each([1,2,3])("publicação imediata da revisão %s alimenta o observador depois do RPC e da releitura scoped",async revision=>{
  const db=database([{...row,revision,google_local_revision:revision,google_synced_local_revision:revision}]),published=vi.fn();
  const r=await resumeGooglePublication(db as never,"org-native",[row.id],published);
  expect(native.guard).toHaveBeenCalledOnce();expect(native.rpc).toHaveBeenCalledWith(db,"fn_google_continuation_resume",{p_org:"org-native",p_ids:[row.id],p_execution:{native:"execution"}});
  expect(db.query.eq).toHaveBeenCalledWith("organization_id","org-native");expect(db.query.in).toHaveBeenCalledWith("id",[row.id]);
  expect(published).toHaveBeenCalledExactlyOnceWith({reservaId:row.id,revisao:revision});expect(native.defer).not.toHaveBeenCalled();
  expect(r).toMatchObject({resumed:true,appointments:[{id:row.id,google_publication:"synced",communication:"not_proven"}]});
 });
 it.each([
  {resumed:false,reason:"no_current_publication_recovery"},
  {resumed:true,deferred:true,state:"waiting"},
  {resumed:true,deferred:true,state:"queued"},
  {resumed:true,deferred:false,state:"stale"},
 ])("não inventa publicação para %j",async result=>{
  native.rpc.mockResolvedValue(result);const db=database(),published=vi.fn();
  await resumeGooglePublication(db as never,"org-native",[row.id],published);expect(published).not.toHaveBeenCalled();
  if(!result.resumed)expect(db.from).toHaveBeenCalledOnce();
  if("deferred" in result && result.deferred)expect(native.defer).toHaveBeenCalledOnce();
 });
 it.each([{status:"pending"},{status:"cancelled"},{google_synced_local_revision:2},{needs_google_push:true},{google_sync_failure_kind:"human_required",google_sync_error:"Reconnect"}])("não observa recibo não comprovado: %j",async patch=>{
  const db=database([{...row,...patch}]),published=vi.fn();await resumeGooglePublication(db as never,"org-native",[row.id],published);expect(published).not.toHaveBeenCalled();
 });
 it("não reduz duas reservas à primeira e preserva ambos os recibos",async()=>{
  const db=database([row,{...row,id:"other-booking"}]),published=vi.fn();
  const r=await resumeGooglePublication(db as never,"org-native",[row.id,"other-booking"],published);
  expect(published).not.toHaveBeenCalled();expect(r).toHaveProperty("appointments",expect.arrayContaining([expect.objectContaining({id:row.id}),expect.objectContaining({id:"other-booking"})]));
 });
 it("não atribui uma revisão concorrente à recuperação do pedido anterior",async()=>{
  const db=database(),published=vi.fn();
  db.query.in.mockResolvedValueOnce({data:[row],error:null}).mockResolvedValueOnce({data:[{...row,revision:4,google_local_revision:4,google_synced_local_revision:4}],error:null});
  const r=await resumeGooglePublication(db as never,"org-native",[row.id],published);
  expect(r).toMatchObject({appointments:[{revision:4,google_publication:"synced"}]});expect(published).not.toHaveBeenCalled();
 });
 it("não roda sem entrada nativa atual, nem quando a guarda rejeita a autoridade",async()=>{
  const db=database(),published=vi.fn();native.job.mockReturnValue({kind:"followup_turn"});
  expect(await resumeGooglePublication(db as never,"org-native",[row.id],published)).toMatchObject({resumed:false});expect(native.rpc).not.toHaveBeenCalled();
  native.job.mockReturnValue({kind:"inbound_turn"});native.guard.mockRejectedValueOnce(new Error("stale"));
  await expect(resumeGooglePublication(db as never,"org-native",[row.id],published)).rejects.toThrow("stale");expect(native.rpc).not.toHaveBeenCalled();expect(published).not.toHaveBeenCalled();
 });
});
