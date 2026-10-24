import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { McpContext } from "./types";
import type { PropostaDeAgenda } from "@/lib/agenda/pedido";
import type * as Consulta from "@/lib/agenda/consulta";

const mocks = vi.hoisted(() => ({ consulta: vi.fn(), criar: vi.fn(), alterar: vi.fn(), cancelar: vi.fn(), tipo: vi.fn(), fronteira: vi.fn() }));
vi.mock("@/lib/agenda/consulta", async original => ({
  ...await original<typeof Consulta>(),
  horariosLivresDaOrg:mocks.consulta, idDoTipoPorSlug:mocks.tipo,
}));
vi.mock("@/lib/atendimento/fronteira-server", () => ({ guardServiceEffect:mocks.fronteira }));
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler:mocks.criar, alterarAgendamentoHandler:mocks.alterar, cancelarAgendamentoHandler:mocks.cancelar,
}));
import { crmBookAppointment, crmFindAndBookAppointment, crmRescheduleAppointment, crmCancelAppointment } from "./tools/agendamento";

const CONTACT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const WHEN = "2026-10-16T17:40:00.000Z";
const consulta = { ok:true as const, slots:[{ inicio:new Date(WHEN),fim:new Date("2026-10-16T18:20:00Z") }],
  fusoDaRegra:"America/Sao_Paulo", publicouHorarios:true,fusoSuposto:false,fontesDefasadas:[],agendaExternaNuncaLida:false,googleCoberturaParcial:false };

function bancada() {
  const reads: Array<{ table:string;key:string;value:unknown }> = [];
  const reserva = { contact_id:CONTACT,event_type_id:"servico",owner_user_id:null,participant_name:null,status:"confirmed",revision:2,starts_at:"2026-10-16T15:00:00Z",ends_at:"2026-10-16T15:40:00Z",time_zone:"America/Sao_Paulo" };
  const from = vi.fn((table:string) => {
    const chain = { select: () => chain,eq:(key:string,value:unknown) => { reads.push({table,key,value});return chain; },
      maybeSingle:async () => ({ data:table==="calendar_appointments" ? reserva : { name:"Consulta",slug:"consulta" },error:null }) };
    return chain;
  });
  const reviewer = vi.fn(async (op:PropostaDeAgenda) =>
    op.inicio===WHEN && op.servico==="Consulta (consulta)" && op.beneficiarios.length===1 && op.beneficiarios[0]==="contato_atendido");
  const ctx: McpContext = { organizationId:"org-a", role:"ai_operator", actor:{type:"ai_agent",id:"agente",role:"ai_operator"},
    apiTokenId:"ephemeral",requestId:"job",sourceJobId:"job",contatoDoTurno:CONTACT,conferirPedidoAgenda:reviewer,
    supabase:{from} as unknown as SupabaseClient };
  return { ctx,reviewer,reads,reserva,from };
}

beforeEach(() => {
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-16T09:00:00Z"));vi.clearAllMocks();
  mocks.consulta.mockResolvedValue(consulta);mocks.tipo.mockResolvedValue({id:"servico"});
  mocks.criar.mockResolvedValue({id:"reserva",status:"confirmed",starts_at:WHEN,time_zone:"America/Sao_Paulo"});
  mocks.alterar.mockResolvedValue({id:"reserva",starts_at:WHEN,time_zone:"America/Sao_Paulo"});
});
afterEach(() => vi.useRealTimers());

