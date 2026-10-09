import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoteamentoResultados } from './RoteamentoResultados';

vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));
const caso = {
  id: '33333333-3333-4333-8333-333333333333', router_id: '44444444-4444-4444-8444-444444444444',
  conversation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", modo: 'jev_sob_demanda', context_message_count: 8, origem: 'jev', motivo_reserva: null,
  intent_jev: 'vendas', intent_tradicional: null, intent_final: 'vendas', agent_id_final: null,
  agent_id_esperado: null, modelo_jev: 'jev-1', destino_jev: 'a', destino_tradicional: null,
  concordou_destino: null, revisao: null, custo_jev_cents: .01, custo_tradicional_cents: 0,
  custo_incompleto: false, tempo_total_ms: 120, created_at: '2026-09-30T12:00:00Z',
};
const resposta = {
  roteadores: [{ id: caso.router_id, name: "Atendimento principal" }],
  casos: [caso], membros: [{ router_id: caso.router_id, agent_id: '55555555-5555-4555-8555-555555555555', intent_name: 'suporte' }],
  pode_revisar: true,
  resumo: { total: 1, limite_amostra: 500, periodo_dias: 30, sem_reserva: 1, reservas: 0,
    motivos_reserva: {}, custo_total_cents: .01, custos_incompletos: 0, mediana_ms: 120, p95_ms: 120,
    comparacoes_destino: 0, concordancias_destino: 0, comparacoes_intencao: 0, concordancias_intencao: 0,
    revisados: 0, corretos_revisados: 0 },
};

afterEach(() => vi.unstubAllGlobals());

describe('aba de resultados do roteamento', () => {
  it('Jev independente aparece sem concordância inventada e com contexto/custo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: resposta }), { status: 200 })));
    render(<RoteamentoResultados />);
    const linha = await screen.findByTestId(`roteamento-${caso.id}`);
    expect(linha).toHaveTextContent('Jev; reserva sob demanda');
    expect(linha).toHaveTextContent('Janela de histórico: 8');
    expect(screen.getByRole('option', { name: 'Atendimento principal' })).toHaveValue(caso.router_id);
    expect(screen.getByRole('link', { name: 'Abrir conversa' })).toHaveAttribute('href', `/app/inbox?id=${caso.conversation_id}`);
    expect(screen.getByText(/Concordância de destino/)).toHaveTextContent('Sem pares');
    expect(screen.getByText(/Reservas sob demanda não formam amostra/)).toBeVisible();
  });

  it('revisão incorreta envia o agente esperado para a API', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === 'PATCH' ? { data: { alterado: true } } : { data: resposta }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(<RoteamentoResultados />);
    const seletor = await screen.findByLabelText('Revisão');
    fireEvent.change(seletor, { target: { value: 'incorreto' } });
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const patch = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ revisao: 'incorreto', agent_id_esperado: null });
  });
});
