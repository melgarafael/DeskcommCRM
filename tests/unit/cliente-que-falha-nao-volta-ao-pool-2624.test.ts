/**
 * #2624 — os call sites RESTANTES de `pool.connect()` também devolvem o cliente
 * ao pool sem erro quando algo falha dentro da transação aberta à mão.
 *
 * Diferença medida contra o #2621 (grep `pool.connect` em lib/ app/ supabase/
 * workers/ + `getRequestPool().connect()` e `harness.connect()`):
 *   · 6 call sites em 5 arquivos já fechados pelo #2621 — queue.ts (2),
 *     before-send.ts, scheduler.ts, playbook-seed.ts, cases/[id]/reply/route.ts;
 *   · lib/agent-engine/db/pool.test.ts:81/83 é o TESTE do próprio pool (caminho
 *     feliz, `release()` explícito em ambos os clientes, sem transação manual)
 *     — não é call site de produção e não muda;
 *   · sobram 8 em 8 arquivos, todos medidos aqui:
 *       app/api/v1/ai/routers/[id]/members/route.ts:82
 *       lib/atendimento/aviso-caso-obsoleto.ts:46
 *       lib/prospecting/agent-session.ts:97
 *       lib/prospecting/agent-chat.ts:147
 *       lib/prospecting/agent-setup.ts:228
 *       lib/prospecting/store.ts:64 (withProspectingLock)
 *       lib/agent-engine/health/circuit.ts:234
 *       lib/external-db/conexao.ts:132
 *
 * O que este arquivo mede, com cliente FALSO (`query` que rejeita + `release`
 * espio), UM caso por arquivo tocado:
 *   (a) consulta que falha dentro da transação → `release` chamado COM erro;
 *   (b) caminho feliz → `release` chamado SEM erro (nada muda para quem não falhou).
 *
 * Nasce VERMELHO: sem o `release(erroNaTransacao)` dos 8 arquivos, (a) reprova
 * em todos os caminhos — é a sabotagem que prova o contra-experimento.
 *
 * O QUE NÃO É MEDIDO AQUI (declarado também no PR): o reuso real de socket
 * contra Postgres de produção. O lado "cliente com erro é descartado em vez de
 * reemprestado" é a semântica do próprio pg-pool 3.14.0 (`_release` com erro →
 * `_remove` → `client.end()`), lida em node_modules/pg-pool/index.js:384-398.
 */
import type pg from 'pg';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CasosDeHumano from '@/lib/agent-engine/agent/human-cases';
import type * as SuporteDeImpersonate from '@/lib/impersonate/support';
import type * as Auditoria from '@/lib/audit';
import type * as RequisitoDePapel from '@/lib/auth/require-role';
import type * as SegredosDoWebhook from '@/lib/webhooks/secrets';
import type * as ChamadaDeModelo from '@/lib/agent-engine/edge/llm/run-model-call';
import type { Logger } from '@/lib/agent-engine/obs/logger';
import type { RoleCheck } from '@/lib/auth/require-role';
import type { AuthUser } from '@/lib/auth/types';

import { registrarRespostaDeCasoObsoleto } from '@/lib/atendimento/aviso-caso-obsoleto';
import { channelHealthTick } from '@/lib/agent-engine/health/circuit';
import { consultar } from '@/lib/external-db/conexao';
import { resolveCaseFromHuman } from '@/lib/agent-engine/agent/human-cases';
import { chatAboutAgent } from '@/lib/prospecting/agent-chat';
import { setupProspectingAgent } from '@/lib/prospecting/agent-setup';
import { prospectingAgentSetupSchema } from '@/lib/prospecting/agent-setup-schema';
import { mutateAgentSession } from '@/lib/prospecting/agent-session';
import { ProspectingError } from '@/lib/prospecting/provider';
import { withProspectingLock } from '@/lib/prospecting/store';
import { requireRole } from '@/lib/auth/require-role';
import { getRequestPool } from '@/lib/agent-engine/db/request-pool';

