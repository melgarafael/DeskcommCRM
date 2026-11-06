import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseList } from '@/app/app/ai/cases/_components/CaseList';

const state = vi.hoisted(() => ({ selectedInUrl: null as string | null }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.selectedInUrl ? { caso: state.selectedInUrl } : {}) }));
vi.mock('@/hooks/ai/useCases', () => ({ useCases: (tab: string) => ({ isLoading: false, data: {
  open_count: 1, cases: [{ id: tab === 'resolved' ? 'closed-case' : 'open-case', title: tab === 'resolved' ? 'Caso concluído de demonstração' : 'Caso aberto de demonstração',
    status: tab === 'resolved' ? 'resolved' : 'awaiting_human', kind: 'outro', contact_name: 'Contato fictício', opened_at: '2026-10-22T15:00:00Z' }],
} }) }));
vi.mock('@/app/app/ai/cases/_components/CaseDetail', () => ({
  CaseDetail: ({ caseId }: { caseId: string | null }) => <p data-testid="selected-case">{caseId ?? 'Sem seleção'}</p>,
}));

beforeEach(() => { state.selectedInUrl = null; });

describe('navegação de Casos entre lista e detalhe', () => {
  it('não rouba foco ao carregar a lista', () => {
    render(<CaseList />);
    expect(screen.getByRole('tab', { name: /Abertos/ })).not.toHaveFocus();
    expect(screen.getByTestId('selected-case')).toHaveTextContent('Sem seleção');
  });
  it('abre o caso e volta à lista, devolvendo foco ao botão de origem', () => {
    render(<CaseList />);
    const trigger = screen.getByTestId('case-item'); fireEvent.click(trigger);
    expect(screen.getByTestId('selected-case')).toHaveTextContent('open-case');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar aos casos' }));
    expect(screen.getByTestId('selected-case')).toHaveTextContent('Sem seleção');
    expect(trigger).toHaveFocus();
  });
  it('o link direto abre seu caso e a volta tem um foco válido sem botão de origem', () => {
    state.selectedInUrl = 'linked-case'; render(<CaseList />);
    expect(screen.getByTestId('selected-case')).toHaveTextContent('linked-case');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar aos casos' }));
    expect(screen.getByTestId('selected-case')).toHaveTextContent('Sem seleção');
    expect(screen.getByRole('tab', { name: /Abertos/ })).toHaveFocus();
  });
  it('voltar preserva o filtro de concluídos', () => {
    render(<CaseList />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Concluídos' }), { button: 0, ctrlKey: false });
    const trigger = screen.getByTestId('case-item'); fireEvent.click(trigger);
    expect(screen.getByTestId('selected-case')).toHaveTextContent('closed-case');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar aos casos' }));
    expect(screen.getByRole('tab', { name: 'Concluídos' })).toHaveAttribute('aria-selected', 'true');
    expect(trigger).toHaveFocus();
  });
});
