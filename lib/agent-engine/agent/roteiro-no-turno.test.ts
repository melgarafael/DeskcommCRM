/**
 * O roteiro dentro do turno: chave desligada não consulta nada; começa por
 * palavra-gatilho ou pelo roteador; o turno que começa só grava o que o
 * validador leu; o log nunca leva o texto do cliente; e — no texto do turno —
 * o roteiro entra DEPOIS de tudo que silencia (achado 5 da prova do #1130).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { FlowGraph } from '@/lib/followup/graph-schema';
import { garantirPerguntaDoRoteiro, prepararRoteiroDoTurno, type ValidarResposta } from './roteiro-no-turno';

const GRAFO: FlowGraph = {
  nodes: [
    { id: 't', type: 'trigger', label: 'Início', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'c1',
      type: 'collect',
      label: 'Nome',
      position: { x: 0, y: 0 },
      config: { key: 'nome_completo', label: 'Nome completo', type: 'text', required: true, permite_correcao: true },
    },
    { id: 'e', type: 'end', label: 'Fim', position: { x: 0, y: 0 }, config: { outcome: 'converted' } },
  ],
  edges: [
    { id: 'a', source: 't', target: 'c1', priority: 0, condition: { type: 'always' } },
    { id: 'b', source: 'c1', target: 'e', priority: 0, condition: { type: 'always' } },
  ],
  settings: { max_tentativas_pergunta: 3, gatilhos: ['financiar'] },
};

/** Primeira pergunta sim/não: a captura determinística leria "sim" como resposta. */
const GRAFO_SIM_NAO: FlowGraph = {
  ...GRAFO,
  nodes: GRAFO.nodes.map((n) =>
    n.type === 'collect'
      ? { ...n, config: { key: 'tem_cnh', label: 'Tem CNH', type: 'boolean', required: true, permite_correcao: true } }
      : n,
  ),
};

