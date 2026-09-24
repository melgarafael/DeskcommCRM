import { describe, expect, it } from 'vitest';

import { buildCriteriosPrompt, parseCriterios } from './extrair-criterios';

describe('buildCriteriosPrompt', () => {
  it('lista as colunas e os valores possíveis', () => {
    const p = buildCriteriosPrompt('quero uma CB 300', ['marca', 'categoria', 'cilindrada'], {
      categoria: ['Naked', 'Street', 'Adventure / Trilha'],
    });
    expect(p).toContain('marca');
    expect(p).toContain('categoria (valores possíveis: Naked, Street, Adventure / Trilha)');
    expect(p).toContain('quero uma CB 300');
    expect(p).toContain('EXEMPLO de resposta');
    expect(p).toContain('SOMENTE o JSON');
  });
});

describe('parseCriterios', () => {
  const COLS = ['marca', 'categoria', 'cilindrada'];

  it('lê a intenção e os critérios, filtrando colunas não permitidas', () => {
    const r = parseCriterios(
      'claro: {"intencao":"pedido","criterios":{"categoria":"Naked","marca":"Yamaha","id":"9"}}',
      COLS,
    );
    expect(r).toEqual({
      intencao: 'pedido',
      criterios: { categoria: 'Naked', marca: 'Yamaha' },
    });
  });

  it('reconhece "alternativa" e aceita número', () => {
    expect(
      parseCriterios('{"intencao":"alternativa","criterios":{"cilindrada":300}}', COLS),
    ).toEqual({ intencao: 'alternativa', criterios: { cilindrada: '300' } });
  });

  it('nunca lança: saída inesperada vira {intencao:null, criterios:{}}', () => {
    const vazio = { intencao: null, criterios: {} };
    expect(parseCriterios('sem json', COLS)).toEqual(vazio);
    expect(parseCriterios('{"criterios": {"categoria": ""}}', COLS)).toEqual(vazio);
  });
});
