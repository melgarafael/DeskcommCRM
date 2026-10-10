/**
 * Dias da semana da prospecção por conexão (0630).
 *
 * O domingo único de `allowSunday` valia para resposta e disparo juntos: quem
 * desliga o domingo para não prospectar no fim de semana calava junto a
 * resposta de domingo. A prospecção ganha os dias próprios
 * (`knobs.prospeccaoDias`, 0=dom … 6=sáb); as horas continuam as de disparo.
 *
 * Estes testes travam a SEPARAÇÃO e o adiamento, não o padrão:
 * - domingo desamarrado nos dois sentidos (responde sem prospectar e vice-versa);
 * - fora do dia, o adiamento cai na próxima abertura DE DIA PERMITIDO;
 * - array vazio nunca trava o `nextWindowOpen` num laço sem fim.
 */
import { describe, expect, it } from 'vitest';

import { PACING_DEFAULTS, type PacingKnobs } from './defaults';
import {
  decidePacing,
  janelaDeEnvioAberta,
  janelaDeProspeccaoAberta,
  proximaAberturaDaProspeccao,
} from './engine';
import { parseDiasDaProspeccao } from './store';

/** 2026-10-10 é sábado, 11 é domingo, 12 é segunda — todos às 10h de São Paulo. */
const SAB_10H = new Date('2026-10-10T10:00:00-03:00');
const DOM_10H = new Date('2026-10-11T10:00:00-03:00');
const SEG_10H = new Date('2026-10-12T10:00:00-03:00');
const SEG_23H = new Date('2026-10-12T23:00:00-03:00');

const TZ = PACING_DEFAULTS.timezone;
const horaNoFuso = (d: Date): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d));
const diaNoFuso = (d: Date): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);

const knobs = (over: Partial<PacingKnobs> = {}): PacingKnobs => ({
  ...PACING_DEFAULTS,
  ...over,
});

const estado = { lastSentAt: null, sentToday: 0, numberActivatedAt: null };

const SEG_A_SEX = [1, 2, 3, 4, 5];
const TODA_A_SEMANA = [0, 1, 2, 3, 4, 5, 6];

describe('dias da prospecção por conexão (0630)', () => {
  it('parseDiasDaProspeccao: filtra, dedup e ordena; vazio ou estranho é null', () => {
    expect(parseDiasDaProspeccao([5, 1, 1, 0])).toEqual([0, 1, 5]);
    expect(parseDiasDaProspeccao([])).toBeNull();
    expect(parseDiasDaProspeccao(null)).toBeNull();
    expect(parseDiasDaProspeccao(undefined)).toBeNull();
    expect(parseDiasDaProspeccao('seg-sex')).toBeNull();
    expect(parseDiasDaProspeccao([1, 7, -1, 2.5, '3'])).toEqual([1]);
    expect(parseDiasDaProspeccao([9, 'x'])).toBeNull();
  });

  it('domingo desamarrado: responde sem prospectar', () => {
    const k = knobs({ allowSunday: true, prospeccaoDias: SEG_A_SEX });
    expect(janelaDeEnvioAberta(DOM_10H, k)).toBe(true);
    expect(janelaDeProspeccaoAberta(DOM_10H, k)).toBe(false);
  });

  it('domingo desamarrado no outro sentido: prospecta sem responder', () => {
    const k = knobs({ allowSunday: false, prospeccaoDias: TODA_A_SEMANA });
    expect(janelaDeEnvioAberta(DOM_10H, k)).toBe(false);
    expect(janelaDeProspeccaoAberta(DOM_10H, k)).toBe(true);
  });

  it('sábado fora dos dias: segunda dentro', () => {
    const k = knobs({ prospeccaoDias: SEG_A_SEX });
    expect(janelaDeProspeccaoAberta(SAB_10H, k)).toBe(false);
    expect(janelaDeProspeccaoAberta(SEG_10H, k)).toBe(true);
  });

  it('a hora continua valendo no dia permitido', () => {
    const k = knobs({ prospeccaoDias: SEG_A_SEX });
    expect(janelaDeProspeccaoAberta(SEG_23H, k)).toBe(false);
  });

  it('o adiamento cai na próxima abertura DE DIA PERMITIDO', () => {
    const k = knobs({ prospeccaoDias: SEG_A_SEX });
    const proxima = proximaAberturaDaProspeccao(SAB_10H, k, () => 0);
    expect(diaNoFuso(proxima)).toBe('Mon');
    expect(horaNoFuso(proxima)).toBe(7);
  });

  it('decidePacing com prospeccao:true veta fora do dia; sem a flag, passa', () => {
    const k = knobs({ allowSunday: true, prospeccaoDias: SEG_A_SEX });
    const comFlag = decidePacing({
      now: SAB_10H,
      knobs: k,
      state: estado,
      crmDailyLimit: null,
      prospeccao: true,
    });
    expect(comFlag.allow).toBe(false);
    if (!comFlag.allow) {
      expect(comFlag.code).toBe('outside_window');
      expect(comFlag.reason).toContain('prospecção');
      expect(diaNoFuso(comFlag.nextAllowedAt)).toBe('Mon');
    }
    expect(
      decidePacing({ now: SAB_10H, knobs: k, state: estado, crmDailyLimit: null }).allow,
    ).toBe(true);
  });

  it('cap estourado com prospeccao:true reabre em dia permitido', () => {
    const k = knobs({ prospeccaoDias: [1] });
    const veto = decidePacing({
      now: SEG_10H,
      knobs: k,
      state: { ...estado, sentToday: 10_000 },
      crmDailyLimit: 1,
      prospeccao: true,
    });
    expect(veto.allow).toBe(false);
    if (!veto.allow) {
      // Só segunda envia: a próxima abertura é sete dias depois, não amanhã.
      expect(diaNoFuso(veto.nextAllowedAt)).toBe('Mon');
      expect(horaNoFuso(veto.nextAllowedAt)).toBe(7);
      expect(veto.nextAllowedAt.getTime()).toBeGreaterThan(SEG_10H.getTime() + 6 * 86_400_000);
    }
  });

  it('array vazio cai na regra antiga em vez de travar o laço', () => {
    const k = knobs({ allowSunday: false, prospeccaoDias: [] });
    // Regra antiga num domingo sem domingo: vetado, com próxima abertura finita.
    expect(janelaDeProspeccaoAberta(DOM_10H, k)).toBe(false);
    const veto = decidePacing({
      now: DOM_10H,
      knobs: k,
      state: estado,
      crmDailyLimit: null,
      prospeccao: true,
    });
    expect(veto.allow).toBe(false);
    if (!veto.allow) expect(Number.isFinite(veto.nextAllowedAt.getTime())).toBe(true);
  });
});
