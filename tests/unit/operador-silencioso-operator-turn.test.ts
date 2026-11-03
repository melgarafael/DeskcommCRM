/**
 * OPERADOR SILENCIOSO — o `operator_turn` roda em lead com handoff humano e com agente assistido.
 *
 * Antes: o handler saía em silêncio quando o lead estava em handoff (`isLeadInHandoff`)
 * e quando o agente estava em modo assistido. Resultado: nas orgs 100% humanas e depois
 * que uma pessoa assumia, ninguém movia etapa, campo, tag ou nota.
 *
 * O que NÃO mudou (e tem controle aqui): agente PAUSADO continua barrando, papel
 * DESLIGADO continua sem rodar, e o Operador só recebe as ferramentas dele
 * (`operator_tool_ids`) — sem `send_message`, então nunca fala com o lead.
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
  payload: { conversation_id: ids.conversation, origin_job_id: ids.origin, agent_id: ids.agent, trigger: 'handoff' },
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const deps = { log, llmCfg: {}, crmCfg: {}, knobs: {} } as unknown as InboundTurnDeps;

const FERRAMENTAS = ['crm_move_lead_stage', 'crm_update_lead', 'crm_manage_tags', 'crm_save_lead_note'];
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

describe('lead em handoff humano', () => {
  it('o Operador RODA e age (antes: saía em silêncio com desfecho pulado/handoff_humano)', async () => {
    mocks.handoff.mockResolvedValue(true);
    const p = pool();
    await rodar(p);

    expect(mocks.model, 'handoff barrou o Operador de novo').toHaveBeenCalledOnce();
    expect(desfechoGravado(p)).toMatchObject({ desfecho: 'agiu', ferramentas_chamadas: ['crm_move_lead_stage'] });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('operador segue em lead com handoff humano'),
      expect.anything(),
    );
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it('só recebe a mão do Operador — as 4 ferramentas de CRM, e NENHUMA de envio', async () => {
    mocks.handoff.mockResolvedValue(true);
    await rodar(pool());

    const mao = mocks.mcp.mock.calls[0]![2] as { toolIds: string[] };
    expect(mao.toolIds).toEqual(FERRAMENTAS);
    expect(mao.toolIds.some(t => /send|message_to|whatsapp/i.test(t) && t !== 'crm_save_lead_note')).toBe(false);
  });
});

describe('em handoff o Operador NÃO apura promessa nem abre aviso', () => {
  /** pool que devolve um checkpoint COM promessa (o que o Conversador declarou) e mais nada. */
  const comPromessa = () => ({
    query: vi.fn(async (sql: string) =>
      String(sql).includes('lead_checkpoints')
        ? { rows: [{ declaracao: { intencoes: [{ o_que: 'quer remarcar a consulta', evidencia: 'pode ser na terça?' }], promessas: [{ o_que: 'vou confirmar o horário e te retorno', prazo: '2026-08-11' }], nada_a_declarar: false } }] }
        : { rows: [] }),
  });
  const campos = (p: ReturnType<typeof pool>) => desfechoGravado(p) as Record<string, unknown>;

  it('CONTROLE POSITIVO — sem handoff, a promessa sem dono É apurada (o que o handoff dispensa)', async () => {
    // agente AUTOMÁTICO de propósito: o controle tem de passar também no código anterior (que barrava o assistido)
    mocks.byId.mockResolvedValue(agente({ operationMode: 'autonomous' as never }));
    const p = comPromessa();
    await rodar(p as never);
    const f = campos(p as never);
    // a apuração rodou se ela concluiu QUALQUER coisa: promessa assumida por alguém ou sem dono
    expect(f.promessa_assumida_por ?? f.promessa_sem_dono_porque, 'sem handoff a apuração tinha de rodar').not.toBeNull();
  });

  it('com handoff, a apuração inteira é dispensada: nem dono nem "sem dono"', async () => {
    mocks.handoff.mockResolvedValue(true);
    const p = comPromessa();
    await rodar(p as never);
    expect(mocks.model, 'o Operador tem de rodar em handoff').toHaveBeenCalledOnce();
    expect(campos(p as never)).toMatchObject({ promessa_assumida_por: null, promessa_sem_dono_porque: null });
  });
});

describe('agente em modo assistido', () => {
  it('o Operador RODA (antes: `operationMode === "assisted"` dava return)', async () => {
    const p = pool();
    await rodar(p);
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(desfechoGravado(p)).toMatchObject({ desfecho: 'agiu' });
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

  it('papel do Operador desligado continua sem chamar modelo, mesmo em handoff', async () => {
    mocks.handoff.mockResolvedValue(true);
    mocks.byId.mockResolvedValue(agente({ operatorEnabled: false }));
    const p = pool();
    await rodar(p);
    expect(mocks.model).not.toHaveBeenCalled();
    expect(desfechoGravado(p)).toMatchObject({ desfecho: 'pulado', porque: 'papel_desligado' });
  });

  it('lead sem handoff e agente automático: roda como sempre (controle positivo)', async () => {
    mocks.byId.mockResolvedValue(agente({ operationMode: 'autonomous' as never }));
    await rodar(pool());
    expect(mocks.model).toHaveBeenCalledOnce();
  });
});
