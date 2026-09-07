import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
function files(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?files(join(dir,item.name)):[join(dir,item.name)]);}
it("todo handler mutante do app declara guarda de suporte ou é infraestrutura identificada",()=>{
 const uncovered:string[]=[];
 for(const path of files("app/api/v1").filter(p=>p.endsWith("/route.ts"))){
  if(/app\/api\/v1\/(cron|webhooks)\//.test(path)||path==="app/api/v1/system/agent/route.ts")continue; // segredo de máquina, sem actor/session cookie
  if(path.includes("/impersonate"))continue; // início/fim autenticam a posse e têm contrato próprio
  const source=ts.createSourceFile(path,readFileSync(path,"utf8"),ts.ScriptTarget.Latest,true);
  for(const node of source.statements){
   if(!ts.isFunctionDeclaration(node)||!node.name||!node.body||!["POST","PUT","PATCH","DELETE"].includes(node.name.text))continue;
   const body=node.body.getText(source);
   if(!body.includes("requireSupportWrite(")&&!body.includes("methodNotAllowed("))uncovered.push(`${path}:${node.name.text}`);
  }
 }
 expect(uncovered).toEqual([]);
});
it("Server Actions que resolvem tenant declaram efeito ou uma exceção pessoal/transição",()=>{
 const exceptions=new Set(["updateProfile.ts","trocarIdioma.ts","recoverOrganization.ts"]); // preferências próprias e recuperação sem org
 const uncovered=files("app/actions").filter(p=>!p.endsWith(".test.ts")&&!exceptions.has(p.split("/").at(-1)!)).filter(p=>{
  const text=readFileSync(p,"utf8");return /await resolveActiveOrg\(/.test(text)&&!text.includes("supportWriteError(");
 });expect(uncovered).toEqual([]);
});
