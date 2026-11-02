import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { escolherAgenteDoNumero, loadPublishedAgentConfig, loadPublishedAgentConfigById } from './agent-config';

const baseRow = {
  agent_id: 'a1', version_id: 'v1', agent_name: 'Vendedor', system_prompt: 'p',
  provider: 'anthropic', model: 'claude-sonnet-4-6', credential_id: null,
  max_steps: 8, history_message_window: 30, history_token_window: 8000,
  handoff_keywords: null, handoff_tool_enabled: true, tool_ids: null,
  version_created_by: null, agent_created_by: null,
  active_kb_version_id: 'kb-1',
  config: { rag_top_k: 7, rag_similarity_threshold: 0.8 },
  followup: { enabled: true, flow_pointer_ids: ['flow-1'], callback_enabled: false },
};

function poolWith(row: Record<string, unknown> | undefined): pg.Pool {
  return { query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) } as unknown as pg.Pool;
}

describe('loadPublishedAgentConfig — campos de RAG', () => {
  it('expõe active_kb_version_id e knobs de RAG do config', async () => {
    const cfg = await loadPublishedAgentConfig(poolWith(baseRow), 'org1', 'cs1');
    expect(cfg?.activeKbVersionId).toBe('kb-1');
    expect(cfg?.ragTopK).toBe(7);
    expect(cfg?.ragSimilarityThreshold).toBe(0.8);
  });

  // 0.40 e não 0.72: o limiar foi CALIBRADO com medição na migration 0097
  // (pergunta literal 0.849, paráfrase 0.49–0.65, irrelevante 0.27). O banco
  // moveu o default e ESTE fallback ficou para trás — e é ele que vale, porque
  // quem corta pelo limiar é o TypeScript, não a RPC. Com 0.72, toda paráfrase
  // era descartada e o RAG parecia quebrado funcionando.
  it('cai nos defaults calibrados (5 / 0.40) quando config é nulo ou fora da faixa', async () => {
    const cfg = await loadPublishedAgentConfig(
      poolWith({ ...baseRow, config: { rag_top_k: 999, rag_similarity_threshold: -1 } }),
      'org1', 'cs1',
    );
    expect(cfg?.ragTopK).toBe(5);
    expect(cfg?.ragSimilarityThreshold).toBe(0.4);
  });

  it('activeKbVersionId nulo quando o agente não tem KB ativa', async () => {
    const cfg = await loadPublishedAgentConfig(poolWith({ ...baseRow, active_kb_version_id: null }), 'org1', 'cs1');
    expect(cfg?.activeKbVersionId).toBeNull();
  });

  it('carrega followup da versão publicada, sem misturar a política de callbacks com os fluxos', async () => {
    const pool = poolWith(baseRow);
    const cfg = await loadPublishedAgentConfig(pool, 'org1', 'cs1');
    const queryMock = pool.query as unknown as ReturnType<typeof vi.fn>;
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toMatch(/v\.followup/);
    expect(cfg?.followup).toEqual({
      enabled: true,
      flow_pointer_ids: ['flow-1'],
      callback_enabled: false,
    });
  });

  it('preserva a configuração legada sem callback_enabled', async () => {
    const cfg = await loadPublishedAgentConfig(
      poolWith({ ...baseRow, followup: { enabled: true, flow_pointer_ids: ['flow-1'] } }),
      'org1',
      'cs1',
    );

    expect(cfg?.followup).toEqual({ enabled: true, flow_pointer_ids: ['flow-1'] });
  });
});

describe('mcpExternoNoAtendimento (#2147) — desligado de fábrica', () => {
  it.each([
    ['ligado', { mcp_externo_no_atendimento: true }, true],
    ['ausente', { rag_top_k: 7 }, false],
    ['config nulo', null, false],
    ['false', { mcp_externo_no_atendimento: false }, false],
    ["'true' em texto", { mcp_externo_no_atendimento: 'true' }, false],
    ['1', { mcp_externo_no_atendimento: 1 }, false],
  ])('%s', async (_c, config, esperado) => {
    const cfg = await loadPublishedAgentConfig(poolWith({ ...baseRow, config }), 'org1', 'cs1');
    expect(cfg?.mcpExternoNoAtendimento).toBe(esperado);
  });
});

