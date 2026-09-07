import { beforeEach, describe, expect, it, vi } from "vitest";
import { supportWriteError, requireSupportWrite, type SupportContext } from "@/lib/impersonate/support";
const { loadAuthUser } = vi.hoisted(()=>({loadAuthUser:vi.fn()}));
vi.mock("@/lib/auth/server",()=>({loadAuthUser}));
const support:SupportContext = {id:"f2200000-0000-4000-8000-000000000001",organization_id:"f2200000-0000-4000-8000-000000000002",actor_user_id:"f2200000-0000-4000-8000-000000000003",auth_session_id:"f2200000-0000-4000-8000-000000000004",previous_organization_id:null,expires_at:"2026-09-06T00:00:00Z",name:"B",locale:null,status:"active",access_mode:"support_readonly"};
beforeEach(()=>vi.clearAllMocks());
describe("cerca de efeito antes de service role",()=>{
 it("readonly vence identidade plataforma e membership física admin",async()=>{
 loadAuthUser.mockResolvedValue({id:support.actor_user_id,is_platform_admin:true,organizations:[{organization_id:support.organization_id,role:"admin"}],support});
 const response=await requireSupportWrite();expect(response?.status).toBe(403);
 expect((await response!.json()).error.message).toContain("somente leitura");
 });
 it("não restringe outro alvo administrativo A/C nem workers sem usuário",async()=>{
 loadAuthUser.mockResolvedValue({support});expect(await requireSupportWrite("f2200000-0000-4000-8000-000000000009")).toBeNull();
 loadAuthUser.mockResolvedValue(null);expect(await requireSupportWrite()).toBeNull();
 });
 it("full permite efeito; expirada/revogada exige saída",()=>{
 expect(supportWriteError({...support,access_mode:"full"})).toBeNull();
 for(const status of ["expired","revoked"] as const) expect(supportWriteError({...support,access_mode:"full",status})).toContain("Saia");
 });
 it("indisponibilidade falha fechada sem afirmar permissão",async()=>{
 loadAuthUser.mockRejectedValue(new Error("database unavailable"));expect((await requireSupportWrite())?.status).toBe(503);
 });
});
