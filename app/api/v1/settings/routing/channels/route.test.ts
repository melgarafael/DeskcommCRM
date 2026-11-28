import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { PATCH } from "./route";
vi.mock("@/lib/auth/require-role",()=>({requireRole:vi.fn()}));
vi.mock("@/lib/auth/server",()=>({mfaEmDivida:vi.fn()}));
vi.mock("@/lib/impersonate/support",()=>({requireSupportWrite:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createClient:vi.fn()}));
vi.mock("@/lib/atendimento/setores-modulo",()=>({seSetoresDesligado:vi.fn()}));
vi.mock("@/lib/audit",()=>({audit:vi.fn()}));
vi.mock("@/lib/routing/channel-policies",()=>({loadChannelRoutingSettings:vi.fn()}));
const org="20000000-0000-4000-8000-000000000001";
const channel="20000000-0000-4000-8000-000000000002";
const rpc=vi.fn();
const req=(body:unknown={channel_session_id:channel,user_ids:[]})=>new Request("http://localhost/api/v1/settings/routing/channels",{method:"PATCH",body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();vi.mocked(requireRole).mockResolvedValue({ok:true,user:{id:org},org:{orgId:org}} as never);vi.mocked(mfaEmDivida).mockResolvedValue(false);vi.mocked(requireSupportWrite).mockResolvedValue(null);vi.mocked(seSetoresDesligado).mockResolvedValue(null);vi.mocked(createClient).mockResolvedValue({rpc} as never);rpc.mockResolvedValue({data:{mode:"restricted_empty",user_ids:[]},error:null});});
describe("política por canal HTTP",()=>{
 it.each([401,403])("preserva negativa de autorização %s",async(status)=>{vi.mocked(requireRole).mockResolvedValue({ok:false,response:new Response(null,{status})} as never);expect((await PATCH(req())).status).toBe(status);expect(rpc).not.toHaveBeenCalled();});
 it("support readonly não chega à RPC",async()=>{vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null,{status:403}) as never);expect((await PATCH(req())).status).toBe(403);expect(rpc).not.toHaveBeenCalled();});
 it("platform admin também prova MFA",async()=>{vi.mocked(mfaEmDivida).mockResolvedValue(true);expect((await PATCH(req())).status).toBe(403);expect(rpc).not.toHaveBeenCalled();});
 it("lista vazia persiste, org vem da sessão e reset é explícito",async()=>{expect((await PATCH(req())).status).toBe(200);expect(rpc).toHaveBeenCalledWith("fn_set_channel_routing",{p_org:org,p_channel:channel,p_users:[],p_reset:false,p_mode:null,p_default_assignee:null});expect((await PATCH(req({channel_session_id:channel,user_ids:[],organization_id:channel}))).status).toBe(422);});
 it.each([["P0002",404],["22023",422]])("RPC %s não vira sucesso parcial",async(code,status)=>{rpc.mockResolvedValue({data:null,error:{code}});expect((await PATCH(req())).status).toBe(status);});
 it("modo e destino padrão do NÚMERO atravessam a rota (issue #2331)",async()=>{
  const ana="20000000-0000-4000-8000-00000000000a";
  expect((await PATCH(req({channel_session_id:channel,user_ids:[ana],distribution_mode:"round_robin",default_assignee_user_id:ana}))).status).toBe(200);
  expect(rpc).toHaveBeenCalledWith("fn_set_channel_routing",{p_org:org,p_channel:channel,p_users:[ana],p_reset:false,p_mode:"round_robin",p_default_assignee:ana});
 });
 it("modo fora da lista da tela é recusado antes da RPC",async()=>{
  expect((await PATCH(req({channel_session_id:channel,user_ids:[],distribution_mode:"telefone"}))).status).toBe(422);
  expect(rpc).not.toHaveBeenCalled();
 });
 it("destino padrão nulo explícito continua chegando à RPC como nulo (número sem regra)",async()=>{
  expect((await PATCH(req({channel_session_id:channel,user_ids:[],distribution_mode:null,default_assignee_user_id:null}))).status).toBe(200);
  expect(rpc).toHaveBeenCalledWith("fn_set_channel_routing",{p_org:org,p_channel:channel,p_users:[],p_reset:false,p_mode:null,p_default_assignee:null});
 });
 it("espera pela IA OMITIDA não chama a segunda RPC: a tela antiga não desliga ninguém (#3966)",async()=>{
  expect((await PATCH(req())).status).toBe(200);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).not.toHaveBeenCalledWith("fn_set_channel_ai_wait",expect.anything());
 });
 it("espera pela IA informada é gravada DEPOIS da regra do número, e nula desliga (#3966)",async()=>{
  const r=await PATCH(req({channel_session_id:channel,user_ids:[],ai_wait_minutes:60}));
  expect(r.status).toBe(200);
  expect(rpc.mock.calls.map((c)=>c[0])).toEqual(["fn_set_channel_routing","fn_set_channel_ai_wait"]);
  expect(rpc).toHaveBeenLastCalledWith("fn_set_channel_ai_wait",{p_org:org,p_channel:channel,p_minutes:60});
  expect((await r.json()).data.ai_wait_minutes).toBe(60);
  rpc.mockClear();
  expect((await PATCH(req({channel_session_id:channel,user_ids:[],ai_wait_minutes:null}))).status).toBe(200);
  expect(rpc).toHaveBeenLastCalledWith("fn_set_channel_ai_wait",{p_org:org,p_channel:channel,p_minutes:null});
 });
 it("prazo fora da faixa é recusado antes de qualquer RPC, e o reset não grava espera (#3966)",async()=>{
  expect((await PATCH(req({channel_session_id:channel,user_ids:[],ai_wait_minutes:5}))).status).toBe(422);
  expect(rpc).not.toHaveBeenCalled();
  expect((await PATCH(req({channel_session_id:channel,user_ids:[],reset:true,ai_wait_minutes:60}))).status).toBe(200);
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it("falha ao gravar a espera não vira sucesso (#3966)",async()=>{
  rpc.mockResolvedValueOnce({data:{mode:"restricted_empty",user_ids:[]},error:null}).mockResolvedValueOnce({data:null,error:{code:"22023"}});
  expect((await PATCH(req({channel_session_id:channel,user_ids:[],ai_wait_minutes:60}))).status).toBe(422);
 });
 it("setor de entrada OMITIDO segue pela RPC de sempre e não consulta o módulo (#5374)",async()=>{
  expect((await PATCH(req())).status).toBe(200);
  expect(rpc.mock.calls.map((c)=>c[0])).toEqual(["fn_set_channel_routing"]);
  expect(seSetoresDesligado).not.toHaveBeenCalled();
 });
 it("setor de entrada informado vai pela RPC com setor, e nulo tira a fila (#5374)",async()=>{
  const fila="20000000-0000-4000-8000-0000000000f1";
  rpc.mockResolvedValue({data:{mode:"restricted_empty",user_ids:[],sector_id:fila},error:null});
  expect((await PATCH(req({channel_session_id:channel,user_ids:[],sector_id:fila}))).status).toBe(200);
  expect(rpc).toHaveBeenCalledWith("fn_set_channel_routing_with_sector",{p_org:org,p_channel:channel,p_users:[],p_mode:null,p_default_assignee:null,p_sector:fila});
  rpc.mockClear();
  expect((await PATCH(req({channel_session_id:channel,user_ids:[],sector_id:null}))).status).toBe(200);
  expect(rpc).toHaveBeenCalledWith("fn_set_channel_routing_with_sector",expect.objectContaining({p_sector:null}));
 });
 it("módulo setores desligado: o setor de entrada é 404 e nada é gravado (#5374)",async()=>{
  vi.mocked(seSetoresDesligado).mockResolvedValue(new Response(null,{status:404}) as never);
  expect((await PATCH(req({channel_session_id:channel,user_ids:[],sector_id:null}))).status).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
 });
 it("reset ignora o setor de entrada: a regra inteira sai, sem consultar o módulo (#5374)",async()=>{
  vi.mocked(seSetoresDesligado).mockResolvedValue(new Response(null,{status:404}) as never);
  expect((await PATCH(req({channel_session_id:channel,user_ids:[],reset:true,sector_id:null}))).status).toBe(200);
  expect(rpc.mock.calls.map((c)=>c[0])).toEqual(["fn_set_channel_routing"]);
 });
 it.each([["routing_sector_without_members","Esta fila ainda não tem atendentes."],["routing_invalid_sector","Selecione um setor desta organização."]])("RPC %s vira 422 com o motivo (#5374)",async(message,texto)=>{
  rpc.mockResolvedValue({data:null,error:{code:"22023",message}});
  const r=await PATCH(req({channel_session_id:channel,user_ids:[],sector_id:"20000000-0000-4000-8000-0000000000f1"}));
  expect(r.status).toBe(422);
  expect((await r.json()).error.message).toBe(texto);
 });
});
