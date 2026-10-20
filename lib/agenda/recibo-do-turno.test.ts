import {describe,it,expect} from 'vitest';
import {criarObservacaoDaAgenda,projetarResultadoAgendaDoTurno} from './recibo-do-turno';

const fonte=(id='atual',v:unknown=2,estado='cancelled')=>({id,origem:'agenda_persistida',estado:'verified',dados:{revisao_reserva:v,estado}});
describe('vínculo factual da operação de agenda do turno',()=>{
  it.each([
    ['crm_book_appointment','marcado','criar','confirmed'],
    ['crm_find_and_book_appointment','marcado','criar','pending'],
    ['crm_reschedule_appointment','remarcado','remarcar','confirmed'],
    ['crm_cancel_appointment','cancelado','cancelar','cancelled'],
  ])('observa o resultado nativo %s e aponta a revisão relida', (nome,sinal,acao,estado)=>{
    const r=criarObservacaoDaAgenda(),seq=r.iniciar();
    r.concluir(seq,nome,{[sinal]:true,compromisso:{id:'atual',revision:'2'}});
    expect(projetarResultadoAgendaDoTurno(r.atual(),{operacoes:[fonte('antiga'),fonte('atual',2,estado)]}))
      .toMatchObject({acao_observada:acao,referencia_recibo:'fonte_2',revisao_relida:2});
  });
  it.each([{}, {cancelado:'true'}, {cancelado:true,ok:false}, {cancelado:true,isError:true},
    {cancelado:true,error:'recusado'}, {cancelado:true,compromisso:{id:'atual',revision:null}},
    {cancelado:true,compromisso:{id:'atual',revision:0}}, {cancelado:true,compromisso:{id:'atual',revision:1.5}}])
  ('não toma erro, ausência ou coerção como efeito: %j',resultado=>{
    const r=criarObservacaoDaAgenda(),seq=r.iniciar();r.concluir(seq,'crm_cancel_appointment',resultado);expect(r.atual()).toBeUndefined();
  });
  it('consulta ou ferramenta desconhecida não atesta escrita',()=>{
    const r=criarObservacaoDaAgenda(),seq=r.iniciar();r.concluir(seq,'crm_list_appointments',{cancelado:true,compromisso:{id:'atual',revision:2}});expect(r.atual()).toBeUndefined();
  });
  it.each([
    {operacoes:[]}, {operacoes:[fonte('outra')]}, {operacoes:[fonte('atual',1)]},
    {operacoes:[fonte('atual',3)]}, {operacoes:[fonte('atual',2,'confirmed')]},
    {operacoes:[{...fonte(),estado:'recorded'}]}, {operacoes:[fonte(),fonte()]},
  ])('recibo ausente, divergente, não verificado ou ambíguo não ganha vínculo',contexto=>{
    expect(projetarResultadoAgendaDoTurno({acao:'cancelar',reservaId:'atual',revisao:2},contexto)).toBeUndefined();
  });
  it('uma remarcação, outra remarcação e cancelamento usam só a última revisão',()=>{
    const r=criarObservacaoDaAgenda();
    for(const [i,nome,sinal] of [[2,'crm_reschedule_appointment','remarcado'],[3,'crm_reschedule_appointment','remarcado'],[4,'crm_cancel_appointment','cancelado']] as const){
      const seq=r.iniciar();r.concluir(seq,nome,{[sinal]:true,compromisso:{id:'atual',revision:i}});
      expect(r.atual()?.revisao).toBe(i);
    }
    expect(projetarResultadoAgendaDoTurno(r.atual(),{operacoes:[fonte('atual',4)]})).toMatchObject({acao_observada:'cancelar',revisao_relida:4});
    const seq=r.iniciar();expect(r.atual()).toBeUndefined();r.concluir(seq,'crm_reschedule_appointment',{remarcado:false});expect(r.atual()).toBeUndefined();
  });
  it('resultado atrasado de outra chamada não substitui a última tentativa',()=>{
    const r=criarObservacaoDaAgenda(),a=r.iniciar(),b=r.iniciar();
    r.concluir(b,'crm_cancel_appointment',{cancelado:true,compromisso:{id:'atual',revision:4}});
    r.concluir(a,'crm_reschedule_appointment',{remarcado:true,compromisso:{id:'atual',revision:3}});
    expect(r.atual()).toEqual({acao:'cancelar',reservaId:'atual',revisao:4});
  });
  it('cada turno tem estado próprio e retornos não permitem mutar o registro',()=>{
    const a=criarObservacaoDaAgenda(),b=criarObservacaoDaAgenda(),seq=a.iniciar();a.concluir(seq,'crm_cancel_appointment',{cancelado:true,compromisso:{id:'atual',revision:2}});
    const registro=a.atual()!;registro.reservaId='forjado';expect(a.atual()?.reservaId).toBe('atual');expect(b.atual()).toBeUndefined();
  });
});