describe("pedido e fuso antes da escrita de agenda", () => {
  it("14h40 local na conjunta usa o UTC do slot e verifica antes da escrita", async () => {
    const b=bancada();
    const r=await crmFindAndBookAppointment.handler({event_type_slug:"consulta",dia:"2026-10-16",horario:"14:40",contact_id:CONTACT},b.ctx);
    expect(r).toMatchObject({marcado:true,inicio:WHEN});
    expect(b.reviewer).toHaveBeenCalledWith(expect.objectContaining({inicio:WHEN,dia:"2026-10-16",horario:"14:40",fuso:"America/Sao_Paulo",acao:"criar"}));
    expect(b.reviewer.mock.invocationCallOrder[0]).toBeLessThan(mocks.criar.mock.invocationCallOrder[0]!);
  });
  it.each([WHEN,"2026-10-16T14:40:00-03:00"])("UTC/offset correto permanece o mesmo instante: %s", async starts_at => {
    const b=bancada();
    expect(await crmBookAppointment.handler({event_type_slug:"consulta",starts_at,contact_id:CONTACT},b.ctx)).toMatchObject({marcado:true});
    expect(mocks.criar.mock.calls[0]![2].starts_at).toBe(WHEN);
    expect(mocks.criar.mock.calls[0]![1].sourceJobId).toBe("job");
  });
  it.each([
    {starts_at:"2026-10-16T14:40:00Z"},
    {starts_at:"2026-10-17T17:40:00Z"},
    {starts_at:WHEN,participants:["Outra pessoa"]},
  ])("recusa operação divergente sem chegar ao escritor/Google: %j", async extra => {
    const b=bancada();
    expect(await crmBookAppointment.handler({event_type_slug:"consulta",contact_id:CONTACT,...extra},b.ctx)).toMatchObject({marcado:false,motivo:"agenda_pedido_divergente_ou_incerto"});
    expect(mocks.criar).not.toHaveBeenCalled();
    if(extra.starts_at==="2026-10-16T14:40:00Z") expect(b.reviewer).toHaveBeenCalledWith(expect.objectContaining({horario:"11:40"}));
  });
  it("outro serviço não herda a escolha", async () => {
    const b=bancada();b.reviewer.mockResolvedValue(false);
    expect(await crmBookAppointment.handler({event_type_slug:"outro-servico",starts_at:WHEN,contact_id:CONTACT},b.ctx)).toMatchObject({marcado:false});
    expect(mocks.criar).not.toHaveBeenCalled();
  });
  it("revisão de serviço conferida vai ao escritor atômico e não vem só do modelo", async () => {
    const b=bancada();mocks.consulta.mockResolvedValue({...consulta,servico:{event_type_id:"servico",booking_mode:"collective_unlimited",revision:3,availability:[]}});
    await crmBookAppointment.handler({event_type_slug:"consulta",starts_at:WHEN,contact_id:CONTACT},b.ctx);
    expect(mocks.criar.mock.calls[0]![2]).toMatchObject({expected_service_revision:3});
    mocks.criar.mockClear();
    expect(await crmBookAppointment.handler({event_type_slug:"consulta",starts_at:WHEN,contact_id:CONTACT,expected_service_revision:2},b.ctx)).toMatchObject({marcado:false,motivo:"agenda_servico_alterado"});
    expect(mocks.criar).not.toHaveBeenCalled();
  });
  it("outro contato e horário passado não pagam revisão nem escrevem", async () => {
    const b=bancada();
    for(const args of [{contact_id:OTHER,starts_at:WHEN},{contact_id:CONTACT,starts_at:"2026-10-15T17:40:00Z"}]) {
      expect(await crmBookAppointment.handler({event_type_slug:"consulta",...args},b.ctx)).toMatchObject({marcado:false});
    }
    expect(b.reviewer).not.toHaveBeenCalled();expect(mocks.criar).not.toHaveBeenCalled();
  });
  it("revisor ausente, incerto ou campo não booleano não concedem autorização", async () => {
    const b=bancada();
    delete b.ctx.conferirPedidoAgenda;
    expect(await crmBookAppointment.handler({event_type_slug:"consulta",starts_at:WHEN,contact_id:CONTACT},b.ctx)).toMatchObject({marcado:false});
    b.ctx.conferirPedidoAgenda=async () => "true" as unknown as boolean;
    expect(await crmBookAppointment.handler({event_type_slug:"consulta",starts_at:WHEN,contact_id:CONTACT},b.ctx)).toMatchObject({marcado:false});
    expect(mocks.criar).not.toHaveBeenCalled();
  });
  it("remarca a mesma reserva só após comparar o destino ao pedido", async () => {
    const b=bancada();
    expect(await crmRescheduleAppointment.handler({appointment_id:"reserva",new_starts_at:"2026-10-16T14:40:00Z"},b.ctx)).toMatchObject({remarcado:false});
    expect(mocks.alterar).not.toHaveBeenCalled();
    expect(await crmRescheduleAppointment.handler({appointment_id:"reserva",new_starts_at:WHEN},b.ctx)).toMatchObject({remarcado:true});
    expect(mocks.alterar.mock.calls[0]![2]).toMatchObject({id:"reserva",starts_at:WHEN,revision:2});
    expect(b.reads.filter(x=>x.key==="organization_id").every(x=>x.value==="org-a")).toBe(true);
  });
  it("origem vem da reserva relida, destino permanece a escolha nova; não expõe ID", async () => {
    const b=bancada();
    expect(await crmRescheduleAppointment.handler({appointment_id:"reserva",new_starts_at:WHEN},b.ctx)).toMatchObject({remarcado:true});
    expect(b.reviewer).toHaveBeenCalledWith(expect.objectContaining({acao:"remarcar",inicio:WHEN,horario:"14:40",
      reserva_atual:{inicio:"2026-10-16T15:00:00.000Z",fim:"2026-10-16T15:40:00.000Z",fuso:"America/Sao_Paulo",
        dia:"2026-10-16",horario:"12:00",quando:expect.any(String),estado:"confirmed",revisao:2}}));
    expect(JSON.stringify(b.reviewer.mock.calls[0]![0])).not.toContain('"reserva"');
    expect(mocks.alterar.mock.calls[0]![2]).toMatchObject({id:"reserva",revision:2});
  });
  it("duas remarcações releem a última origem e a revisão, sem criar outra reserva",async()=>{
    const b=bancada();b.reviewer.mockResolvedValue(true);
    expect(await crmRescheduleAppointment.handler({appointment_id:"reserva",new_starts_at:WHEN},b.ctx)).toMatchObject({remarcado:true});
    Object.assign(b.reserva,{starts_at:WHEN,ends_at:"2026-10-16T18:20:00Z",revision:3});
    expect(await crmRescheduleAppointment.handler({appointment_id:"reserva",new_starts_at:"2026-10-16T22:20:00Z"},b.ctx)).toMatchObject({remarcado:true});
    expect(b.reviewer.mock.calls[1]![0]).toMatchObject({inicio:"2026-10-16T22:20:00.000Z",horario:"19:20",
      reserva_atual:{inicio:WHEN,horario:"14:40",revisao:3}});
    expect(mocks.alterar.mock.calls.map(c=>({id:c[2].id,revision:c[2].revision}))).toEqual([{id:"reserva",revision:2},{id:"reserva",revision:3}]);
    expect(mocks.criar).not.toHaveBeenCalled();expect(mocks.cancelar).not.toHaveBeenCalled();
  });
  it.each([{starts_at:"inválido"},{ends_at:"2026-10-16T14:00Z"},{time_zone:"fuso-inválido"},{revision:0}])(
    "origem essencial inválida %j recusa sem revisão/efeito",async patch=>{
      const b=bancada();Object.assign(b.reserva,patch);
      expect(await crmRescheduleAppointment.handler({appointment_id:"reserva",new_starts_at:WHEN},b.ctx))
        .toMatchObject({remarcado:false,motivo:"agenda_pedido_origem_nao_conferida"});
      expect(b.reviewer).not.toHaveBeenCalled();expect(mocks.alterar).not.toHaveBeenCalled();
    });
  it("reserva cancelada ou de outro contato não pode ser remarcada", async () => {
    const b=bancada();b.reserva.status="cancelled";
    expect(await crmRescheduleAppointment.handler({appointment_id:"reserva",new_starts_at:WHEN},b.ctx)).toMatchObject({remarcado:false});
    b.reserva.status="confirmed";b.reserva.contact_id=OTHER;
    expect(await crmRescheduleAppointment.handler({appointment_id:"reserva",new_starts_at:WHEN},b.ctx)).toMatchObject({remarcado:false});
    expect(mocks.alterar).not.toHaveBeenCalled();
  });
  it("cancelar não vira nova reserva nem exige revisão de um horário novo", async () => {
    const b=bancada();mocks.cancelar.mockResolvedValue({id:"reserva",status:"cancelled"});
    expect(await crmCancelAppointment.handler({appointment_id:"reserva",reason:"Cliente desistiu"},b.ctx)).toMatchObject({cancelado:true});
    expect(b.reviewer).not.toHaveBeenCalled();expect(mocks.criar).not.toHaveBeenCalled();
  });
  it.each([0,1,2])("cancela a mesma reserva após %i remarcações sem cancelar/criar para mover",async vezes=>{
    const b=bancada();b.reviewer.mockResolvedValue(true);
    for(const inicio of [WHEN,"2026-10-16T22:20:00.000Z"].slice(0,vezes)){
      expect(await crmRescheduleAppointment.handler({appointment_id:"reserva",new_starts_at:inicio},b.ctx)).toMatchObject({remarcado:true});
      Object.assign(b.reserva,{starts_at:inicio,ends_at:new Date(Date.parse(inicio)+40*60_000).toISOString(),revision:b.reserva.revision+1});
    }
    mocks.cancelar.mockResolvedValue({id:"reserva",status:"cancelled"});
    expect(await crmCancelAppointment.handler({appointment_id:"reserva",reason:"Cliente desistiu"},b.ctx)).toMatchObject({cancelado:true});
    expect(mocks.alterar).toHaveBeenCalledTimes(vezes);expect(mocks.cancelar).toHaveBeenCalledOnce();
    expect(mocks.cancelar.mock.calls[0]![2]).toMatchObject({id:"reserva",reason:"Cliente desistiu"});
    expect(mocks.criar).not.toHaveBeenCalled();expect(b.reviewer).toHaveBeenCalledTimes(vezes);
  });
  it("API externa sem conversa preserva UTC e não consulta contexto de cliente", async () => {
    const b=bancada();delete b.ctx.contatoDoTurno;
    expect(await crmBookAppointment.handler({event_type_slug:"consulta",starts_at:WHEN,contact_id:CONTACT},b.ctx)).toMatchObject({marcado:true});
    expect(b.from).not.toHaveBeenCalled();expect(b.reviewer).not.toHaveBeenCalled();
  });
});


