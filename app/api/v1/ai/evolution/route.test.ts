import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const requireRole = vi.fn();
vi.mock('@/lib/auth/require-role', () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));

const from = vi.fn();
const rpc = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from, rpc }) }));

/** Agregado zerado no formato de `fn_uso_de_ia` (`usoDeIaSchema`). */
function agregado(custo: number | string = 0) {
  return {
    chamadas: 0,
    custo_cents: custo,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    chamadas_cacheaveis: 0,
    input_tokens_cacheaveis: 0,
    cache_read_tokens_cacheaveis: 0,
    cache_write_tokens: 0,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
  };
}

/** O `jsonb` de `fn_uso_de_ia` com o custo total do período. */
function usoDoBanco(custo: number | string = 0) {
  return {
    totais: { ...agregado(custo), turnos: 0, custo_dos_turnos_cents: 0 },
    dias: [],
    purposes: [],
    inbounds: {},
    handoffs: {},
  };
}

import { GET } from './route';
import { NextRequest } from 'next/server';

function req(qs = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/ai/evolution${qs}`);
}

/** O que o fake registra de CADA consulta, para as asserções de filtro. */
interface Espiao {
  eq: Array<[string, unknown]>;
  gte: Array<[string, unknown]>;
  lte: Array<[string, unknown]>;
  order: Array<[string, string]>;
  tabelas: string[];
}

/**
 * Encadeamento do query builder do Supabase: tudo devolve `this`, o await resolve.
 *
 * `head: true` devolve `data: null` + `count`, como o PostgREST de verdade. Sem
 * isso o fake entregaria as linhas nas duas formas e um `data.length` passaria
 * por uma contagem — o teste concordaria com o defeito em vez de medi-lo.
 */
function fakeDb(
  porTabela: Record<string, unknown[]> = {},
  erros: Record<string, string> = {},
  /** `count` que o servidor devolve, quando não é o tamanho da página (corte, ou ausente). */
  totais: Record<string, number | null> = {},
): Espiao {
  const espiao: Espiao = { eq: [], gte: [], lte: [], order: [], tabelas: [] };
  from.mockImplementation((tabela: string) => {
    espiao.tabelas.push(tabela);
    const rows = porTabela[tabela] ?? [];
    let head = false;
    let pediuCount = false;
    const b: Record<string, unknown> = {};
    for (const m of ['not', 'limit', 'in']) b[m] = () => b;
    b.order = (col: string) => {
      espiao.order.push([tabela, col]);
      return b;
    };
    b.select = (_colunas: string, opts?: { head?: boolean; count?: string }) => {
      head = opts?.head === true;
      // Como o PostgREST: sem `count` pedido, não vem `count` nenhum.
      pediuCount = opts?.count === "exact";
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      espiao.eq.push([col, val]);
      return b;
    };
    b.gte = (col: string, val: unknown) => {
      espiao.gte.push([col, val]);
      return b;
    };
    b.lte = (col: string, val: unknown) => {
      espiao.lte.push([col, val]);
      return b;
    };
    b.then = (resolve: (v: unknown) => void) =>
      resolve(
        erros[tabela]
          ? { data: null, count: null, error: { message: erros[tabela] } }
          : {
              data: head ? null : rows,
              count: !pediuCount ? null : tabela in totais ? totais[tabela] : rows.length,
              error: null,
            },
      );
    return b;
  });
  return espiao;
}

beforeEach(() => {
  requireRole.mockReset();
  from.mockReset();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: usoDoBanco(), error: null });
  requireRole.mockResolvedValue({ ok: true, org: { orgId: 'org-1' }, user: { idioma: 'pt-BR' } });
  fakeDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function decisoes(n: number) {
  return Array.from({ length: n }, () => ({
    created_at: '2026-07-02T10:00:00.000Z',
    outcome: 'matched',
    intent_name: null,
    router_id: 'r1',
  }));
}

describe('GET /api/v1/ai/evolution', () => {
  it('recusa quem não é manager', async () => {
    requireRole.mockResolvedValue({ ok: false, response: new Response('nao', { status: 403 }) });
    const r = await GET(req());
    expect(r.status).toBe(403);
  });

  it('recusa intervalo malformado com 422', async () => {
    const r = await GET(req('?from=ontem'));
    expect(r.status).toBe(422);
  });

  it('devolve o payload agregado sem double-nest', async () => {
    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    expect(r.status).toBe(200);
    const body = await r.json();
    // `ok()` já envelopa em { data } — um `data.data` aqui é o bug de double-nest.
    expect(body.data.range).toEqual({ from: '2026-07-01', to: '2026-07-03' });
    expect(body.data.data).toBeUndefined();
    expect(body.data.gaps).toBeDefined();
  });

  it('toda consulta filtra a organização do JWT', async () => {
    const espiao = fakeDb();
    await GET(req('?from=2026-07-01&to=2026-07-03'));

    const orgFilters = espiao.eq.filter(([c]) => c === 'organization_id');
    expect(orgFilters.length).toBeGreaterThan(0);
    expect(orgFilters.every(([, v]) => v === 'org-1')).toBe(true);
    // Nenhuma tabela pode ser lida sem o filtro de org: uma consulta a mais que
    // filtros de org significa exatamente uma leitura de tenant aberta.
    expect(orgFilters.length).toBe(espiao.tabelas.length);
  });

  it('toda leitura por data usa o MESMO intervalo do range devolvido', async () => {
    // Contadores contam TUDO que a rota entrega; as séries só cobrem os dias do
    // range. Buscar fora da janela some do gráfico e permanece no card.
    const espiao = fakeDb();
    await GET(req('?from=2026-07-01&to=2026-07-03'));

    expect(espiao.gte.every(([, v]) => v === '2026-07-01T00:00:00.000Z')).toBe(true);
    expect(espiao.lte.every(([, v]) => v === '2026-07-03T23:59:59.999Z')).toBe(true);
    // Contra TODAS as consultas menos `crm_stages` (estado atual do funil, não
    // evento do período). Comparar `gte.length` com `lte.length` NÃO serviria:
    // some o par inteiro de uma leitura e a igualdade continua verdadeira — que é
    // justamente o defeito "leitura sem janela nenhuma".
    expect(espiao.gte.length).toBe(espiao.tabelas.length - 1);
    expect(espiao.lte.length).toBe(espiao.tabelas.length - 1);
  });

  it('soma as DUAS fontes de handoff — os dois runtimes registram em lugares diferentes', async () => {
    // O agent-engine (canônico) grava agent_inbox_items(kind=handoff) e não toca
    // no event_log; o runtime nativo antigo só emite event_log. Ler um só devolve
    // "0% de handoff" para o tenant inteiro do outro.
    fakeDb({
      messages: [{}, {}, {}, {}, {}, {}, {}, {}],
      agent_inbox_items: [{}, {}],
      event_log: [{}],
    });
    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    const body = await r.json();
    expect(body.data.outcome.handoff_rate).toBe(3 / 8);
  });

  it('assere os filtros que definem numerador e denominador', async () => {
    // Sem isto, apagar o `.eq("direction","inbound")` deixa a suíte verde e passa
    // a contar mensagem OUTBOUND no denominador da taxa de handoff.
    const espiao = fakeDb();
    await GET(req('?from=2026-07-01&to=2026-07-03'));
    const pares = espiao.eq.map(([c, v]) => `${c}=${String(v)}`);
    expect(pares).toContain('direction=inbound');
    expect(pares).toContain('kind=handoff');
    expect(pares).toContain('event_type=ai.handoff_triggered');
    expect(pares).toContain('is_archived=false');
    // O embed também filtra a org: o cabeçalho do arquivo promete defesa em
    // profundidade, e a RLS não é a promessa — é a rede embaixo dela.
    expect(pares).toContain('crm_pipelines.organization_id=org-1');
  });

  it('ordena antes de truncar e avisa quando o teto é atingido', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // O teto é o `max_rows` do PostgREST (supabase/config.toml): 1.000. Um teto
    // maior nunca é atingido — o servidor corta antes — e o aviso nunca sai (#5016).
    const ROW_CAP = 1_000;
    const espiao = fakeDb(
      {
        ai_router_decisions: Array.from({ length: ROW_CAP }, () => ({
          created_at: '2026-07-02T10:00:00.000Z',
          outcome: 'matched',
          intent_name: null,
          router_id: 'r1',
        })),
      },
      {},
      { ai_router_decisions: 1_500 },
    );

    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    expect(r.status).toBe(200);

    // Sem ORDER BY, QUAIS linhas voltam é indefinido: as séries viram amostra
    // arbitrária, com cara de número exato.
    expect(espiao.order).toContainEqual(['ai_router_decisions', 'created_at']);

    const aviso = warn.mock.calls.find((c) => String(c[0]).includes('ai_router_decisions'));
    expect(aviso, 'teto batido tem que sinalizar, não passar por número exato').toBeDefined();
    expect(JSON.stringify(aviso![1])).toContain('row cap');
  });

  it('o custo vem da soma do banco, não das linhas de llm_calls (#5016)', async () => {
    // Uma empresa com 4.908 chamadas no período: o PostgREST entrega 1.000
    // linhas, e a soma no app parava nelas. A soma de `fn_uso_de_ia` é a mesma
    // da tela Uso de IA.
    const espiao = fakeDb({ llm_calls: Array.from({ length: 1_000 }, () => ({ cost_cents: 1 })) });
    rpc.mockResolvedValue({ data: usoDoBanco(4908), error: null });

    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    const body = await r.json();

    expect(body.data.outcome.cost_cents).toBe(4908);
    expect(espiao.tabelas).not.toContain('llm_calls');
    expect(rpc).toHaveBeenCalledWith('fn_uso_de_ia', {
      p_org: 'org-1',
      p_desde: '2026-07-01T00:00:00.000Z',
      p_ate: '2026-07-03T23:59:59.999Z',
    });
  });

  it('soma o custo como número mesmo quando o banco entrega numeric como string', async () => {
    // `custo_cents` é `numeric`; um `+` sobre strings concatena em silêncio.
    rpc.mockResolvedValue({ data: usoDoBanco('42.75'), error: null });
    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    const body = await r.json();
    expect(body.data.outcome.cost_cents).toBe(42.75);
  });

  it('a soma do custo que falha zera o card e entra em fontes_incompletas', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { message: 'function down' } });

    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    expect(r.status).toBe(200);
    const body = await r.json();

    expect(body.data.outcome.cost_cents).toBe(0);
    expect(body.data.fontes_incompletas).toContainEqual({ fonte: 'llm_calls', motivo: 'falhou' });
  });

  it('leitura que bate no teto entra em fontes_incompletas como cortada', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeDb({ ai_router_decisions: decisoes(1_000) }, {}, { ai_router_decisions: 4_000 });

    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    const body = await r.json();

    expect(body.data.fontes_incompletas).toEqual([{ fonte: 'ai_router_decisions', motivo: 'cortada' }]);
  });

  it('servidor com max_rows menor (500): o count exato acusa o corte', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeDb({ knowledge_searches: Array.from({ length: 500 }, () => ({ created_at: '2026-07-02T10:00:00.000Z', hits: 1, top_score: 0.9, threshold: 0.5, author_kind: 'agent' })) }, {}, { knowledge_searches: 800 });

    const body = await (await GET(req('?from=2026-07-01&to=2026-07-03'))).json();

    expect(body.data.fontes_incompletas).toEqual([{ fonte: 'knowledge_searches', motivo: 'cortada' }]);
  });

  it('exatamente 1.000 linhas, e o período tem 1.000: não é corte', async () => {
    fakeDb({ ai_router_decisions: decisoes(1_000) });

    const body = await (await GET(req('?from=2026-07-01&to=2026-07-03'))).json();

    expect(body.data.fontes_incompletas).toEqual([]);
  });

  it('total ilegível (Content-Range */*, NaN) com página cheia ainda é corte', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeDb({ ai_router_decisions: decisoes(1_000) }, {}, { ai_router_decisions: Number.NaN });

    const body = await (await GET(req('?from=2026-07-01&to=2026-07-03'))).json();

    expect(body.data.fontes_incompletas).toEqual([{ fonte: 'ai_router_decisions', motivo: 'cortada' }]);
  });

  it('contagem com total ilegível (NaN) é falha, não um número', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeDb({}, {}, { messages: Number.NaN });

    const body = await (await GET(req('?from=2026-07-01&to=2026-07-03'))).json();

    expect(body.data.fontes_incompletas).toContainEqual({ fonte: 'messages', motivo: 'falhou' });
  });

  it('contagem que volta sem count e sem erro é falha, não zero', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeDb({ messages: [{}, {}] }, {}, { messages: null });

    const body = await (await GET(req('?from=2026-07-01&to=2026-07-03'))).json();

    expect(body.data.fontes_incompletas).toContainEqual({ fonte: 'messages', motivo: 'falhou' });
  });

  it('custo nulo na soma do banco é falha, não um zero calado', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: usoDoBanco(null as unknown as number), error: null });

    const body = await (await GET(req('?from=2026-07-01&to=2026-07-03'))).json();

    expect(body.data.outcome.cost_cents).toBe(0);
    expect(body.data.fontes_incompletas).toContainEqual({ fonte: 'llm_calls', motivo: 'falhou' });
  });

  it('sem corte nem falha, fontes_incompletas vem vazia', async () => {
    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    const body = await r.json();
    expect(body.data.fontes_incompletas).toEqual([]);
  });

  it('deriva a taxa de handoff da contagem, não do tamanho da página lida', async () => {
    fakeDb({
      messages: [{}, {}, {}, {}],
      event_log: [{}],
    });
    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    const body = await r.json();
    expect(body.data.outcome.handoff_rate).toBe(0.25);
  });

  it('uma fonte fora do ar zera o bloco dela e nomeia tabela + requestId no log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeDb(
      { skill_activations: [{ created_at: '2026-07-02T10:00:00.000Z', skill_name: 'a' }] },
      { org_memory_entries: 'relation down' },
    );

    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    expect(r.status).toBe(200);
    const body = await r.json();

    // O bloco da fonte quebrada zera; os outros continuam contando a história.
    expect(body.data.learned.memory_entries).toBe(0);
    expect(body.data.activity.by_skill).toEqual({ a: 1 });

    // E a tela fica sabendo: o bloco zerado não passa por "não aconteceu nada" (#5016).
    expect(body.data.fontes_incompletas).toContainEqual({ fonte: 'org_memory_entries', motivo: 'falhou' });

    const chamada = warn.mock.calls.find((c) => String(c[0]).includes('org_memory_entries'));
    expect(chamada, 'a tabela que falhou precisa aparecer no log').toBeDefined();
    expect(JSON.stringify(chamada![1])).toContain(r.headers.get('X-Request-Id'));
  });
});
