/**
 * O motivo cru do upstream não chega à tela — e o desconhecido não some.
 *
 * O aviso de chamada perdida nascia com o corpo `Motivo: user_ended`. Este
 * arquivo guarda as duas direções: token conhecido vira frase, token que este
 * build não conhece vira frase QUE CARREGA o token, porque a alternativa
 * (esconder) deixa quem investiga sem a única pista existente.
 */
import { describe, expect, it } from 'vitest';

import { motivoDaChamadaEmPortugues } from '@/lib/wacalls/motivo-da-chamada';

describe('motivo da chamada em português', () => {
  it.each([
    ['user_ended', /desligou/i],
    ['timeout', /ninguém atendeu/i],
    ['do_not_disturb', /não perturbe/i],
    ['busy', /ocupada/i],
    ['declined', /recusada/i],
    // O motivo que o NOSSO cron grava (#3977) também tem frase própria: ele não
    // vem do upstream, e cair no "não sabemos traduzir" seria mentira nossa.
    ['encerrada_por_prazo_sem_evento', /encerrou a ligação por prazo/i],
  ])('%s vira frase de gente e não carrega o token', (cru, esperado) => {
    const frase = motivoDaChamadaEmPortugues(cru);
    expect(frase).toMatch(esperado);
    expect(frase).not.toContain(cru);
  });

  it('motivo que este build não conhece diz que não sabe E mostra o cru', () => {
    const frase = motivoDaChamadaEmPortugues('network_congestion');
    expect(frase).toContain('network_congestion');
    expect(frase).toMatch(/não sabemos/i);
  });

  it('ausência de motivo não vira frase tranquilizadora nem string vazia', () => {
    for (const vazio of [null, undefined, '', '   ']) {
      const frase = motivoDaChamadaEmPortugues(vazio);
      expect(frase.length).toBeGreaterThan(10);
      expect(frase).toMatch(/sem que o WhatsApp informasse/i);
    }
  });
});