vi.mock(
  '@/lib/auth/require-role',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RequisitoDePapel>()),
    requireRole: vi.fn(),
  }),
);
vi.mock('@/lib/agent-engine/db/request-pool', () => ({ getRequestPool: vi.fn() }));
vi.mock(
  '@/lib/audit',
  async (importOriginal) => ({
    ...(await importOriginal<typeof Auditoria>()),
    audit: vi.fn(async () => undefined),
  }),
);
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock('@/lib/ai/agents/router-members-http', () => ({
  replaceRouterMembersHttp: vi.fn(async () => undefined),
}));
vi.mock(
  '@/lib/agent-engine/edge/llm/run-model-call',
  async (importOriginal) => ({
    ...(await importOriginal<typeof ChamadaDeModelo>()),
    runModelCall: vi.fn(),
  }),
);
vi.mock(
  '@/lib/webhooks/secrets',
  async (importOriginal) => ({
    ...(await importOriginal<typeof SegredosDoWebhook>()),
    decryptWebhookSecret: vi.fn(() => Promise.resolve('chave-em-claro')),
    encryptWebhookSecret: vi.fn(() => Promise.resolve('cifrado')),
  }),
);
// A autoridade de suporte é exercitada na suíte própria daquele módulo.
vi.mock('@/lib/impersonate/support', async (importOriginal) => ({
  ...(await importOriginal<typeof SuporteDeImpersonate>()),
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock('@/lib/agent-engine/agent/human-cases', async (importOriginal) => ({
  ...(await importOriginal<typeof CasosDeHumano>()),
  resolveCaseFromHuman: vi.fn(),
}));
// O mesmo conjunto do tests/unit/prospecting-agent-setup.test.ts — setupProspectingAgent
// só chega a usá-los DEPOIS da transação, que aqui falha antes.
vi.mock('@/lib/ai/agents/publish', () => ({ publishAgentVersion: vi.fn() }));
vi.mock('@/lib/ai/agents/create-draft', () => ({ createMcpAgentDraft: vi.fn() }));
vi.mock('@/lib/ai/runtime/agent', () => ({ chaveDePlataforma: vi.fn() }));
vi.mock('@/lib/ai/agents/capacidades-padrao', () => ({
  capacidadesPadraoDoOnboarding: () => ['crm_get_lead'],
}));

const MENSAGEM = 'Query read timeout';
const ORG = '10000000-0000-4000-8000-000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '33333333-3333-4333-8333-333333333333';
const CANAL = '30000000-0000-4000-8000-000000000001';
const CAMPANHA = '20000000-0000-4000-8000-000000000001';
const ROTEADOR = '44444444-4444-4444-8444-444444444444';
const AGENTE = '55555555-5555-4555-8555-555555555555';

interface ClienteFalso {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

/**
 * Cliente fake: `query` rejeita em `falhaEm` (substring minúscula do SQL — a
 * consulta que "estoura o timeout"), devolve `linhas` para o resto e
 * `rowCount: 1` por default; `release` é espio, é por ele que se mede o desfecho.
 */
function clienteFalso(falhaEm?: string, linhas: Array<[string, unknown[]]> = []): ClienteFalso {
  return {
    query: vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase();
      if (falhaEm !== undefined && s.includes(falhaEm)) throw new Error(MENSAGEM);
      const achado = linhas.find(([sub]) => s.includes(sub));
      return { rows: achado?.[1] ?? [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
}

function poolFalso(cliente: ClienteFalso, linhasDoPool: unknown[] = []): pg.Pool {
  return {
    connect: vi.fn(async () => cliente),
    query: vi.fn(async () => ({ rows: linhasDoPool, rowCount: linhasDoPool.length })),
  } as unknown as pg.Pool;
}

/** (a) o release saiu COM erro — é o único desfecho seguro para quem falhou na tx. */
function liberouComErro(cliente: ClienteFalso, mensagem = MENSAGEM): void {
  expect(cliente.release, 'release deveria ser chamado UMA vez').toHaveBeenCalledTimes(1);
  const liberado = cliente.release.mock.calls[0]?.[0];
  expect(liberado, 'o cliente voltou ao pool SEM erro — é o bug da #2624').toBeInstanceOf(Error);
  expect((liberado as Error).message).toBe(mensagem);
}

/** (b) caminho feliz: release sem argumento, como antes do conserto. */
function liberouSemErro(cliente: ClienteFalso): void {
  expect(cliente.release, 'release deveria ser chamado UMA vez').toHaveBeenCalledTimes(1);
  expect(cliente.release.mock.calls[0]?.[0]).toBeUndefined();
}

function comandosDaTransacao(cliente: ClienteFalso): string[] {
  return cliente.query.mock.calls.map(([sql]) => String(sql).toLowerCase().trim());
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// lib/prospecting/store.ts — withProspectingLock (advisory lock de SESSÃO)
// ---------------------------------------------------------------------------

describe('#2624 · store.ts (withProspectingLock)', () => {
  it('o try-lock que rejeita solta o cliente COM erro', async () => {
    const cliente = clienteFalso('pg_try_advisory_lock');
    const pool = poolFalso(cliente);

    await expect(withProspectingLock(pool, ORG, async () => 'nunca')).rejects.toThrow(MENSAGEM);

    // sem lock adquirido não há unlock a rodar — mas o cliente NÃO volta limpo.
    expect(comandosDaTransacao(cliente)).not.toContain(
      'select pg_advisory_unlock(hashtextextended($1,0))',
    );
    liberouComErro(cliente);
  });

  it('o unlock que rejeita solta o cliente COM erro — o lock morre com a conexão', async () => {
    const cliente = clienteFalso('pg_advisory_unlock', [
      ['pg_try_advisory_lock', [{ locked: true }]],
    ]);
    const pool = poolFalso(cliente);

    // a operação em si terminou; só o destravamento falhou.
    await expect(withProspectingLock(pool, ORG, async () => 'feito')).resolves.toBe('feito');

    liberouComErro(cliente);
  });

  it('o fn que falha solta o cliente COM erro, depois de destravar', async () => {
    const cliente = clienteFalso(undefined, [['pg_try_advisory_lock', [{ locked: true }]]]);
    const pool = poolFalso(cliente);

    await expect(
      withProspectingLock(pool, ORG, async () => {
        throw new ProspectingError('deu ruim na operação');
      }),
    ).rejects.toThrow('deu ruim na operação');

    expect(comandosDaTransacao(cliente)).toContain(
      'select pg_advisory_unlock(hashtextextended($1,0))',
    );
    liberouComErro(cliente, 'deu ruim na operação');
  });

  it('caminho feliz: destrava e solta o cliente SEM erro', async () => {
    const cliente = clienteFalso(undefined, [['pg_try_advisory_lock', [{ locked: true }]]]);
    const pool = poolFalso(cliente);

    await expect(withProspectingLock(pool, ORG, async () => 'ok')).resolves.toBe('ok');

    liberouSemErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// lib/prospecting/agent-session.ts — mutateAgentSession (transação + lock)
// ---------------------------------------------------------------------------

const ATOR = { orgId: ORG, userId: USER_ID, requestId: 'req-2624' };

describe('#2624 · agent-session.ts (mutateAgentSession)', () => {
  it('o advisory lock que rejeita solta o cliente COM erro e o erro sobe', async () => {
    const cliente = clienteFalso('pg_advisory_xact_lock');
    const pool = poolFalso(cliente);

    await expect(
      mutateAgentSession(pool, ATOR, CAMPANHA, 7, (atual) => atual),
    ).rejects.toThrow(MENSAGEM);

    expect(comandosDaTransacao(cliente)).toEqual([
      'begin',
      expect.stringContaining('pg_advisory_xact_lock'),
      'rollback',
    ]);
    liberouComErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// lib/prospecting/agent-chat.ts — chatAboutAgent (leituras sob connect())
// ---------------------------------------------------------------------------

describe('#2624 · agent-chat.ts (chatAboutAgent)', () => {
  it('a consulta que rejeita solta o cliente COM erro e o erro sobe', async () => {
    const cliente = clienteFalso('from prospecting_campaigns');
    const pool = poolFalso(cliente);

    await expect(
      chatAboutAgent(
        pool,
        ORG,
        { campaign_id: CAMPANHA, messages: [{ role: 'user', content: 'Monte o agente.' }] },
        () => true,
      ),
    ).rejects.toThrow(MENSAGEM);

    liberouComErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// lib/atendimento/aviso-caso-obsoleto.ts — registrarRespostaDeCasoObsoleto
// ---------------------------------------------------------------------------

describe('#2624 · aviso-caso-obsoleto.ts (registrarRespostaDeCasoObsoleto)', () => {
  it('a resolução que rejeita solta o cliente COM erro e o erro sobe', async () => {
    const cliente = clienteFalso();
    const pool = poolFalso(cliente);
    vi.mocked(resolveCaseFromHuman).mockRejectedValueOnce(new Error(MENSAGEM));

    await expect(
      registrarRespostaDeCasoObsoleto(pool, ORG, CASE_ID, USER_ID, 'respondido'),
    ).rejects.toThrow(MENSAGEM);

    expect(comandosDaTransacao(cliente)).toEqual(['begin', 'rollback']);
    liberouComErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// lib/agent-engine/health/circuit.ts — evaluateSession (via channelHealthTick)
// ---------------------------------------------------------------------------

const LOG: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function poolDoCircuito(cliente: ClienteFalso): pg.Pool {
  return {
    connect: vi.fn(async () => cliente),
    // espelho, knobs e taxas: tudo no pool; a transação da sessão é do cliente.
    query: vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase();
      if (s.includes('health_knobs')) return { rows: [], rowCount: 0 };
      if (s.includes('with cut')) return { rows: [], rowCount: 0 };
      if (s.includes('channel_session_health'))
        return {
          rows: [{ organization_id: ORG, channel_session_id: CANAL }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as pg.Pool;
}

describe('#2624 · health/circuit.ts (evaluateSession via channelHealthTick)', () => {
  it('o select com for update que rejeita solta o cliente COM erro', async () => {
    const cliente = clienteFalso('for update');
    const pool = poolDoCircuito(cliente);

    // a sessão que falhou não derruba as demais: o tick segue e loga o erro.
    const tick = await channelHealthTick(pool, LOG);

    expect(tick.evaluated).toBe(0);
    expect(LOG.error).toHaveBeenCalled();
    expect(comandosDaTransacao(cliente)).toEqual([
      'begin',
      expect.stringContaining('for update'),
      'rollback',
    ]);
    liberouComErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// app/api/v1/ai/routers/[id]/members/route.ts — transação via getRequestPool()
// ---------------------------------------------------------------------------

const AUTORIZACAO: RoleCheck = {
  ok: true,
  user: {
    id: USER_ID,
    email: 'u@example.com',
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: 'pt-BR',
    organizations: [{ organization_id: ORG, organization_name: 'Org', role: 'admin' }],
  } as AuthUser,
  org: { orgId: ORG, name: 'Org', role: 'admin' },
};

const MEMBRO = {
  agent_id: AGENTE,
  intent_name: 'saudar',
  intent_description: 'Sauda o cliente',
  examples: [],
  flow_pointer_id: null,
  pipeline_id: null,
  stage_id: null,
};

describe('#2624 · routers/[id]/members/route.ts (PUT members)', () => {
  it('a escrita que rejeita solta o cliente COM erro e a rota responde 500', async () => {
    vi.stubEnv('SUPABASE_DB_URL', 'postgresql://postgres@127.0.0.1:5432/db');
    vi.mocked(requireRole).mockResolvedValue(AUTORIZACAO);
    const cliente = clienteFalso('delete from ai_router_members', [
      ['select id,config,is_active', [{ id: ROTEADOR, config: {}, is_active: true }]],
      ['from ai_agents', [{ id: AGENTE }]],
    ]);
    vi.mocked(getRequestPool).mockReturnValue({
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => cliente),
    } as unknown as ReturnType<typeof getRequestPool>);

    const { PUT } = await import('@/app/api/v1/ai/routers/[id]/members/route');
    const req = new NextRequest(`http://localhost/api/v1/ai/routers/${ROTEADOR}/members`, {
      method: 'PUT',
      body: JSON.stringify({ members: [MEMBRO] }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: ROTEADOR }) });

    expect(res.status).toBe(500);
    expect(comandosDaTransacao(cliente)).toEqual([
      'begin',
      expect.stringContaining('for update'),
      expect.stringContaining('from ai_agents'),
      expect.stringContaining('delete from ai_router_members'),
      'rollback',
    ]);
    liberouComErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// lib/prospecting/agent-setup.ts — setupProspectingAgent (locks + transação)
// ---------------------------------------------------------------------------

const INPUT_SETUP = prospectingAgentSetupSchema.parse({
  request_id: ORG,
  campaign_id: CAMPANHA,
  name: 'Consultor comercial',
  tone: 'cordial',
  instruction: 'Oferecer diagnóstico de atendimento comercial',
  qualification: 'Necessidade confirmada e interesse em conversar',
  channel_session_id: CANAL,
  pipeline_id: ORG,
  stage_id: ORG,
  qualified_stage_id: CANAL,
});

describe('#2624 · agent-setup.ts (setupProspectingAgent)', () => {
  it('a consulta do lock que rejeita solta o cliente COM erro', async () => {
    const cliente = clienteFalso('pg_advisory_lock');
    const pool = poolFalso(cliente);

    await expect(
      setupProspectingAgent(pool, {} as never, { orgId: ORG, userId: USER_ID, requestId: ORG }, INPUT_SETUP),
    ).rejects.toThrow('Não foi possível preparar o agente');

    // o rollback (best-effort) roda e o erro original é o que o pg-pool recebe.
    expect(comandosDaTransacao(cliente)).toContain('rollback');
    liberouComErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// lib/external-db/conexao.ts — consultar (BEGIN READ ONLY)
// ---------------------------------------------------------------------------

describe('#2624 · external-db/conexao.ts (consultar)', () => {
  it('a consulta dentro do BEGIN READ ONLY que rejeita solta o cliente COM erro', async () => {
    const cliente = clienteFalso('from clientes');
    const pool = poolFalso(cliente);

    await expect(consultar(pool, 'select nome from clientes')).rejects.toThrow(MENSAGEM);

    expect(comandosDaTransacao(cliente)).toEqual([
      'begin read only',
      expect.stringContaining('statement_timeout'),
      expect.stringContaining('lock_timeout'),
      expect.stringContaining('idle_in_transaction_session_timeout'),
      expect.stringContaining('from clientes'),
      'rollback',
    ]);
    liberouComErro(cliente);
  });

  it('caminho feliz: commita e solta o cliente SEM erro', async () => {
    const cliente = clienteFalso(undefined, [['select nome from clientes', [{ nome: 'Ana' }]]]);
    const pool = poolFalso(cliente);

    const r = await consultar<{ nome: string }>(pool, 'select nome from clientes');

    expect(r.rows).toEqual([{ nome: 'Ana' }]);
    expect(comandosDaTransacao(cliente)).toContain('commit');
    liberouSemErro(cliente);
  });
});
