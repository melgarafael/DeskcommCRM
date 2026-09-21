import { describe, expect, it } from 'vitest';

import { renderBlocoDeEstado } from './estado-do-atendimento';

const TWISTER = {
  nome: 'CB 300 F Twister',
  ano: '2025',
  cor: 'Vermelho',
  fotos: ['https://x/tw-1.jpg'],
};

describe('renderBlocoDeEstado', () => {
  it('sem escolha e sem dados ⇒ vazio (zero token)', () => {
    expect(renderBlocoDeEstado({ contact: { name: null, custom_fields: {} }, escolhida: null })).toBe(
      '',
    );
  });

  it('declara a moto escolhida com a trava de não oferecer outra', () => {
    const bloco = renderBlocoDeEstado({
      contact: { name: null, custom_fields: {} },
      escolhida: TWISTER,
    });
    expect(bloco).toContain('Moto escolhida pelo cliente: CB 300 F Twister (2025, Vermelho)');
    expect(bloco).toContain('NÃO ofereça outras motos');
  });

  it('lê de volta os dados do contato (CPF/nascimento inclusos) — não reperguntar', () => {
    const bloco = renderBlocoDeEstado({
      contact: {
        name: 'Vander',
        custom_fields: {
          cidade: 'São José dos Campos',
          cnh: true,
          cpf: '097.908.906-99',
          data_nascimento: '1989-02-26',
        },
      },
      escolhida: null,
    });
    expect(bloco).toContain('Nome: Vander');
    expect(bloco).toContain('CNH: sim');
    expect(bloco).toContain('CPF: 097.908.906-99');
    expect(bloco).toContain('Nascimento: 1989-02-26');
    expect(bloco).toContain('NÃO pergunte de novo');
  });

  it('inclui o já respondido no fluxo', () => {
    const bloco = renderBlocoDeEstado({
      contact: { name: null, custom_fields: {} },
      escolhida: null,
      valoresDoFluxo: { moto_troca: 'cg 125', troca_ano: '2015', vazio: '  ' },
    });
    expect(bloco).toContain('Já respondido no fluxo');
    expect(bloco).toContain('moto_troca: cg 125');
    expect(bloco).not.toContain('vazio:');
  });

  it('CNH false vira "não"', () => {
    const bloco = renderBlocoDeEstado({
      contact: { name: null, custom_fields: { cnh: false } },
      escolhida: null,
    });
    expect(bloco).toContain('CNH: não');
  });
});
