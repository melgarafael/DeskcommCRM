import { describe, expect, it } from 'vitest';
import { criarRecuperacaoDeEnvioDaAgenda } from './recuperacao-envio-agenda';

describe('recuperação do envio de agenda', () => {
  it('interrompe o lote após veto; PAR-Q não substitui a confirmação', () => {
    const r = criarRecuperacaoDeEnvioDaAgenda();
    expect(r.permitirTentativa()).toBe(true);
    r.recusar('Sessão reservada para as 10h.', 'agenda_request_mismatch');
    expect(r.interromper()).toBe(true);
    expect(r.permitirTentativa()).toBe(false);
    expect(r.contexto()?.candidate).toBe('Sessão reservada para as 10h.');
    expect(r.iniciarCorrecao()).toBe(true);
    expect(r.permitirTentativa()).toBe(true);
    // Mesmo um segundo envio paralelo da correção fica barrado até o recibo.
    expect(r.permitirTentativa()).toBe(false);
    r.registrarCanal('sent');
    r.encerrarCorrecao();
    expect(r.contexto()).toBeUndefined();
    expect(r.interromper()).toBe(false);
    expect(r.permitirTentativa()).toBe(true);
  });

  it.each(['agenda_request_mismatch', 'human_decision_unfaithful'])('não libera por insistência após %s', code => {
    const r = criarRecuperacaoDeEnvioDaAgenda();
    r.recusar('Confirmação não entregue', code);
    r.iniciarCorrecao();
    r.permitirTentativa();
    r.recusar('Formulário', 'agenda_request_mismatch');
    r.encerrarCorrecao();
    expect(r.iniciarCorrecao()).toBe(false);
    expect(r.permitirTentativa()).toBe(false);
    expect(r.contexto()).toEqual({ candidate: 'Confirmação não entregue', code });
  });

  it.each(['failed', 'blocked'])('resultado %s não comprova comunicação', kind => {
    const r = criarRecuperacaoDeEnvioDaAgenda();
    r.recusar('Recibo', 'agenda_request_mismatch');
    r.iniciarCorrecao(); r.permitirTentativa(); r.registrarCanal(kind); r.encerrarCorrecao();
    expect(r.contexto()).toBeDefined();
    expect(r.interromper()).toBe(true);
  });

  it('aceite queued impede reenvio e dependentes, sem tratá-lo como novo veto', () => {
    const r = criarRecuperacaoDeEnvioDaAgenda();
    r.recusar('Recibo', 'agenda_request_mismatch');
    r.iniciarCorrecao(); r.permitirTentativa(); r.registrarCanal('queued'); r.encerrarCorrecao();
    expect(r.contexto()).toBeUndefined();
    expect(r.interromper()).toBe(true);
    expect(r.permitirTentativa()).toBe(false);
    expect(r.iniciarCorrecao()).toBe(false);
  });

  it('already_sent evita duplicação; cada execução conserva seu próprio estado', () => {
    const a = criarRecuperacaoDeEnvioDaAgenda(), b = criarRecuperacaoDeEnvioDaAgenda();
    a.recusar('Recibo', 'agenda_request_mismatch');
    expect(b.interromper()).toBe(false);
    a.iniciarCorrecao(); a.permitirTentativa(); a.registrarCanal('already_sent'); a.encerrarCorrecao();
    expect(a.interromper()).toBe(false);
    expect(a.iniciarCorrecao()).toBe(false);
  });

  it('não converte pacing ou outro veto em revisão de conteúdo', () => {
    const r = criarRecuperacaoDeEnvioDaAgenda();
    for (const code of ['warmup_cap', 'daily_cap', 'opted_out', 'clinical_claim']) r.recusar('Texto', code);
    expect(r.contexto()).toBeUndefined();
    expect(r.iniciarCorrecao()).toBe(false);
  });
});


it('tool calls paralelas conservam a ordem e não deixam orientação ultrapassar o veto', async () => {
  const r = criarRecuperacaoDeEnvioDaAgenda(); const enviados: string[] = [];
  await Promise.all([
    r.emOrdem(async () => { await Promise.resolve(); r.recusar('Confirmação', 'agenda_request_mismatch'); }),
    r.emOrdem(async () => { if (r.permitirTentativa()) enviados.push('Formulário'); }),
  ]);
  expect(enviados).toEqual([]);
  await expect(r.emOrdem(async () => { throw new Error('canal'); })).rejects.toThrow('canal');
  // Rejeição não prende a fila nem libera a pendência.
  expect(await r.emOrdem(async () => r.permitirTentativa())).toBe(false);
});


it('recuperação corrige afirmação extra sem provar ausência nem repetir a operação',async()=>{
 const {CORRECAO_DO_ENVIO_DE_AGENDA}=await import('./recuperacao-envio-agenda');
 expect(CORRECAO_DO_ENVIO_DE_AGENDA).toContain('retire');
 expect(CORRECAO_DO_ENVIO_DE_AGENDA).toContain('uma afirmação adicional sem prova');
 expect(CORRECAO_DO_ENVIO_DE_AGENDA).toContain('Não altere nem');
 expect(CORRECAO_DO_ENVIO_DE_AGENDA).toContain('Todas as proteções continuam valendo');
});

it.each(['agenda_review_context_incomplete','agenda_review_inconclusive','agenda_review_candidate_misbound'])
('recuperação técnica %s é limitada e não muda o primeiro texto pendente',code=>{
 const r=criarRecuperacaoDeEnvioDaAgenda();
 r.recusar('Pergunta original',code);expect(r.falhaTecnica()).toBe(true);
 expect(r.iniciarCorrecao()).toBe(true);expect(r.permitirTentativa()).toBe(true);
 r.recusar('Nova pergunta',code);r.encerrarCorrecao();
 expect(r.contexto()).toEqual({candidate:'Pergunta original',code});
 expect(r.iniciarCorrecao()).toBe(false);expect(r.permitirTentativa()).toBe(false);
 expect(r.falhaTecnica()).toBe(true);
});
it('Caso descreve a última causa comprovada, conservando a tentativa original como fonte',()=>{
 for(const [primeira,ultima,tecnica] of [
  ['agenda_request_mismatch','agenda_review_inconclusive',true],
  ['agenda_review_inconclusive','agenda_request_mismatch',false],
 ] as const){
  const r=criarRecuperacaoDeEnvioDaAgenda();r.recusar('Primeira',primeira);
  r.iniciarCorrecao();r.permitirTentativa();r.recusar('Atual',ultima);r.encerrarCorrecao();
  expect(r.falhaTecnica()).toBe(tecnica);expect(r.contexto()?.candidate).toBe('Primeira');
 }
});
