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
  // DUAS FORMAS de exportar um handler, e o gate precisa das duas. A varredura
  // só enxergava `export async function POST`; `export const PATCH = async () => {}`
  // é igualmente válida para o App Router e passava sem guarda NENHUMA, com o
  // gate verde. Para a forma `const`, o texto medido é a declaração inteira
  // (não só o corpo) — assim um wrapper `export const POST = comX(async () => …)`
  // também é lido. Indireção opaca (`export const POST = handle;`) cai como
  // descoberta de propósito: o gate não enxerga o corpo, e falhar fechado aqui
  // custa uma justificativa, enquanto falhar aberto custa uma rota sem guarda.
  const trechos:Array<[string,string]>=[];
  for(const node of source.statements){
   if(ts.isFunctionDeclaration(node)&&node.name&&node.body&&["POST","PUT","PATCH","DELETE"].includes(node.name.text))
    trechos.push([node.name.text,node.body.getText(source)]);
   if(ts.isVariableStatement(node))for(const decl of node.declarationList.declarations)
    if(ts.isIdentifier(decl.name)&&["POST","PUT","PATCH","DELETE"].includes(decl.name.text)&&decl.initializer)
     trechos.push([decl.name.text,decl.getText(source)]);
  }
  for(const [nome,texto] of trechos)
   if(!texto.includes("requireSupportWrite(")&&!texto.includes("methodNotAllowed("))uncovered.push(`${path}:${nome}`);
 }
 expect(uncovered).toEqual([]);
});
it("Server Actions que resolvem tenant declaram efeito ou uma exceção pessoal/transição",()=>{
 const exceptions=new Set(["updateProfile.ts","trocarIdioma.ts","recoverOrganization.ts"]); // preferências próprias e recuperação sem org
 const uncovered=files("app/actions").filter(p=>!p.endsWith(".test.ts")&&!exceptions.has(p.split("/").at(-1)!)).filter(p=>{
  const text=readFileSync(p,"utf8");return /await resolveActiveOrg\(/.test(text)&&!text.includes("supportWriteError(");
 });expect(uncovered).toEqual([]);
});
