/**
 * O `operator_turn` roda com agente em modo assistido (recorte do #3915, de @felipehenriquess).
 *
 * Antes: o handler saía em silêncio quando o agente estava em modo assistido, e no
 * assistido ninguém movia etapa, campo, tag ou nota.
 *
 * Handoff humano NÃO entra neste recorte: o Operador continua barrado ali (controle abaixo).
 *
 * O que NÃO mudou (e tem controle aqui): agente PAUSADO continua barrando, papel
 * DESLIGADO continua sem rodar, e o Operador só recebe as ferramentas dele
 * (`operator_tool_ids`) — sem `send_message`, então nunca fala com o lead.
 *
 * E no assistido a lista dele perde, em código, toda ferramenta que faz algo sair
 * (`saiSemAprovacao`, em entrega-de-capacidade.ts), mesmo marcada na tela.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  handoff: vi.fn(), byId: vi.fn(), mcp: vi.fn(), model: vi.fn(), cleanup: vi.fn(), operation: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), isLeadInHandoff: mocks.handoff,
}));
vi.mock('@/lib/agent-engine/agent/agent-config', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), loadPublishedAgentConfigById: mocks.byId,
}));
vi.mock('@/lib/agent-engine/edge/crm/mcp-tools', () => ({ buildMcpTurnTools: mocks.mcp }));
vi.mock('@/lib/agent-engine/edge/llm/run-model-call', () => ({ runModelCall: mocks.model }));
vi.mock('@/lib/agent-engine/agent/fuso-da-org', () => ({ fusoDaOrganizacao: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  currentExecutionBoundary: () => undefined, setExecutionAgentOperation: mocks.operation, guardServiceEffect: vi.fn(),
}));

import { createOperatorTurnHandler } from '@/lib/agent-engine/agent/operator-turn';
import type { InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';

const ids = {
  org: '22000000-0000-4000-8000-000000000001', contact: '22000000-0000-4000-8000-000000000002',
  conversation: '22000000-0000-4000-8000-000000000003', origin: '22000000-0000-4000-8000-000000000004',
  job: '22000000-0000-4000-8000-000000000005', agent: '22000000-0000-4000-8000-000000000006',
};
const job = {
  id: ids.job, organization_id: ids.org, contact_id: ids.contact, kind: 'operator_turn',
  payload: { conversation_id: ids.conversation, origin_job_id: ids.origin, agent_id: ids.agent, trigger: 'assistido' },
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const deps = { log, llmCfg: {}, crmCfg: {}, knobs: {} } as unknown as InboundTurnDeps;

const FERRAMENTAS = ['crm_move_lead_stage', 'crm_update_lead', 'crm_manage_tags', 'crm_list_stages'];

/**
 * Configuração ADVERSA: a lista do Operador é configurável, e nada impede alguém de
 * marcar nela ferramenta que faz algo SAIR. No assistido nenhuma pode chegar à mão.
 */
const REMOTA_DE_LEITURA = 'mcp_externo:leitura:buscar_pedido';
const DE_SAIDA = [
  'crm_start_conversation_and_send',
  'crm_send_whatsapp_message',
  'crm_schedule_followup',
  'crm_enroll_followup_flow',
  'mcp_externo:escrita:cancelar_pedido',
  'mcp_externo:22000000-0000-4000-8000-0000000000aa:escrita:enviar_email',
];
const agente = (extra: Partial<PublishedAgentConfig> = {}): PublishedAgentConfig =>
  ({
    agentId: ids.agent, versionId: 'v1', operationRevision: null, operationMode: 'assisted', pausedAt: null,
    operatorEnabled: true, operatorToolIds: FERRAMENTAS, operatorModel: null, model: 'm', maxSteps: 4,
    provider: 'openai', credentialId: 'cred-1', ...extra,
  }) as unknown as PublishedAgentConfig;

