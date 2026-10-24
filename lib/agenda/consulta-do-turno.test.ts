import { describe, expect, it } from 'vitest';
import { criarObservacaoDeConsultasDaAgenda } from './consulta-do-turno';

const input = { dia:'2030-11-19', event_type_slug:'sessao-coletiva', limite:50 };
const resultado = () => ({
  horarios:[{inicio:'2030-11-19T17:00:00Z',fim:'2030-11-19T17:40:00Z'}],
  fuso_da_regra:'America/Sao_Paulo',publicou_horarios:true,fuso_suposto:false,
  total_de_horarios:1,ha_mais:false,fontes_defasadas:[],agenda_externa_nunca_lida:false,
  servico:{modo:'collective_unlimited',revisao:3,horarios:[{inicio:'fora-do-recorte'}],reserva:'nao_executada'},
});
const criar = () => criarObservacaoDeConsultasDaAgenda(() => new Date('2030-11-18T12:00:00Z'));

describe('consulta real no turno, sem converter leitura em execução', () => {
  it('transporta o resultado local normalizado, sem a faixa bruta de outros dias nem IDs', () => {
    const o=criar();o.concluir(o.iniciar({...input,owner_user_id:'id-privado'}),resultado());
    const foto=o.atual()!;
    expect(foto.consultas[0]).toMatchObject({cobertura:'present',consulta:{servico:'sessao-coletiva',dia:'2030-11-19'},
      resultado:{horarios:[{inicio_local:'2030-11-19T14:00:00-03:00'}],modo_servico:'collective_unlimited',revisao_servico:3}});
    expect(JSON.stringify(foto)).not.toContain('id-privado');
    expect(JSON.stringify(foto)).not.toContain('fora-do-recorte');
    foto.consultas[0]!.cobertura='stale';
    expect(o.atual()!.consultas[0]!.cobertura).toBe('present');
    expect(criar().atual()).toBeUndefined();
  });
  it('preserva paginação, ausência de jornada e ressalvas; lista vazia não fabrica lotação', () => {
    const o=criar();o.concluir(o.iniciar(input),{...resultado(),horarios:[],total_de_horarios:5,ha_mais:true,
      publicou_horarios:false,fuso_suposto:true,fontes_defasadas:[{nome:'não transportar'}],agenda_externa_nunca_lida:true});
    expect(o.atual()!.consultas[0]!.resultado).toMatchObject({horarios:[],ha_mais:true,publicou_horarios:false,
      fuso_suposto:true,fontes_defasadas:1,agenda_externa_nunca_lida:true});
    expect(JSON.stringify(o.atual())).not.toContain('não transportar');
  });
  it.each([{horarios:[],motivo:'service_inactive'},{...resultado(),fuso_da_regra:'fuso-invalido'},
    {...resultado(),agenda_externa_nunca_lida:undefined},{...resultado(),horarios:[{inicio:'2030-11-19T17:00:00',fim:'2030-11-19T18:00:00Z'}]}])(
    'falha/resultado incompleto não é consulta vazia válida', r => {
      const o=criar();o.concluir(o.iniciar(input),r);
      expect(o.atual()!.consultas[0]).toMatchObject({cobertura:'unavailable'});
      expect(o.atual()!.consultas[0]!.resultado).toBeUndefined();
    });
  it('não herda sucesso no retry, nem aceita resultado atrasado após uma escrita', () => {
    const o=criar();o.concluir(o.iniciar(input),resultado());
    const segunda=o.iniciar(input);o.falhar(segunda);
    expect(o.atual()!.consultas.map(c=>c.cobertura)).toEqual(['present','unavailable']);
    const terceira=o.iniciar(input);o.invalidar();o.concluir(terceira,resultado());
    expect(o.atual()!.consultas.every(c=>c.cobertura==='stale' && !c.resultado)).toBe(true);
  });
  it('delimita individual, consultas concorrentes e exclusão por teto sem truncar horários silenciosamente', () => {
    const o=criar();
    const seqs=Array.from({length:5},(_,i)=>o.iniciar({...input,dia:`2030-11-${19+i}`}));
    const individual={...resultado(),servico:undefined};
    for(const seq of seqs.reverse()) o.concluir(seq,{...individual,horarios:Array.from({length:50},()=>resultado().horarios[0]) ,total_de_horarios:50});
    expect(o.atual()).toMatchObject({omitidas:1});
    expect(o.atual()!.consultas).toHaveLength(4);
    expect(o.atual()!.consultas[0]!.resultado).not.toHaveProperty('modo_servico');
    expect(o.atual()!.consultas.slice(1).every(c=>c.cobertura==='excluded_by_limit' && !c.resultado)).toBe(true);
  });
});
