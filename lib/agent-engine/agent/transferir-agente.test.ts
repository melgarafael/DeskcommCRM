import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { z } from 'zod';

import { loadPublishedAgentConfigById, type PublishedAgentConfig } from './agent-config';
import { agenteDaCampanhaDaConversa } from './agente-da-campanha';
import { classifyIntent } from './intent-classifier';
import { loadActiveRouter, type LoadedRouter } from './router-config';
import {
  CODIGOS_DE_RECUSA_DA_TRANSFERENCIA,
  MOTIVOS_DA_TRANSFERENCIA_DE_AGENTE,
  TransferenciaDeAgenteRecusada,
  ferramentaDePassagemEntreAgentes,
  transferirAgenteDaConversa,
} from './transferir-agente';

// O dublê do classificador existe para provar que a passagem NÃO o chama: o
// módulo da ação não importa o classificador (asserção estrutural mais abaixo),
// e se alguém "só confirmar a intenção" aqui dentro, este espião acusa.
vi.mock('./intent-classifier', () => ({ classifyIntent: vi.fn() }));
// As três leituras que o TURNO faz (roteador, agente da campanha, agente por id)
// são as mesmas que a ação faz — dubladas aqui, com o formato de produção.
vi.mock('./router-config', () => ({ loadActiveRouter: vi.fn() }));
vi.mock('./agente-da-campanha', () => ({ agenteDaCampanhaDaConversa: vi.fn() }));
vi.mock('./agent-config', () => ({ loadPublishedAgentConfigById: vi.fn() }));

/**
 * A passagem EXPLÍCITA de um agente de IA para outro, no mesmo número (#3770).
 *
 * O que este arquivo mede:
 *  - com destino válido, a conversa fica com o agente X e a decisão entra em
 *    `ai_router_decisions` com desfecho `transferred` e `origem = 'acao'` —
 *    NUNCA `reclassified`, que é o desfecho do classificador;
 *  - onde o turno seguinte ignoraria a passagem (sem roteador, sticky desligado,
 *    roteador por remetente, conversa de campanha), recusa com código próprio e
 *    NADA escrito;
 *  - destino inexistente, pausado ou fora do roteador: erro claro e NADA escrito;
 *    destino membro do roteador publicado em OUTRO número: passa (o turno carrega
 *    o membro pelo id);
 *  - a ferramenta `transfer_to_agent` só existe onde a passagem vale, só oferece
 *    os outros membros e devolve recusa como resultado;
 *  - a passagem não chama classificador.
 *
 * O que ele NÃO mede: o efeito no banco real (o `update` + `insert` atômico do
 * statement). Este arquivo dubla o pool; o statement é provado pelo próprio SQL
 * (uma CTE: `update … returning` alimenta o `insert`).
 */

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const CONVERSA = 'aaaaaaaa-1111-4000-8000-000000000001';
const SESSAO = 'aaaaaaaa-8888-4000-8000-000000000001';
const AGENTE_ANTERIOR = 'aaaaaaaa-2222-4000-8000-000000000001';
const AGENTE_DESTINO = 'aaaaaaaa-2222-4000-8000-000000000002';
const AGENTE_TERCEIRO = 'aaaaaaaa-2222-4000-8000-000000000003';
const AGENTE_CAMPANHA = 'aaaaaaaa-2222-4000-8000-000000000009';
const ROUTER = 'aaaaaaaa-4444-4000-8000-000000000001';
const USUARIO = 'aaaaaaaa-3333-4000-8000-000000000003';

interface Escrita {
  sql: string;
  params: unknown[];
}

function roteador(extra: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: ROUTER,
    name: 'Roteador',
    classifierModel: null,
    classifierProvider: null,
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: null,
    members: [
      { agentId: AGENTE_ANTERIOR, intentName: 'vendas', intentDescription: 'quer comprar', examples: [] },
      { agentId: AGENTE_DESTINO, intentName: 'automacao', intentDescription: 'quer automatizar', examples: [] },
      { agentId: AGENTE_TERCEIRO, intentName: 'suporte', intentDescription: 'tem um problema', examples: [] },
    ],
    ...extra,
  };
}

/** O agente publicado como `loadPublishedAgentConfigById` o devolve (só o que a ação lê). */
function publicado(agentId: string, pausedAt: string | null = null): PublishedAgentConfig {
  const parcial: Partial<PublishedAgentConfig> = { agentId, pausedAt };
  return parcial as PublishedAgentConfig;
}

interface Cenario {
  conversa: { channel_session_id: string | null; active_ai_agent_id: string | null } | null;
  roteador: LoadedRouter | null;
  /** Agentes que `loadPublishedAgentConfigById` encontra (id → pausado em). */
  publicados: Record<string, string | null>;
  agenteDaCampanha?: string | null;
  /** O `update` da CTE não casa com linha (conversa sumiu entre a leitura e a escrita). */
  updateSemLinha?: boolean;
}

