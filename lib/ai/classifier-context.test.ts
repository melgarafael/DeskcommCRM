import { describe, expect, it } from 'vitest';
import { quantidadeDeHistoricoSalva } from './classifier-context';

describe('quantidade nativa de histórico dos decisores', () => {
  it.each([0, 4, 12, 16])('preserva a quantidade salva %i', quantidade => {
    expect(quantidadeDeHistoricoSalva({ context_message_count: quantidade })).toBe(quantidade);
  });
  it.each([undefined, null, {}, [], { context_message_count: '12' }, { context_message_count: 17 },
    { context_message_count: -1 }, { context_message_count: 2.5 }, { context_message_count: NaN }])('não inventa valor salvo para %j', config => {
    expect(quantidadeDeHistoricoSalva(config)).toBeNull();
  });
});