it('o quadro externo conserva o scrub e não revela UUIDs no texto do recibo',()=>{
 const ctx={operacoes:[{...fonte(),dados:{...fonte().dados,titulo:'Sessão 11111111-1111-4111-8111-111111111111'}}]};
 const r=projetarResultadoAgendaDoTurno({acao:'cancelar',reservaId:'atual',revisao:2},ctx);
 expect(JSON.stringify(r)).not.toContain('11111111-1111-4111-8111-111111111111');
 expect(JSON.stringify(r)).toContain('[referencia_interna]');
});


describe('transição de remarcação observada na ponte nativa',()=>{
 const origem={reserva_id:'atual',inicio:'2030-07-03T13:00:00Z',fim:'2030-07-03T13:40:00Z',fuso:'America/Sao_Paulo',estado:'confirmed',revisao:1};
 const compromisso={id:'atual',starts_at:'2030-07-03T17:40:00Z',ends_at:'2030-07-03T18:20:00Z',time_zone:'America/Sao_Paulo',revision:2,status:'confirmed'};
 const atual=(c=compromisso)=>({id:c.id,origem:'agenda_persistida',estado:'verified',dados:{estado:c.status,revisao_reserva:c.revision,inicio:c.starts_at,fim:c.ends_at,fuso:c.time_zone}});
 function observar(o:unknown=origem,c=compromisso){
  const r=criarObservacaoDaAgenda();r.concluir(r.iniciar(),'crm_reschedule_appointment',{remarcado:true,origem_remarcacao:o,compromisso:c});return r;
 }
 it('conserva origem e destino da mesma escrita/revisão, sem exigir que origem seja o horário atual',()=>{
  const p=projetarResultadoAgendaDoTurno(observar().atual(),{operacoes:[fonte('antiga'),atual()]});
  expect(p).toMatchObject({acao_observada:'remarcar',referencia_recibo:'fonte_2',revisao_relida:2,transicao_remarcacao:{mesma_reserva:true,
   origem:{inicio:origem.inicio,revisao:1,inicio_local:'2030-07-03T10:00:00-03:00'},destino:{inicio:compromisso.starts_at,revisao:2,inicio_local:'2030-07-03T14:40:00-03:00'}}});
  expect(JSON.stringify(p)).not.toContain('reserva_id');
 });
 it.each([{reserva_id:'outra'},{revisao:2},{revisao:0},{inicio:'inválido'},{fim:'2030-07-03T12:00:00Z'},
  {fuso:'fuso-inválido'},{estado:'cancelled'},{inicio:compromisso.starts_at,fim:compromisso.ends_at}])('não atesta origem inválida ou de outro objeto: %j',patch=>{
  const p=projetarResultadoAgendaDoTurno(observar({...origem,...patch}).atual(),{operacoes:[atual()]});
  expect(p?.transicao_remarcacao).toBeUndefined();
 });
 it('a releitura do destino precisa corresponder à escrita observada; coincidência de revisão não basta',()=>{
  const c=atual();c.dados.inicio='2030-07-03T22:20:00Z';
  expect(projetarResultadoAgendaDoTurno(observar().atual(),{operacoes:[c]})?.transicao_remarcacao).toBeUndefined();
 });
 it('não fabrica origem para resultado legado ou consulta de estado',()=>{
  const r=criarObservacaoDaAgenda();r.concluir(r.iniciar(),'crm_reschedule_appointment',{remarcado:true,compromisso});
  const p=projetarResultadoAgendaDoTurno(r.atual(),{operacoes:[atual()]});expect(p?.transicao_remarcacao).toBeUndefined();expect(p?.recibo).toBeDefined();
 });
 it('cada remarcação sucessiva usa a origem mais recente e cancelamento não herda a transição',()=>{
  const r=observar();const segunda={...compromisso,starts_at:'2030-07-03T22:20:00Z',ends_at:'2030-07-03T23:00:00Z',revision:3};
  r.concluir(r.iniciar(),'crm_reschedule_appointment',{remarcado:true,compromisso:segunda,
   origem_remarcacao:{...origem,inicio:compromisso.starts_at,fim:compromisso.ends_at,revisao:2}});
  expect(projetarResultadoAgendaDoTurno(r.atual(),{operacoes:[atual(segunda)]})).toMatchObject({transicao_remarcacao:{origem:{revisao:2,inicio:compromisso.starts_at},destino:{revisao:3,inicio:segunda.starts_at}}});
  const copia=r.atual()!;if(copia.remarcacao)copia.remarcacao.origem.inicio='forjado';
  expect(projetarResultadoAgendaDoTurno(r.atual(),{operacoes:[atual(segunda)]})?.transicao_remarcacao).toMatchObject({origem:{inicio:compromisso.starts_at}});
  r.concluir(r.iniciar(),'crm_cancel_appointment',{cancelado:true,compromisso:{...segunda,status:'cancelled',revision:4},origem_remarcacao:origem});
  expect(projetarResultadoAgendaDoTurno(r.atual(),{operacoes:[fonte('atual',4)]})?.transicao_remarcacao).toBeUndefined();
 });
});