/** Banco fake: um roteiro 'coletando' passa a existir quando alguém o insere. */
function banco(
  opts: {
    roteiroJaExiste?: boolean;
    grafo?: FlowGraph;
    /** A linha da mensagem do turno, como o roteiro a lê (legenda + derivado da mídia). */
    mensagem?: { body: string | null; media_derived_text?: string | null } | null;
    /** Perguntas já feitas ao cliente (eventos `roteiro_pergunta_feita`). */
    perguntasFeitas?: string[];
    /** O LOTE inteiro (rajada): vence `mensagem` quando presente. */
    lote?: Array<{ id: string; body: string | null; media_derived_text?: string | null }>;
  } = {},
) {
  const GRAFO_DO_BANCO = opts.grafo ?? GRAFO;
  const mensagem =
    opts.mensagem === undefined ? { body: 'quero financiar, meu nome é Lia Mendes', media_derived_text: null } : opts.mensagem;
  let existe = opts.roteiroJaExiste ?? false;
  const sqls: string[] = [];
  const chaves = new Set<string>();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    if (/insert into followup_enrollment_events/.test(sql) && typeof params[5] === 'string') {
      if (chaves.has(params[5])) return { rows: [], rowCount: 0 };
      chaves.add(params[5]);
    }
    if (/from followup_enrollments e[\s\S]*e\.status = 'coletando'/.test(sql)) {
      return existe
        ? {
            rows: [
              {
                id: 'enr-1',
                pointer_id: 'ptr-1',
                version_id: 'ver-1',
                contact_id: 'ct',
                current_node_id: 't',
                status: 'coletando',
                nome: 'Cadastro',
                graph: GRAFO_DO_BANCO,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (/select p\.id, p\.name as nome, v\.graph/.test(sql)) {
      return { rows: [{ id: 'ptr-1', nome: 'Cadastro', graph: GRAFO_DO_BANCO }], rowCount: 1 };
    }
    if (/select p\.active_version_id, v\.graph/.test(sql)) {
      return { rows: [{ active_version_id: 'ver-1', graph: GRAFO_DO_BANCO }], rowCount: 1 };
    }
    if (/insert into followup_enrollments/.test(sql)) {
      existe = true;
      return { rows: [{ id: 'enr-1' }], rowCount: 1 };
    }
    if (/event_type in \('roteiro_tentativa', 'roteiro_pergunta_feita'\)/.test(sql)) {
      const linhas = (opts.perguntasFeitas ?? []).map((campo) => ({ tipo: 'roteiro_pergunta_feita', campo, n: 1 }));
      return { rows: linhas, rowCount: linhas.length };
    }
    if (/from messages/.test(sql)) {
      const linhas = opts.lote ?? (mensagem === null ? [] : [{ id: 'msg-1', ...mensagem }]);
      return { rows: linhas, rowCount: linhas.length };
    }
    if (/select custom_fields from contacts/.test(sql)) return { rows: [{ custom_fields: {} }], rowCount: 1 };
    if (/insert into followup_enrollment_events|update /.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as pg.Pool, query, sqls };
}

function log() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const turno = {
  organizationId: 'org',
  contactId: 'ct',
  conversationId: 'conv',
  texto: 'quero financiar, meu nome é Lia Mendes',
  messageId: 'msg-1',
  flowPointerDoRoteador: null,
  mensagens: [{ de: 'cliente' as const, texto: 'quero financiar, meu nome é Lia Mendes' }],
};

const semLeitura: ValidarResposta = async () => ({ resultado: 'nao_respondeu' });

describe('prepararRoteiroDoTurno', () => {
  it('chave desligada: null, sem uma consulta sequer — mesmo com roteiro em andamento', async () => {
    const b = banco({ roteiroJaExiste: true });
    const r = await prepararRoteiroDoTurno(
      { pool: b.pool, moduloLigado: async () => false, validar: semLeitura, log: log() as never },
      turno,
    );
    expect(r).toBeNull();
    expect(b.query).not.toHaveBeenCalled();
  });

  it('sem roteiro e sem palavra-gatilho: null, nada é criado', async () => {
    const b = banco({ mensagem: { body: 'oi, tudo bem?' } });
    const r = await prepararRoteiroDoTurno(
      { pool: b.pool, moduloLigado: async () => true, validar: semLeitura, log: log() as never },
      { ...turno, texto: 'oi, tudo bem?' },
    );
    expect(r).toBeNull();
    expect(b.sqls.some((s) => /insert into followup_enrollments/.test(s))).toBe(false);
  });

  it('palavra-gatilho começa o roteiro; sem leitura do validador, a frase de gatilho NÃO vira resposta', async () => {
    const b = banco();
    const r = await prepararRoteiroDoTurno(
      { pool: b.pool, moduloLigado: async () => true, validar: semLeitura, log: log() as never },
      turno,
    );
    expect(r?.iniciadoNesteTurno).toBe(true);
    expect(r?.estado.situacao.pendentes.map((n) => n.config.key)).toEqual(['nome_completo']);
    expect(r?.bloco).toContain('Roteiro de atendimento ativo — Cadastro');
    expect(b.sqls.some((s) => /update contacts/.test(s))).toBe(false);
  });

  it('no turno de início, a captura determinística não roda: "sim, quero financiar" não responde a CNH', async () => {
    const b = banco({ grafo: GRAFO_SIM_NAO, mensagem: { body: 'sim, quero financiar' } });
    const r = await prepararRoteiroDoTurno(
      { pool: b.pool, moduloLigado: async () => true, validar: semLeitura, log: log() as never },
      { ...turno, texto: 'sim, quero financiar' },
    );
    expect(r?.iniciadoNesteTurno).toBe(true);
    expect(b.sqls.some((s) => /update contacts/.test(s))).toBe(false);
    expect(r?.estado.situacao.pendentes.map((n) => n.config.key)).toEqual(['tem_cnh']);
  });

  it('no turno de início, o que o validador leu na mensagem já é gravado', async () => {
    const b = banco();
    const r = await prepararRoteiroDoTurno(
      {
        pool: b.pool,
        moduloLigado: async () => true,
        validar: async () => ({ resultado: 'respondeu', respostas: [{ campo: 'nome_completo', valor: 'Lia Mendes' }] }),
        log: log() as never,
      },
      turno,
    );
    expect(b.sqls.some((s) => /update contacts/.test(s))).toBe(true);
    expect(r?.estado.situacao.pendentes).toHaveLength(0);
  });

  it('o roteador começa o roteiro que a intenção aponta, sem olhar palavra-gatilho', async () => {
    const b = banco({ mensagem: { body: 'oi' } });
    const r = await prepararRoteiroDoTurno(
      { pool: b.pool, moduloLigado: async () => true, validar: semLeitura, log: log() as never },
      { ...turno, texto: 'oi', flowPointerDoRoteador: 'ptr-1' },
    );
    expect(r?.iniciadoNesteTurno).toBe(true);
    expect(b.sqls.some((s) => /select p\.id, p\.name as nome, v\.graph/.test(s))).toBe(false);
  });

  it('o log do turno nunca leva o texto do cliente nem o valor lido', async () => {
    const b = banco({ roteiroJaExiste: true, mensagem: { body: 'meu CPF é 529.982.247-25 e sou Lia Mendes' } });
    const l = log();
    await prepararRoteiroDoTurno(
      {
        pool: b.pool,
        moduloLigado: async () => true,
        validar: async () => ({ resultado: 'respondeu', respostas: [{ campo: 'nome_completo', valor: 'Lia Mendes' }] }),
        log: l as never,
      },
      { ...turno, texto: 'meu CPF é 529.982.247-25 e sou Lia Mendes' },
    );
    const tudo = JSON.stringify([...l.info.mock.calls, ...l.warn.mock.calls]);
    expect(l.info).toHaveBeenCalled();
    expect(tudo).not.toContain('529');
    expect(tudo).not.toContain('Lia');
  });

  it('banco que falha: o turno segue sem roteiro (null), com aviso', async () => {
    const l = log();
    const r = await prepararRoteiroDoTurno(
      {
        pool: { query: async () => { throw new Error('conexão caiu'); } } as unknown as pg.Pool,
        moduloLigado: async () => true,
        validar: semLeitura,
        log: l as never,
      },
      turno,
    );
    expect(r).toBeNull();
    expect(l.warn).toHaveBeenCalled();
  });
});

describe('mídia e retry (achado 8 da prova; revisão do PR 1)', () => {
  it('figurinha ou áudio sem transcrição: nem tentativa, nem validador', async () => {
    const b = banco({ roteiroJaExiste: true, mensagem: { body: null, media_derived_text: null } });
    const validar = vi.fn(semLeitura);
    const r = await prepararRoteiroDoTurno(
      { pool: b.pool, moduloLigado: async () => true, validar, log: log() as never },
      { ...turno, texto: '[sticker]' },
    );
    expect(r).not.toBeNull();
    expect(validar).not.toHaveBeenCalled();
    // A mensagem é reivindicada (o retry não a relê), mas nada conta tentativa.
    const tipos = b.query.mock.calls
      .filter(([sql]) => /insert into followup_enrollment_events/.test(String(sql)))
      .map(([, params]) => (params as unknown[])[3]);
    expect(tipos).toEqual(['roteiro_mensagem']);
  });

  it('áudio TRANSCRITO: o roteiro lê a transcrição, sem o enquadramento do histórico', async () => {
    const b = banco({ roteiroJaExiste: true, mensagem: { body: null, media_derived_text: 'meu nome é Lia Mendes' } });
    const validar = vi.fn(semLeitura);
    await prepararRoteiroDoTurno(
      { pool: b.pool, moduloLigado: async () => true, validar, log: log() as never },
      { ...turno, texto: '[Mídia do cliente: ele enviou um áudio…]\nConteúdo: meu nome é Lia Mendes' },
    );
    expect(validar).toHaveBeenCalledWith(expect.objectContaining({ textoAtual: 'meu nome é Lia Mendes' }));
  });

  it('retry da mesma mensagem não chama o validador de novo', async () => {
    const b = banco({ roteiroJaExiste: true });
    const validar = vi.fn(semLeitura);
    const deps = { pool: b.pool, moduloLigado: async () => true, validar, log: log() as never };
    await prepararRoteiroDoTurno(deps, turno);
    await prepararRoteiroDoTurno(deps, turno);
    expect(validar).toHaveBeenCalledTimes(1);
  });
});

describe('revisão adversarial do PR 2 — dado inventado', () => {
  it('⭐ turno que COMEÇA o roteiro: "sim, quero financiar" não vira tem_cnh = true', async () => {
    const b = banco({ grafo: GRAFO_SIM_NAO, mensagem: { body: 'sim, quero financiar' } });
    const validar = vi.fn<ValidarResposta>(async () => ({ resultado: 'nao_respondeu' }));
    const r = await prepararRoteiroDoTurno(
      { pool: b.pool, moduloLigado: async () => true, validar, log: log() as never },
      { ...turno, texto: 'sim, quero financiar' },
    );
    // Nenhuma pergunta foi feita: não há "pergunta atual" para o validador.
    expect(validar).toHaveBeenCalledWith(expect.objectContaining({ perguntaAtual: null }));
    expect(b.sqls.some((s) => /update contacts/.test(s))).toBe(false);
    expect(r?.estado.situacao.pendentes.map((n) => n.config.key)).toEqual(['tem_cnh']);
  });

  it('pergunta já FEITA é a pergunta atual no turno seguinte', async () => {
    const b = banco({
      roteiroJaExiste: true,
      grafo: GRAFO_SIM_NAO,
      mensagem: { body: 'sim' },
      perguntasFeitas: ['tem_cnh'],
    });
    const validar = vi.fn<ValidarResposta>(async () => ({ resultado: 'nao_respondeu' }));
    await prepararRoteiroDoTurno(
      { pool: b.pool, moduloLigado: async () => true, validar, log: log() as never },
      { ...turno, texto: 'sim' },
    );
    expect(validar).toHaveBeenCalledWith(expect.objectContaining({ perguntaAtual: 'tem_cnh' }));
  });

  it('⭐ rajada "oi" + "meu cpf é 529.982.247-25": o validador lê o LOTE, e o retry não relê', async () => {
    const b = banco({
      roteiroJaExiste: true,
      lote: [
        { id: 'm1', body: 'oi' },
        { id: 'm2', body: 'meu cpf é 529.982.247-25' },
      ],
    });
    const validar = vi.fn<ValidarResposta>(async () => ({ resultado: 'nao_respondeu' }));
    const deps = { pool: b.pool, moduloLigado: async () => true, validar, log: log() as never };
    await prepararRoteiroDoTurno(deps, { ...turno, messageId: 'm1', texto: 'oi' });
    expect(validar).toHaveBeenCalledWith(
      expect.objectContaining({ textoAtual: 'oi\nmeu cpf é 529.982.247-25' }),
    );
    await prepararRoteiroDoTurno(deps, { ...turno, messageId: 'm1', texto: 'oi' });
    expect(validar).toHaveBeenCalledTimes(1);
  });
});

describe('garantirPerguntaDoRoteiro', () => {
  async function roteiroAtivo() {
    const b = banco({ roteiroJaExiste: true });
    const r = await prepararRoteiroDoTurno(
      { pool: b.pool, moduloLigado: async () => true, validar: semLeitura, log: log() as never },
      { ...turno, messageId: null },
    );
    return { roteiro: r!, b };
  }

  it('o modelo já perguntou: o motor não manda de novo', async () => {
    const { roteiro, b } = await roteiroAtivo();
    const enviar = vi.fn(async () => true);
    await garantirPerguntaDoRoteiro(
      { pool: b.pool, log: log() as never },
      { organizationId: 'org', roteiro, corposEnviados: ['Legal! Qual é o seu nome completo?'], enviar },
    );
    expect(enviar).not.toHaveBeenCalled();
  });

  it('o modelo não perguntou: o motor manda a pergunta pela cadeia', async () => {
    const { roteiro, b } = await roteiroAtivo();
    const enviar = vi.fn(async () => true);
    await garantirPerguntaDoRoteiro(
      { pool: b.pool, log: log() as never },
      { organizationId: 'org', roteiro, corposEnviados: ['Temos várias opções de financiamento.'], enviar },
    );
    expect(enviar).toHaveBeenCalledWith('Nome completo?');
  });
});

describe('ordem no turno (achado 5 da prova do #1130)', () => {
  const src = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'), 'utf8');
  const chamada = src.indexOf('await prepararRoteiroDoTurno(');

  it('o roteiro entra DEPOIS da pausa, do pedido de humano e do opt-out ambíguo', () => {
    expect(chamada).toBeGreaterThan(0);
    for (const trava of [
      'agentConfig.pausedAt',
      'detectHumanHandoffRequest(texto)',
      'detectAmbiguousOptOut(texto)',
      'isLeadInHandoff(pool, tenantId, leadId)',
    ]) {
      const posicao = src.indexOf(trava);
      expect(posicao, trava).toBeGreaterThan(0);
      expect(posicao, trava).toBeLessThan(chamada);
    }
  });

  it('e nunca para contato bloqueado, nem fora do turno de inbound', () => {
    const guarda = src.slice(src.lastIndexOf('const roteiro =', chamada), chamada);
    expect(guarda).toContain("liveJob().kind === 'inbound_turn'");
    expect(guarda).toContain('!optedOutThisTurn');
    expect(guarda).toContain('!preview');
  });
});
