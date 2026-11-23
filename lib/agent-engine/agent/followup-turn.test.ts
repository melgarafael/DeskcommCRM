/**
 * Regressão de segurança CO-LOCADA de `followup-turn.ts`.
 *
 * Comportamento REAL das fronteiras exportadas que guardam o follow-up:
 *
 *  1. `followupTurnPayloadSchema` é o portão de entrada do runner de follow-up:
 *     só payloads bem formados entram. Modo forjado (`mode` fora de
 *     agent/template) e enrollment forjado (uuid inválido) são recusados no
 *     schema — a recusa acontece ANTES de qualquer envio, e corpo fixo vazio
 *     (`fixed_body: ''`) é indespachável pelo mesmo `.min(1)` do send_message.
 *  2. `buildTemporalBlock` monta o contexto de re-entrada SEM nunca inventar
 *     promessa: sem `promise` no payload, o bloco não contém a fórmula
 *     "Você prometeu" — o silêncio do payload vira silêncio no prompt, não
 *     promessa fabricada.
 *
 * O follow-up fixo NÃO tem gate near-dup (#2996, item 2 — decisão registrada
 * em `sendFixedOutbound`): re-resposta de promessa é protegida no caminho do
 * agente (`runAgentTurn` → `send_message`), e a AUSÊNCIA do gate — contrato de
 * que texto do operador e laço `{{volta}}` nunca somem — é pinçada por
 * `tests/unit/seguranca-supressao-duplicata-e-desfecho-terminal.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { buildTemporalBlock, followupTurnPayloadSchema } from './followup-turn';

describe('followupTurnPayloadSchema: só payloads bem formados entram no runner', () => {
  it('variante mínima sem promessa (re-entrada acc3) é TOLERADA', () => {
    expect(followupTurnPayloadSchema.safeParse({}).success).toBe(true);
  });

  it('modo legítimo de re-entrada (agent/template) é aceito', () => {
    expect(followupTurnPayloadSchema.safeParse({ mode: 'agent' }).success).toBe(true);
    expect(followupTurnPayloadSchema.safeParse({ mode: 'template' }).success).toBe(true);
    // Retomar ao devolver (lib/escalacao/retomada-ao-devolver.ts).
    expect(followupTurnPayloadSchema.safeParse({ mode: 'retomada' }).success).toBe(true);
  });

  it('modo FORJADO fora do enum é recusado (nunca entra no runner)', () => {
    expect(followupTurnPayloadSchema.safeParse({ mode: 'sms' }).success).toBe(false);
  });

  it('fixed_body vazio é indespachável (min(1)) — follow-up nunca sai sem corpo', () => {
    expect(followupTurnPayloadSchema.safeParse({ fixed_body: '' }).success).toBe(false);
    expect(followupTurnPayloadSchema.safeParse({ fixed_body: 'Oi, tudo bem?' }).success).toBe(true);
  });

  it('enrollment forjado (não-uuid) é recusado no portão', () => {
    expect(
      followupTurnPayloadSchema.safeParse({ followup_enrollment_id: 'não-é-uuid' }).success,
    ).toBe(false);
    expect(
      followupTurnPayloadSchema.safeParse({
        followup_enrollment_id: '3f1a9b7e-0000-4000-8000-000000000001',
      }).success,
    ).toBe(true);
  });
});

describe('buildTemporalBlock: re-entrada conta o tempo sem inventar promessa', () => {
  const agora = new Date('2026-10-13T12:00:00Z');

  it('com promessa, declara a promessa E o prazo prometido', () => {
    const bloco = buildTemporalBlock({
      now: agora,
      promise: 'retorno amanhã de manhã com o valor',
      promisedAt: '2026-10-14T09:00:00Z',
      lastInbound: { body: 'obrigada!', sentAt: '2026-10-13T10:00:00Z' },
    });
    expect(bloco).toContain('Você prometeu: retorno amanhã de manhã com o valor (para 2026-10-14T09:00:00Z).');
  });

  it('SEM promessa, o bloco nunca a inventa (contrato acc3)', () => {
    const bloco = buildTemporalBlock({
      now: agora,
      lastInbound: { body: 'ok', sentAt: '2026-10-13T11:00:00Z' },
    });
    expect(bloco).not.toContain('prometeu');
  });

  it('delta desde a última inbound é medido em ordem de grandeza humana', () => {
    const bloco = buildTemporalBlock({
      now: agora,
      lastInbound: { body: 'ok', sentAt: '2026-10-11T12:00:00Z' },
    });
    expect(bloco).toContain('Passaram 2 dias desde a última resposta do lead.');
  });

  it('sem inbound no contexto, cai na abertura de retomada — não num delta inventado', () => {
    const bloco = buildTemporalBlock({ now: agora, lastInbound: null });
    expect(bloco).toContain('não há resposta recente registrada');
    expect(bloco).not.toContain('Passaram');
  });

  it('sentAt ilegível não vaza "NaN" para o prompt (guard de parsing)', () => {
    const bloco = buildTemporalBlock({
      now: agora,
      lastInbound: { body: 'ok', sentAt: 'data-invalida' },
    });
    expect(bloco).toContain('após o intervalo combinado');
    expect(bloco).not.toContain('NaN');
  });
});
