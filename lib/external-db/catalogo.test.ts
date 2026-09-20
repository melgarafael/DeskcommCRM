import { describe, expect, it } from 'vitest';

import {
  colunasDoCatalogo,
  colunasParaConsulta,
  criteriosDeSimilaridade,
  detectarPapelColuna,
  renderBlocoCatalogo,
  type CatalogoMapeamento,
} from './catalogo';

const BASE: CatalogoMapeamento = {
  connectionId: 'c1',
  schemaName: 'public',
  tableName: 'motos',
  colNome: 'nome',
  colAno: 'ano',
  colCor: 'cor',
  colKm: 'quilometragem',
  colPreco: 'preco',
  colImagem: 'imagem_url',
  colEstoque: null,
  colCilindrada: null,
  colTipo: null,
  buscaOperador: 'contem',
};

describe('colunasDoCatalogo', () => {
  it('mapeia só as colunas preenchidas', () => {
    const c = colunasDoCatalogo(BASE);
    expect(c).toEqual({
      nome: 'nome',
      ano: 'ano',
      cor: 'cor',
      km: 'quilometragem',
      preco: 'preco',
      imagem: 'imagem_url',
    });
    expect('estoque' in c).toBe(false);
  });
});

describe('colunasParaConsulta', () => {
  it('lista nome + as colunas configuradas, sem os nulos', () => {
    expect(colunasParaConsulta(BASE)).toEqual([
      'nome',
      'ano',
      'cor',
      'quilometragem',
      'preco',
      'imagem_url',
    ]);
  });
});

describe('detectarPapelColuna', () => {
  it('reconhece os nomes usuais das colunas', () => {
    expect(detectarPapelColuna('nome')).toBe('nome');
    expect(detectarPapelColuna('preco')).toBe('preco');
    expect(detectarPapelColuna('imagem_url')).toBe('imagem');
    expect(detectarPapelColuna('quilometragem')).toBe('km');
    expect(detectarPapelColuna('cilindrada')).toBe('cilindrada');
    expect(detectarPapelColuna('categoria')).toBe('tipo');
  });

  it('igualdade exata vence o "contém" (preco vs preco_promocional)', () => {
    expect(detectarPapelColuna('preco')).toBe('preco');
    expect(detectarPapelColuna('preco_promocional')).toBe('preco');
  });

  it('coluna sem papel conhecido → null', () => {
    expect(detectarPapelColuna('id')).toBeNull();
    expect(detectarPapelColuna('garantia')).toBeNull();
  });
});

describe('criteriosDeSimilaridade', () => {
  it('usa a ordem configurada, ignorando papéis que não são critério', () => {
    expect(
      criteriosDeSimilaridade({
        ...BASE,
        ordem: { preco: 1, cilindrada: 2, nome: 3, cor: 4 },
      }),
    ).toEqual(['preco', 'cilindrada']);
  });

  it('sem ordem → default cilindrada, preco', () => {
    expect(criteriosDeSimilaridade({ ...BASE, ordem: {} })).toEqual(['cilindrada', 'preco']);
  });
});

describe('renderBlocoCatalogo', () => {
  it('vazio quando não há mapeamento', () => {
    expect(renderBlocoCatalogo(null)).toBe('');
  });

  it('cita a tabela, a coluna de busca e as colunas reais', () => {
    const bloco = renderBlocoCatalogo(BASE);
    expect(bloco).toContain('Tabela: motos');
    expect(bloco).toContain('nome');
    expect(bloco).toContain('imagem_url');
    expect(bloco).toContain('contem');
  });
});