function poolFake(cenario: Cenario): { db: pg.Pool; escritas: Escrita[] } {
  const escritas: Escrita[] = [];
  vi.mocked(loadActiveRouter).mockResolvedValue(cenario.roteador);
  vi.mocked(agenteDaCampanhaDaConversa).mockResolvedValue(cenario.agenteDaCampanha ?? null);
  vi.mocked(loadPublishedAgentConfigById).mockImplementation(async (_db, _org, id) =>
    id in cenario.publicados ? publicado(id, cenario.publicados[id] ?? null) : null,
  );
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/insert into ai_router_decisions/i.test(sql)) {
        escritas.push({ sql, params });
        return { rows: [], rowCount: cenario.updateSemLinha === true ? 0 : 1 };
      }
      if (/from conversations\s+where organization_id = \$1 and id = \$2/i.test(sql)) {
        return { rows: cenario.conversa === null ? [] : [cenario.conversa], rowCount: 0 };
      }
      throw new Error(`pool dublê sem resposta para: ${sql.slice(0, 80)}`);
    },
  } as unknown as pg.Pool;
  return { db, escritas };
}

const CENARIO_OK: Cenario = {
  conversa: { channel_session_id: SESSAO, active_ai_agent_id: AGENTE_ANTERIOR },
  roteador: roteador(),
  publicados: { [AGENTE_DESTINO]: null, [AGENTE_TERCEIRO]: null, [AGENTE_ANTERIOR]: null },
};

const ENTRADA = {
  organizationId: ORG,
  conversationId: CONVERSA,
  agenteDestinoId: AGENTE_DESTINO,
  motivo: 'pedido_do_agente' as const,
  solicitadoPor: USUARIO,
  jobId: 'job-1',
};

async function recusa(cenario: Cenario, codigo: string): Promise<void> {
  const p = poolFake(cenario);
  const erro = await transferirAgenteDaConversa(p.db, ENTRADA).catch((e: unknown) => e);
  expect(erro).toBeInstanceOf(TransferenciaDeAgenteRecusada);
  expect(erro).toMatchObject({ codigo });
  expect(p.escritas).toHaveLength(0);
}

