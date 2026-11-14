import { describe, expect, it, vi } from 'vitest';

// O fetch de destino da organização consulta rede/DNS; aqui só interessa o que o SDK envia.
vi.mock('@/lib/automation/destinos-internos-autorizados', () => ({
  fetchParaDestinoDaOrganizacao: (interno: typeof fetch) => interno,
}));

import { buildModel } from '@/lib/ai/runtime/agent';

import { createDefaultRegistry } from './providers';

const ENDERECO = 'https://gateway.exemplo.test/v1';

describe('provedor personalizado', () => {
  it.each([
    [
      'turno do agente',
      () => createDefaultRegistry({ allowedHosts: ['gateway.exemplo.test'] }).custom!('chave', 'qualquer-modelo', ENDERECO),
    ],
    ['ensaio da aba Teste', () => buildModel('custom', 'chave', 'qualquer-modelo', ENDERECO)],
  ])('pede JSON (Accept: application/json) na chamada sem streaming (%s)', async (_rotulo, montar) => {
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
      await generateText({ model: montar(), prompt: 'oi' });
      expect(visto.accept).toBe('application/json');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
