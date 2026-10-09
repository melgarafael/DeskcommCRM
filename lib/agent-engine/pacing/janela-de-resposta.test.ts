/**
 * A janela de RESPOSTA é diferente da janela de DISPARO (migration 0495).
 *
 * Responder a quem escreveu pode sair a qualquer hora; disparo, prospecção e
 * retomada de conversa parada, não. Antes da 0495 as duas coisas liam o mesmo
 * par de horas de disparo, então abrir o atendimento para 24h abria o disparo junto.
 *
 * Estes testes existem para travar a SEPARAÇÃO, não o padrão: se alguém voltar
 * a ler as horas de DISPARO no caminho da resposta, este arquivo reprova.
 */
import { describe, expect, it } from 'vitest';

import { effectiveKnobs, type ChannelKnobsRow } from '@/lib/ai/pacing-knobs';

import { PACING_DEFAULTS, type PacingKnobs } from './defaults';
import {
  decidePacing,
  janelaDeEnvioAberta,
  proximaAberturaDaJanela,
} from './engine';

/** 2026-09-30 é quarta. 03:00 e 21:00 são as horas que separam as janelas. */
const AS_3H = new Date('2026-09-30T03:00:00-03:00'); // meia-noite-1h em São Paulo
const AS_21H = new Date('2026-09-30T21:00:00-03:00');
const AS_10H = new Date('2026-09-30T10:00:00-03:00');

/**
 * A hora local do TENANT, não a da máquina.
 *
 * `getHours()` devolve a hora no fuso do PROCESSO — e o runner pode ser UTC
 * enquanto a janela é avaliada em São Paulo. Foi assim que este arquivo
 * "provou" que o adiado era às 12h em vez das 9h: a diferença era o fuso do
 * teste, não o do motor. Ler a hora sem o fuso mede o relógio errado.
 */
const TZ = PACING_DEFAULTS.timezone;
const horaNoFuso = (d: Date): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d));

const knobs = (over: Partial<PacingKnobs> = {}): PacingKnobs => ({
  ...PACING_DEFAULTS,
  ...over,
});

const estado = { lastSentAt: null, sentToday: 0, numberActivatedAt: null };

const LINHA_VAZIA: ChannelKnobsRow = {
  throttle_ms: null, jitter_max_ms: null, window_start_hour: null, window_end_hour: null,
  allow_sunday: null, timezone: null, warmup_daily_caps: null,
};

