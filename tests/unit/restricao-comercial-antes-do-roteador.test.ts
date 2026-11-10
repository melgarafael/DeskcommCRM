/**
 * VALORES E NEGOCIAÇÃO SÓ COM A EQUIPE (#2877) — a passagem antes do roteador.
 *
 * Mede o handler de verdade (`createInboundTurnHandler`) com a leitura real da
 * camada (`comercialExigeHumano`) contra um pool que responde por SQL:
 *
 *  - ligada + pedido de preço: o cliente é avisado ANTES da passagem, a passagem
 *    leva o desfecho do aviso, e o roteador nunca é chamado;
 *  - leitura que estoura: o turno cai (o job volta para a fila) e nada responde —
 *    falha de leitura não vira permissão para a IA negociar;
 *  - desligada, ou ligada sem assunto de preço: o turno segue para o roteador.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emHandoff: vi.fn(async () => false),
  passagem: vi.fn(async (..._args: unknown[]) => {}),
  aviso: vi.fn(async (..._args: unknown[]) => ({ avisado: true as const })),
  roteador: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLeadInHandoff: mocks.emHandoff,
  performHumanHandoff: mocks.passagem,
}));
vi.mock('@/lib/agent-engine/agent/aviso-de-escalacao', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  avisarLeadLendoOContato: mocks.aviso,
}));
vi.mock('@/lib/agent-engine/agent/resolve-turn-agent', () => ({ resolveConversationTurn: mocks.roteador }));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: vi.fn(async () => null) }));

import { createInboundTurnHandler, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';

const ids = {
  org: '12000000-0000-4000-8000-000000000001', contact: '12000000-0000-4000-8000-000000000002',
  conversation: '12000000-0000-4000-8000-000000000003', channel: '12000000-0000-4000-8000-000000000004',
  job: '12000000-0000-4000-8000-000000000005',
};
const job = {
  id: ids.job, organization_id: ids.org, contact_id: ids.contact, kind: 'inbound_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel,
    inbound_message_id: '12000000-0000-4000-8000-000000000006', crm_event_id: '12000000-0000-4000-8000-000000000007' },
};
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {},
  channel: () => ({}),
} as unknown as InboundTurnDeps;

const CHEGOU_AO_ROTEADOR = new Error('roteador chamado');

function pool(camada: boolean | 'falha', mensagem: string) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('org_guardrail_layers')) {
        if (camada === 'falha') throw new Error('banco fora do ar');
        return { rows: [{ enabled: camada }] };
      }
      if (sql.includes('from messages m')) return { rows: [{ body: mensagem }] };
      return { rows: [] };
    }),
  };
}
const rodar = (p: ReturnType<typeof pool>) =>
  createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.roteador.mockRejectedValue(CHEGOU_AO_ROTEADOR);
});

describe('restrição comercial antes do roteador', () => {
  it('ligada + pedido de preço: avisa o cliente, passa para a equipe e não chama o roteador', async () => {
    await rodar(pool(true, 'Quanto custa o óculos?'));
    expect(mocks.roteador).not.toHaveBeenCalled();
    expect(mocks.aviso).toHaveBeenCalledOnce();
    expect(mocks.aviso.mock.calls[0]?.[2]).toMatchObject({ motivo: 'outro' });
    expect(mocks.passagem).toHaveBeenCalledOnce();
    expect(mocks.passagem.mock.calls[0]?.[2]).toMatchObject({ avisoAoLead: { avisado: true } });
    // O aviso vem ANTES: é a passagem que arma o silêncio que a cadeia de envio lê.
    expect(mocks.aviso.mock.invocationCallOrder[0]).toBeLessThan(mocks.passagem.mock.invocationCallOrder[0]!);
  });

  it('leitura que estoura derruba o turno: ninguém responde e nada é liberado', async () => {
    await expect(rodar(pool('falha', 'Quanto custa?'))).rejects.toThrow('banco fora do ar');
    expect(mocks.roteador).not.toHaveBeenCalled();
    expect(mocks.aviso).not.toHaveBeenCalled();
    expect(mocks.passagem).not.toHaveBeenCalled();
  });

  it.each([
    ['desligada', false, 'Quanto custa?'],
    ['ligada, mas a mensagem é de agenda', true, 'Pode ser dia 15.10 às 14.30?'],
  ] as const)('%s: segue para o roteador', async (_caso, camada, mensagem) => {
    await expect(rodar(pool(camada, mensagem))).rejects.toBe(CHEGOU_AO_ROTEADOR);
    expect(mocks.aviso).not.toHaveBeenCalled();
    expect(mocks.passagem).not.toHaveBeenCalled();
  });
});
