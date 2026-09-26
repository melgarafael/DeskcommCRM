import { describe, expect, it } from 'vitest';

import { buildCriteriosPrompt, criteriosVazios, parseCriterios } from './extrair-criterios';
import type { MotoDoCatalogo } from './fotos-do-catalogo';

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

  it('inclui o ESTOQUE real no prompt (a IA escolhe entre as motos do dono)', () => {
    const estoque: MotoDoCatalogo[] = [
      {
        nome: 'HONDA CB 300 F Twister',
        fotos: [],
        valores: { nome: 'CB 300', marca: 'HONDA', categoria: 'Street', cilindrada: '293.5 cc' },
      },
      {
        nome: 'YAMAHA Factor 125',
        fotos: [],
        valores: { nome: 'Factor 125', marca: 'YAMAHA', categoria: 'Street', cilindrada: '124 cc' },
      },
    ];
    const p = buildCriteriosPrompt('quero uma cb 50', ['nome', 'marca', 'cilindrada'], undefined, estoque);
    expect(p).toContain('ESTOQUE DISPONÍVEL');
    expect(p).toContain('HONDA CB 300 F Twister');
    expect(p).toContain('YAMAHA Factor 125');
    expect(p).toContain('marca: HONDA');
    // O formato novo pede hipóteses + faixas.
    expect(p).toContain('hipoteses');
    expect(p).toContain('faixas');
  });
});

describe('parseCriterios', () => {
  const COLS = ['nome', 'marca', 'categoria', 'cilindrada', 'preco'];

  it('lê a intenção e os critérios, filtrando colunas não permitidas', () => {
    const r = parseCriterios(
      'claro: {"intencao":"pedido","criterios":{"categoria":"Naked","marca":"Yamaha","id":"9"}}',
      COLS,
    );
    expect(r.intencao).toBe('pedido');
    expect(r.criterios).toEqual({ categoria: 'Naked', marca: 'Yamaha' });
  });

  it('reconhece "alternativa" e aceita número', () => {
    const r = parseCriterios('{"intencao":"alternativa","criterios":{"cilindrada":300}}', COLS);
    expect(r.intencao).toBe('alternativa');
    expect(r.criterios).toEqual({ cilindrada: '300' });
  });

  it('lê o formato NOVO: hipóteses + faixas', () => {
    const r = parseCriterios(
      JSON.stringify({
        intencao: 'pedido',
        hipoteses: [
          { nome: 'CB 250', marca: 'HONDA', cilindrada: '250' },
          { nome: 'CB 300', marca: 'HONDA', cilindrada: '293.5' },
        ],
        faixas: { cilindrada: { min: 125, max: 300 }, preco: { min: 9000, max: 20000 } },
      }),
      COLS,
    );
    expect(r.intencao).toBe('pedido');
    expect(r.hipoteses).toHaveLength(2);
    expect(r.hipoteses[0]).toMatchObject({ nome: 'CB 250', marca: 'HONDA' });
    expect(r.faixas.cilindrada).toEqual({ min: 125, max: 300 });
    expect(r.faixas.preco).toEqual({ min: 9000, max: 20000 });
  });

  it('ignora hipóteses com colunas não permitidas', () => {
    const r = parseCriterios(
      '{"hipoteses":[{"nome":"CB 250","secreto":"x"}],"faixas":{"secreto":{"min":1}}}',
      COLS,
    );
    expect(r.hipoteses).toEqual([{ nome: 'CB 250' }]);
    expect(r.faixas).toEqual({});
  });

  it('normaliza faixa numérica simples para {min,max} iguais', () => {
    const r = parseCriterios('{"faixas":{"cilindrada":250}}', COLS);
    expect(r.faixas.cilindrada).toEqual({ min: 250, max: 250 });
  });

  it('nunca lança: saída inesperada vira o formato vazio', () => {
    expect(parseCriterios('sem json', COLS)).toEqual(criteriosVazios());
    expect(parseCriterios('{"criterios": {"categoria": ""}}', COLS).criterios).toEqual({});
    expect(parseCriterios('{"hipoteses": "x", "faixas": 3}', COLS)).toEqual(criteriosVazios());
  });
});
