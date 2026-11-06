/**
 * #3877 — a costura do CALENDÁRIO no aviso de fora do horário.
 *
 * O aviso não recalcula feriado nenhum: ele pergunta a
 * `feriadoDoDiaDaOrganizacao`, que é a MESMA leitura do bloco `## Agora`
 * (`feriadoDoDia` sobre `feriadosDasSettings`, régua dos nacionais em
 * `isHolidayBR`). O que este teste prova é a parte que só existe aqui:
 *
 *   1. a DATA CIVIL sai do fuso da ORGANIZAÇÃO (`organizations.timezone`), não
 *      do relógio do runtime — 02/11 23:00 em São Paulo já é 03/11 em UTC, e
 *      usar a data do processo daria o feriado errado para quem está a oeste;
 *   2. os feriados `proprios` que a organização já cadastra entram (mesma
 *      leitura do bloco), sem tela nova;
 *   3. falha ABERTA: banco atrás do código, fuso inválido ou settings torto
 *      NÃO lançam — caem na degradação que o turno já usa (fuso padrão do
 *      produto, nacionais ligados), nunca numa exceção no ramo que adia o
 *      turno.
 */
import { describe, expect, it } from 'vitest';

import { feriadoDoDiaDaOrganizacao } from '@/lib/agent-engine/agent/feriados-da-org';
import type { Queryable } from '@/lib/agent-engine/queue/queue';

interface Bancos {
  timezone?: string | null;
  feriados?: unknown;
  /** Faz a leitura estourar — o caso do clone com schema atrás do código. */
  estoura?: boolean;
}

function dbFalso(config: Bancos): Queryable {
  return {
    query: async (texto: string) => {
      if (config.estoura) throw new Error('relation "organizations" does not exist');
      // Duas leituras: `fusoDaOrganizacao` (timezone) e `feriadosDaOrganizacao`
      // (settings -> feriados). A ordem é a do código real.
      if (texto.includes('timezone')) {
        return {
          rows: [{ timezone: config.timezone === undefined ? 'America/Sao_Paulo' : config.timezone }],
        };
      }
      return { rows: [{ feriados: config.feriados ?? null }] };
    },
  } as unknown as Queryable;
}

describe('feriado do dia no fuso da organização (#3877)', () => {
  it('02/11/2026 (Finados) no fuso da organização ⇒ "Finados"', async () => {
    // 22:00 UTC = 19:00 BRT, ainda dia 02 no Brasil.
    const feriado = await feriadoDoDiaDaOrganizacao(
      dbFalso({}),
      'org-1',
      new Date('2026-11-02T22:00:00Z'),
    );

    expect(feriado).toBe('Finados');
  });

  it('a data é a do FUSO: 02/11 23:30 BRT (já 03/11 em UTC) continua Finados', async () => {
    const feriado = await feriadoDoDiaDaOrganizacao(
      dbFalso({ timezone: 'America/Sao_Paulo' }),
      'org-1',
      new Date('2026-11-03T02:30:00Z'),
    );

    expect(feriado).toBe('Finados');
  });

  it('dia útil ⇒ null (o aviso de feriado não vaza)', async () => {
    const feriado = await feriadoDoDiaDaOrganizacao(
      dbFalso({}),
      'org-1',
      new Date('2026-11-03T22:00:00Z'),
    );

    expect(feriado).toBeNull();
  });

  it('feriado PRÓPRIO da organização entra pela mesma leitura', async () => {
    const feriado = await feriadoDoDiaDaOrganizacao(
      dbFalso({ feriados: { proprios: [{ data: '2026-11-03', nome: 'Aniversário da cidade' }] } }),
      'org-1',
      new Date('2026-11-03T22:00:00Z'),
    );

    expect(feriado).toBe('Aniversário da cidade');
  });

  it('organização que desligou os NACIONAIS não recebe aviso de feriado nacional', async () => {
    const feriado = await feriadoDoDiaDaOrganizacao(
      dbFalso({ feriados: { nacionais: false } }),
      'org-1',
      new Date('2026-11-02T22:00:00Z'),
    );

    expect(feriado).toBeNull();
  });

  it('falha ABERTA: banco com erro NÃO lança — cai na degradação que o turno já usa', async () => {
    // `fusoDaOrganizacao` degrada para o fuso padrão do produto e
    // `feriadosDaOrganizacao` para "nacionais ligados" (ambos documentados nos
    // seus arquivos), então o resultado é o calendário padrão, não uma exceção.
    // O contrato DESTE nível é não lançar: o aviso roda no ramo em que o turno
    // já vai ser adiado, e um throw aqui viraria turno adiado sem aviso — pior
    // que um texto de feriado calculado no fuso padrão.
    await expect(
      feriadoDoDiaDaOrganizacao(
        dbFalso({ estoura: true }),
        'org-1',
        new Date('2026-11-02T22:00:00Z'),
      ),
    ).resolves.toBe('Finados');
  });

  it('fuso inválido na organização ⇒ não lança e usa o padrão do produto', async () => {
    // `organizations.timezone` não é validada por escritor nenhum; um
    // "Marte/Base" derrubaria o `Intl` e, com ele, o aviso.
    await expect(
      feriadoDoDiaDaOrganizacao(
        dbFalso({ timezone: 'Marte/Base' }),
        'org-1',
        new Date('2026-11-02T22:00:00Z'),
      ),
    ).resolves.toBe('Finados');
  });
});
