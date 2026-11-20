import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelRoutingForm } from "./_channels-form";
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock("@/hooks/i18n/useT",()=>({useT:()=>(s:string)=>s}));
const fetcher=vi.fn();
beforeEach(()=>{vi.stubGlobal("fetch",fetcher);fetcher.mockReset();fetcher.mockResolvedValue({ok:true,json:async()=>({data:{mode:"restricted_empty",user_ids:[]}})});});
const initial={
 channels:[
  {id:"a",display_name:"Número A",phone_number:null,user_ids:["ana"],mode:"restricted" as const,distribution_mode:"round_robin" as const,default_assignee_user_id:"ana"},
  {id:"b",display_name:"Número B",phone_number:null,user_ids:[],mode:"legacy_unconfigured" as const,distribution_mode:null,default_assignee_user_id:null},
 ],
 members:[{id:"ana",name:"Ana"},{id:"bruno",name:"Bruno"}]};
const corpo=()=>JSON.parse(fetcher.mock.calls[0]![1].body);
describe("responsáveis por número na tela",()=>{
 it("salvar lista vazia é explícito e não altera o número vizinho",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  const a=within(screen.getByRole("group",{name:"Número A"}));
  fireEvent.click(a.getByRole("checkbox",{name:"Ana"}));fireEvent.click(a.getByRole("button",{name:"Salvar responsáveis"}));
  await waitFor(()=>expect(a.getByText("Ninguém configurado — as conversas ficarão na fila.")).toBeVisible());
  expect(corpo()).toEqual({channel_session_id:"a",user_ids:[],reset:false,distribution_mode:"round_robin",default_assignee_user_id:"ana"});
  expect(within(screen.getByRole("group",{name:"Número B"})).getByText("Usa todos os atendentes elegíveis da organização.")).toBeVisible();
 });
 it("voltar ao padrão envia reset; erro não anuncia salvo",async()=>{
  fetcher.mockResolvedValue({ok:false,json:async()=>({error:{message:"A equipe mudou."}})});
  render(<ChannelRoutingForm initial={initial}/>);
  fireEvent.click(within(screen.getByRole("group",{name:"Número A"})).getByRole("button",{name:"Voltar ao padrão da organização"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("A equipe mudou."));
  expect(corpo().reset).toBe(true);
  expect(screen.queryByText("Responsáveis salvos.")).not.toBeInTheDocument();
 });
 // ─── Issue #2331: modo e destino padrão POR NÚMERO ───
 it("número sem regra própria sai do formulário sem regra (herda a organização)",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  const b=within(screen.getByRole("group",{name:"Número B"}));
  expect(b.getByTestId("modo-do-numero-b")).toHaveValue("");
  fireEvent.click(b.getByRole("button",{name:"Salvar responsáveis"}));
  await waitFor(()=>expect(fetcher).toHaveBeenCalled());
  expect(corpo()).toEqual({channel_session_id:"b",user_ids:[],reset:false,distribution_mode:null,default_assignee_user_id:null});
 });
 it("escolher modo e destino de UM número não encosta no outro",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  const b=within(screen.getByRole("group",{name:"Número B"}));
  // O destino só destrava depois de o número ter modo próprio: sem modo não há
  // distribuição de que o destino seja exceção.
  expect(b.getByTestId("destino-do-numero-b")).toBeDisabled();
  fireEvent.change(b.getByTestId("modo-do-numero-b"),{target:{value:"manual"}});
  expect(b.getByTestId("destino-do-numero-b")).not.toBeDisabled();
  fireEvent.change(b.getByTestId("destino-do-numero-b"),{target:{value:"bruno"}});
  fireEvent.click(b.getByRole("button",{name:"Salvar responsáveis"}));
  await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
  expect(corpo()).toEqual({channel_session_id:"b",user_ids:[],reset:false,distribution_mode:"manual",default_assignee_user_id:"bruno"});
  // O número A continua com a regra dele no estado do formulário.
  const a=within(screen.getByRole("group",{name:"Número A"}));
  expect(a.getByTestId("modo-do-numero-a")).toHaveValue("round_robin");
  expect(a.getByTestId("destino-do-numero-a")).toHaveValue("ana");
 });
 it("voltar o modo para o padrão da organização limpa o destino padrão junto",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  const a=within(screen.getByRole("group",{name:"Número A"}));
  fireEvent.change(a.getByTestId("modo-do-numero-a"),{target:{value:""}});
  expect(a.getByTestId("destino-do-numero-a")).toBeDisabled();
  fireEvent.click(a.getByRole("button",{name:"Salvar responsáveis"}));
  await waitFor(()=>expect(fetcher).toHaveBeenCalled());
  expect(corpo()).toEqual({channel_session_id:"a",user_ids:["ana"],reset:false,distribution_mode:null,default_assignee_user_id:null});
 });
 it("o prazo de espera pela IA é do número: digitado vai no corpo, apagado desliga (#3966)",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  const a=within(screen.getByRole("group",{name:"Número A"}));
  // Desligado de fábrica: o campo nasce vazio.
  expect(a.getByTestId("espera-pela-ia-a")).toHaveValue(null);
  fireEvent.change(a.getByTestId("espera-pela-ia-a"),{target:{value:"60"}});
  fireEvent.click(a.getByRole("button",{name:"Salvar responsáveis"}));
  await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
  expect(corpo().ai_wait_minutes).toBe(60);
  // O número vizinho não foi tocado.
  expect(within(screen.getByRole("group",{name:"Número B"})).getByTestId("espera-pela-ia-b")).toHaveValue(null);
  // Espera o salvamento terminar: enquanto ele corre, o bloco fica travado.
  await waitFor(()=>expect(a.getByRole("button",{name:"Salvar responsáveis"})).toBeEnabled());
  fetcher.mockClear();
  fireEvent.change(a.getByTestId("espera-pela-ia-a"),{target:{value:""}});
  fireEvent.click(a.getByRole("button",{name:"Salvar responsáveis"}));
  await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
  expect(corpo().ai_wait_minutes).toBeNull();
 });
});
