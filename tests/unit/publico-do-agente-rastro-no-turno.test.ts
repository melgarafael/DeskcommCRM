/**
 * O RASTRO DO PÚBLICO NO TURNO (#3722) — "quem foi considerado e por que
 * ganhou/perdeu", no caminho de resolução do turno.
 *
 * A régua (`publico-do-gatilho.ts`) e a escolha (`agent-config.ts`) provam
 * QUEM atende. O que este arquivo prova é o que o operador tem na mão quando
 * pergunta "por que o agente de vendas não respondeu?": a resolução do turno
 * carrega o rastro da seleção (`rastroDoPublico`) e o registra UMA vez no log
 * do turno, com a fila inteira — cada candidato, sua posição, se declarou
 * público, e a regra que o liberou ou barrou.
 *
 * O log é o artefato: quem recebe a reclamação não abre o banco. Por isso a
 * asserção é sobre os CAMPOS do log, não sobre uma mensagem solta — um
 * `log.info('público')` sem a fila dentro passaria num teste de substring e
 * não serviria para nada.
 *
 * E o silêncio é preservado: número onde NINGUÉM declarou público não ganha
 * linha nova no log do turno (quem não usa o recurso não paga nem uma linha).
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveTurnAgent } from '@/lib/agent-engine/agent/resolve-turn-agent';
import type { EscolhaDoNumero, PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

/** Config mínima válida — só o agentId importa aqui. */
function fakeConfig(agentId: string): PublishedAgentConfig {
  return {
    agentId,
    versionId: `v-${agentId}`,
    agentName: agentId,
    systemPrompt: 'prompt',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    credentialId: null,
    maxSteps: 5,
    historyMessageWindow: 20,
    historyTokenWindow: 4000,
    handoffKeywords: [],
    handoffToolEnabled: false,
    proposalAiDraftEnabled: true,
    splitMessages: false,
    splitMaxChars: 900,
    inboundDebounceMs: null,
    multimodalInput: false,
    casesEnabled: false,
    toolIds: [],
    knowledgeSourceIds: [],
    activeKbVersionId: null,
    ragTopK: 5,
    ragSimilarityThreshold: 0.72,
    janelaDeAtendimento: null,
    versionCreatedBy: null,
    operatorEnabled: false,
    operatorModel: null,
    operatorToolIds: [],
    pipelineIds: [],
    agentCreatedBy: null,
    vozEnabled: false,
    vozQuando: 'espelhar',
  };
}

const input = {
  tenantId: 'org-1',
  leadId: 'contato-1',
  jobId: 'job-1',
  channelSessionId: 'sess-1',
  conversationId: 'conv-1',
  signal: 'meu contrato está errado',
  stickyAgentId: null,
  stickyIntent: null,
};

/** A fila que a seleção devolve no caso da issue: o vendedor perde, o suporte ganha. */
const ESCOLHA_COM_RASTRO: EscolhaDoNumero = {
  config: fakeConfig('suporte'),
  motivo: 'publico_liberou',
  rastro: {
    contatoAvaliado: true,
    escolhidoAgentId: 'suporte',
    candidatos: [
      {
        agentId: 'vendas',
        agentName: 'Vendedor',
        posicao: 0,
        pausado: false,
        semPublico: false,
        decisao: { passa: false, regra: 'barrado_por_etiqueta_excluida', valor: 'cliente ativo' },
      },
      {
        agentId: 'suporte',
        agentName: 'Suporte',
        posicao: 1,
        pausado: false,
        semPublico: false,
        decisao: { passa: true, regra: 'passou', valor: null },
      },
    ],
  },
};

function depsCom(escolha: EscolhaDoNumero) {
  const info = vi.fn();
  return {
    deps: {
      log: { info, warn: vi.fn(), error: vi.fn() },
      loadActiveRouter: vi.fn().mockResolvedValue(null),
      escolherAgenteDoNumero: vi.fn().mockResolvedValue(escolha),
    } as never,
    info,
  };
}

const linhaDoRastro = (info: ReturnType<typeof vi.fn>) =>
  info.mock.calls.find((c) => String(c[0]).includes('público do agente'));

describe('rastro do público na resolução do turno (#3722)', () => {
  it('a resolução carrega o rastro da seleção (quem foi considerado)', async () => {
    const { deps } = depsCom(ESCOLHA_COM_RASTRO);
    const out = await resolveTurnAgent({} as never, {} as never, input, deps);

    expect(out.outcome).toBe('no_router');
    expect(out.config?.agentId).toBe('suporte');
    expect(out.rastroDoPublico).toEqual(ESCOLHA_COM_RASTRO.rastro);
  });

  it('o log do turno nomeia o candidato barrado, a regra e o item — com campos, não frase', async () => {
    const { deps, info } = depsCom(ESCOLHA_COM_RASTRO);
    await resolveTurnAgent({} as never, {} as never, input, deps);

    const chamada = linhaDoRastro(info);
    expect(chamada, 'o turno tem de registrar quem foi considerado').toBeDefined();
    const campos = chamada![1] as {
      escolhido: string | null;
      contatoAvaliado: boolean;
      candidatos: Record<string, unknown>[];
    };
    expect(campos.escolhido).toBe('suporte');
    expect(campos.contatoAvaliado).toBe(true);
    expect(campos.candidatos).toEqual([
      {
        agente: 'Vendedor',
        posicao: 0,
        pausado: false,
        sem_publico: false,
        regra: 'barrado_por_etiqueta_excluida',
        valor: 'cliente ativo',
      },
      { agente: 'Suporte', posicao: 1, pausado: false, sem_publico: false, regra: 'passou', valor: null },
    ]);
  });

  it('o rastro registra em log não leva dado do contato — só o item DECLARADO na config', async () => {
    const { deps, info } = depsCom(ESCOLHA_COM_RASTRO);
    await resolveTurnAgent({} as never, {} as never, input, deps);

    const campos = linhaDoRastro(info)![1] as Record<string, unknown>;
    // Nada de lista de etiquetas do contato nem telefone/nome: a disciplina de
    // PII do logger é do call site, e este é o call site.
    expect(Object.keys(campos).sort()).toEqual(
      ['candidatos', 'contactId', 'contatoAvaliado', 'conversationId', 'escolhido', 'tenantId'].sort(),
    );
    expect(JSON.stringify(campos)).not.toContain('5511');
  });

  it('número sem público declarado: nenhum rastro, nenhuma linha nova no log', async () => {
    const semRastro: EscolhaDoNumero = { config: fakeConfig('unico'), motivo: 'primeiro_da_fila' };
    const { deps, info } = depsCom(semRastro);
    const out = await resolveTurnAgent({} as never, {} as never, input, deps);

    expect(out.config?.agentId).toBe('unico');
    expect(out.rastroDoPublico).toBeUndefined();
    expect(linhaDoRastro(info), 'quem não usa o público não ganha log novo por turno').toBeUndefined();
  });
});
