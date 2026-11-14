import { describe, expect, it, vi } from 'vitest';

// O fetch de destino da organização consulta rede/DNS; aqui só interessa o que o SDK envia.
vi.mock('@/lib/automation/destinos-internos-autorizados', () => ({
  fetchParaDestinoDaOrganizacao: (interno: typeof fetch) => interno,
}));

import { createDefaultRegistry } from './providers';

describe('provedor personalizado', () => {
  it('pede JSON (Accept: application/json) na chamada sem streaming', async () => {
    const visto: Record<string, string> = {};
    const fetchFalso = vi.fn(async (_url: unknown, init?: RequestInit) => {
      new Headers(init?.headers).forEach((v, k) => {
        visto[k] = v;
      });
      return new Response(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchFalso);
    try {
      const { generateText } = await import('ai');
      const registry = createDefaultRegistry({ allowedHosts: ['gateway.exemplo.test'] });
      const modelo = registry.custom('chave', 'qualquer-modelo', 'https://gateway.exemplo.test/v1');
      await generateText({ model: modelo, prompt: 'oi' });
      expect(visto.accept).toBe('application/json');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
