import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireRole } from '@/lib/auth/require-role';
import { createAdminClient } from '@/lib/supabase/admin';
import { GET } from './route';

vi.mock('@/lib/auth/require-role', () => ({ requireRole: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
const ORG = '22222222-2222-4222-8222-222222222222';
const OUTRA = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const MSG = '55555555-5555-4555-8555-555555555555';

function caso(extra: Record<string, unknown> = {}) {
  return { id: '66666666-6666-4666-8666-666666666666', router_id: '77777777-7777-4777-8777-777777777777',
    conversation_id: null, message_id: MSG, job_id: JOB, modo: 'jev_sob_demanda', context_message_count: 8,
    origem: 'jev', motivo_reserva: null, intent_jev: 'vendas', intent_tradicional: null, intent_final: 'vendas',
    agent_id_final: null, confianca_final: .9, modelo_jev: 'jev-1', custo_jev_cents: .01,
    custo_tradicional_cents: 0, custo_incompleto: false, tempo_total_ms: 120,
    revisao: null, agent_id_esperado: null, revisado_em: null, created_at: new Date().toISOString(), ...extra };
}

let linhas: ReturnType<typeof caso>[];
let observacoes: Record<string, unknown>[];
let chamadas: Record<string, unknown>[];
let filtros: Array<[string,string,unknown]>;
beforeEach(() => {
  vi.clearAllMocks();
  linhas = []; observacoes = []; chamadas = []; filtros = [];
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: 'u' }, org: { orgId: ORG, role: 'admin' } } as never);
  vi.mocked(createAdminClient).mockReturnValue({
    from: (nome: string) => {
      const chain = {
        select: () => chain, order: () => chain, limit: () => chain,
        eq: (c: string, v: unknown) => { filtros.push([nome,c,v]); return chain; },
        gte: (c: string, v: unknown) => { filtros.push([nome,c,v]); return chain; },
        in: (c: string, v: unknown) => { filtros.push([nome,c,v]); return chain; },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: nome === 'jev_router_decisions' ? linhas : nome === 'jev_observacoes' ? observacoes : nome === 'llm_calls' ? chamadas : [], error: null }),
      };
      return chain;
    },
  } as never);
});

async function pedir(query = '') {
  const res = await GET(new NextRequest(`http://localhost/api/v1/ai/routing-results${query}`));
  return { status: res.status, body: await res.json() };
}

describe('resultados do roteamento', () => {
  it('Jev independente sem reserva conta uma decisão, sem inventar comparação', async () => {
    linhas = [caso()];
    chamadas = [{ job_id: JOB, provider: 'typesafe', cost_cents: .01, model: 'jev-1' }];
    const { status, body } = await pedir();
    expect(status).toBe(200);
    expect(body.data.resumo).toMatchObject({ total: 1, sem_reserva: 1, reservas: 0, comparacoes_destino: 0, custo_total_cents: .01, custos_incompletos: 0 });
    expect(filtros).toContainEqual(['jev_router_decisions', 'organization_id', ORG]);
    expect(filtros).toContainEqual(['ai_routers', 'organization_id', ORG]);
    expect(filtros).not.toContainEqual(['jev_router_decisions', 'organization_id', OUTRA]);
  });

  it('comparação usa apenas pares reais de destino e intenção', async () => {
    linhas = [caso({ modo: 'jev_comparacao', origem: 'jev', intent_tradicional: 'vendas', custo_tradicional_cents: .2 })];
    observacoes = [{ message_id: MSG, rotulo_jev: 'agente-1', rotulo_atual: 'agente-1',
      intencao_jev: 'vendas', intencao_atual: 'vendas', concordou: true, modelo: 'jev-1' }];
    chamadas = [{ job_id: JOB, provider: 'typesafe', cost_cents: .01, model: 'jev-1' },
      { job_id: JOB, provider: 'anthropic', cost_cents: .2, model: 'haiku' }];
    const { body } = await pedir('?modo=jev_comparacao&contexto=8');
    expect(body.data.resumo).toMatchObject({ comparacoes_destino: 1, concordancias_destino: 1,
      comparacoes_intencao: 1, concordancias_intencao: 1 });
    expect(body.data.resumo.custo_total_cents).toBeCloseTo(.21);
    expect(filtros).toContainEqual(['jev_router_decisions','modo','jev_comparacao']);
    expect(filtros).toContainEqual(['jev_router_decisions','context_message_count',8]);
  });

  it('preço ausente na chamada real não é mascarado pelo custo registrado antes', async () => {
    linhas = [caso({ modo: 'tradicional_comparacao', origem: 'tradicional', custo_jev_cents: .01,
      custo_tradicional_cents: .2 })];
    chamadas = [{ job_id: JOB, provider: 'typesafe', cost_cents: null, model: 'jev-1' },
      { job_id: JOB, provider: 'anthropic', cost_cents: .2, model: 'haiku' }];
    const { body } = await pedir();
    expect(body.data.resumo).toMatchObject({ custo_total_cents: 0, custos_incompletos: 1 });
    expect(body.data.casos[0].custo_jev_cents).toBeNull();
  });

  it('query inválida é recusada antes de consultar o banco', async () => {
    expect((await pedir('?contexto=18')).status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
