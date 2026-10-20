import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { loadActiveRouter } from './router-config';

function poolSeq(responses: Array<{ rows: unknown[] }>): pg.Pool {
  const query = vi.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  return { query } as unknown as pg.Pool;
}

describe('loadActiveRouter', () => {
  it('não escolhe o primeiro se houver vínculo ativo ambíguo', async () => {
    expect(await loadActiveRouter(poolSeq([{ rows: [{ id: 'r1' }, { id: 'r2' }] }]), 'org1', 'cs1')).toBeNull();
  });
  it.each([0, 4, 12, 16])('lê %i do mesmo campo salvo pelo painel, com empresa e canal', async quantidade => {
    const pool = poolSeq([{ rows: [{ id: 'r1', name: 'X', config: { context_message_count: quantidade }, fallback_agent_id: null }] }, { rows: [] }]);
    expect((await loadActiveRouter(pool, 'org1', 'canal1'))?.contextMessageCount).toBe(quantidade);
    expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringMatching(/organization_id = \$1[\s\S]*channel_session_id = \$2/), ['org1', 'canal1']);
  });
  it.each([{}, { context_message_count: 17 }, { context_message_count: '4' }])('preserva fallback oito sem valor salvo válido %j', async config => {
    expect((await loadActiveRouter(poolSeq([{ rows: [{ id: 'r1', name: 'X', config, fallback_agent_id: null }] }, { rows: [] }]), 'org1', 'cs1'))?.contextMessageCount).toBe(8);
  });
  it('devolve null quando o canal não tem router ativo', async () => {
    const router = await loadActiveRouter(poolSeq([{ rows: [] }]), 'org1', 'cs1');
    expect(router).toBeNull();
  });

  it('monta router com membros ordenados por position', async () => {
    const pool = poolSeq([
      { rows: [{ id: 'r1', name: 'Atendimento', config: { classifier_model: 'claude-haiku-4-5', sticky: true, min_confidence: 0.6 }, fallback_agent_id: 'a-fb' }] },
      { rows: [
        { agent_id: 'a2', intent_name: 'suporte', intent_description: 'Problemas técnicos', examples: ['não consigo entrar'] },
        { agent_id: 'a1', intent_name: 'vendas', intent_description: 'Quer comprar', examples: [] },
      ] },
    ]);
    const router = await loadActiveRouter(pool, 'org1', 'cs1');
    expect(router?.id).toBe('r1');
    expect(router?.classifierModel).toBe('claude-haiku-4-5');
    expect(router?.sticky).toBe(true);
    expect(router?.minConfidence).toBe(0.6);
    expect(router?.fallbackAgentId).toBe('a-fb');
    expect(router?.members.map((m) => m.intentName)).toEqual(['suporte', 'vendas']);
  });

  it('config malformada cai nos defaults (modelo do seam, sticky, 0.6)', async () => {
    const pool = poolSeq([
      { rows: [{ id: 'r1', name: 'X', config: { min_confidence: 'muito' }, fallback_agent_id: null }] },
      { rows: [] },
    ]);
    const router = await loadActiveRouter(pool, 'org1', 'cs1');
    // null = "Automático": quem decide é o seam, nunca um id fixo de provedor.
    expect(router?.classifierModel).toBeNull();
    expect(router?.sticky).toBe(true);
    expect(router?.minConfidence).toBe(0.6);
  });
});

describe('loadActiveRouter — provedor do classificador', () => {
  it('lê classifier_provider da config', async () => {
    const pool = poolSeq([
      { rows: [{ id: 'r1', name: 'X', config: { classifier_model: 'gpt-5-mini', classifier_provider: 'openai' }, fallback_agent_id: null }] },
      { rows: [] },
    ]);
    const router = await loadActiveRouter(pool, 'org1', 'cs1');
    expect(router?.classifierModel).toBe('gpt-5-mini');
    expect(router?.classifierProvider).toBe('openai');
  });

  it('sem classifier_provider → null (usa o provedor da organização, como antes)', async () => {
    const pool = poolSeq([
      { rows: [{ id: 'r1', name: 'X', config: { classifier_model: 'claude-haiku-4-5' }, fallback_agent_id: null }] },
      { rows: [] },
    ]);
    const router = await loadActiveRouter(pool, 'org1', 'cs1');
    expect(router?.classifierProvider).toBeNull();
  });

  it('classifier_provider vazio ou não-string é ignorado — não vira provedor ""', async () => {
    for (const valor of ['', '   ', 42, null, {}]) {
      const pool = poolSeq([
        { rows: [{ id: 'r1', name: 'X', config: { classifier_provider: valor }, fallback_agent_id: null }] },
        { rows: [] },
      ]);
      const router = await loadActiveRouter(pool, 'org1', 'cs1');
      expect(router?.classifierProvider).toBeNull();
    }
  });
});
