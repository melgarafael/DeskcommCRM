import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
const credentials=credenciaisSupabaseDeTeste();
const db=createClient(credentials.url,credentials.serviceRole,{auth:{persistSession:false}});
const password=`Local-${randomUUID()}!`;
async function insert(table:string,value:Record<string,unknown>) {
 const {data,error}=await db.from(table).insert(value).select("id").single(); if(error)throw error; return data.id as string;
}
async function login(page:Page,email:string){await page.goto("/login");await page.getByLabel(/e-?mail/i).fill(email);await page.getByLabel(/senha/i).fill(password);await page.getByRole("button",{name:/entrar/i}).click();await page.waitForURL(/\/app(\/|$)/,{timeout:60000});}
async function start(page:Page,org:string,readonly=false){
 await page.goto(`/admin/tenants/${org}`);
 await page.getByRole("button",{name:/Acompanhar/}).click();
 if(readonly)await page.getByLabel("Somente leitura",{exact:true}).check();
 await page.getByRole("button",{name:"Confirmar e entrar"}).click();
 await page.waitForURL("**/app/inbox");
}
async function end(page:Page){await page.getByRole("button",{name:"Sair do acompanhamento"}).click();await page.waitForURL("**/app/inbox");await expect(page.getByRole("button",{name:"Sair do acompanhamento"})).toHaveCount(0);}