describe('transferirAgenteDaConversa — a passagem que não depende do classificador', () => {
  beforeEach(() => {
    vi.mocked(classifyIntent).mockClear();
  });

  it('destino válido: a conversa fica com o agente X e a decisão é registrada com origem ação', async () => {
    const p = poolFake(CENARIO_OK);
    const resultado = await transferirAgenteDaConversa(p.db, ENTRADA);

    expect(resultado).toEqual({
      agenteAnteriorId: AGENTE_ANTERIOR,
      agenteDestinoId: AGENTE_DESTINO,
      intentName: 'automacao',
      routerId: ROUTER,
    });

    // UMA escrita: o sticky e a linha de trilha na mesma CTE.
    expect(p.escritas).toHaveLength(1);
    const { sql, params } = p.escritas[0]!;
    expect(sql).toMatch(/update conversations/i);
    expect(sql).toMatch(/set active_ai_agent_id = \$3/i);
    expect(sql).toMatch(/insert into ai_router_decisions/i);
    // A decisão é AÇÃO, não reclassificação.
    expect(sql).toContain("'transferred'");
    expect(sql).toContain("'acao'");
    expect(sql).not.toContain("'reclassified'");
    expect(params).toEqual([
      ORG,
      CONVERSA,
      AGENTE_DESTINO,
      'automacao',
      ROUTER,
      'job-1',
      AGENTE_ANTERIOR,
      'pedido_do_agente',
      USUARIO,
    ]);
  });

  it('a trilha registra de quem para quem, quando, quem pediu e o motivo (sem texto livre)', async () => {
    const p = poolFake(CENARIO_OK);
    await transferirAgenteDaConversa(p.db, { ...ENTRADA, solicitadoPor: null });

    const { sql, params } = p.escritas[0]!;
    // de qual agente → para qual agente
    expect(params[6]).toBe(AGENTE_ANTERIOR);
    expect(params[2]).toBe(AGENTE_DESTINO);
    // quando → created_at do próprio registro
    expect(sql).not.toMatch(/created_at/i);
    // quem pediu / motivo
    expect(sql).toMatch(/solicitado_por/);
    expect(sql).toMatch(/motivo/);
    expect(params[8]).toBeNull();
    expect(MOTIVOS_DA_TRANSFERENCIA_DE_AGENTE).toContain(params[7]);
  });

  it('número sem roteador: recusa (o turno usaria o agente do número) e NADA muda', async () => {
    await recusa({ ...CENARIO_OK, roteador: null }, 'sem_roteador');
  });

  it('conversa sem número: recusa como sem roteador e nem procura roteador', async () => {
    vi.mocked(loadActiveRouter).mockClear();
    await recusa(
      { ...CENARIO_OK, conversa: { channel_session_id: null, active_ai_agent_id: AGENTE_ANTERIOR } },
      'sem_roteador',
    );
    expect(loadActiveRouter).not.toHaveBeenCalled();
  });

  it('roteador com sticky desligado: recusa e NADA muda', async () => {
    await recusa({ ...CENARIO_OK, roteador: roteador({ sticky: false }) }, 'roteador_sem_sticky');
  });

  it('roteador por regras de remetente: recusa e NADA muda', async () => {
    await recusa(
      { ...CENARIO_OK, roteador: roteador({ senderRoutes: [{ telefone: '5511999990000' }] }) },
      'roteador_por_remetente',
    );
  });

  it('roteador com lista de remetentes VAZIA não está no modo por remetente: passa', async () => {
    const p = poolFake({ ...CENARIO_OK, roteador: roteador({ senderRoutes: [] }) });
    await transferirAgenteDaConversa(p.db, ENTRADA);
    expect(p.escritas).toHaveLength(1);
  });

  it('conversa nascida de campanha com agente publicado: recusa e NADA muda', async () => {
    await recusa(
      {
        ...CENARIO_OK,
        agenteDaCampanha: AGENTE_CAMPANHA,
        publicados: { ...CENARIO_OK.publicados, [AGENTE_CAMPANHA]: null },
      },
      'conversa_de_campanha',
    );
  });

  it('campanha com agente SEM versão publicada: o turno segue pela régua do número, e a passagem vale', async () => {
    const p = poolFake({ ...CENARIO_OK, agenteDaCampanha: AGENTE_CAMPANHA });
    await transferirAgenteDaConversa(p.db, ENTRADA);
    expect(p.escritas).toHaveLength(1);
  });

  it('agente inexistente (ou de outra organização, ou sem versão publicada): erro claro e NADA muda', async () => {
    await recusa({ ...CENARIO_OK, publicados: {} }, 'agente_inexistente');
  });

  it('agente de destino pausado: recusa (o turno sairia calado) e NADA muda', async () => {
    await recusa(
      { ...CENARIO_OK, publicados: { [AGENTE_DESTINO]: '2026-11-10T12:00:00Z' } },
      'agente_pausado',
    );
  });

  it('membro do roteador publicado em OUTRO número: passa — o turno carrega o membro pelo id', async () => {
    // `loadPublishedAgentConfigById` não olha o número; a ação também não.
    const p = poolFake(CENARIO_OK);
    const resultado = await transferirAgenteDaConversa(p.db, ENTRADA);
    expect(resultado.agenteDestinoId).toBe(AGENTE_DESTINO);
    expect(loadPublishedAgentConfigById).toHaveBeenCalledWith(p.db, ORG, AGENTE_DESTINO);
    expect(p.escritas).toHaveLength(1);
  });

  it('agente publicado que não é membro do roteador: recusa e NADA muda', async () => {
    await recusa(
      {
        ...CENARIO_OK,
        roteador: roteador({ members: roteador().members.filter((m) => m.agentId !== AGENTE_DESTINO) }),
      },
      'agente_fora_do_roteador',
    );
  });

  it('conversa inexistente na organização: recusa e NADA muda', async () => {
    await recusa({ ...CENARIO_OK, conversa: null }, 'conversa_nao_encontrada');
  });

  it('a conversa já está com o agente: recusa sem reescrever o sticky', async () => {
    await recusa(
      { ...CENARIO_OK, conversa: { channel_session_id: SESSAO, active_ai_agent_id: AGENTE_DESTINO } },
      'ja_esta_no_agente',
    );
  });

  it('conversa que sumiu entre a leitura e a escrita: erro claro, sem trilha órfã', async () => {
    const p = poolFake({ ...CENARIO_OK, updateSemLinha: true });

    await expect(transferirAgenteDaConversa(p.db, ENTRADA)).rejects.toMatchObject({
      codigo: 'conversa_nao_encontrada',
    });
  });

  it('o vocabulário de recusa não tem mais a checagem por número', () => {
    expect(CODIGOS_DE_RECUSA_DA_TRANSFERENCIA).not.toContain('agente_de_outro_numero');
  });

  it('NÃO chama o classificador — a passagem não custa modelo nenhum', async () => {
    const p = poolFake(CENARIO_OK);
    await transferirAgenteDaConversa(p.db, ENTRADA);

    expect(classifyIntent).not.toHaveBeenCalled();
    // E não pode voltar a chamar por dentro: o módulo não usa o classificador nem
    // o resolvedor do turno (que classificaria). A asserção é sobre o
    // arquivo-fonte de propósito — é o que impede a regressão silenciosa de
    // alguém "só confirmar a intenção" aqui dentro. Casa USO (import/chamada),
    // não a menção em comentário, que é como os dois aparecem hoje.
    const fonte = readFileSync(
      path.join(process.cwd(), 'lib/agent-engine/agent/transferir-agente.ts'),
      'utf8',
    );
    expect(fonte).not.toMatch(/from '[^']*intent-classifier'/);
    expect(fonte).not.toMatch(/\bclassifyIntent\b/);
    expect(fonte).not.toMatch(/\bresolveTurnAgent\b/);
    expect(fonte).not.toMatch(/\bconsultarJevNoRoteador\b/);
  });
});