describe('janela de resposta separada da janela de disparo (0495)', () => {
  it('a 3h a resposta é liberada e o disparo é barrado', () => {
    const k = knobs({ respostaStartHour: 0, respostaEndHour: 24 });

    expect(janelaDeEnvioAberta(AS_3H, k, true)).toBe(true);
    expect(janelaDeEnvioAberta(AS_3H, k, false)).toBe(false);
  });

  it('o mesmo número de knobs decide diferente conforme o tipo de envio', () => {
    const k = knobs({ respostaStartHour: 0, respostaEndHour: 24 });

    const resposta = decidePacing({
      now: AS_3H, knobs: k, state: estado, crmDailyLimit: null, resposta: true,
    });
    const disparo = decidePacing({
      now: AS_3H, knobs: k, state: estado, crmDailyLimit: null, resposta: false,
    });

    expect(resposta.allow).toBe(true);
    expect(disparo.allow).toBe(false);
    if (!disparo.allow) expect(disparo.code).toBe('outside_window');
  });

  it('omitir `resposta` é DISPARO — a direção que fecha o número', () => {
    const k = knobs({ respostaStartHour: 0, respostaEndHour: 24 });
    // O chamador que esquece o campo não pode abrir o número às 3h.
    expect(janelaDeEnvioAberta(AS_3H, k)).toBe(false);
    expect(decidePacing({ now: AS_3H, knobs: k, state: estado, crmDailyLimit: null }).allow).toBe(false);
  });

  it('dentro do horário comercial os dois são liberados', () => {
    const k = knobs({ respostaStartHour: 0, respostaEndHour: 24 });
    expect(janelaDeEnvioAberta(AS_10H, k, true)).toBe(true);
    expect(janelaDeEnvioAberta(AS_10H, k, false)).toBe(true);
  });

  it('coluna vazia no banco: a resposta herda a janela de disparo', () => {
    // O caminho real: `null` em `resposta_*` vira o par `window_*` na leitura
    // (`effectiveKnobs`, mesma regra de `loadChannelKnobs`). Não vira 0-24 sozinho.
    const k = effectiveKnobs({
      ...LINHA_VAZIA, window_start_hour: 9, window_end_hour: 18,
      resposta_start_hour: null, resposta_end_hour: null,
    });
    expect([k.respostaStartHour, k.respostaEndHour]).toEqual([9, 18]);
    expect(janelaDeEnvioAberta(AS_3H, k, true)).toBe(false);
    expect(janelaDeEnvioAberta(AS_10H, k, true)).toBe(true);
  });

  it('o fallback é coluna a coluna, igual ao que a tela mostra no placeholder', () => {
    // Só o início gravado: o fim segue o do disparo. É o que a ficha Anti-ban
    // exibe no campo vazio, então o operador vê a janela que o motor aplica.
    const k = effectiveKnobs({
      ...LINHA_VAZIA, window_start_hour: 7, window_end_hour: 22,
      resposta_start_hour: 0, resposta_end_hour: null,
    });
    expect([k.respostaStartHour, k.respostaEndHour]).toEqual([0, 22]);
  });

  it('o veto da RESPOSTA atrasa para a abertura da resposta, não 7h', () => {
    // Resposta com janela própria 9h-21h: fora dela, o adiado é 9h, não o
    // `window_start_hour` do disparo. É o que o dono vê no painel.
    const k = knobs({ respostaStartHour: 9, respostaEndHour: 21 });
    const d = decidePacing({
      now: AS_3H, knobs: k, state: estado, crmDailyLimit: null, resposta: true, rng: () => 0,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(horaNoFuso(d.nextAllowedAt)).toBe(9);
      expect(d.reason).toContain('resposta');
      expect(d.reason).toContain('9h-21h');
    }
  });

  it('o veto do DISPARO continua citando a janela de disparo', () => {
    const k = knobs({ respostaStartHour: 0, respostaEndHour: 24 });
    const d = decidePacing({
      now: AS_3H, knobs: k, state: estado, crmDailyLimit: null, resposta: false, rng: () => 0,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain('7h-22h');
      expect(d.reason).not.toContain('0h-24h');
    }
  });

  it('cap diário continua valendo na RESPOSTA — 24h não é sem limite', () => {
    // A janela é cortesia; o anti-ban (cap, warm-up, throttle) não abre junto.
    const k = knobs({ respostaStartHour: 0, respostaEndHour: 24 });
    const d = decidePacing({
      now: AS_3H, knobs: k, state: { ...estado, sentToday: 999 }, crmDailyLimit: null, resposta: true,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).not.toBe('outside_window');
  });

  it('domingo desligado cala a resposta também (knob único, sem par)', () => {
    const k = knobs({ respostaStartHour: 0, respostaEndHour: 24, allowSunday: false });
    const domingo = new Date('2026-10-04T12:00:00-03:00'); // domingo
    expect(janelaDeEnvioAberta(domingo, k, true)).toBe(false);
  });

  it('o padrão do repositório continua espelhando a janela de disparo', () => {
    // Se este teste quebrar, todo clone que não gravou `resposta_*` mudou de
    // comportamento sem ninguém pedir.
    expect(PACING_DEFAULTS.respostaStartHour).toBe(PACING_DEFAULTS.windowStartHour);
    expect(PACING_DEFAULTS.respostaEndHour).toBe(PACING_DEFAULTS.windowEndHour);
  });

  it('proximaAberturaDaJanela segue a janela do tipo de envio', () => {
    const k = knobs({ respostaStartHour: 0, respostaEndHour: 24 });
    // Às 21h, para o disparo só amanhã 7h; para a resposta, amanhã 0h.
    const paraDisparo = proximaAberturaDaJanela(AS_21H, k, false, () => 0);
    const paraResposta = proximaAberturaDaJanela(AS_21H, k, true, () => 0);
    expect(horaNoFuso(paraDisparo)).toBe(7);
    expect(horaNoFuso(paraResposta)).toBe(0);
  });
});
describe('quem lê a janela de resposta (0495)', () => {
  it('só o turno que reage a quem escreveu é resposta', async () => {
    const { eTurnoDeResposta } = await import('@/lib/agent-engine/agent/inbound-turn');
    expect(eTurnoDeResposta({ kind: 'inbound_turn' })).toBe(true);
    expect(eTurnoDeResposta({ kind: 'case_reply_turn' })).toBe(true);
    // Retomar conversa parada às 4h é o que a janela de disparo existe para barrar.
    expect(eTurnoDeResposta({ kind: 'followup_turn' })).toBe(false);
  });
});
