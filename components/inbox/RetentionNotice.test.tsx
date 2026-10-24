// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ptBR } from 'date-fns/locale';
const state=vi.hoisted(()=>({gate:'semantic_promise',code:'agenda_request_mismatch'}));
vi.mock('@/hooks/inbox/useRetention',()=>({useRetention:()=>({data:{
  retentions:[{id:'trace',created_at:'2030-01-01T12:00:00Z',vetoed_gate:state.gate,vetoed_code:state.code}],
  context:{window_start_hour:8,window_end_hour:21,allow_sunday:false,timezone:'America/Sao_Paulo'},
}})}));
vi.mock('@/hooks/i18n/useT',()=>({useT:()=>((s:string)=>s)}));
vi.mock('@/hooks/i18n/useLocaleDeData',()=>({useLocaleDeData:()=>ptBR}));
import { RetentionNotice } from './RetentionNotice';
afterEach(cleanup);
describe('origem do veto da API chega ao aviso',()=>{
  it.each([
    ['semantic_promise','agenda_request_mismatch','Resposta bloqueada pela revisão da IA'],
    ['pacing','warmup_cap','Resposta segurada pela proteção do número'],
    ['pacing','outside_window','Resposta retida pela janela de envio'],
    ['stop','contato_bloqueado','Resposta bloqueada por conformidade'],
    ['desconhecida','novo_codigo','Resposta não enviada'],
  ])('%s/%s identifica a origem real', (gate,code,title)=>{
    state.gate=gate;state.code=code;render(<RetentionNotice conversationId="conversa"/>);
    expect(screen.getByTestId('retention-notice').textContent).toContain(title);
    expect(screen.getByTestId('retention-notice').textContent).toContain(`${gate} / ${code}`);
    if(gate!=='pacing'||code==='outside_window') expect(screen.queryByText('Resposta segurada pela proteção do número')).toBeNull();
  });
});
