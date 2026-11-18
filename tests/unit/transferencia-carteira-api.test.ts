import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks=vi.hoisted(()=>({rpc:vi.fn(),audit:vi.fn(),atividade:vi.fn(),auth:vi.fn()}));
vi.mock("@/lib/impersonate/support",()=>({requireSupportWrite:async()=>null}));
// A transferência lê o número da conversa antes da troca (#3642): a leitura não acha nada aqui.
const leitura=vi.hoisted(()=>{const l:Record<string,unknown>={};l.select=()=>l;l.eq=()=>l;l.maybeSingle=async()=>({data:null,error:null});return l;});
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>({rpc:mocks.rpc,from:()=>leitura})}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:vi.fn()}));
vi.mock("@/lib/audit",()=>({audit:mocks.audit,isServiceRoleConfigured:()=>false}));
vi.mock("@/lib/inbox/atividade-de-comando",()=>({registrarTrocaDeComando:mocks.atividade}));
vi.mock("@/lib/auth/require-role",()=>({requireRole:mocks.auth}));
import { POST } from "@/app/api/v1/conversations/[id]/transfer/route";
const org="11111111-1111-4111-8111-111111111111";
const destino="22222222-2222-4222-8222-222222222222";
beforeEach(()=>{
 vi.clearAllMocks();mocks.auth.mockResolvedValue({ok:true,user:{id:destino,idioma:"pt-BR"},org:{orgId:org,role:"agent"}});
});
describe("transferência: conversa fora da visibilidade responde como inexistente",()=>{
 it("zero linhas da RPC vira 404, sem auditoria ou notificação de sucesso",async()=>{
  mocks.rpc.mockResolvedValue({data:[],error:null});
  const req=new NextRequest("http://localhost/api/v1/conversations/teste/transfer",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to_user_id:destino})});
  const r=await POST(req,{params:Promise.resolve({id:"teste"})});expect(r.status).toBe(404);
  expect(mocks.rpc).toHaveBeenCalledOnce();expect(mocks.rpc).toHaveBeenCalledWith("fn_conversation_assign",expect.objectContaining({p_organization_id:org,p_to_user_id:destino}));
  expect(mocks.audit).not.toHaveBeenCalled();expect(mocks.atividade).not.toHaveBeenCalled();
  expect((await r.json()).error.code).toBe("not_found");
 });
 it("não deixa body escolher a organização da atribuição",async()=>{
  mocks.rpc.mockResolvedValue({data:[],error:null});
  const r=await POST(new NextRequest("http://localhost/api/v1/conversations/teste/transfer",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to_user_id:destino,organization_id:"outra"})}),{params:Promise.resolve({id:"teste"})});
  expect(r.status).toBe(404);expect(mocks.rpc).toHaveBeenCalledWith("fn_conversation_assign",expect.objectContaining({p_organization_id:org}));
 });
});
