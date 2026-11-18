import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { composeSystemPrompt, entradaVigente, entradasVigentes, loadOrgMemory, renderOrgMemory } from './org-memory';

function poolSeq(responses: Array<{ rows: unknown[] }>): pg.Pool {
  const query = vi.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  return { query } as unknown as pg.Pool;
}

/**
 * #2369 — o aprendizado com prazo.
 *
 * A programação semanal de um restaurante vive como entrada de memória da org e
 * entra no prefixo de TODO turno. Sem prazo, a atração de sexta continua sendo
 * verdade na terça seguinte até alguém arquivar à mão — o defeito relatado.
 *
 * Aqui se prova o recorte que o motor passa a representar:
 *  - entrada sem `valid_until` continua valendo para sempre (nada muda);
 *  - entrada vencida não entra no bloco do prompt;
 *  - "vencida" é decidida no FUSO DA ORGANIZAÇÃO, e não em UTC: às 23h de
 *    domingo em São Paulo ainda é domingo, e a programação de domingo vale.
 */

const linha = (id: string, valid_until: string | null, fuso: string | null = 'America/Sao_Paulo') => ({
  id,
  title: `título ${id}`,
  body: `corpo ${id}`,
  valid_until,
  fuso,
});

describe('loadOrgMemory', () => {
  it('resolve doc pelo ponteiro e entries active em ordem estável', async () => {
    const pool = poolSeq([
      { rows: [{ content: 'Regras da org.' }] },
      { rows: [{ id: 'e1', title: 'Horário', body: 'Atendemos 8h-18h.', valid_until: null, fuso: null }] },
    ]);
    const mem = await loadOrgMemory(pool, 'org1');
    expect(mem).toEqual({
      content: 'Regras da org.',
      entries: [{ id: 'e1', title: 'Horário', body: 'Atendemos 8h-18h.', valid_until: null }],
    });
  });

  it('org sem memória: content null e entries vazias', async () => {
    const mem = await loadOrgMemory(poolSeq([{ rows: [] }, { rows: [] }]), 'org1');
    expect(mem).toEqual({ content: null, entries: [] });
  });

  it('deixa de fora a entrada vencida: a programação da semana passada não entra no prompt', async () => {
    const pool = poolSeq([
      { rows: [] },
      { rows: [linha('programacao-vencida', '2026-10-19'), linha('programacao-da-semana', '2026-10-26')] },
    ]);

    const memoria = await loadOrgMemory(pool, 'org1', { agora: new Date('2026-10-27T02:00:00.000Z') });

    expect(memoria.entries.map((e) => e.id)).toEqual(['programacao-da-semana']);
    const bloco = renderOrgMemory(memoria);
    expect(bloco).toContain('programacao-da-semana');
    expect(bloco).not.toContain('programacao-vencida');
  });

  it('decide o prazo no fuso da organização, não em UTC', async () => {
    // 02:00 UTC de 27/10 é 23:00 de 26/10 em São Paulo: a entrada que vence em
    // 26/10 ainda vale. Em UTC ela já teria vencido — a régua errada derrubaria
    // a programação de domingo três horas antes de domingo acabar.
    const pool = poolSeq([{ rows: [] }, { rows: [linha('vale-hoje', '2026-10-26', 'America/Sao_Paulo')] }]);

    const memoria = await loadOrgMemory(pool, 'org1', { agora: new Date('2026-10-27T02:00:00.000Z') });

    expect(memoria.entries.map((e) => e.id)).toEqual(['vale-hoje']);
  });

  it('organização sem fuso configurado cai no padrão do produto, sem estourar', async () => {
    const pool = poolSeq([{ rows: [] }, { rows: [linha('sem-fuso', '2026-10-31', null)] }]);

    const memoria = await loadOrgMemory(pool, 'org1', { agora: new Date('2026-10-27T02:00:00.000Z') });

    expect(memoria.entries.map((e) => e.id)).toEqual(['sem-fuso']);
  });

  it('entrada sem prazo (toda a memória de antes) continua entrando', async () => {
    const pool = poolSeq([
      { rows: [{ content: 'Política da casa.' }] },
      { rows: [linha('antiga-1', null), linha('antiga-2', null)] },
    ]);

    const memoria = await loadOrgMemory(pool, 'org1', { agora: new Date('2026-10-27T02:00:00.000Z') });

    expect(memoria.entries.map((e) => e.id)).toEqual(['antiga-1', 'antiga-2']);
    expect(memoria.content).toBe('Política da casa.');
  });

  it('pede a data em texto no SQL: DATE do driver viraria Date e a comparação de calendário mentiria', async () => {
    const query = vi.fn();
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    await loadOrgMemory({ query } as unknown as pg.Pool, 'org1', { agora: new Date('2026-10-27T02:00:00.000Z') });

    const daMemoria = query.mock.calls.map((c) => String(c[0])).find((sql) => sql.includes('org_memory_entries'));
    expect(daMemoria).toBeDefined();
    expect(daMemoria).toContain("to_char(e.valid_until, 'YYYY-MM-DD')");
  });
});

