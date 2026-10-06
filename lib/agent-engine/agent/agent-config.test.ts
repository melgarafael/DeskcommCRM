import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import {
  loadPublishedAgentConfig,
  loadPublishedAgentConfigById,
  loadPublishedAgentConfigsDaSessao,
} from './agent-config';

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

describe('loadPublishedAgentConfigsDaSessao — todos os agentes do número', () => {
  function poolComLinhas(linhas: Record<string, unknown>[]): pg.Pool {
    return { query: vi.fn().mockResolvedValue({ rows: linhas }) } as unknown as pg.Pool;
  }

  it('devolve todos, na ordem do banco, filtrando organização e número', async () => {
    const pool = poolComLinhas([
      { ...baseRow, agent_id: 'a1', version_id: 'v1' },
      { ...baseRow, agent_id: 'a2', version_id: 'v2' },
    ]);
    const lista = await loadPublishedAgentConfigsDaSessao(pool, 'org-1', 'sess-1');
    expect(lista.map((c) => c.agentId)).toEqual(['a1', 'a2']);
    const [sql, values] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(values).toEqual(['org-1', 'sess-1']);
    expect(sql).toContain('order by a.priority desc, a.created_at asc');
    expect(sql).not.toContain('limit 1');
  });

  it('número sem agente publicado ⇒ lista vazia', async () => {
    expect(await loadPublishedAgentConfigsDaSessao(poolComLinhas([]), 'org-1', 'sess-1')).toEqual([]);
  });

  it('loadPublishedAgentConfig segue devolvendo só o primeiro', async () => {
    const pool = poolComLinhas([
      { ...baseRow, agent_id: 'a1', version_id: 'v1' },
      { ...baseRow, agent_id: 'a2', version_id: 'v2' },
    ]);
    expect((await loadPublishedAgentConfig(pool, 'org-1', 'sess-1'))?.agentId).toBe('a1');
  });
});
