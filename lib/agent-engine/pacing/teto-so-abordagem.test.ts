/**
 * O TETO DO DIA PODE CONTAR SÓ A ABORDAGEM (issue #3851, opção por canal).
 *
 * A 9061 tirou a RESPOSTA do teto; o que sobrou foi o follow-up de quem já foi
 * abordado — ele gasta e espera o teto de warm-up como se fosse gente nova, e é
 * ele quem empurra a próxima conversa para o dia seguinte. `tetoSoAbordagem`
 * (channel_knobs, default desligado) liga a régua nova POR CANAL: o teto conta e
 * barra só a 1ª mensagem a pessoa nova.
 *
 * O que este arquivo trava, além do caminho feliz:
 *
 *  - canal SEM a opção = comportamento de hoje, byte a byte (o follow-up continua
 *    barrado e a resposta continua saindo);
 *  - a ABORDAGEM continua barrada no teto — a opção não virou fumaça;
 *  - intervalo mínimo e janela horária continuam valendo para o follow-up: a
 *    opção tira o teto, não o anti-ban;
 *  - a contagem é POR CANAL: o teto de um número não segura o outro;
 *  - estado sem a contagem de abordagens (montado à mão) falha FECHADO.
 */
import { describe, expect, it } from 'vitest';

import { PACING_DEFAULTS, type PacingKnobs } from './defaults';
import { decidePacing } from './engine';

const COMERCIAL = new Date('2026-07-28T13:00:00Z'); // 10h BRT, terça
const MADRUGADA = new Date('2026-07-28T06:00:00Z'); // 03h BRT

const COM_OPCAO: PacingKnobs = { ...PACING_DEFAULTS, tetoSoAbordagem: true };
const SEM_OPCAO: PacingKnobs = { ...PACING_DEFAULTS, tetoSoAbordagem: false };

function input(over: {
  knobs?: PacingKnobs;
  now?: Date;
  resposta?: boolean;
  prospeccao?: boolean;
  abordagem?: boolean;
  sentToday?: number;
  abordagensToday?: number;
  lastSentAt?: Date | null;
  crmDailyLimit?: number | null;
}) {
  return {
    now: over.now ?? COMERCIAL,
    knobs: over.knobs ?? SEM_OPCAO,
    ...(over.resposta !== undefined ? { resposta: over.resposta } : {}),
    ...(over.prospeccao !== undefined ? { prospeccao: over.prospeccao } : {}),
    ...(over.abordagem !== undefined ? { abordagem: over.abordagem } : {}),
    state: {
      lastSentAt: over.lastSentAt ?? null,
      sentToday: over.sentToday ?? 0,
      // 20/20 é o degrau do dia 0 (`numberActivatedAt: null`): o número novo bate
      // o teto com a idade mais conservadora.
      abordagensToday: over.abordagensToday ?? (over.sentToday ?? 0),
      numberActivatedAt: null,
    },
    crmDailyLimit: over.crmDailyLimit ?? null,
    rng: () => 0,
  };
}

describe('padrão = hoje (canal sem a opção)', () => {
  it('o follow-up de quem já foi abordado continua gastando e esperando o teto', () => {
    const d = decidePacing(input({ sentToday: 20, abordagem: false }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
    // A `reason` de hoje continua igual, sem nota nenhuma da opção.
    expect(d.reason).toContain('cap de warm-up atingido (20/dia para número com 0 dia(s) de idade)');
    expect(d.reason).not.toContain('contando só abordagem');
  });

  it('a resposta a quem escreveu continua saindo (9061 intacto)', () => {
    expect(decidePacing(input({ sentToday: 20, resposta: true })).allow).toBe(true);
  });

  it('o default do motor é a opção DESLIGADA', () => {
    expect(PACING_DEFAULTS.tetoSoAbordagem).toBe(false);
  });
});

describe('com a opção ligada, o follow-up de quem já foi abordado sai', () => {
  it('GREEN: teto de abordagem batido, follow-up com abordagem:false passa', () => {
    // 20 abordagens hoje; o follow-up NÃO é abordagem.
    const d = decidePacing(input({ knobs: COM_OPCAO, sentToday: 25, abordagensToday: 20, abordagem: false }));
    expect(d).toEqual({ allow: true, waitMs: 0 });
  });

  it('não gasta o teto: a 21ª abordagem continua barrada depois do follow-up', () => {
    const d = decidePacing(input({ knobs: COM_OPCAO, sentToday: 20, abordagensToday: 20, abordagem: true }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
    expect(d.reason).toContain('contando só abordagem');
  });
});

describe('a abordagem a pessoa nova continua respeitando o teto', () => {
  it('21ª abordagem com o teto de 20 batido é barrada', () => {
    const d = decidePacing(input({ knobs: COM_OPCAO, sentToday: 20, abordagensToday: 20, abordagem: true }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
  });

  it('quem não declara `abordagem` conta como abordagem (o worker de prospecção não muda)', () => {
    const d = decidePacing(input({ knobs: COM_OPCAO, sentToday: 20, abordagensToday: 20 }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
  });

  it('prospecção declarada com abordagem:false NÃO abre o teto (prospecção prevalece)', () => {
    const d = decidePacing(
      input({ knobs: COM_OPCAO, sentToday: 20, abordagensToday: 20, abordagem: false, prospeccao: true }),
    );
    expect(d.allow).toBe(false);
  });
});

describe('a opção tira o teto, não o anti-ban', () => {
  it('o intervalo mínimo entre mensagens continua valendo para o follow-up', () => {
    const d = decidePacing(
      input({
        knobs: COM_OPCAO,
        sentToday: 20,
        abordagensToday: 20,
        abordagem: false,
        lastSentAt: new Date(COMERCIAL.getTime() - 200),
      }),
    );
    // Espera o resto do throttle (1,2 s) — sair na hora seria assinatura de bot.
    expect(d).toEqual({ allow: true, waitMs: PACING_DEFAULTS.throttleMs - 200 });
  });

  it('a janela horária continua valendo para o follow-up (3h da manhã é veto)', () => {
    const d = decidePacing(
      input({ knobs: COM_OPCAO, now: MADRUGADA, sentToday: 20, abordagensToday: 20, abordagem: false }),
    );
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('outside_window');
  });

  it('o limite do CRM (daily_message_limit) também conta só abordagem com a opção', () => {
    const d = decidePacing(
      input({ knobs: COM_OPCAO, sentToday: 40, abordagensToday: 5, abordagem: true, crmDailyLimit: 5 }),
    );
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('daily_cap');
    expect(d.reason).toContain('contando só abordagem');
  });
});

describe('a contagem do teto é POR CANAL', () => {
  it('canal A no teto não segura o canal B — cada estado é do seu número', () => {
    const canalA = decidePacing(input({ knobs: COM_OPCAO, sentToday: 20, abordagensToday: 20, abordagem: true }));
    const canalB = decidePacing(input({ knobs: COM_OPCAO, sentToday: 0, abordagensToday: 0, abordagem: true }));
    expect(canalA.allow).toBe(false);
    expect(canalB.allow).toBe(true);
  });

  it('estado sem `abordagensToday` (montado à mão) falha FECHADO: usa sentToday', () => {
    const d = decidePacing({
      now: COMERCIAL,
      knobs: COM_OPCAO,
      state: { lastSentAt: null, sentToday: 20, numberActivatedAt: null },
      crmDailyLimit: null,
      rng: () => 0,
    });
    expect(d.allow).toBe(false);
  });
});