describe('loadPublishedAgentConfigById', () => {
  it('filtra por organization_id e agent_id, nessa ordem — risco de vazamento cross-tenant se removido', async () => {
    const pool = poolWith(baseRow);
    await loadPublishedAgentConfigById(pool, 'org1', 'a1');
    const queryMock = pool.query as unknown as ReturnType<typeof vi.fn>;
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    // params na ORDEM exata — falha se o filtro de org for removido/trocado.
    expect(params).toEqual(['org1', 'a1']);
    // e o SQL de fato usa esses params pra filtrar org+id (não só passa o
    // valor sem usar) — falha se o `and a.organization_id = $1` sumir do SQL.
    expect(sql).toMatch(/a\.organization_id\s*=\s*\$1/);
    expect(sql).toMatch(/a\.id\s*=\s*\$2/);
  });

  it('retorna null quando o agente não é encontrado', async () => {
    const cfg = await loadPublishedAgentConfigById(poolWith(undefined), 'org1', 'a1');
    expect(cfg).toBeNull();
  });

  it('mapeia a linha com o mesmo mapper de loadPublishedAgentConfig (rag knobs inclusos)', async () => {
    const cfg = await loadPublishedAgentConfigById(poolWith(baseRow), 'org1', 'a1');
    expect(cfg?.agentId).toBe('a1');
    expect(cfg?.agentName).toBe('Vendedor');
    expect(cfg?.provider).toBe('anthropic');
    expect(cfg?.model).toBe('claude-sonnet-4-6');
    expect(cfg?.activeKbVersionId).toBe('kb-1');
    expect(cfg?.ragTopK).toBe(7);
    expect(cfg?.ragSimilarityThreshold).toBe(0.8);
  });
});

/**
 * PÚBLICO DO AGENTE NA SELEÇÃO (#3722) — o teste que fica VERMELHO sem o
 * conserto.
 *
 * O defeito medido pelo autor da issue: dois agentes publicados no MESMO
 * número, e a seleção pegava `limit 1` na ordem de prioridade — o segundo
 * nunca era escolhido, então não havia como dar o cliente com contrato ao
 * agente de suporte e o prospect ao de vendas.
 *
 * Aqui a seleção é exercitada com o pool fingido devolvendo as DUAS linhas na
 * ordem que o SQL devolveria. Sem a escolha por público, o primeiro (vendas)
 * vence sempre e os casos "o cliente com contrato vai para o suporte" e
 * "ninguém elegível ⇒ silêncio" reprovam.
 */
function agentRow(id: string, trigger: unknown, extra: Record<string, unknown> = {}) {
  return {
    ...baseRow,
    agent_id: id,
    version_id: `v-${id}`,
    agent_name: id,
    trigger_config: trigger,
    ...extra,
  };
}

const NUMERO = 'cs1';
const CONTATO = 'contato-1';

/** Pool que responde à seleção e à leitura dos fatos do contato. */
function poolDaSelecao(
  candidatos: Record<string, unknown>[],
  fatos: { tags?: string[]; funis?: string[] } | null = { tags: [], funis: [] },
): pg.Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (/from contacts c/.test(sql)) {
        return { rows: fatos === null ? [] : [{ tags: fatos.tags ?? [], funis: fatos.funis ?? [] }] };
      }
      return { rows: candidatos };
    }),
  } as unknown as pg.Pool;
}

const VENDAS = agentRow('vendas', {
  filters: { exclude_tags: ['cliente ativo'] },
  // prioridade maior: é o primeiro da fila de sempre
}, { priority: 10, created_at: '2026-01-01T00:00:00Z' });

const SUPORTE = agentRow('suporte', {
  filters: { include_tags: ['cliente ativo'] },
}, { priority: 5, created_at: '2026-02-01T00:00:00Z' });