describe('origem autenticada acompanha somente a remarcação efetivamente condicionada',()=>{
 it('liga a releitura anterior ao resultado CAS da mesma reserva para a revisão posterior',async()=>{
  const b=bancada();mocks.alterar.mockResolvedValue({id:'reserva',starts_at:WHEN,ends_at:'2026-10-16T18:20:00Z',time_zone:'America/Sao_Paulo',revision:3,status:'confirmed'});
  const r=await crmRescheduleAppointment.handler({appointment_id:'reserva',new_starts_at:WHEN,notes:'Texto livre não prova origem.'},b.ctx);
  expect(r).toMatchObject({remarcado:true,origem_remarcacao:{reserva_id:'reserva',inicio:new Date(b.reserva.starts_at).toISOString(),fim:new Date(b.reserva.ends_at).toISOString(),fuso:b.reserva.time_zone,revisao:2,estado:'confirmed'}});
  expect(mocks.alterar.mock.calls[0]![2]).toMatchObject({revision:2});
 });
 it.each([{id:'outra'},{revision:4},{starts_at:'2026-10-16T22:20:00Z'}])('resposta divergente não ganha prova de transição: %j',patch=>{
  // O escritor é controlado aqui; não simulamos uma execução correta com fonte divergente.
  const b=bancada();mocks.alterar.mockResolvedValue({id:'reserva',starts_at:WHEN,ends_at:'2026-10-16T18:20:00Z',time_zone:'America/Sao_Paulo',revision:3,status:'confirmed',...patch});
  return expect(crmRescheduleAppointment.handler({appointment_id:'reserva',new_starts_at:WHEN},b.ctx)).resolves.not.toHaveProperty('origem_remarcacao');
 });
 it('chamada externa sem releitura de pedido não inventa origem ou decisão humana',async()=>{
  const b=bancada();delete b.ctx.contatoDoTurno;mocks.alterar.mockResolvedValue({id:'reserva',starts_at:WHEN,revision:3});
  expect(await crmRescheduleAppointment.handler({appointment_id:'reserva',new_starts_at:WHEN},b.ctx)).not.toHaveProperty('origem_remarcacao');
 });
});


