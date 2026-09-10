import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/modules/require-academia",()=>({requireAcademia:vi.fn()}));
vi.mock("@/lib/impersonate/support",()=>({requireSupportWrite:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createClient:vi.fn()}));
vi.mock("@/lib/audit",()=>({audit:vi.fn()}));
import { requireAcademia } from "@/lib/modules/require-academia";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { POST, PATCH } from "@/app/api/v1/academia/catalogs/[kind]/route";
const id="a2340000-0000-4000-8000-000000000001";
const org="a2340000-0000-4000-8000-000000000002";
const context={params:Promise.resolve({kind:"teachers"})};
const values={name:"Professor de teste",notes:"",active:true};
const maybeSingle=vi.fn();
const chain={insert:vi.fn(),update:vi.fn(),select:vi.fn(),eq:vi.fn(),maybeSingle};
const from=vi.fn(()=>chain);
beforeEach(()=>{
 vi.resetAllMocks();from.mockReturnValue(chain);
 for(const method of [chain.insert,chain.update,chain.select,chain.eq])method.mockReturnValue(chain);
 vi.mocked(createClient).mockResolvedValue({from} as never);
 vi.mocked(requireSupportWrite).mockResolvedValue(null);
 vi.mocked(requireAcademia).mockResolvedValue({ok:true,org:{orgId:org},user:{id:"user"}} as never);
});
function req(method:string,data:unknown){return new Request("http://localhost/api/v1/academia/catalogs/teachers",{method,headers:{"Content-Type":"application/json","Idempotency-Key":id},body:JSON.stringify(data)});}
it("retry do mesmo POST não duplica nem audita novamente",async()=>{
 const row={id,organization_id:org,...values,revision:1};
 maybeSingle.mockResolvedValueOnce({data:row,error:null});
 expect((await POST(req("POST",{values}),context)).status).toBe(201);
 expect(chain.insert).toHaveBeenCalledWith({id,organization_id:org,...values});
 maybeSingle.mockResolvedValueOnce({data:null,error:{code:"23505"}}).mockResolvedValueOnce({data:row,error:null});
 expect((await POST(req("POST",{values}),context)).status).toBe(200);
 expect(audit).toHaveBeenCalledTimes(1);
 expect(requireAcademia).toHaveBeenCalledWith(expect.any(String),"manager");
});
it("reutilizar chave com conteúdo diferente é conflito",async()=>{
 maybeSingle.mockResolvedValueOnce({data:null,error:{code:"23505"}}).mockResolvedValueOnce({data:{id,...values,name:"Alterado"},error:null});
 expect((await POST(req("POST",{values}),context)).status).toBe(409);expect(audit).not.toHaveBeenCalled();
});
it("PATCH exige a revisão corrente e escopa organização",async()=>{
 maybeSingle.mockResolvedValue({data:null,error:null});
 expect((await PATCH(req("PATCH",{id,revision:1,values}),context)).status).toBe(409);
 expect(chain.eq).toHaveBeenCalledWith("organization_id",org);expect(chain.eq).toHaveBeenCalledWith("revision",1);expect(audit).not.toHaveBeenCalled();
});
it("tenant no payload não chega ao banco",async()=>{
 expect((await POST(req("POST",{values:{...values,organization_id:"outro"}}),context)).status).toBe(422);expect(from).not.toHaveBeenCalled();
});
it("suporte readonly interrompe antes de autorização e banco",async()=>{
 vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null,{status:403}) as never);
 expect((await POST(req("POST",{values}),context)).status).toBe(403);expect(requireAcademia).not.toHaveBeenCalled();expect(from).not.toHaveBeenCalled();
});
