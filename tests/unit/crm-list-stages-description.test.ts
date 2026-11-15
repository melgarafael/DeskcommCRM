/**
 * `crm_list_stages` devolve `description` (o critério da etapa) e `agent_stage_hint` — a ponte entre a etapa do tenant e o funil
 * do agente (new|contacted|qualifying|qualified|negotiating|won|lost).
 *
 * Sem isto o Operador via só o NOME da etapa e tinha de adivinhar quando um card entra nela.
 * `crm_stages.description` existe desde o baseline; o hint diz a que passo do agente ela corresponde.
 * `null` é estado legítimo (etapa sem equivalente no funil do agente) e NÃO pode virar
 * `undefined` — o campo some do JSON e o consumidor não distingue "sem mapeamento" de
 * "não veio".
 */
import { describe, expect, it } from 'vitest';

import { corpo } from '@/lib/leads/stage-operations';
import { crmListStages } from '@/lib/mcp/tools/operacao';

const etapa = (extra: Record<string, unknown>) => ({
  id: 'e', name: 'Etapa', slug: 'etapa', description: null, position: 1, is_won: false, is_lost: false, is_archived: false,
  win_probability: null, avisar_na_central: false, expected_duration_hours: null,
  last_change_actor_kind: null, last_change_at: null, ...extra,
});

describe('description — o critério da etapa, escrito por quem montou o funil', () => {
  it('corpo() carrega o texto de cada etapa e null quando não há', () => {
    const { etapas } = corpo([
      etapa({ id: 'a', description: 'Entra aqui quando o cliente descreve o projeto' }),
      etapa({ id: 'b', description: null }),
      etapa({ id: 'c' }), // linha antiga/sem a chave: vira null, nunca undefined
    ] as never);
    expect(etapas.map(e => e.description)).toEqual(['Entra aqui quando o cliente descreve o projeto', null, null]);
    for (const e of etapas) expect(Object.prototype.hasOwnProperty.call(e, 'description')).toBe(true);
  });

  it('a ferramenta crm_list_stages anuncia o campo na descrição', () => {
    expect(crmListStages.description).toContain('description (o criterio da etapa');
  });
});

describe('corpo() — o que sai para quem lê o funil', () => {
  it('carrega o hint de cada etapa', () => {
    const { etapas } = corpo([
      etapa({ id: 'a', agent_stage_hint: 'qualifying' }),
      etapa({ id: 'b', agent_stage_hint: 'negotiating' }),
      etapa({ id: 'c', is_won: true, agent_stage_hint: 'won' }),
    ] as never);
    expect(etapas.map(e => [e.id, e.agent_stage_hint])).toEqual([
      ['a', 'qualifying'], ['b', 'negotiating'], ['c', 'won'],
    ]);
  });

  it('etapa sem mapeamento sai com `null` explícito (a chave EXISTE)', () => {
    const { etapas } = corpo([etapa({ agent_stage_hint: null }), etapa({})] as never);
    for (const e of etapas) {
      expect(Object.prototype.hasOwnProperty.call(e, 'agent_stage_hint')).toBe(true);
      expect(e.agent_stage_hint).toBeNull();
    }
  });

  it('etapa arquivada continua fora (o hint não reabre o que a regra já esconde)', () => {
    const { etapas } = corpo([etapa({ id: 'x', is_archived: true, agent_stage_hint: 'qualified' })] as never);
    expect(etapas).toEqual([]);
  });
});

describe('a ferramenta crm_list_stages (caminho do MCP / do Operador)', () => {
  /** supabase de mentira: o funil existe e devolve estas linhas, já na ordem do quadro. */
  function supabase(linhas: unknown[]) {
    const encadeia = (resolve: () => unknown) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.order = () => Promise.resolve(resolve());
      q.maybeSingle = () => Promise.resolve(resolve());
      return q;
    };
    return {
      from: (tabela: string) =>
        tabela === 'crm_pipelines'
          ? encadeia(() => ({ data: { id: 'p1' }, error: null }))
          : encadeia(() => ({ data: linhas, error: null })),
    };
  }

  it('devolve o hint de cada etapa na resposta da ferramenta', async () => {
    const saida = (await crmListStages.handler(
      { pipeline_id: '33000000-0000-4000-8000-000000000001' },
      {
        supabase: supabase([
          etapa({ id: 'a', name: '3. Entendendo o projeto', agent_stage_hint: 'qualifying' }),
          etapa({ id: 'b', name: '7. Não fechou', is_lost: true, agent_stage_hint: 'lost' }),
          etapa({ id: 'c', name: 'Sem equivalente', agent_stage_hint: null }),
        ]),
        organizationId: '33000000-0000-4000-8000-000000000002',
        requestId: 'req-1',
      } as never,
    )) as { etapas: Array<{ name: string; agent_stage_hint: string | null }> };

    expect(saida.etapas.map(e => [e.name, e.agent_stage_hint])).toEqual([
      ['3. Entendendo o projeto', 'qualifying'],
      ['7. Não fechou', 'lost'],
      ['Sem equivalente', null],
    ]);
  });

  it('a descrição da ferramenta anuncia o campo (o modelo só usa o que a ferramenta diz que tem)', () => {
    expect(crmListStages.description).toContain('agent_stage_hint');
  });
});