describe('público do agente — quem atende no mesmo número (#3722)', () => {
  it('cliente com contrato NÃO é atendido pelo agente de vendas: o suporte assume', async () => {
    const pool = poolDaSelecao([VENDAS, SUPORTE], { tags: ['Cliente Ativo'], funis: [] });
    const escolha = await escolherAgenteDoNumero(pool, 'org1', NUMERO, CONTATO);
    expect(escolha.config?.agentId).toBe('suporte');
    expect(escolha.motivo).toBe('publico_liberou');
  });

  it('prospect (sem a etiqueta) é atendido pelo agente de vendas', async () => {
    const pool = poolDaSelecao([VENDAS, SUPORTE], { tags: ['prospect'], funis: [] });
    const escolha = await escolherAgenteDoNumero(pool, 'org1', NUMERO, CONTATO);
    expect(escolha.config?.agentId).toBe('vendas');
    expect(escolha.motivo).toBe('publico_liberou');
  });

  it('ninguém elegível ⇒ config null e motivo `publico_barrou` (o genérico não assume)', async () => {
    const pool = poolDaSelecao(
      [
        agentRow('so-clientes', { filters: { include_tags: ['cliente ativo'] } }),
        agentRow('so-prospects', { filters: { exclude_tags: ['prospect'] } }),
      ],
      { tags: ['prospect'], funis: [] },
    );
    const escolha = await escolherAgenteDoNumero(pool, 'org1', NUMERO, CONTATO);
    expect(escolha).toEqual({ config: null, motivo: 'publico_barrou' });
  });

  it('precedência com critérios sobrepostos: vence o PRIMEIRO da ordem de sempre', async () => {
    // Os dois aceitam o cliente; a ordem (priority desc) decide — não existe
    // pontuação de especificidade no meio.
    const pool = poolDaSelecao(
      [
        agentRow('primeiro', {
          filters: { include_tags: ['cliente ativo'] },
        }, { priority: 10, created_at: '2026-01-01T00:00:00Z' }),
        agentRow('segundo', {
          filters: { include_tags: ['cliente ativo'], include_pipeline_ids: ['p1'] },
        }, { priority: 5, created_at: '2026-02-01T00:00:00Z' }),
      ],
      { tags: ['cliente ativo'], funis: ['p1'] },
    );
    const escolha = await escolherAgenteDoNumero(pool, 'org1', NUMERO, CONTATO);
    expect(escolha.config?.agentId).toBe('primeiro');
  });

  it('quem não configurou público não paga a leitura do contato', async () => {
    const pool = poolDaSelecao([agentRow('unico', { filters: { keyword_regex: 'oi' } })]);
    const escolha = await escolherAgenteDoNumero(pool, 'org1', NUMERO, CONTATO);
    expect(escolha.motivo).toBe('primeiro_da_fila');
    const sqls = (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(sqls.some((s) => /from contacts c/.test(s))).toBe(false);
  });

  it('pausado continua por último e um pausado de prioridade alta não sequestra o número', async () => {
    const pool = poolDaSelecao(
      [
        agentRow('no-ar', { filters: {} }, { priority: 0, paused_at: null }),
        agentRow('pausado', { filters: {} }, { priority: 99, paused_at: '2026-10-01T00:00:00Z' }),
      ],
      { tags: [], funis: [] },
    );
    const escolha = await escolherAgenteDoNumero(pool, 'org1', NUMERO, CONTATO);
    expect(escolha.config?.agentId).toBe('no-ar');
  });

  it('sem candidato nenhum o motivo é `sem_agente` (comportamento de sempre)', async () => {
    const escolha = await escolherAgenteDoNumero(poolDaSelecao([]), 'org1', NUMERO, CONTATO);
    expect(escolha).toEqual({ config: null, motivo: 'sem_agente' });
  });

  it('público configurado e contato ausente: a régua não é aplicada e o motivo diz isso', async () => {
    const escolha = await escolherAgenteDoNumero(poolDaSelecao([VENDAS]), 'org1', NUMERO, null);
    expect(escolha).toEqual({ config: expect.objectContaining({ agentId: 'vendas' }), motivo: 'sem_contato' });
  });

  it('erro ao ler os dados do contato SOBE (a fila re-tenta o job)', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (/from contacts c/.test(sql)) throw new Error('timeout');
        return { rows: [VENDAS, SUPORTE] };
      }),
    } as unknown as pg.Pool;
    await expect(escolherAgenteDoNumero(pool, 'org1', NUMERO, CONTATO)).rejects.toThrow('timeout');
  });

  it('loadPublishedAgentConfig continua devolvendo o mesmo agente que a escolha', async () => {
    const pool = poolDaSelecao([VENDAS, SUPORTE], { tags: ['cliente ativo'], funis: [] });
    const cfg = await loadPublishedAgentConfig(pool, 'org1', NUMERO, CONTATO);
    expect(cfg?.agentId).toBe('suporte');
  });
});
