import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";
import { issueState } from "@/lib/nuvemshop/state";
const fake=vi.hoisted(()=>({audit:vi.fn(),allowed:vi.fn(async()=>true),integration:"fa220000-0000-4000-8000-000000000001"}));
vi.mock("@/lib/audit",()=>({audit:fake.audit}));
vi.mock("@/lib/impersonate/support",()=>({supportCallbackWriteAllowed:fake.allowed}));
vi.mock("@/lib/nuvemshop/config",()=>({getConfig:()=>({clientSecret:"local"}),SUBSCRIBED_EVENTS:["order/created"],eventToSlug:()=>"order-created"}));
vi.mock("@/lib/nuvemshop/oauth",()=>({exchangeCodeForToken:async()=>({ok:true,accessToken:"local",storeId:"12345",scope:"read_orders"})}));
vi.mock("@/lib/nuvemshop/api-client",()=>({NuvemshopApiClient:class {async createWebhook(){return {id:1};}}}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>({
 rpc:async()=>({data:"\\x00",error:null}),
 from:()=>({insert:async()=>({error:null}),upsert:()=>({select:()=>({single:async()=>({data:{id:fake.integration},error:null})})}),update:()=>({eq:()=>({eq:async()=>({error:null})})})}),
})}));
it("callback sem JWT encaminha identidade do state validado e recurso UUID à auditoria",async()=>{
 const actor=randomUUID(),session=randomUUID(),org=randomUUID();
 const state=issueState(org,{userId:actor,authSessionId:session});
 const {GET}=await import("@/app/api/v1/integrations/nuvemshop/callback/route");
 const response=await GET(new NextRequest(`http://localhost/api/v1/integrations/nuvemshop/callback?code=local&state=${encodeURIComponent(state)}`));
 // A volta é de OUTRO site (Nuvemshop) e o cookie de sessão é Strict: 3xx para
 // `/app/...` continuaria a cadeia cross-site e jogaria a pessoa em `/login`
 // com a integração já gravada. A entrega é a ponte — 200, sem `Location`, com
 // o destino dentro do documento (issue #4335).
 expect(response.headers.get("location")).toBeNull();
 expect(response.status).toBe(200);
 expect(await response.clone().text()).toContain("window.location.replace(\"/app/integrations/nuvemshop?ok=1\");");
 expect(fake.allowed).toHaveBeenCalledWith(org,actor,session);
 expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({action:"nuvemshop.connected",actorUserId:actor,actorAuthSessionId:session,organizationId:org,resourceId:fake.integration}));
});