describe('regra de confirmação do serviço acompanha a revisão da proposta',()=>{
 it.each([false,true])('leva a exigência %s da consulta atual, sem aceitar uma dispensa do modelo',async requires_confirmation=>{
  const b=bancada();mocks.consulta.mockResolvedValue({...consulta,servico:{event_type_id:'servico',booking_mode:'collective_unlimited',revision:7,requires_confirmation,availability:[]}});
  await crmBookAppointment.handler({event_type_slug:'consulta',starts_at:WHEN,contact_id:CONTACT,expected_service_revision:7},b.ctx);
  expect(b.reviewer).toHaveBeenCalledWith(expect.objectContaining({politica_do_servico:{confirmacao_equipe_exigida:requires_confirmation,revisao_regra:7}}));
  expect(mocks.criar.mock.calls[0]![2].expected_service_revision).toBe(7);
 });
 it('ausência da regra não fabrica dispensa nem muda o fluxo individual',async()=>{
  const b=bancada();await crmBookAppointment.handler({event_type_slug:'consulta',starts_at:WHEN,contact_id:CONTACT},b.ctx);
  expect(b.reviewer.mock.calls[0]![0]).not.toHaveProperty('politica_do_servico');
  expect(mocks.criar).toHaveBeenCalledTimes(1);
 });
 it('mudança de revisão recusa antes do modelo, sem herdar regra antiga',async()=>{
  const b=bancada();mocks.consulta.mockResolvedValue({...consulta,servico:{event_type_id:'servico',booking_mode:'collective_unlimited',revision:8,requires_confirmation:true,availability:[]}});
  expect(await crmBookAppointment.handler({event_type_slug:'consulta',starts_at:WHEN,contact_id:CONTACT,expected_service_revision:7},b.ctx)).toMatchObject({marcado:false,motivo:'agenda_servico_alterado'});
  expect(b.reviewer).not.toHaveBeenCalled();expect(mocks.criar).not.toHaveBeenCalled();
 });
});