/** pool de mentira: nenhuma linha em lugar nenhum (sem checkpoint, sem card), e guarda o que foi escrito. */
const pool = () => ({ query: vi.fn(async () => ({ rows: [] })) });
const rodar = (p: ReturnType<typeof pool>) =>
  createOperatorTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });

/** o `desfecho` que foi para o event_log neste turno. */
function desfechoGravado(p: ReturnType<typeof pool>): Record<string, unknown> | undefined {
  const chamada = (p.query.mock.calls as unknown as Array<[string, unknown[]?]>).find(([sql]) =>
    sql.includes("'agent.operator_turn'"),
  );
  const json = chamada?.[1]?.[2];
  return typeof json === 'string' ? (JSON.parse(json) as Record<string, unknown>) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoff.mockResolvedValue(false);
  mocks.byId.mockResolvedValue(agente());
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.mcp.mockResolvedValue({ tools: {}, toolIds: FERRAMENTAS, cleanup: mocks.cleanup });
  mocks.model.mockResolvedValue({ result: { steps: [{ toolCalls: [{ toolName: 'crm_move_lead_stage' }] }] } });
});

describe('agente em modo assistido', () => {
  it('o Operador RODA (antes: `operationMode === "assisted"` dava return)', async () => {
    const p = pool();
    await rodar(p);
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(desfechoGravado(p)).toMatchObject({ desfecho: 'agiu' });
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it('só recebe a mão do Operador — as 4 ferramentas de CRM', async () => {
    await rodar(pool());

    const mao = mocks.mcp.mock.calls[0]![2] as { toolIds: string[] };
    expect(mao.toolIds).toEqual(FERRAMENTAS);
  });

  it('com ferramentas de SAÍDA marcadas na lista dele, a mão chega SEM elas', async () => {
    mocks.byId.mockResolvedValue(
      agente({ operatorToolIds: [...FERRAMENTAS, ...DE_SAIDA, REMOTA_DE_LEITURA] }),
    );
    await rodar(pool());

    const mao = mocks.mcp.mock.calls[0]![2] as { toolIds: string[] };
    expect(mao.toolIds).toEqual([...FERRAMENTAS, REMOTA_DE_LEITURA]);
  });
});

describe('controles — o que continua barrando', () => {
  it('agente PAUSADO continua sem rodar o Operador', async () => {
    mocks.byId.mockResolvedValue(agente({ pausedAt: new Date('2026-11-01T00:00:00Z') as never }));
    const p = pool();
    await rodar(p);
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.mcp).not.toHaveBeenCalled();
  });

  it('papel do Operador desligado continua sem chamar modelo', async () => {
    mocks.byId.mockResolvedValue(agente({ operatorEnabled: false }));
    const p = pool();
    await rodar(p);
    expect(mocks.model).not.toHaveBeenCalled();
    expect(desfechoGravado(p)).toMatchObject({ desfecho: 'pulado', porque: 'papel_desligado' });
  });

  it('lead em handoff humano: o Operador continua SEM rodar (fora deste recorte)', async () => {
    mocks.handoff.mockResolvedValue(true);
    const p = pool();
    await rodar(p);
    expect(mocks.model).not.toHaveBeenCalled();
    expect(desfechoGravado(p)).toMatchObject({ desfecho: 'pulado', porque: 'handoff_humano' });
  });

  it('agente AUTOMÁTICO com a mesma lista: as ferramentas de saída continuam na mão', async () => {
    mocks.byId.mockResolvedValue(
      agente({ operationMode: 'automatic', operatorToolIds: [...FERRAMENTAS, ...DE_SAIDA] }),
    );
    await rodar(pool());

    const mao = mocks.mcp.mock.calls[0]![2] as { toolIds: string[] };
    expect(mao.toolIds).toEqual([...FERRAMENTAS, ...DE_SAIDA]);
  });

  it('lead sem handoff e agente automático: roda como sempre (controle positivo)', async () => {
    mocks.byId.mockResolvedValue(agente({ operationMode: 'autonomous' as never }));
    await rodar(pool());
    expect(mocks.model).toHaveBeenCalledOnce();
  });
});