test("suporte mantém identidade, opera B e encerra sem misturar A; readonly/expiração/revogação são reais",async({page,browser})=>{
 test.setTimeout(240000);
 page.setDefaultTimeout(20000);
 const pendingMutations = new Set<Request>();
 const blockedBeforeSend = new WeakSet<Request>();
 const knownServerActions = new Set<Request>();
 const mutatesFixture = (request: Request) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) return true;
  // Estes GETs sincronizam saúde no banco; polls somente de leitura ficam fora.
  const path = new URL(request.url()).pathname;
  return request.method() === "GET" && (/^\/api\/v1\/channel-sessions\/[^/]+$/.test(path)
   || path === "/api/v1/onboarding/whatsapp/session");
 };
 const observeRequests = (context: BrowserContext) => {
  context.on("request", request => {
   if (mutatesFixture(request) && !blockedBeforeSend.has(request)) pendingMutations.add(request);
   if(request.method()==="POST" && ["/login","/app/settings/tenant"].includes(new URL(request.url()).pathname)) knownServerActions.add(request);
  });
  context.on("requestfinished", request => pendingMutations.delete(request));
  // Cancelamento após envio não prova que a transação no servidor terminou.
  context.on("requestfailed", request => { if (blockedBeforeSend.has(request)) pendingMutations.delete(request); });
 };
 const acknowledgeKnownAction = async (target: Page, path: "/login" | "/app/settings/tenant") => {
  // Chamar SOMENTE após a confirmação semântica específica abaixo. O stream
  // RSC pode continuar aberto mesmo com a action já concluída no servidor.
  const matching=[...knownServerActions].filter(request=>request.method()==="POST"
   && new URL(request.url()).pathname===path && request.frame().page()===target);
  expect(matching,"A confirmação deve corresponder a uma action observada nesta página").toHaveLength(1);
  const request=matching[0]!;const response=await request.response();
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/x-component");
  pendingMutations.delete(request);knownServerActions.delete(request);
 };
 const pendingMutationDescriptions = () => [...pendingMutations].map(request=>({
  method:request.method(),path:new URL(request.url()).pathname,
 }));
 observeRequests(page.context());
 const joins: Array<{role:string;topic:string}> = [];
 const observeAuth=(target:Page)=>target.on("websocket",socket=>socket.on("framesent",frame=>{
  try {const p=JSON.parse(frame.payload.toString());const m=Array.isArray(p)?{topic:p[2],event:p[3],payload:p[4]}:p;
   if(m.event==="phx_join"&&m.payload?.config?.postgres_changes?.length){const token=m.payload.access_token;const claims=token?JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString()):{};joins.push({role:claims.role??"missing",topic:m.topic});}
  }catch{/* só metadados, nunca guardar token */}
 }));
 observeAuth(page);page.context().on("page",observeAuth);
 const suffix=randomUUID().slice(0,8); const email=`support-${suffix}@invariant.test`;
 const {data:created,error}=await db.auth.admin.createUser({email,password,email_confirm:true});if(error||!created.user)throw error;
 const actor=created.user.id;const orgs:string[]=[];let second: BrowserContext | undefined;
 let scenarioFailure: unknown;
 const receiverHits: string[] = [];
 type RemoteSession = { name: string; status: string; engine: "NOWEB"; config: Record<string, unknown>; me: null };
 const remoteSessions = new Map<string, RemoteSession>();
 const receiver = createServer(async (req,res) => {
  receiverHits.push(`${req.method} ${req.url}`);
  const reply = (status: number, body: unknown) => { res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body)); };
  const missing = () => reply(404,{statusCode:404,error:"Not Found",message:"Session not found"});
  try {
   const chunks: Buffer[] = [];for await (const chunk of req) chunks.push(Buffer.from(chunk));
   const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
   const path = new URL(req.url ?? "/","http://receiver.local").pathname;
   if (path === "/api/sessions" && req.method === "POST") {
    if (typeof body.name !== "string" || !remoteSessions.has(body.name)) return missing();
    return reply(422,{statusCode:422,error:"Unprocessable Entity",message:`Session '${body.name}' already exists. Use PUT to update it.`});
   }
   const match = /^\/api\/sessions\/([^/]+)(?:\/(stop|start))?$/.exec(path);
   const remote = match ? remoteSessions.get(decodeURIComponent(match[1]!)) : undefined;
   if (!remote) return missing();
   if (req.method === "GET" && !match![2]) return reply(200,remote);
   if (req.method === "PUT" && !match![2] && body.config && typeof body.config === "object") {
    remote.config = body.config as Record<string, unknown>;return reply(200,remote);
   }
   if (req.method === "POST" && match![2] === "stop") { remote.status="STOPPED";return reply(200,remote); }
   if (req.method === "POST" && match![2] === "start") { remote.status="STARTING";return reply(200,remote); }
   return reply(405,{error:"Unexpected receiver operation"});
  } catch { return reply(400,{error:"Invalid receiver request"}); }
 });
 const receiverUrl = new URL(process.env.WAHA_API_BASE_URL!);
 expect(receiverUrl.hostname).toBe("127.0.0.1");
 await new Promise<void>((resolve,reject) => {receiver.once("error",reject); receiver.listen(Number(receiverUrl.port),receiverUrl.hostname,resolve);});
 mkdirSync(".superpowers/evidence/comunidade-360",{recursive:true});
 try{
  const contacts:string[]=[];const convs:string[]=[];const channels:string[]=[];
  for(const label of ["A","B"]){
   const org=await insert("organizations",{slug:`support-${label.toLowerCase()}-${suffix}`,display_name:`Suporte ${label} ${suffix}`,legal_name:`Suporte ${label}`,onboarded_at:label === "A" ? new Date().toISOString() : null});orgs.push(org);
   const contact=await insert("contacts",{organization_id:org,name:`Contato ${label} ${suffix}`,display_name:`Contato ${label} ${suffix}`,force_human:true});contacts.push(contact);
   const sessionName=`support-${randomUUID()}`;
   remoteSessions.set(sessionName,{name:sessionName,status:"STOPPED",engine:"NOWEB",
    config:{ignore:{status:true,broadcast:true,channels:true,groups:true}},me:null});
   const channel=await insert("channel_sessions",{organization_id:org,waha_session_name:sessionName,display_name:"Canal local",status:"STOPPED",webhook_secret_encrypted:"\\x00"});channels.push(channel);
   const conv=await insert("conversations",{organization_id:org,contact_id:contact,channel_session_id:channel,status:"open",unread_count_for_assignee:2,last_message_at:new Date().toISOString(),last_message_preview:`Mensagem ${label}`});convs.push(conv);
  }
  await insert("user_organizations",{organization_id:orgs[0],user_id:actor,role:"admin",accepted_at:new Date().toISOString()});
  const pa=await db.from("platform_admins").insert({user_id:actor,granted_by:actor,scope:"full",mfa_required:false,reason:"E2E local support"});if(pa.error)throw pa.error;
  await login(page,email);await acknowledgeKnownAction(page,"/login");
  const sameTab=await page.context().newPage();await sameTab.goto("/app/inbox");
  await expect(sameTab.getByTestId("tenant-switcher")).toContainText(`Suporte A ${suffix}`);
  second=await browser.newContext();observeRequests(second);const other=await second.newPage();observeAuth(other);await login(other,email);await acknowledgeKnownAction(other,"/login");
  await start(page,orgs[1]!);
  await expect(sameTab.getByTestId("tenant-switcher")).toContainText(`Suporte B ${suffix}`);
  await expect(sameTab.locator("[data-conversation-id]").getByText(`Contato B ${suffix}`,{exact:true})).toBeVisible();
  await expect(sameTab.locator("[data-conversation-id]").getByText(`Contato A ${suffix}`,{exact:true})).toHaveCount(0);
  await page.goto("/onboarding");await page.waitForURL("**/app/inbox");
  await expect(page.getByRole("alert").filter({hasText:/edição permitida/i})).toContainText(`Suporte B ${suffix}`);
  await expect(page.locator("[data-conversation-id]").getByText(`Contato B ${suffix}`,{exact:true})).toBeVisible();
  await expect(page.locator("[data-conversation-id]").getByText(`Contato A ${suffix}`,{exact:true})).toHaveCount(0);
  await other.reload();await expect(other.getByTestId("tenant-switcher")).toContainText(`Suporte A ${suffix}`);
  const members=await db.from("user_organizations").select("id").eq("organization_id",orgs[1]).eq("user_id",actor);expect(members.data).toEqual([]);
  await page.goto(`/app/contacts/${contacts[1]}`);await page.getByRole("button",{name:"Editar",exact:true}).click();
  await page.getByLabel("Nome",{exact:true}).fill(`Editado B ${suffix}`);await page.getByRole("button",{name:"Salvar",exact:true}).click();
  await expect.poll(async()=> (await db.from("contacts").select("name").eq("id",contacts[1]).single()).data?.name).toBe(`Editado B ${suffix}`);
  await expect.poll(async()=> (await db.from("api_audit_log").select("metadata,actor_user_id").eq("organization_id",orgs[1]).eq("actor_user_id",actor).eq("resource_id",contacts[1]).order("created_at",{ascending:false}).limit(1)).data?.[0]?.metadata?.support_session_id).toBeTruthy();
  await page.screenshot({path:".superpowers/evidence/comunidade-360/suporte-full-edita-b.png"});
  const typeCreate=await page.request.post("/api/v1/agenda/tipos",{data:{name:`Tipo suporte ${suffix}`,duration_minutes:30,category:"outro",location_kind:"in_person"}});
  expect(typeCreate.status()).toBe(201);
  const typeId=(await typeCreate.json()).data.id;
  const typePatch=await page.request.patch("/api/v1/agenda/tipos",{data:{id:typeId,name:`Tipo editado ${suffix}`}});expect(typePatch.status()).toBe(200);
  const typeDelete=await page.request.delete("/api/v1/agenda/tipos",{data:{id:typeId}});expect(typeDelete.status()).toBe(200);
  for(const action of ["agenda.tipo_criado","agenda.tipo_alterado","agenda.tipo_desativado"]){
   const auditRow=(await db.from("api_audit_log").select("actor_user_id,metadata").eq("organization_id",orgs[1]).eq("resource_id",typeId).eq("action",action).single()).data;
   expect(auditRow?.actor_user_id).toBe(actor);expect(auditRow?.metadata?.support_session_id).toBeTruthy();
  }
  const reconnect=await page.request.post(`/api/v1/channel-sessions/${channels[1]}/reconnect`,{data:{}});
  expect(reconnect.status()).toBe(200);
  expect(receiverHits.filter(hit=>hit.startsWith("POST ")).length).toBe(3);
  // Formulário full já aberto não pode atravessar rebaixamento no servidor.
  await page.goto("/app/settings/tenant");
  await page.getByLabel("Nome de exibição").fill("Alteração que deve ser recusada");
  const downgrade=await db.from("platform_admins").update({scope:"support_readonly"}).eq("user_id",actor);if(downgrade.error)throw downgrade.error;
  await page.getByRole("button",{name:"Salvar",exact:true}).click();
  await expect(page.getByText(/Erro: forbidden/)).toBeVisible();
  expect((await db.from("organizations").select("display_name").eq("id",orgs[1]).single()).data?.display_name).toBe(`Suporte B ${suffix}`);
  await acknowledgeKnownAction(page,"/app/settings/tenant");
  await db.from("platform_admins").update({scope:"full"}).eq("user_id",actor);

  // Org A fresca não tem automático: a consulta final da fila inclui ambos
  // os comandos depois de automatico-ativo resolver. Observa antes do reload.
  const returnedToA=sameTab.waitForResponse(async response=>{
   const url=new URL(response.url());
   if(response.request().method()!=="GET" || url.pathname!=="/api/v1/conversations"
    || url.searchParams.get("comando")!=="aguardando,automatico" || response.status()!==200)return false;
   const body=await response.json().catch(()=>null) as {data?:Array<{organization_id?:string;contacts?:{name?:string}}> } | null;
   return body?.data?.some(conversation=>conversation.organization_id===orgs[0]
    && conversation.contacts?.name===`Contato A ${suffix}`)===true;
  });
  // Evita rejeição não observada se end falhar antes do await da resposta.
  void returnedToA.catch(()=>{});
  await end(page);await returnedToA;
  await expect(page.getByTestId("tenant-switcher")).toContainText(`Suporte A ${suffix}`);
  await expect(sameTab.getByTestId("tenant-switcher")).toContainText(`Suporte A ${suffix}`);
  await expect(sameTab.locator("[data-conversation-id]").getByText(`Contato A ${suffix}`,{exact:true})).toBeVisible();
  await expect(sameTab.locator("[data-conversation-id]").getByText(`Contato B ${suffix}`,{exact:true})).toHaveCount(0);
  // Readonly prevalece inclusive depois de o ator ser admin FÍSICO em B.
  await insert("user_organizations",{organization_id:orgs[1],user_id:actor,role:"admin",accepted_at:new Date().toISOString()});
  await db.from("conversations").update({unread_count_for_assignee:2}).eq("id",convs[1]);
  let inboxSubscribed=false;
  let inboxPushed=false;
  const realtimeEvidence:unknown[]=[];
  page.on("websocket",socket=>socket.on("framereceived",frame=>{
   try {const parsed=JSON.parse(frame.payload.toString());const message=Array.isArray(parsed)?{topic:parsed[2],event:parsed[3],payload:parsed[4]}:parsed;realtimeEvidence.push({topic:message.topic,event:message.event,status:message.payload?.status});if(message.topic?.startsWith(`realtime:inbox-${orgs[1]}::`)&&message.event==="postgres_changes")inboxPushed=true;if(message.topic?.startsWith(`realtime:inbox-${orgs[1]}::`)&&message.event==="phx_reply"&&message.payload?.status==="ok")inboxSubscribed=true;}catch{/* frames de controle não JSON */}
  }));
  const unexpectedDenials:string[]=[];
  page.on("response",response=>{if(response.status()===403)unexpectedDenials.push(response.url());});
  await start(page,orgs[1]!,true);
  await expect(sameTab.getByTestId("tenant-switcher")).toContainText(`Suporte B ${suffix}`);
  await page.goto("/onboarding");await page.waitForURL("**/app/inbox");
  const writes:string[]=[];page.on("request",request=>{if(request.method()!=="GET"&&/mark-read|availability|messages/.test(request.url()))writes.push(request.url());});
  await page.locator(`[data-conversation-id="${convs[1]}"]`).click();
  await expect(page.getByRole("alert").filter({hasText:/somente leitura/i})).toBeVisible();
  await page.waitForTimeout(2000);expect(writes).toEqual([]);expect(unexpectedDenials).toEqual([]);
  const bannerBox=await page.getByRole("alert").filter({hasText:/somente leitura/i}).boundingBox();
  expect(bannerBox?.y).toBe(0);expect(bannerBox?.height).toBeGreaterThan(30);expect(bannerBox?.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect((await db.from("conversations").select("unread_count_for_assignee").eq("id",convs[1]).single()).data?.unread_count_for_assignee).toBe(2);
  await expect.poll(()=>inboxSubscribed,{timeout:20000}).toBe(true).catch(()=>{throw new Error(`Assinatura B não confirmada: ${JSON.stringify(realtimeEvidence)}`);});
  // O atendimento real continua: mudanças de outro ator em B chegam pela assinatura B.
  expect(joins.length).toBeGreaterThan(0);expect(joins.filter(join=>join.role!=="authenticated")).toEqual([]);
  const incoming=await db.from("conversations").update({last_message_preview:`Nova mensagem B ${suffix}`,last_message_at:new Date().toISOString()}).eq("id",convs[1]).select("last_message_preview").single();
  expect(incoming.error).toBeNull();expect(incoming.data?.last_message_preview).toBe(`Nova mensagem B ${suffix}`);
  await expect.poll(()=>inboxPushed,{timeout:20000}).toBe(true);
  await expect(page.locator(`[data-conversation-id="${convs[1]}"]`)).toContainText(`Nova mensagem B ${suffix}`,{timeout:20000});
  await db.from("conversations").update({last_message_preview:`Mensagem invisível A ${suffix}`}).eq("id",convs[0]);
  await expect(page.getByText(`Mensagem invisível A ${suffix}`)).toHaveCount(0);
  const deliveredBefore=receiverHits.length;
  const forbiddenReconnect=await page.request.post(`/api/v1/channel-sessions/${channels[1]}/reconnect`,{data:{}});
  expect(forbiddenReconnect.status()).toBe(403);
  expect(receiverHits).toHaveLength(deliveredBefore);
  // Outra sessão continua operando o transporte de A durante a observação de B.
  const otherReconnect=await other.request.post(`/api/v1/channel-sessions/${channels[0]}/reconnect`,{data:{}});
  expect(otherReconnect.status()).toBe(200);expect(receiverHits.slice(deliveredBefore).filter(hit=>hit.startsWith("POST "))).toHaveLength(3);
  const api=await page.request.patch(`/api/v1/contacts/${contacts[1]}`,{data:{name:"Forbidden"}});expect(api.status()).toBe(403);
  const send=await page.request.post("/api/v1/messages",{data:{conversation_id:convs[1],content:"Não enviar"}});expect(send.status()).toBe(403);
  const adminApi=await page.request.post(`/api/v1/admin/tenants/${orgs[1]}/suspend`,{data:{reason:"Teste de recusa readonly"}});expect(adminApi.status()).toBe(403);
  await page.screenshot({path:".superpowers/evidence/comunidade-360/suporte-readonly-b.png"});
  const expire=await db.from("platform_support_sessions").update({expires_at:new Date(Date.now()-1000).toISOString()}).eq("actor_user_id",actor).is("ended_at",null);if(expire.error)throw expire.error;
  const stale=await page.request.patch(`/api/v1/contacts/${contacts[1]}`,{data:{name:"Forbidden expired"}});expect(stale.status()).toBe(403);
  await page.reload();await page.waitForURL("**/support-ended");await expect(page.getByRole("heading",{name:"Encerre o acompanhamento para continuar"})).toBeVisible();
  const revoke=await db.from("platform_admins").update({revoked_at:new Date().toISOString()}).eq("user_id",actor);if(revoke.error)throw revoke.error;
  await end(page);await expect(page.getByTestId("tenant-switcher")).toContainText(`Suporte A ${suffix}`);
  expect((await db.from("contacts").select("name").eq("id",contacts[0]).single()).data?.name).toBe(`Contato A ${suffix}`);
  expect(joins.filter(join=>join.role!=="authenticated")).toEqual([]);
  expect((await db.from("organizations").select("onboarded_at").eq("id",orgs[1]).single()).data?.onboarded_at).toBeNull();
 }catch(error){
  scenarioFailure=error;throw error;
 }finally{
  try {
   const contexts=[page.context(),...(second ? [second] : [])];
   // Bloqueia novas mutações ANTES de fechar páginas; só aborts interceptados
   // antes do envio podem ser retirados sem esperar uma resposta do servidor.
   await Promise.all(contexts.map(context=>context.route("**/*",async route=>{
    const request=route.request();
    if(mutatesFixture(request)){
     blockedBeforeSend.add(request);pendingMutations.delete(request);await route.abort("aborted");
    }else await route.continue();
   })));
   await expect.poll(()=>pendingMutations.size,{timeout:20000,
    message:"Mutações enviadas devem concluir antes de fechar contextos ou apagar fixtures"}).toBe(0);
   const closing = await Promise.allSettled([
    ...page.context().pages().map(ownedPage => ownedPage.close()),
    ...(second ? [second.close()] : []),
   ]);
   const failures = closing.filter(result => result.status === "rejected");
   if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Falha ao fechar páginas próprias do suporte");
   expect(pendingMutations.size,"Nenhuma mutação enviada pode permanecer em voo no cleanup").toBe(0);
   for(const org of orgs){const result=await db.from("organizations").delete().eq("id",org);if(result.error)throw result.error;}
   const platformDelete=await db.from("platform_admins").delete().eq("user_id",actor);if(platformDelete.error)throw platformDelete.error;
   const userDelete=await db.auth.admin.deleteUser(actor);if(userDelete.error)throw userDelete.error;
  } catch(cleanupError) {
   // Não troca a causa original por erro de teardown. Sem prova de quiescência,
   // conserva as fixtures para investigação em vez de apagar com writes em voo.
   test.info().annotations.push({type:"cleanup",description:`Cleanup incompleto; fixtures podem permanecer: ${orgs.join(",")}. Mutações pendentes: ${JSON.stringify(pendingMutationDescriptions())}.`});
   if(!scenarioFailure)throw cleanupError;
  } finally {
   await new Promise<void>(resolve=>receiver.close(()=>resolve()));
  }
 }
});
