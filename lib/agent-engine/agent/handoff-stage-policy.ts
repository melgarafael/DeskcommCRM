import type { ToolSet } from '../edge/llm/run-model-call';

/** Passagem de atendimento não é uma decisão comercial. Vale no preview e no envio real. */
export function preserveStageDuringHandoff(tools: ToolSet, requestedHuman: boolean): ToolSet {
  let handingOff = requestedHuman;
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    if (!definition.execute || !['request_human_handoff', 'update_lead_state'].includes(name))
      return [name, definition];
    const execute = definition.execute;
    return [name, {
      ...definition,
      execute: async (...args: Parameters<typeof execute>) => {
        const input = args[0];
        if (name === 'update_lead_state' && handingOff && input && typeof input === 'object' && 'stage' in input) {
          return { ok: false, error: { code: 'handoff_preserves_stage', message:
            'Pedido de atendimento humano não altera a etapa comercial. Preserve a etapa atual, registre o contexto e passe para uma pessoa. A pessoa poderá avaliar uma desistência comercial separadamente.' } };
        }
        const result = await execute(...args);
        if (name === 'request_human_handoff' && result && typeof result === 'object' && 'ok' in result && result.ok === true)
          handingOff = true;
        return result;
      },
    }];
  }));
}
