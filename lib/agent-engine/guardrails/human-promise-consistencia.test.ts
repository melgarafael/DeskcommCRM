import { describe, expect, it } from 'vitest';
import { detectHumanPromise } from './human-promise';

describe('T11 negação e descrição não encobrem compromisso', () => {
  it.each([
    'Não vou chamar a equipe.',
    'Nunca vou consultar o responsável.',
    'A equipe não vai retornar hoje.',
    'Sua solicitação não está em análise pela equipe.',
    'A equipe pode avaliar situações excepcionais.',
    'Para encaminhar para a equipe, preciso de seu consentimento.',
    'Como falar com o responsável?',
    'Quer que eu consulte a equipe?',
    'Posso falar com o responsável para você?',
    'Temos uma demonstração disponível; qual período prefere?',
  ])('não inventa operação em %s', body => expect(detectHumanPromise(body)).toBe(false));
  it.each([
    'Não vou chamar a equipe, mas o responsável vai te retornar hoje.',
    'Não vou chamar a equipe. Já solicitei a avaliação interna.',
    'A equipe pode avaliar situações excepcionais, mas vou verificar com o responsável seu pedido.',
    'Quer que eu consulte a equipe? Seu caso já está em análise pela equipe.',
    'Não vou chamar a equipe e vou consultar o gerente.',
    'A equipe pode resolver seu caso amanhã.',
    'Não só vou chamar a equipe: vou pedir para liberar sua solicitação.',
    'Vou levar as informações para avaliação interna.',
    'Já registrei seu pedido para análise interna.',
    'Sua solicitação ficou em análise com o responsável.',
    'Posso falar com a equipe que vai te retornar hoje?',
  ])('preserva o compromisso em %s', body => expect(detectHumanPromise(body)).toBe(true));
  it('aplica a negação também ao nome próprio, sem perder a oração positiva', () => {
    expect(detectHumanPromise('Não vou consultar o Fulano.', ['Fulano'])).toBe(false);
    expect(detectHumanPromise('Não vou consultar o Fulano, mas vou pedir para a equipe avaliar.', ['Fulano'])).toBe(true);
  });
});
