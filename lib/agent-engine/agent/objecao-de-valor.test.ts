import { describe, expect, it } from 'vitest';

import {
  ehObjecaoValor,
  ehPedidoDesconto,
  ehPedidoDiferente,
  proximaFase,
  renderBlocoObjecao,
} from './objecao-de-valor';

describe('ehObjecaoValor', () => {
  it('reconhece objeção de valor', () => {
    for (const frase of [
      'Achei caro',
      'ta caro',
      'muito caro',
      'nao tenho esse valor',
      'vi mais barato',
      'vou pensar',
      'esta fora do meu orcamento',
    ]) {
      expect(ehObjecaoValor(frase), frase).toBe(true);
    }
  });

  it('pedido explícito de DIFERENTE não é objeção de valor', () => {
    for (const frase of ['quero uma mais barata', 'quero outra cor', 'tem outra?', 'quero mais nova']) {
      expect(ehPedidoDiferente(frase), frase).toBe(true);
      expect(ehObjecaoValor(frase), frase).toBe(false);
    }
  });

  it('não confunde com outros assuntos', () => {
    for (const frase of [
      'bom dia',
      'quero ver mais fotos',
      'como funciona o financiamento?',
      'qual o endereco da loja?',
      'quero ver a Biz 125',
    ]) {
      expect(ehObjecaoValor(frase), frase).toBe(false);
    }
  });
});

describe('ehPedidoDesconto', () => {
  it('reconhece pedido DIRETO de desconto/condição melhor', () => {
    for (const frase of [
      'tem como melhorar o valor?',
      'consegue um desconto?',
      'da pra baixar o preco?',
      'faz por menos?',
      'tem um melhor preco?',
    ]) {
      expect(ehPedidoDesconto(frase), frase).toBe(true);
    }
  });

  it('não confunde com objeção comum', () => {
    for (const frase of ['achei caro', 'vi mais barato', 'vou pensar', 'ta muito caro']) {
      expect(ehPedidoDesconto(frase), frase).toBe(false);
    }
  });
});

describe('proximaFase', () => {
  it('null → persuadir; persuadir + genérico → checar; checar + genérico → checar', () => {
    expect(proximaFase(null, false)).toBe('persuadir');
    expect(proximaFase('persuadir', false)).toBe('checar');
    expect(proximaFase('checar', false)).toBe('checar');
  });

  it('INSISTIU no desconto → handoff (a persuasão falhou)', () => {
    expect(proximaFase('persuadir', true)).toBe('handoff');
    expect(proximaFase('checar', true)).toBe('handoff');
    expect(proximaFase('handoff', true)).toBe('handoff');
  });
});

describe('renderBlocoObjecao', () => {
  it('persuadir: justificar e NÃO oferecer outra moto', () => {
    const b = renderBlocoObjecao('persuadir');
    expect(b).toContain('JUSTIFICAR');
    expect(b).toContain('procedência');
    expect(b).toContain('NÃO ofereça outra moto');
  });

  it('checar: oferecer variando a frase e NUNCA pedir para encaminhar', () => {
    const b = renderBlocoObjecao('checar');
    expect(b).toContain('OFERECER');
    expect(b).toContain('VARIE');
    expect(b).toContain('NUNCA pergunte se pode encaminhar');
  });

  it('handoff: encaminhar sem oferecer motos nem perguntar', () => {
    const b = renderBlocoObjecao('handoff');
    expect(b).toContain('ENCAMINHAR');
    expect(b).toContain('crm_request_human_handoff');
    expect(b).toContain('NUNCA pergunte');
  });
});
