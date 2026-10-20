import { describe,expect,it,vi } from 'vitest';
import { sinalAgendaDoTexto } from './sinal-agenda';
describe('leitura conservadora do sinal de agenda',()=>{
 it.each([
  ['{"agendaCompativel":true}',true],['```json\n{"agendaCompativel":false}\n```',false],
  ['{"agendaCompativel":true} {"agendaCompativel":true}',true],
  ['{"agendaCompativel":true} {"agendaCompativel":false}',undefined],
  ['{"agendaCompativel":false} {"agendaCompativel":true}',undefined],
  ['{"agendaCompativel":"true"}',undefined],['{"outro":true}',undefined],['texto sem resultado',undefined],
  ['[{"agendaCompativel":true}]',undefined],
  [JSON.stringify({agendaCompativel:true,razao:'texto com {chaves} e "aspas"'}),true],
 ])('não transforma saída ambígua ou inválida em autorização: %s',(text,expected)=>{expect(sinalAgendaDoTexto(text as string)).toBe(expected);});
 it('avisa sobre conflito sem registrar texto privado',()=>{
  const warn=vi.fn();sinalAgendaDoTexto('{"agendaCompativel":true,"nome":"PRIVADO"} {"agendaCompativel":false}',{warn} as never);
  expect(warn).toHaveBeenCalledWith(expect.any(String),{event:'agenda_review_ambiguous_output',objetos:2});
  expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVADO');
 });
});
