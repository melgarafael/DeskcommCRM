import { describe, expect, it } from 'vitest';
import { normalizarFontesDoAtendimento, projetarContextoDoAtendimento, criarFontesConsultadasDoTurno, type FontesDoAtendimento } from './contexto-do-atendimento';
import { montarContextoDaRevisao } from '../guardrails/promise/contexto-da-revisao';
const at='2026-10-09T12:00:00-03:00';
function base():FontesDoAtendimento { return { contato:{id:'contato',organization_id:'org'},negocios:[],notas:[],atividades:[],propostas:[],agenda:[],retornos:[],caso:[],conversa:{id:'conversa',organization_id:'org',contact_id:'contato',service_revision:1},
  job:{id:'job',organization_id:'org',contact_id:'contato',kind:'inbound_turn',status:'claimed',created_at:at,canonical_message:{id:'pedido-original',text:'É para Ana amanhã.',at,origem:'client_message'}} }; }
describe('T08 pedido, autoria e fotografia material',()=>{
  it('preserva mensagem canônica e data da fonte, sem eleger a fala mais recente',()=>{
    const f=base(),c=normalizarFontesDoAtendimento(f,'org');
    expect(c.pedido).toMatchObject({estado:'present',mensagem:{id:'pedido-original',at,text:'É para Ana amanhã.'}});
    f.job!.kind='case_reply_turn';f.job!.trigger_at='2026-10-10T13:00:00-03:00';
    const p=JSON.stringify(projetarContextoDoAtendimento(normalizarFontesDoAtendimento(f,'org')));
    expect(p).toContain(at);expect(p).toContain('evento_humano_sobre_pedido_original_nao_nova_mensagem_cliente');expect(p).not.toContain('pedido-original');
  });
  it('pedido ausente ou grande não é completado por palpite',()=>{
    const f=base();delete f.job!.canonical_message;
    expect(normalizarFontesDoAtendimento(f,'org').pedido!.estado).toBe('unavailable');
    f.job!.canonical_message={id:'pedido',text:'x'.repeat(8001)+'RESSALVA',at};
    expect(normalizarFontesDoAtendimento(f,'org').pedido).toMatchObject({estado:'excluded_by_limit',mensagem:null});
  });
  it('cancelamento do job, fronteira e política invalidam a fotografia',()=>{
    const f=base(),initial=normalizarFontesDoAtendimento(f,'org').fingerprint;
    f.job!.status='cancelled';expect(normalizarFontesDoAtendimento(f,'org').fingerprint).not.toBe(initial);
    f.job!.status='claimed';f.conversa!.current_demanda_id='outra';expect(normalizarFontesDoAtendimento(f,'org').fingerprint).not.toBe(initial);
    delete f.conversa!.current_demanda_id;f.policy={sources:[{id:'kb',active:false,version:'v2'}]};expect(normalizarFontesDoAtendimento(f,'org').fingerprint).not.toBe(initial);
  });
  it('retirada da memória e skill não ressuscita snapshot de abertura',()=>{
    const f=base();f.auxiliares=[];f.policy={skills:[]};const registry=criarFontesConsultadasDoTurno(at);
    registry.registrar('memoria_org','documento','ANTIGA');registry.registrar('skill_ativa','revogada','SKILL_ANTIGA');
    const c=registry.aplicar(normalizarFontesDoAtendimento(f,'org'));
    expect(JSON.stringify(c.perfil)).not.toContain('ANTIGA');expect(c.cobertura.find(x=>x.categoria==='perfil')!.estado).toBe('excluded_by_limit');
  });
  it('outbound desconhecida não ganha autoria humana; fila e veto não são antecedentes',()=>{
    const c=montarContextoDaRevisao([
      {direction:'outbound',body:'Foi aprovado',sent_at:at,status:'sent'},
      {direction:'outbound',body:'FILA_NAO_ENVIADA',status:'queued'},
      {direction:'outbound',body:'VETO_NAO_ENVIADO',status:'failed'},
      {direction:'inbound',body:'É para ela',sent_at:at,status:'received',author:'client'},
    ],null,'2026-10-10T16:00:00Z','America/Sao_Paulo');
    expect(c.mensagens).toHaveLength(2);expect(c.mensagens[0]).toMatchObject({autoria:'unknown_outbound',em:at,estado_envio:'sent'});
    expect(JSON.stringify(c)).not.toContain('NAO_ENVIAD');expect(c.fuso).toBe('America/Sao_Paulo');
  });
  it('reference perde validade junto com sua skill, inclusive sem corpo consultado',()=>{
    const f=base();f.policy={skills:[{version:'v1'}]};const registry=criarFontesConsultadasDoTurno(at);
    registry.registrar('referencia_skill','arquivo','REFERENCIA_ATUAL','v1');
    expect(registry.skillVersionIds()).toEqual(['v1']);
    expect(JSON.stringify(registry.aplicar(normalizarFontesDoAtendimento(f,'org')).perfil)).toContain('REFERENCIA_ATUAL');
    f.policy={skills:[{version:'v2'}]};const c=registry.aplicar(normalizarFontesDoAtendimento(f,'org'));
    expect(JSON.stringify(c.perfil)).not.toContain('REFERENCIA_ATUAL');expect(c.cobertura.find(x=>x.categoria==='perfil')!.estado).toBe('excluded_by_limit');
  });
});