describe('contexto da retomada: prova de publicação separada de nova escrita',()=>{
 const publicado=(revision:number)=>({id:'atual',origem:'agenda_persistida',estado:'verified',dados:{estado:'confirmed',revisao_reserva:revision,publicacao_google:'synced',revisao_google_local:revision,revisao_google_publicada:revision,publicacao_pendente:false,motivo_publicacao:null,classificacao_falha:null}});
 it.each([1,2,3])('retoma a publicação da revisão %s sem fabricar origem ou outra escrita',revision=>{
  const obs=criarObservacaoDaAgenda({reservaId:'atual',revisao:revision});
  const packet=projetarResultadoAgendaDoTurno(obs.atual(),{operacoes:[publicado(revision)]});
  expect(packet).toMatchObject({acao_observada:'publicar',revisao_relida:revision,referencia_recibo:'fonte_1'});
  expect(packet?.significado).toBe('publicacao_nativa_da_revisao_do_pedido_nao_nova_escrita');
  expect(packet?.transicao_remarcacao).toBeUndefined();
 });
 it.each([{reservaId:'',revisao:2},{reservaId:'atual',revisao:0},{reservaId:'atual',revisao:1.5}])('dado inválido não inicializa prova: %j',bad=>{
  expect(criarObservacaoDaAgenda(bad).atual()).toBeUndefined();
 });
 it.each([{estado:'cancelled'},{publicacao_google:'pending'},{revisao_reserva:3},{revisao_google_publicada:1},{publicacao_pendente:true},{motivo_publicacao:'falha'},{classificacao_falha:'human_required'}])('publicação divergente ou pendente não vira prova: %j',patch=>{
  const c=publicado(2);Object.assign(c.dados,patch);
  expect(projetarResultadoAgendaDoTurno(criarObservacaoDaAgenda({reservaId:'atual',revisao:2}).atual(),{operacoes:[c]})).toBeUndefined();
 });
 it.each([2,3,4])('cancelamento na revisão %s não é retomada de publicação',revision=>{
  const c=publicado(revision);c.dados.estado='cancelled';c.dados.publicacao_google='removed';
  expect(projetarResultadoAgendaDoTurno(criarObservacaoDaAgenda({reservaId:'atual',revisao:revision}).atual(),{operacoes:[c]})).toBeUndefined();
 });
});

