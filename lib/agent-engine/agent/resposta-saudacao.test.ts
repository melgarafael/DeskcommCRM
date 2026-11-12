import { describe, expect, it } from 'vitest';
import { respostaParaSaudacao } from './resposta-saudacao';

const prompt = 'RESPOSTA_SAUDACAO: Olá! Sou a assistente virtual. Como posso ajudar?';

describe('respostaParaSaudacao', () => {
  it('usa a resposta configurada para saudações isoladas, inclusive em sequência', () => {
    expect(respostaParaSaudacao(prompt, ['oi', 'boa noote'])).toBe('Olá! Sou a assistente virtual. Como posso ajudar?');
    expect(respostaParaSaudacao(prompt, ['Boa tarde, tudo bem? 😊'])).toBe('Olá! Sou a assistente virtual. Como posso ajudar?');
  });

  it('preserva mensagens com pedido ou conteúdo não reconhecido', () => {
    expect(respostaParaSaudacao(prompt, ['oi, quanto custa?'])).toBeNull();
    expect(respostaParaSaudacao(prompt, ['oi', 'quero marcar'])).toBeNull();
    expect(respostaParaSaudacao(prompt, ['não quero receber mensagens'])).toBeNull();
    expect(respostaParaSaudacao(prompt, [])).toBeNull();
    expect(respostaParaSaudacao('sem configuração', ['oi'])).toBeNull();
  });
});
