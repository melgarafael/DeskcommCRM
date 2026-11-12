import { describe, expect, it, vi } from 'vitest';

import { agenteDaCampanhaDaConversa, agenteDaCampanhaDeEntrada } from './agente-da-campanha';

/**
 * O CONTRATO DE SQL DOS DOIS DEGRAUS DE CAMPANHA — o que os testes de
 * `resolveTurnAgent` não conseguem ver, porque lá o banco é um dublê.
 *
 * Duas propriedades que, se sumirem do texto da consulta, não quebram tipo nem
 * derrubam nada em runtime — e custam caro em produção:
 *
 *  1. **`organization_id = $1`** nas duas. Sem ele a leitura atravessa
 *     organizações: o turno de uma empresa responderia pelo agente de outra.
 *     A FK composta da 9348 recusa a GRAVAÇÃO, mas o degrau não pode depender
 *     de a escrita ter sido a única porta.
 *  2. **Nenhuma escrita** na campanha de ENTRADA. A primeira versão carimbava
 *     uso único (`update … set claimed_at = now()`); o carimbo se gastava num
 *     turno ADIADO pela janela anti-ban, e a conversa — nunca atendida pelo
 *     agente da campanha — voltava para o número. A decisão do mantenedor
 *     (2026-11-05) é ler o agente em todo turno, como a campanha de saída já
 *     faz: `select` puro, sem coluna de carimbo.
 */

function pool(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows }));
  return { query } as never;
}

const ORG = 'org-1';
const CONVERSA = 'conversa-1';

describe('agenteDaCampanhaDeEntrada — a conversa da frase do anúncio (#4024)', () => {
  it('lê o agente da campanha, sempre recortado pela organização e pela conversa, sem escrever', async () => {
    const db = pool([{ agent_id: 'agente-implantes' }]) as unknown as {
      query: ReturnType<typeof vi.fn>;
    };

    const id = await agenteDaCampanhaDeEntrada(db as never, ORG, CONVERSA);

    expect(id).toBe('agente-implantes');
    const [sql, values] = db.query.mock.calls[0]!;
    expect(sql).toContain('select c.campaign_entry_agent_id as agent_id');
    expect(sql).toContain('from public.conversations c');
    expect(sql).toContain('c.organization_id = $1');
    expect(sql).toContain('c.id = $2');
    // O uso único saiu com a decisão do mantenedor: um `select` não tem estado
    // a gastar, então o turno adiado pela janela não tira a conversa do agente.
    expect(sql).not.toContain('update');
    expect(sql).not.toContain('claimed');
    expect(values).toEqual([ORG, CONVERSA]);
  });

  it('o segundo turno da MESMA conversa continua no agente da campanha', async () => {
    // A decisão do mantenedor: a conversa em que a frase casou fica com o
    // agente da campanha, como a campanha de saída. Não há "primeiro turno".
    const db = pool([{ agent_id: 'agente-implantes' }]) as unknown as {
      query: ReturnType<typeof vi.fn>;
    };

    await expect(agenteDaCampanhaDeEntrada(db as never, ORG, CONVERSA)).resolves.toBe(
      'agente-implantes',
    );
    await expect(agenteDaCampanhaDeEntrada(db as never, ORG, CONVERSA)).resolves.toBe(
      'agente-implantes',
    );
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('coluna nula (conversa que NÃO veio do anúncio) devolve `null`', async () => {
    await expect(
      agenteDaCampanhaDeEntrada(pool([{ agent_id: null }]) as never, ORG, CONVERSA),
    ).resolves.toBeNull();
  });

  it('conversa que não casa o par (org, id) devolve `null`', async () => {
    await expect(agenteDaCampanhaDeEntrada(pool([]) as never, ORG, CONVERSA)).resolves.toBeNull();
  });

  it('falha de leitura vira `null` — o turno segue pela régua do número', async () => {
    const db = {
      query: vi.fn(async () => {
        throw new Error('pool esgotado');
      }),
    } as never;
    await expect(agenteDaCampanhaDeEntrada(db, ORG, CONVERSA)).resolves.toBeNull();
  });

  it('NÃO varre `messages` para descobrir nada sobre o turno', async () => {
    // A leitura é uma linha por PK (organização + conversa). Uma varredura em
    // `messages` custaria uma leitura a mais em todo turno do produto.
    const db = pool([{ agent_id: 'agente-implantes' }]) as unknown as {
      query: ReturnType<typeof vi.fn>;
    };
    await agenteDaCampanhaDeEntrada(db as never, ORG, CONVERSA);
    expect(db.query.mock.calls[0]![0]).not.toContain('from messages');
  });
});

describe('agenteDaCampanhaDaConversa — o degrau da campanha de SAÍDA continua igual', () => {
  it('lê `campaigns.agent_id` da conversa que a campanha CRIOU, recortado pela organização', async () => {
    const db = pool([{ agent_id: 'agente-prospeccao' }]) as unknown as {
      query: ReturnType<typeof vi.fn>;
    };

    const id = await agenteDaCampanhaDaConversa(db as never, ORG, CONVERSA);

    expect(id).toBe('agente-prospeccao');
    const [sql, values] = db.query.mock.calls[0]!;
    expect(sql).toContain('from campaign_recipients r');
    expect(sql).toContain('r.organization_id = $1');
    expect(sql).toContain('r.conversation_id = $2');
    // As duas campanhas seguem a MESMA regra desde a decisão de 2026-11-05:
    // valem em todo turno da conversa, sem carimbo de uso único.
    expect(sql).not.toContain('claimed_at');
    expect(values).toEqual([ORG, CONVERSA]);
  });

  it('campanha sem agente (ou conversa que não nasceu dela) devolve `null`', async () => {
    await expect(agenteDaCampanhaDaConversa(pool([]) as never, ORG, CONVERSA)).resolves.toBeNull();
  });

  it('erro de consulta não derruba o turno', async () => {
    const db = {
      query: vi.fn(async () => {
        throw new Error('db fora do ar');
      }),
    } as never;
    await expect(agenteDaCampanhaDaConversa(db, ORG, CONVERSA)).resolves.toBeNull();
  });
});
