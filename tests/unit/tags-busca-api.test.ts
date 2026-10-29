import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { GET as contacts } from "@/app/api/v1/contact-tags/route";
import { GET as conversations } from "@/app/api/v1/conversation-tags/route";
import { GET as vocabulary, POST as operar } from "@/app/api/v1/tags/vocabulario/route";
vi.mock("@/lib/auth/require-role",()=>({requireRole:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createClient:vi.fn()}));
vi.mock("@/lib/auth/server",()=>({mfaEmDivida:vi.fn().mockResolvedValue(false)}));
vi.mock("@/lib/audit",()=>({audit:vi.fn()}));
vi.mock("@/lib/impersonate/support",()=>({requireSupportWrite:vi.fn().mockResolvedValue(null)}));
const rpc=vi.fn();
const row={tag:"Loja Z — 2024",uso_em_contatos:0,uso_em_leads:0,uso_em_conversas:0,em_regras:0,cor:null,descricao:null,no_vocabulario:true};
const routes=[['contato',contacts],['conversa',conversations],['vocabulário',vocabulary]] as const;
beforeEach(()=>{
 rpc.mockReset().mockResolvedValue({data:{total:717,items:[row]},error:null});
 vi.mocked(requireRole).mockResolvedValue({ok:true,user:{id:'usuario-da-sessao'},org:{orgId:'org-da-sessao',role:'manager'}} as never);
 vi.mocked(createClient).mockResolvedValue({rpc} as never);
});
describe.each(routes)('busca de %s',(_,get)=>{
 it('usa organização da sessão, sem exigir contatos portando a etiqueta',async()=>{
  const response=await get(new NextRequest('http://x?busca=loja&organization_id=org-injetada'));
  expect(response.status).toBe(200);
  expect(rpc).toHaveBeenCalledWith('fn_vocabulario_de_tags_pagina',expect.objectContaining({p_org:'org-da-sessao',p_busca:'loja'}));
  const data=await response.json();expect(data.data).toHaveLength(1);
 });
 it('recusa busca enorme antes da consulta',async()=>{
  const response=await get(new NextRequest('http://x?busca='+ 'x'.repeat(61)));
  expect(response.status).toBe(422);expect(rpc).not.toHaveBeenCalled();
 });
 it('falha de banco e contrato inválido não viram lista vazia',async()=>{
  rpc.mockResolvedValueOnce({data:null,error:{message:'queda'}});
  expect((await get(new NextRequest('http://x?busca=loja'))).status).toBe(500);
  rpc.mockResolvedValueOnce({data:{items:[]},error:null});
  expect((await get(new NextRequest('http://x?busca=loja'))).status).toBe(500);
 });
 it('sessão sem autorização não faz consulta',async()=>{
  vi.mocked(requireRole).mockResolvedValue({ok:false,response:new Response('',{status:403})} as never);
  expect((await get(new NextRequest('http://x?busca=loja'))).status).toBe(403);
  expect(rpc).not.toHaveBeenCalled();
 });
});
it('gerência informa total verdadeiro e desloca a página 8',async()=>{
 const response=await vocabulary(new NextRequest('http://x?page=8&busca='));
 const data=await response.json();expect(data.meta.total).toBe(717);expect(data.meta.page).toBe(8);
 expect(rpc).toHaveBeenCalledWith('fn_vocabulario_de_tags_pagina',{p_org:'org-da-sessao',p_busca:'',p_offset:700,p_limit:100});
});

describe("juntar só leva para uma etiqueta que existe (#2855)",()=>{
 const juntar=(destino:string)=>operar(new NextRequest("http://x",{method:"POST",
  body:JSON.stringify({acao:"juntar",tag:"loja",destino}),headers:{"Content-Type":"application/json"}}));
 it("destino que não existe é recusado antes da operação",async()=>{
  const response=await juntar("nome-que-nao-existe");
  expect(response.status).toBe(422);
  expect((await response.json()).error.code).toBe("destino_inexistente");
  expect(rpc).toHaveBeenCalledWith("fn_vocabulario_de_tags_pagina",{p_org:"org-da-sessao",p_busca:"nome-que-nao-existe",p_offset:0,p_limit:200});
  expect(rpc.mock.calls.map(c=>c[0])).not.toContain("fn_vocabulario_de_tags_operar");
 });
 it("destino que existe, em outra caixa, segue para a operação",async()=>{
  const response=await juntar("loja z — 2024");
  expect(response.status).toBe(200);
  expect(rpc).toHaveBeenCalledWith("fn_vocabulario_de_tags_operar",expect.objectContaining({p_acao:"juntar",p_destino:"loja z — 2024"}));
 });
 it("falha na conferência não vira junção às cegas",async()=>{
  rpc.mockResolvedValueOnce({data:null,error:{message:"queda"}});
  expect((await juntar("loja z — 2024")).status).toBe(500);
  expect(rpc.mock.calls.map(c=>c[0])).not.toContain("fn_vocabulario_de_tags_operar");
 });
});
