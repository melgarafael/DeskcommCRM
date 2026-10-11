import { describe, expect, it } from 'vitest';
import { criarEvidenciasComerciaisDoTurno } from './evidencias-comerciais';
const produto = { codigo:'ANUAL', nome:'Plano anual', preco:'R$ 200,00', descricao:'Somente no anual; não inclui matrícula.', disponivel:true };
const fonte = (revisao = 'v1', ativa = true) => ({ id:'fonte', revisao, ativa });
const trecho = { knowledge_source_id:'fonte', chunk_id:'trecho', content:'Demonstração: até três sessões, mediante aprovação.', source_name:'Política' };
describe('T06/T08 evidência completa e vigente', () => {
  it('item grande não perde a condição: é omitido inteiro e contado', () => {
    const e=criarEvidenciasComerciaisDoTurno([]);
    e.registrarCatalogo({produtos:[{...produto,descricao:'x'.repeat(4000)+' NÃO É GRATUITO'}]});
    expect(e.ler()).toEqual([]);
    expect(e.cobertura()).toMatchObject({estado:'excluded_by_limit',encontrados:1,selecionados:0,omitidos:1,motivos:['item_inteiro_excede_limite']});
  });
  it('seleção preserva produto e política contraditória completos; omissão não vira not_found', () => {
    const e=criarEvidenciasComerciaisDoTurno(['fonte']);
    e.registrarConhecimento({results:[trecho,{...trecho,chunk_id:'restricao',content:'Plano anual NÃO tem demonstração gratuita.'}]});
    e.registrarCatalogo({produtos:[produto,...Array.from({length:35},(_,i)=>({...produto,codigo:`outro${i}`,nome:`Outro ${i}`}))]});
    const p=e.ler('Plano anual com demonstração gratuita');
    expect(p.some(x=>x.referencia==='ANUAL')).toBe(true);
    expect(p.some(x=>x.conteudo.includes('NÃO tem'))).toBe(true);
    expect(e.cobertura()).toMatchObject({estado:'excluded_by_limit',encontrados:38});
    expect(e.cobertura().omitidos).toBeGreaterThan(0);
  });
  it('revogar ou publicar versão nova invalida a fonte e impede ressuscitar o cache', () => {
    const e=criarEvidenciasComerciaisDoTurno(['fonte']);
    e.revalidar({fontes:[fonte()],produtos:[]});e.registrarConhecimento({results:[trecho]});
    e.revalidar({fontes:[fonte('v2')],produtos:[]});
    expect(e.ler()).toEqual([]);expect(e.cobertura().estado).toBe('stale');
    e.registrarConhecimento({results:[trecho]});expect(e.ler()).toEqual([]);
    const novo=criarEvidenciasComerciaisDoTurno(['fonte']);novo.revalidar({fontes:[fonte()],produtos:[]});novo.registrarConhecimento({results:[trecho]});
    novo.revalidar({fontes:[fonte('v1',false)],produtos:[]});expect(novo.ler()).toEqual([]);
  });
  it('catálogo alterado ou indisponível não empresta o preço consultado antes', () => {
    const e=criarEvidenciasComerciaisDoTurno([]);e.registrarCatalogo({produtos:[produto]});
    e.revalidar({fontes:[],produtos:[produto]});expect(e.ler()).toHaveLength(1);
    const antes=e.contexto();e.revalidar({fontes:[],produtos:[{...produto,preco:'R$ 300,00'}]});
    expect(e.ler()).toEqual([]);expect(e.cobertura().estado).toBe('stale');expect(e.contexto()).not.toBe(antes);
  });
  it('falha na releitura exclui o acervo e mantém motivo separado de ausência', () => {
    const e=criarEvidenciasComerciaisDoTurno(['fonte']);e.registrarConhecimento({results:[trecho]});e.revalidar(undefined);
    expect(e.ler()).toEqual([]);expect(e.cobertura().estado).toBe('unavailable');
    expect(criarEvidenciasComerciaisDoTurno([]).cobertura().estado).toBe('not_found');
  });
});
