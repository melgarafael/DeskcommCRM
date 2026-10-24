import { expect, it, vi } from 'vitest';
import { criarConsultaDeFuncionamento } from './funcionamento-na-consulta';
import { criarContextoCompartilhadoDoTurno, observarFerramentasDoTurno } from './contexto-compartilhado-do-turno';
import { pacoteParaJev } from '@/lib/ai/decisao/revisao-resposta';
import { casePromiseGate } from '@/lib/agent-engine/guardrails/before-send';
import { tool } from 'ai';
import { z } from 'zod';

it('consulta uma vez, preserva a grade e entrega as mesmas fontes ao agente e à revisão', async () => {
  const fonte = { ok: true, results: [{ content: 'Segunda a sexta: abre 7h e fecha 21h30.', source_name: 'Funcionamento' }] };
  const buscar = vi.fn(async () => fonte);
  const consulta = criarConsultaDeFuncionamento(buscar);
  const contexto = criarContextoCompartilhadoDoTurno();
  const original = { horarios: [{ horario_local: '07:00' }, { horario_local: '07:40' }], total_de_horarios: 2 };
  const ferramentas = observarFerramentasDoTurno({
    crm_find_free_slots: tool({ inputSchema: z.object({}), execute: async () => consulta.anexar(original) }),
  }, contexto);
  const recebido = await ferramentas.crm_find_free_slots!.execute!({}, { toolCallId: 'consulta', messages: [], context: {} });
  expect(recebido).toMatchObject({ ...original, funcionamento_presencial: { consulta: fonte } });
  await consulta.anexar(original);
  expect(buscar).toHaveBeenCalledTimes(1);
  const pacote = pacoteParaJev({ candidate: 'Às 6h30 estaremos fechados; abrimos às 7h. Tenho 7h ou 7h40. Qual prefere?', agentContext: contexto.atual() });
  expect(JSON.stringify(pacote.contexto_observado_do_turno)).toContain('Segunda a sexta: abre 7h e fecha 21h30.');
  expect(original).not.toHaveProperty('funcionamento_presencial');
});

it('base sem fonte ou falha explícita não vira horário inventado nem reserva', async () => {
  const consulta = criarConsultaDeFuncionamento(async () => ({ ok: false, error: { code: 'no_knowledge_base' } }));
  const resultado = await consulta.anexar({ horarios: [], reserva: 'nao_executada' });
  expect(resultado).toMatchObject({ horarios: [], reserva: 'nao_executada', funcionamento_presencial: { consulta: { ok: false } } });
  const outra = criarConsultaDeFuncionamento(async () => ({ ok: true, results: [] }));
  expect(await outra.anexar(null)).toBeNull();
});

it('compromisso natural exige Caso real, preservando os dois lados da proteção', () => {
  const ctx = { body: 'Vou confirmar com a equipe e te retorno por aqui.', casesEnabled: true,
    hasOpenCase: false, openedCaseThisTurn: false,
    semanticPromise: { isPromise: false, prometeuRetornoHumano: true, retornoSoDoAssistente: false } };
  expect(casePromiseGate.evaluate(ctx as Parameters<typeof casePromiseGate.evaluate>[0])).toMatchObject({ pass: false, code: 'case_promise_without_case' });
  expect(casePromiseGate.evaluate({ ...ctx, hasOpenCase: true } as Parameters<typeof casePromiseGate.evaluate>[0])).toMatchObject({ pass: true });
});
