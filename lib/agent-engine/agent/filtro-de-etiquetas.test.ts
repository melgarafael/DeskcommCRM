import { describe, expect, it } from 'vitest';

import { agenteAtendeAsEtiquetas, lerFiltroDeEtiquetas } from './filtro-de-etiquetas';

describe('lerFiltroDeEtiquetas', () => {
  it('lê as duas listas e normaliza (minúscula, sem borda, sem repetida)', () => {
    expect(
      lerFiltroDeEtiquetas({
        filters: { contact_tags_include: [' Cliente ', 'cliente', 'VIP'], contact_tags_exclude: ['Fornecedor'] },
      }),
    ).toEqual({ incluir: ['cliente', 'vip'], excluir: ['fornecedor'] });
  });

  it('sem filtro declarado ⇒ null (atende todos)', () => {
    expect(lerFiltroDeEtiquetas(null)).toBeNull();
    expect(lerFiltroDeEtiquetas({})).toBeNull();
    expect(lerFiltroDeEtiquetas({ filters: { ignore_groups: true } })).toBeNull();
    expect(lerFiltroDeEtiquetas({ filters: { contact_tags_include: [], contact_tags_exclude: [] } })).toBeNull();
  });

  it('forma torta falha ABERTA: vira "sem filtro", nunca mordaça', () => {
    expect(lerFiltroDeEtiquetas({ filters: { contact_tags_include: 'cliente' } })).toBeNull();
    expect(lerFiltroDeEtiquetas({ filters: { contact_tags_include: [42, null, '  '] } })).toBeNull();
  });
});

describe('agenteAtendeAsEtiquetas', () => {
  const soCliente = { incluir: ['cliente'], excluir: [] };

  it('sem filtro, atende qualquer contato — inclusive sem etiqueta', () => {
    expect(agenteAtendeAsEtiquetas(null, [])).toBe(true);
    expect(agenteAtendeAsEtiquetas(undefined, ['x'])).toBe(true);
  });

  it('"só quem tem": atende quem tem uma delas e recusa quem não tem nenhuma', () => {
    expect(agenteAtendeAsEtiquetas(soCliente, ['cliente', 'sp'])).toBe(true);
    expect(agenteAtendeAsEtiquetas(soCliente, ['lead'])).toBe(false);
    expect(agenteAtendeAsEtiquetas(soCliente, [])).toBe(false);
  });

  it('compara sem caixa e sem espaço de borda (etiqueta antiga gravada torta)', () => {
    expect(agenteAtendeAsEtiquetas(soCliente, [' Cliente '])).toBe(true);
  });

  it('"nunca quem tem" vence "só quem tem"', () => {
    const filtro = { incluir: ['cliente'], excluir: ['inadimplente'] };
    expect(agenteAtendeAsEtiquetas(filtro, ['cliente', 'inadimplente'])).toBe(false);
  });

  it('só "nunca quem tem": atende todos menos quem tem a etiqueta', () => {
    const filtro = { incluir: [], excluir: ['fornecedor'] };
    expect(agenteAtendeAsEtiquetas(filtro, [])).toBe(true);
    expect(agenteAtendeAsEtiquetas(filtro, ['fornecedor'])).toBe(false);
  });
});
