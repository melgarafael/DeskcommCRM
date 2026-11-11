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
 *     A FK composta da 9332 recusa a GRAVAÇÃO, mas o degrau não pode depender
 *     de a escrita ter sido a única porta.
 *  2. **O carimbo de uso único** da campanha de ENTRADA (`claimed_at is null`,
 *     no `update … returning`). Sem ele o degrau vale em TODO turno, e a
 *     conversa fica presa no agente do anúncio para sempre — o defeito oposto
 *     ao da issue #4024.
 */

function pool(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows }));
  return { query } as never;
}

const ORG = 'org-1';
const CONVERSA = 'conversa-1';

describe('agenteDaCampanhaDeEntrada — o primeiro turno da frase do anúncio (#4024)', () => {
  it('carimba o uso e devolve o agente, sempre recortado pela organização e pela conversa', async () => {
    const db = pool([{ agent_id: 'agente-implantes' }]) as unknown as {
      query: ReturnType<typeof vi.fn>;
    };

    const id = await agenteDaCampanhaDeEntrada(db as never, ORG, CONVERSA);

    expect(id).toBe('agente-implantes');
    const [sql, values] = db.query.mock.calls[0]!;
    expect(sql).toContain('update public.conversations');
    expect(sql).toContain('set campaign_entry_agent_claimed_at = now()');
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('id = $2');
    // O uso único: sem as duas condições o `update` carimbaria de novo e o
    // degrau valeria em todo turno.
    expect(sql).toContain('campaign_entry_agent_id is not null');
    expect(sql).toContain('campaign_entry_agent_claimed_at is null');
    expect(sql).toContain('returning campaign_entry_agent_id');
    expect(values).toEqual([ORG, CONVERSA]);
  });

  it('o segundo turno não volta para o agente da campanha: sem linha, `null`', async () => {
    // É o que o banco devolve quando `claimed_at` já está carimbado, quando a
    // conversa não veio de campanha ou quando o par (org, id) não casa.
    const id = await agenteDaCampanhaDeEntrada(pool([]) as never, ORG, CONVERSA);
    expect(id).toBeNull();
  });

  it('falha de leitura/escrita vira `null` — o turno segue pela régua do número', async () => {
    const db = {
      query: vi.fn(async () => {
        throw new Error('pool esgotado');
      }),
    } as never;
    await expect(agenteDaCampanhaDeEntrada(db, ORG, CONVERSA)).resolves.toBeNull();
  });

  it('NÃO conta mensagens para descobrir "primeiro turno"', async () => {
    // A definição de primeiro turno é o CARIMBO, não uma varredura em
    // `messages`: a varredura erraria em qualquer conversa em que o cliente
    // mande três mensagens antes da primeira resposta, e custaria uma leitura a
    // mais em todo turno do produto.
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
    // A de saída NÃO tem carimbo: o degrau vale em todo turno da conversa que
    // nasceu da campanha (decisão do dono, 2026-09-19).
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
