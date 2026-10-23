import { beforeAll, describe, expect, it } from "vitest";
import { seedGov, GOV_MANAGER, GOV_ORG, sql } from "./gov-helpers";
const OTHER="0662aaaa-0000-4000-8000-000000000001";
beforeAll(()=>{
  seedGov();
  sql(`update organizations set settings=jsonb_build_object('tags',
    (select jsonb_agg('etiqueta' || lpad(n::text,4,'0')) from generate_series(1,720) n)) where id='${GOV_ORG}';
    insert into organizations(id,slug,legal_name,display_name,settings)
    values('${OTHER}','tags-page-other','Outra','Outra','{"tags":["segredo-outra-organizacao"]}');`);
});
function page(offset=0, limit=100, search="", org=GOV_ORG){
 const out=sql(`set role authenticated;
   select set_config('request.jwt.claims','{"sub":"${GOV_MANAGER}"}',false);
   select fn_vocabulario_de_tags_pagina('${org}','${search.replaceAll("'","''")}',${offset},${limit});`);
 return JSON.parse(out.split("\n").at(-1)!);
}
describe("etiquetas paginadas sem corte silencioso",()=>{
 it("alcança etiquetas depois da 500ª e mantém o total verdadeiro",()=>{
   const p=page(700);
   expect(p.total).toBe(720);expect(p.items).toHaveLength(20);
   expect(p.items.at(-1).tag).toBe("etiqueta0720");
 });
 it("páginas não repetem nomes e respeitam o tamanho pedido",()=>{
   const first=page(0,100),second=page(100,100);
   expect(first.items).toHaveLength(100);expect(second.items).toHaveLength(100);
   const a=new Set(first.items.map((r:{tag:string})=>r.tag));
   expect(second.items.some((r:{tag:string})=>a.has(r.tag))).toBe(false);
 });
 it("busca reduz o total; percentagem é texto, não um wildcard",()=>{
   expect(page(0,100,"etiqueta0720").total).toBe(1);
   expect(page(0,100,"%").total).toBe(0);
 });
 it("a RLS recusa a organização de fora e anon não executa a função",()=>{
   expect(page(0,100,"",OTHER)).toEqual({items:[],total:0});
   expect(()=>sql(`set role anon; select fn_vocabulario_de_tags_pagina('${GOV_ORG}');`)).toThrow();
 });
 it("o banco também limita tamanho e corrige deslocamento negativo",()=>{
   expect(page(-2,10000).items).toHaveLength(200);
 });
});