describe('ferramenta transfer_to_agent — o consumidor com motivo pedido_do_agente', () => {
  const CTX = {
    organizationId: ORG,
    conversationId: CONVERSA,
    channelSessionId: SESSAO,
    agenteAtualId: AGENTE_ANTERIOR,
    jobId: 'job-9',
    noteRunError: vi.fn(),
  };
  const OPCOES = { toolCallId: 't1', messages: [] } as never;

  it('só é oferecida onde a passagem vale', async () => {
    for (const cenario of [
      { ...CENARIO_OK, roteador: null },
      { ...CENARIO_OK, roteador: roteador({ sticky: false }) },
      { ...CENARIO_OK, roteador: roteador({ senderRoutes: [{ telefone: '5511999990000' }] }) },
      {
        ...CENARIO_OK,
        agenteDaCampanha: AGENTE_CAMPANHA,
        publicados: { ...CENARIO_OK.publicados, [AGENTE_CAMPANHA]: null },
      },
    ]) {
      const p = poolFake(cenario);
      expect(await ferramentaDePassagemEntreAgentes(p.db, CTX)).toBeNull();
    }
  });

  it('não é oferecida quando o único membro é o próprio agente em turno', async () => {
    const p = poolFake({
      ...CENARIO_OK,
      roteador: roteador({ members: roteador().members.filter((m) => m.agentId === AGENTE_ANTERIOR) }),
    });
    expect(await ferramentaDePassagemEntreAgentes(p.db, CTX)).toBeNull();
  });

  it('o destino é um enum dos OUTROS membros do roteador', async () => {
    const p = poolFake(CENARIO_OK);
    const ferramenta = await ferramentaDePassagemEntreAgentes(p.db, CTX);
    expect(ferramenta).not.toBeNull();
    const schema = ferramenta!.inputSchema as z.ZodType;
    expect(schema.safeParse({ destino: 'automacao' }).success).toBe(true);
    expect(schema.safeParse({ destino: 'suporte' }).success).toBe(true);
    expect(schema.safeParse({ destino: 'vendas' }).success).toBe(false);
    expect(schema.safeParse({ destino: AGENTE_DESTINO }).success).toBe(false);
  });

  it('passa a conversa com motivo pedido_do_agente, sem pessoa, com o job do turno e origem ação', async () => {
    const p = poolFake(CENARIO_OK);
    const ferramenta = await ferramentaDePassagemEntreAgentes(p.db, CTX);
    const resultado = await ferramenta!.execute!({ destino: 'automacao' }, OPCOES);

    expect(resultado).toMatchObject({ ok: true, status: 'transferida' });
    expect(p.escritas).toHaveLength(1);
    const { sql, params } = p.escritas[0]!;
    expect(sql).toContain("'acao'");
    expect(params[2]).toBe(AGENTE_DESTINO);
    expect(params[5]).toBe('job-9');
    expect(params[7]).toBe('pedido_do_agente');
    expect(params[8]).toBeNull();
  });

  it('recusa vira resultado da ferramenta, não exceção — e nada é escrito', async () => {
    const p = poolFake(CENARIO_OK);
    const ferramenta = await ferramentaDePassagemEntreAgentes(p.db, CTX);
    // O destino é pausado depois de a ferramenta ser montada.
    vi.mocked(loadPublishedAgentConfigById).mockResolvedValue(publicado(AGENTE_DESTINO, '2026-11-10T12:00:00Z'));

    const resultado = await ferramenta!.execute!({ destino: 'automacao' }, OPCOES);

    expect(resultado).toMatchObject({ ok: false, error: { code: 'agente_pausado' } });
    expect(p.escritas).toHaveLength(0);
    expect(CTX.noteRunError).not.toHaveBeenCalled();
  });
});
