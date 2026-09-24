import { describe, expect, it } from 'vitest';

import type { MotoDoCatalogo } from './fotos-do-catalogo';
import {
  casarPorReferencia,
  escolherComReferencia,
  pontuarReferencia,
  separarReferencias,
} from './similaridade-referencia';

function moto(nome: string, similares: string, extras: Partial<MotoDoCatalogo> = {}): MotoDoCatalogo {
  return { nome, fotos: [], valores: { moto_similar: similares }, ...extras };
}

const CATALOGO: MotoDoCatalogo[] = [
  moto('XRE 300', 'CB 300, CB 300F, XRE 190, Tornado 250', { valores: { moto_similar: 'CB 300, CB 300F, XRE 190, Tornado 250', cilindrada: '300' } }),
  moto('Biz 125', 'Pop 110, Fan 125, PCX 125', { valores: { moto_similar: 'Pop 110, Fan 125, PCX 125', cilindrada: '125' } }),
  moto('Titan 160', 'Fan 160, CG 160, Biz 125', { valores: { moto_similar: 'Fan 160, CG 160, Biz 125', cilindrada: '160' } }),
];

describe('separarReferencias', () => {
  it('separa por vírgula, ponto-e-vírgula, pipe e barra', () => {
    expect(separarReferencias('CB 300, CB 300F; XRE 190|Tornado 250')).toEqual([
      'CB 300',
      'CB 300F',
      'XRE 190',
      'Tornado 250',
    ]);
  });
  it('vazio/undefined → lista vazia', () => {
    expect(separarReferencias(undefined)).toEqual([]);
    expect(separarReferencias('')).toEqual([]);
  });
});

describe('pontuarReferencia', () => {
  it('igual > contém > tokens', () => {
    expect(pontuarReferencia('CB 300', 'CB 300')).toBe(3);
    expect(pontuarReferencia('CB 300', 'Honda CB 300')).toBe(2);
    expect(pontuarReferencia('CB 300', 'CB 300F')).toBe(2);
    expect(pontuarReferencia('CB 300', 'Biz 125')).toBe(0);
  });
});

describe('casarPorReferencia', () => {
  it('acha a moto REAL cuja lista cita o pedido (não devolve a referência)', () => {
    const r = casarPorReferencia('CB 300', CATALOGO, 'moto_similar');
    expect(r.map((m) => m.nome)).toEqual(['XRE 300']);
    // nunca devolve o nome de referência como se fosse moto
    expect(r.map((m) => m.nome)).not.toContain('CB 300');
  });

  it('pedido que ninguém cita → vazio', () => {
    expect(casarPorReferencia('Harley 883', CATALOGO, 'moto_similar')).toEqual([]);
  });

  it('sem coluna configurada → vazio', () => {
    expect(casarPorReferencia('CB 300', CATALOGO, '')).toEqual([]);
  });
});

describe('escolherComReferencia', () => {
  it('a reserva vem PRIMEIRO, sem anotação, e completa com os demais', () => {
    const r = escolherComReferencia('CB 300', CATALOGO, {
      quantidade: 3,
      criteriosColunas: ['cilindrada'],
      colunaSimilares: 'moto_similar',
    });
    expect(r[0]?.nome).toBe('XRE 300'); // reserva
    expect(r.length).toBe(3); // não trava em uma só
  });

  it('respeita a quantidade', () => {
    const r = escolherComReferencia('CB 300', CATALOGO, {
      quantidade: 1,
      colunaSimilares: 'moto_similar',
    });
    expect(r.map((m) => m.nome)).toEqual(['XRE 300']);
  });

  it('sem coluna de referência → ordenação normal (não filtra marca)', () => {
    const r = escolherComReferencia('quero uma 300', CATALOGO, {
      quantidade: 3,
      criteriosColunas: ['cilindrada'],
      colunaSimilares: null,
    });
    expect(r[0]?.nome).toBe('XRE 300');
    expect(r.length).toBe(3);
  });
});
