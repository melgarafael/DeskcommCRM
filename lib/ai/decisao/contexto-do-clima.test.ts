import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { carregarContextoDoClima, entradaDoClima, metadadosDoContexto, projetarHistoricoDoClima } from './contexto-do-clima';

const momento = '2026-10-20T14:30:00Z';
const linha = (body: string, direction = 'inbound', status = 'received') => ({
  body, direction, status, created_at: '2026-10-20T14:20:00Z', sent_at: null as string | null,
});

describe('fotografia delimitada do clima', () => {
  it('aplica a quantidade resolvida à consulta e declara omissão sem afetar outras fontes', async () => {
    let limite = 0;
    const q = { select: () => q, eq: () => q, neq: () => q, lt: () => q, order: () => q,
      limit: async (n: number) => { limite = n; return { data: Array.from({ length: n }, (_, i) => linha(`m${i}`)), error: null }; } };
    const c = await carregarContextoDoClima({ from: () => q } as unknown as SupabaseClient,
      { organizationId: 'org', conversationId: 'conv', messageId: 'atual', createdAt: momento, serviceRevision: 1,
        janela: { quantidade: 4, origem: 'roteador', motivo: 'configurado' } });
    expect(limite).toBe(5);expect(c.historico).toHaveLength(4);expect(c).toMatchObject({ cobertura: 'limited', omitidas: 1 });
  });
  it('aceita revisão bigint decimal persistida, sem aceitar revisão arbitrária', async () => {
    let leituras = 0;
    const q = { select: () => q, eq: () => q, neq: () => q, lt: () => q, order: () => q,
      limit: async () => { leituras++; return { data: [linha('anterior')], error: null }; } };
    const admin = { from: () => q } as unknown as SupabaseClient;
    const input = { organizationId: 'org', conversationId: 'conv', messageId: 'id', createdAt: momento, serviceRevision: '1' };
    expect((await carregarContextoDoClima(admin, input)).historico).toHaveLength(1);
    expect(await carregarContextoDoClima(admin, { ...input, serviceRevision: '1 OR TRUE' })).toMatchObject({ cobertura: 'unavailable' });
    expect(leituras).toBe(1);
  });
  it('exclui saída não entregue, envio futuro e conteúdo anonimizado; ordena pelo instante efetivo', () => {
    const c = projetarHistoricoDoClima([
      { ...linha('resposta enviada', 'outbound', 'sent'), sent_at: '2026-10-20T14:25:00Z' },
      linha('cliente perguntou'), linha('rascunho', 'outbound', 'pending'),
      { ...linha('ainda não enviada', 'outbound', 'sent'), sent_at: '2026-10-20T14:31:00Z' },
      linha('[mensagem anonimizada]'),
    ], momento);
    expect(c.historico.map(m => m.texto)).toEqual(['cliente perguntou', 'resposta enviada']);
    expect(c).toMatchObject({ cobertura: 'limited', omitidas: 3 });
  });

  it('mantém mensagens inteiras e declara o limite, sem fabricar um histórico completo', () => {
    const c = projetarHistoricoDoClima(Array.from({ length: 17 }, (_, n) => linha(`m${n}`)), momento);
    expect(c.historico).toHaveLength(16);
    expect(c).toMatchObject({ cobertura: 'limited', omitidas: 1 });
    const grande = projetarHistoricoDoClima([linha('a'.repeat(16001)), linha('anterior inteira')], momento);
    expect(grande.historico.map(m => m.texto)).toEqual(['anterior inteira']);
    expect(grande.omitidas).toBe(1);
  });

  it('sanitiza a mensagem atual e o histórico e registra somente metadados do pacote', () => {
    const c = projetarHistoricoDoClima([linha('envie para pessoa@example.com')], momento);
    const p = entradaDoClima('meu telefone +55 11 98765-4321', c);
    expect(JSON.stringify(p)).not.toMatch(/pessoa@example|98765/);
    expect(metadadosDoContexto('Pode dx', c)).toMatchObject({ mensagens: 1, cobertura: 'present', omitidas: 0 });
    expect(metadadosDoContexto('Pode dx', c).fingerprint).not.toBe(metadadosDoContexto('Outra', c).fingerprint);
    expect(entradaDoClima('Pode dx')).toBe('Pode dx');
  });
});