it('recuperação nativa publicada atualiza a prova sem aceitar resultado atrasado ou reviver escrita anterior',()=>{
 const obs=criarObservacaoDaAgenda(),seq=obs.iniciar();
 obs.publicar(seq,{reservaId:'atual',revisao:3});
 expect(obs.atual()).toEqual({acao:'publicar',reservaId:'atual',revisao:3});
 const next=obs.iniciar();obs.publicar(seq,{reservaId:'atrasada',revisao:2});expect(obs.atual()).toBeUndefined();
 obs.publicar(next,{reservaId:'',revisao:3});expect(obs.atual()).toBeUndefined();
 obs.concluir(next,'crm_cancel_appointment',{cancelado:true,compromisso:{id:'atual',revision:4}});
 expect(obs.atual()).toEqual({acao:'cancelar',reservaId:'atual',revisao:4});
});


it.each([1,2,3,4])('alcance do recibo na revisão %s não comprova ausência de outras reservas',revision=>{
 const obs=criarObservacaoDaAgenda();obs.concluir(obs.iniciar(),'crm_cancel_appointment',{cancelado:true,compromisso:{id:'atual',revision}});
 const packet=projetarResultadoAgendaDoTurno(obs.atual(),{operacoes:[fonte('atual',revision),fonte('outra',1,'confirmed')]});
 expect(packet).toMatchObject({acao_observada:'cancelar',revisao_relida:revision,alcance:'somente_reserva_e_revisao_relidas_nao_inventario_da_agenda'});
 expect(packet?.recibo).toMatchObject({estado:'cancelled'});
 // A outra reserva permanece: o resultado específico não atesta nem muda seu estado.
 expect(packet).not.toHaveProperty('sem_outras_reservas');
});


describe('leitura atual da agenda não inventa operação',()=>{
 const current=(id='atual')=>({...fonte(id,4),dados:{estado:'cancelled',revisao_reserva:4,revisao_google_local:4,revisao_google_publicada:4,publicacao_google:'removed',publicacao_pendente:false,motivo_publicacao:null,classificacao_falha:null,cancelada_em:'2026-11-22T12:00:00Z',natureza_cancelamento:'cancelamento_sincronizado_no_google'}});
 it('conserva referências de registros distintos sem escolher a primeira e sem IDs privados',async()=>{
  const {projetarLeiturasDeEstadoDaAgenda}=await import('./recibo-do-turno');
  const p=projetarLeiturasDeEstadoDaAgenda({operacoes:[fonte('historica',1,'pending'),current()]});
  expect(p).toEqual([{referencia_recibo:'fonte_2',revisao_relida:4,estado_relido:'cancelled'}]);
  expect(JSON.stringify(p)).not.toContain('atual');
 });
 it.each([{estado:'confirmed'},{publicacao_google:'pending'},{publicacao_pendente:true},{revisao_google_publicada:3},
  {motivo_publicacao:'erro'},{classificacao_falha:'human_required'},{cancelada_em:null},{cancelada_em:'inválida'},{revisao_reserva:0},
  {natureza_cancelamento:'cancelamento_salvo_sem_remocao_comprovada'}])('não apresenta estado incompleto/divergente como prova: %j',async patch=>{
   const {projetarLeiturasDeEstadoDaAgenda}=await import('./recibo-do-turno');const c=current();Object.assign(c.dados,patch);
   expect(projetarLeiturasDeEstadoDaAgenda({operacoes:[c]})).toEqual([]);
 });
 it('não apresenta fonte não verificada nem identidade duplicada',async()=>{
  const {projetarLeiturasDeEstadoDaAgenda}=await import('./recibo-do-turno');
  expect(projetarLeiturasDeEstadoDaAgenda({operacoes:[{...current(),estado:'recorded'}]})).toEqual([]);
  expect(projetarLeiturasDeEstadoDaAgenda({operacoes:[current(),current()]})).toEqual([]);
 });
});