describe('prazo do aprendizado (unidade)', () => {
  const entrada = (id: string, valid_until: string | null) => ({ id, valid_until });

  it('sem data vale para sempre — o comportamento de toda entrada de antes', () => {
    expect(entradaVigente(entrada('a', null), '2026-10-26')).toBe(true);
  });

  it('vale no próprio dia do prazo', () => {
    expect(entradaVigente(entrada('a', '2026-10-26'), '2026-10-26')).toBe(true);
  });

  it('não vale no dia seguinte ao prazo', () => {
    expect(entradaVigente(entrada('a', '2026-10-25'), '2026-10-26')).toBe(false);
  });

  it('filtra preservando ordem e o resto dos campos', () => {
    const lista = [entrada('a', null), entrada('b', '2026-10-19'), entrada('c', '2026-11-01')];
    expect(entradasVigentes(lista, '2026-10-26').map((e) => e.id)).toEqual(['a', 'c']);
  });
});

describe('renderOrgMemory', () => {
  it('vazio quando não há doc nem entries', () => {
    expect(renderOrgMemory({ content: null, entries: [] })).toBe('');
  });
  it('doc + entries viram bloco determinístico', () => {
    const out = renderOrgMemory({
      content: 'Doc.',
      entries: [{ id: 'e1', title: 'T', body: 'B', valid_until: null }],
    });
    expect(out).toContain('=== memória da organização (regras e aprendizados — valem para TODO atendimento) ===');
    expect(out).toContain('Doc.');
    expect(out).toContain('- T: B');
  });
  it('o prazo NÃO aparece no texto que o modelo lê — a validade é do motor, não da fala', () => {
    const out = renderOrgMemory({
      content: null,
      entries: [{ id: 'e1', title: 'Programação', body: 'Sexta: Fulano.', valid_until: '2026-10-30' }],
    });
    expect(out).toBe(
      [
        '=== memória da organização (regras e aprendizados — valem para TODO atendimento) ===',
        '--- aprendizados ---',
        '- Programação: Sexta: Fulano.',
      ].join('\n'),
    );
  });
});

describe('composeSystemPrompt', () => {
  it('ordem: playbook → memória → índice de skills; blocos vazios somem sem separadores órfãos', () => {
    expect(composeSystemPrompt({ playbookPrompt: 'P', orgMemoryBlock: '', skillIndex: '' })).toBe('P');
    const full = composeSystemPrompt({ playbookPrompt: 'P', orgMemoryBlock: 'M', skillIndex: 'S' });
    expect(full.indexOf('P')).toBeLessThan(full.indexOf('M'));
    expect(full.indexOf('M')).toBeLessThan(full.indexOf('S'));
    expect(full).toContain('=== skills (índice — o corpo carrega no turno quando a situação dispara) ===');
  });
});
