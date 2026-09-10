import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
// Opt-in local, sem reset de usuários, canais ou onboarding. Registros sintéticos
// são identificados e desativados pela API ao final, mantendo a auditoria.
test("cadastros pela tela, revisão, retry, desativação e tela móvel",async({page})=>{
 test.skip(!process.env.ACADEMIA_E2E_EMAIL || !process.env.ACADEMIA_E2E_PASSWORD);
 test.setTimeout(120000);
 const records: {kind:string;id:string}[]=[];
 await page.goto("/login");await page.locator("#email").fill(process.env.ACADEMIA_E2E_EMAIL!);await page.locator("#password").fill(process.env.ACADEMIA_E2E_PASSWORD!);await page.getByRole("button",{name:/entrar/i}).click();await page.waitForURL(/\/app(?:\/|$)/);
 await page.getByRole("link",{name:"Minha Academia",exact:true}).click();
 await expect(page.getByRole("heading",{name:"Minha Academia",exact:true})).toBeVisible();
 try {
 for(const [kind,label] of [["audiences","Públicos"],["modalities","Modalidades"],["teachers","Professores"],["spaces","Ambientes"]] as const){
  await page.getByRole("button",{name:label,exact:true}).click();
  await page.getByRole("button",{name:"Novo cadastro",exact:true}).click();
  const name=`Verificação técnica ${kind} ${randomUUID().slice(0,8)}`;
  const dialog=page.getByRole("dialog");await dialog.getByLabel("Nome",{exact:true}).fill(name);
  if(kind==="audiences"){
   await dialog.getByLabel("Idade mínima",{exact:true}).fill("11");await dialog.getByLabel("Idade máxima",{exact:true}).fill("15");await expect(dialog.getByLabel("Faixa etária provisória")).toBeChecked();
  }
  if(kind==="modalities")await dialog.getByLabel("Nomes alternativos",{exact:true}).fill("Spinning de teste");
  const created=page.waitForResponse(r=>r.url().endsWith(`/api/v1/academia/catalogs/${kind}`)&&r.request().method()==="POST");
  await dialog.getByRole("button",{name:"Salvar cadastro",exact:true}).click();
  const response=await created;expect(response.status()).toBe(201);const body=await response.json();
  records.push({kind,id:body.data.id});writeFileSync(".local/catalogs-test-records.json",JSON.stringify(records));
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading",{name,exact:true})).toBeVisible();
  const original=response.request().postDataJSON();
  expect((await page.request.post(`/api/v1/academia/catalogs/${kind}`,{data:original,headers:{"Idempotency-Key":body.data.id}})).status()).toBe(200);
  await page.getByRole("button",{name:`Editar: ${name}`,exact:true}).click();
  await dialog.getByLabel("Cadastro ativo",{exact:true}).uncheck();
  const edited=page.waitForResponse(r=>r.url().endsWith(`/api/v1/academia/catalogs/${kind}`)&&r.request().method()==="PATCH");
  await dialog.getByRole("button",{name:"Salvar cadastro",exact:true}).click();expect((await edited).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  const card=page.locator("article").filter({has:page.getByRole("heading",{name,exact:true})});await expect(card.getByText("Inativo",{exact:true})).toBeVisible();
  expect((await page.request.patch(`/api/v1/academia/catalogs/${kind}`,{data:{id:body.data.id,revision:1,values:original.values}})).status()).toBe(409);
  await card.getByRole("button",{name:`Editar: ${name}`,exact:true}).click();await dialog.getByLabel("Cadastro ativo",{exact:true}).check();
  if(kind==="audiences")await dialog.getByLabel("Idade máxima",{exact:true}).fill("16");
  const reactivated=page.waitForResponse(r=>r.url().endsWith(`/api/v1/academia/catalogs/${kind}`)&&r.request().method()==="PATCH");await dialog.getByRole("button",{name:"Salvar cadastro",exact:true}).click();expect((await reactivated).status()).toBe(200);await expect(dialog).toHaveCount(0);await expect(card.getByText("Ativo",{exact:true})).toBeVisible();
 }
 await page.getByRole("button",{name:"Públicos",exact:true}).click();
 await page.screenshot({path:".superpowers/evidence/catalogs-desktop.png",fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await expect(page.getByRole("button",{name:"Novo cadastro",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.getByRole("button",{name:"Novo cadastro",exact:true}).click();await expect(page.getByLabel("Idade máxima",{exact:true})).toBeVisible();
 await page.screenshot({path:".superpowers/evidence/catalogs-mobile.png",fullPage:true});
 await page.getByRole("button",{name:"Cancelar",exact:true}).click();
 } finally {
  for (const record of records) {
   let cursor: string | null = null;
   do {
    const response = await page.request.get(`/api/v1/academia/catalogs/${record.kind}` + (cursor ? `?cursor=${cursor}` : ""));
    expect(response.status()).toBe(200);
    const payload = await response.json();
    const row = payload.data.find((item: { id: string }) => item.id === record.id);
    if (row) {
     const values = Object.fromEntries(Object.entries(row).filter(([key]) => !["id","organization_id","revision","created_at","updated_at"].includes(key)));
     const archived = await page.request.patch(`/api/v1/academia/catalogs/${record.kind}`, { data: { id: row.id, revision: row.revision, values: { ...values, active: false } } });
     expect(archived.status()).toBe(200);
     break;
    }
    cursor = payload.meta.cursor;
   } while (cursor);
  }
 }
});
