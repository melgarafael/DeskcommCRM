import { beforeEach, expect, it, vi } from "vitest";
const deps=vi.hoisted(()=>({support:vi.fn(),role:vi.fn(),rpc:vi.fn(),audit:vi.fn()}));
vi.mock("@/lib/impersonate/support",()=>({requireSupportWrite:deps.support}));
vi.mock("@/lib/auth/require-role",()=>({requireRole:deps.role}));
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>({rpc:deps.rpc})}));
vi.mock("@/lib/audit",()=>({audit:deps.audit}));
import { PATCH } from "@/app/api/v1/agenda/configuracao/route";
const settings={confirmation_delay_minutes:10,unknown_protection_minutes:1440};
/**
 * O que a RPC recebe NÃO é o que o cliente mandou: `pending_expires_after_minutes`
 * tem `.default(1440)` no schema, então o Zod o completa. É por isso que a rota
 * grava três campos mesmo quando o corpo trouxe dois — e é o que mantém um PATCH
 * escrito antes desta versão (uma aba aberta, por exemplo) funcionando em vez de
 * tomar 422.
 */
const gravado={...settings,pending_expires_after_minutes:1440};
beforeEach(()=>{vi.resetAllMocks();deps.support.mockResolvedValue(null);deps.role.mockResolvedValue({ok:true,user:{id:'human'},org:{orgId:'trusted-org'}});deps.rpc.mockResolvedValue({data:settings,error:null});});
const request=(body:unknown=settings)=>new Request('http://localhost/api/v1/agenda/configuracao',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
it('suporte somente leitura é barrado antes de leitura ou efeito',async()=>{
 deps.support.mockResolvedValue(new Response('readonly',{status:403}));expect((await PATCH(request())).status).toBe(403);
 expect(deps.role).not.toHaveBeenCalled();expect(deps.rpc).not.toHaveBeenCalled();expect(deps.audit).not.toHaveBeenCalled();
});
it('gestão autorizada altera a organização da sessão e audita autoria',async()=>{
 expect((await PATCH(request())).status).toBe(200);expect(deps.role).toHaveBeenCalledWith('manager',expect.anything());
 expect(deps.rpc).toHaveBeenCalledWith('fn_agenda_settings',{p_org:'trusted-org',p_config:gravado});expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({actorUserId:'human',organizationId:'trusted-org',action:'agenda.settings_updated'}));
});
it('prazo inválido não chega à escrita',async()=>{
 expect((await PATCH(request({...settings,unknown_protection_minutes:1}))).status).toBe(422);expect(deps.rpc).not.toHaveBeenCalled();expect(deps.audit).not.toHaveBeenCalled();
});
