import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelRoutingForm } from "./_channels-form";
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock("@/hooks/i18n/useT",()=>({useT:()=>(s:string)=>s}));
const fetcher=vi.fn();
beforeEach(()=>{vi.stubGlobal("fetch",fetcher);fetcher.mockReset();fetcher.mockResolvedValue({ok:true,json:async()=>({data:{mode:"restricted_empty",user_ids:[]}})});});
const initial={channels:[{id:"a",display_name:"Número A",phone_number:null,user_ids:["ana"],mode:"restricted" as const},{id:"b",display_name:"Número B",phone_number:null,user_ids:[],mode:"legacy_unconfigured" as const}],members:[{id:"ana",name:"Ana"},{id:"bruno",name:"Bruno"}]};
describe("responsáveis por número na tela",()=>{
 it("salvar lista vazia é explícito e não altera o número vizinho",async()=>{
  render(<ChannelRoutingForm initial={initial}/>);
  const a=within(screen.getByRole("group",{name:"Número A"}));
  fireEvent.click(a.getByRole("checkbox",{name:"Ana"}));fireEvent.click(a.getByRole("button",{name:"Salvar responsáveis"}));
  await waitFor(()=>expect(a.getByText("Ninguém configurado — as conversas ficarão na fila.")).toBeVisible());
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({channel_session_id:"a",user_ids:[],reset:false});
  expect(within(screen.getByRole("group",{name:"Número B"})).getByText("Usa todos os atendentes elegíveis da organização.")).toBeVisible();
 });
 it("voltar ao padrão envia reset; erro não anuncia salvo",async()=>{
  fetcher.mockResolvedValue({ok:false,json:async()=>({error:{message:"A equipe mudou."}})});
  render(<ChannelRoutingForm initial={initial}/>);
  fireEvent.click(within(screen.getByRole("group",{name:"Número A"})).getByRole("button",{name:"Voltar ao padrão da organização"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("A equipe mudou."));
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).reset).toBe(true);
  expect(screen.queryByText("Responsáveis salvos.")).not.toBeInTheDocument();
 });
});
