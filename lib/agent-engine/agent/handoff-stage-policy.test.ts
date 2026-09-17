import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '../edge/llm/run-model-call';
import { preserveStageDuringHandoff } from './handoff-stage-policy';
import { detectHumanHandoffRequest } from './human-handoff';
const opts = { toolCallId: 'test', messages: [], context: undefined };
function setup(requested = false, success = true) {
  const write = vi.fn(async () => ({ ok: true }));
  const tools = preserveStageDuringHandoff({
    update_lead_state: tool({ inputSchema: z.object({ stage: z.string().optional() }), execute: write }),
    request_human_handoff: tool({ inputSchema: z.object({}), execute: async () => ({ ok: success }) }),
  }, requested);
  return { tools, write };
}
describe('passagem humana preserva etapa comercial', () => {
  it('barra a perda do caso real mesmo antes da chamada de handoff', async () => {
    const { tools, write } = setup(detectHumanHandoffRequest('Quero falar com uma pessoa, não quero responder mais perguntas.'));
    expect(await tools.update_lead_state!.execute!({ stage: 'lost' }, opts)).toMatchObject({ ok: false });
    expect(write).not.toHaveBeenCalled();
  });
  it.each(['lost', 'contacted', 'won'])('após handoff barra etapa %s em preview ou executor real', async (stage) => {
    const { tools, write } = setup();
    await tools.request_human_handoff!.execute!({}, opts);
    expect(await tools.update_lead_state!.execute!({ stage }, opts)).toMatchObject({ ok: false });
    expect(write).not.toHaveBeenCalled();
  });
  it('não bloqueia desistência comercial sem pedido humano', async () => {
    const { tools, write } = setup();
    await tools.update_lead_state!.execute!({ stage: 'lost' }, opts);
    expect(write).toHaveBeenCalledOnce();
  });
  it('não trata falha da passagem como passagem concluída', async () => {
    const { tools, write } = setup(false, false);
    await tools.request_human_handoff!.execute!({}, opts);
    await tools.update_lead_state!.execute!({ stage: 'qualifying' }, opts);
    expect(write).toHaveBeenCalledOnce();
  });
  it('permite atualizar contexto sem alterar etapa', async () => {
    const { tools, write } = setup(true);
    await tools.update_lead_state!.execute!({}, opts);
    expect(write).toHaveBeenCalledOnce();
  });
});
