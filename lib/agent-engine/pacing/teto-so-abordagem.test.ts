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
 *
 * ─── Os dois ajustes de desenho da revisão (10/11) ────────────────────────────
 *
 * A opção tirava o teto do follow-up e não punha nada no lugar, e a régua que
 * decide "esta pessoa já foi abordada?" olhava a EMPRESA inteira. Os dois
 * defeitos são do mesmo dia e moram juntos aqui:
 *
 *  1. "JÁ RECEBEU MENSAGEM" É DO NÚMERO, NÃO DA EMPRESA — `countPriorAcceptedSends`
 *     (o `isFirstOutbound` que o disclosure, o LGPD e a classificação de abordagem
 *     compartilham) contava os envios aceitos do CONTATO na organização. Com dois
 *     números na mesma empresa, o número B ouvia "já foi abordado" porque o A havia
 *     falado — e a pessoa nova do B nunca recebia a apresentação (e a abordagem do
 *     B deixava de contar no teto, que é o buraco por onde o volume escapa).
 *  2. FOLLOW-UP TEM TETO PRÓPRIO — com a opção ligada, o follow-up não gasta nem
 *     espera o teto de abordagem, e era isso mesmo que se queria; mas 200 follow-ups
 *     num dia saíam todos, sem teto nenhum. `followupDailyCap` (o mesmo lugar dos
 *     outros limites: os knobs do canal) põe o teto de segurança do follow-up,
 *     separado do de abordagem e sem reabrir a régua antiga.
 */
import { describe, expect, it } from 'vitest';

import { countPriorAcceptedSends } from '../guardrails/disclosure/template';
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

/**
 * Dublê do `send_ledger` que obedece à régua que a SQL EXPRESSA — de propósito.
 *
 * O que está sob teste aqui é o contrato da consulta, não o Postgres: "esta pessoa
 * já recebeu deste NÚMERO?". O dublê responde `existe` a partir do filtro que a
 * SQL traz (a coluna do canal) — sem o filtro, ele responde pela empresa inteira,
 * que é exatamente o defeito medido. Um dublê que só devolvesse `true` deixaria o
 * teste verde com a SQL errada.
 */
function dubleDoLedger(linhas: ReadonlyArray<{ canal: string; status: 'accepted' | 'queued' }>) {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  return {
    sqls,
    params,
    async query(sql: string, valores: unknown[] = []) {
      sqls.push(sql);
      params.push(valores);
      const filtraPorNumero = /channel_session_id/.test(sql);
      const aceitos = linhas.filter(
        (l) => l.status === 'accepted' && (!filtraPorNumero || l.canal === valores[2]),
      );
      return { rows: [{ existe: aceitos.length > 0 }] };
    },
  };
}

describe('T1 — dois números, um já abordou hoje: o "já recebeu" é DO NÚMERO', () => {
  it('TRUE para o número que enviou, FALSE para o outro (a empresa não responde pela pessoa)', async () => {
    // O número A já falou com a pessoa; o B tentou e a mensagem ficou na fila
    // (`queued` não alcançou o lead, então não conta como envio recebido).
    const db = dubleDoLedger([
      { canal: 'numero-a', status: 'accepted' },
      { canal: 'numero-b', status: 'queued' },
    ]);

    expect(await countPriorAcceptedSends(db as never, 'org', 'pessoa', 'numero-a')).toBe(1);
    expect(await countPriorAcceptedSends(db as never, 'org', 'pessoa', 'numero-b')).toBe(0);
    // O número consultado vai à SQL: sem isso o `exists` volta a ser da empresa.
    expect(db.params.at(-1)).toContain('numero-b');
  });
});

describe('T2 — o follow-up tem teto diário PRÓPRIO (segurança), separado do de abordagem', () => {
  it('com a chave ligada, o 200º follow-up sai e o 201º não', () => {
    // 20 abordagens no dia (o teto de abordagem já está batido) + 199 follow-ups
    // = 219 disparos: o próximo é o 200º follow-up, e o teto próprio é 200.
    const d200 = decidePacing(input({ knobs: COM_OPCAO, sentToday: 219, abordagensToday: 20, abordagem: false }));
    expect(d200).toEqual({ allow: true, waitMs: 0 });

    // Já saíram 200 follow-ups hoje: o 201º espera o próximo dia — pelo teto DELE,
    // não pelo de abordagem (que está batido e não governa mais este envio).
    const d201 = decidePacing(input({ knobs: COM_OPCAO, sentToday: 220, abordagensToday: 20, abordagem: false }));
    expect(d201.allow).toBe(false);
    if (d201.allow) throw new Error('inalcançável');
    expect(d201.code).toBe('followup_cap');
    expect(d201.reason).toContain('follow-up');
    expect(d201.reason).toContain(`${PACING_DEFAULTS.followupDailyCap}/dia`);
    expect(d201.reason).not.toContain('contando só abordagem');
  });
});

describe('T3 — chave desligada: a régua antiga continua byte a byte', () => {
  it('o follow-up segue contando no teto de sempre, e o teto próprio não existe', () => {
    // Sem a opção, 220 disparos no dia batem o cap de warm-up — como sempre.
    const d = decidePacing(input({ sentToday: 220, abordagensToday: 20, abordagem: false }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
    expect(d.reason).not.toContain('follow-up');
    expect(d.reason).not.toContain('contando só abordagem');
    // E sem teto batido, o follow-up sai exatamente como antes.
    expect(decidePacing(input({ sentToday: 0, abordagensToday: 0, abordagem: false }))).toEqual({
      allow: true,
      waitMs: 0,
    });
  });
});
