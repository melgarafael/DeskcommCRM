import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CRITERIO_ENVIO_AGENDA, INSTRUCAO_CONTINUIDADE_CASO } from '@/lib/agenda/pedido';
import { INSTRUCAO_CONSULTA_AGENDA } from '@/lib/agenda/consulta-do-turno';
import { pacoteParaJev, perguntasDaRevisao } from '@/lib/ai/decisao/revisao-resposta';
import type { ContextoDoAtendimento } from '../../agent/contexto-do-atendimento';
import { semanticPromiseGate, type GateContext } from '../before-send';
const mock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../edge/llm/run-model-call', () => ({ runModelCall: mock.call }));
import { classifyPromise } from './semantic';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const pool = {} as pg.Pool;
const request = 'Quero marcar uma consulta para mim.';
const context: ContextoDoAtendimento = {
  versao: 1, fingerprint: 'fotografia', perfil: [], decisoes: [], operacoes: [],
  pedido: { estado: 'present', tipoTurno: 'inbound_turn', gatilhoEm: '2026-10-19T12:00:00Z',
    mensagem: { id: 'mensagem-privada', text: request, at: '2026-10-19T12:00:00Z', origem: 'client_message' } },
  continuidade: [{ id: 'caso-privado', origem: 'caso_humano', sujeito: 'contato',
    em: '2026-10-19T12:00:05Z', revisao: '1', estado: 'recorded',
    dados: { estado: 'awaiting_human', titulo: 'Analisar solicitação de consulta',
      pedido_original: request, bloqueio: 'Aguardando esclarecimento da equipe.',
      natureza: 'pendencia_operacional_do_pedido_original', autoridade: 'nao_atesta_decisao_humana_nem_veto_global' } }],
  cobertura: [{ categoria: 'continuidade', estado: 'present', encontrados: 1, selecionados: 1, omitidos: 0 }],
};

beforeEach(() => { vi.clearAllMocks(); mock.call.mockReset(); });

describe('prova de registro de solicitação não é prova de agendamento', () => {
  it('leva o Caso sem reserva e o mesmo critério ao JEV, reserva e confirmador, sem liberar pelo texto', async () => {
    const args = { candidate: 'Seu pedido ficou registrado. O agendamento ainda não está confirmado.',
      agendaReviewRequired: true, serviceContext: context };
    mock.call.mockResolvedValueOnce({ result: { text: '{"isPromise":false,"prometeuRetornoHumano":true,"retornoSoDoAssistente":false}' } })
      .mockResolvedValueOnce({ result: { text: '{"agendaCompativel":true}' } })
      .mockResolvedValueOnce({ result: { text: '{"prometeuRetornoHumano":true,"retornoSoDoAssistente":false}' } });
    const value = await classifyPromise(pool, {}, { tenantId: 'org-a' }, args,
      { log, loadHumanReturnBinding: vi.fn(async () => ({ is_enabled: true, purpose: 'human_return_confirmation' })) as never });
    expect(value).toMatchObject({ agendaCompativel: true, prometeuRetornoHumano: true });
    expect(mock.call).toHaveBeenCalledTimes(3);
    const packet = pacoteParaJev(args);
    expect(packet).toMatchObject({ contexto_atendimento: { operacoes: [], continuidade: [
      { origem: 'caso_humano', estado: 'recorded', dados: { pedido_original: request, estado: 'awaiting_human' } },
    ] } });
    expect(JSON.stringify(packet)).not.toContain('caso-privado');
    for (const call of mock.call.mock.calls) {
      expect(JSON.parse(call[2].messages[0].content)).toEqual(packet);
      expect(call[2].system).toContain(INSTRUCAO_CONTINUIDADE_CASO);
    }
    expect(perguntasDaRevisao(false, false, true).agenda?.instrucao).toContain(CRITERIO_ENVIO_AGENDA);
    expect(perguntasDaRevisao(false, false, true).agenda?.instrucao).toContain(INSTRUCAO_CONSULTA_AGENDA);
    // O modelo foi controlado: esta prova mede a propagação, não a acurácia do classificador.
  });

  it.each([
    ['reserva sem recibo', 'Sua consulta está agendada e confirmada.'],
    ['registro sem Caso', 'Seu pedido ficou registrado.'],
    ['Caso de outro pedido', 'Seu novo pedido ficou registrado.'],
  ])('conserva o veto do modelo para %s; não transforma o Caso ou a frase em autorização', async (_label, candidate) => {
    const serviceContext = _label === 'registro sem Caso' ? { ...context, continuidade: [],
      cobertura: [{ categoria: 'continuidade' as const, estado: 'not_found' as const, encontrados: 0, selecionados: 0, omitidos: 0 }] }
      : _label === 'Caso de outro pedido' ? { ...context, continuidade: [{ ...context.continuidade[0]!,
        dados: { ...context.continuidade[0]!.dados, pedido_original: 'Solicitação para outra pessoa.' } }] } : context;
    mock.call.mockResolvedValueOnce({ result: { text: '{"isPromise":false,"prometeuRetornoHumano":false}' } })
      .mockResolvedValueOnce({ result: { text: '{"agendaCompativel":false}' } });
    const value = await classifyPromise(pool, {}, { tenantId: 'org-a' },
      { candidate, agendaReviewRequired: true, serviceContext }, { log });
    expect(value.agendaCompativel).toBe(false);
    expect(semanticPromiseGate.evaluate({ semanticPromise: value, agendaRequestReviewRequired: true } as GateContext))
      .toMatchObject({ pass: false, code: 'agenda_request_mismatch' });
  });
});
