/**
 * O fluxo de consulta de laudo — testes FOCADOS das decisões do workflow,
 * com todas as bordas externas mockadas: histórico de mensagens, envio e
 * entrega para humano. Nenhum envio real, nenhum acesso real de rede/banco —
 * o "banco" é um fake das três consultas de estado em `conversations.metadata`.
 *
 * O core NÃO traz integração de status: lookup verificado, imagem de
 * pagamento e afins são da extensão da instalação, e por isso não têm
 * teste aqui — o que o core garante é o gate e o caminho determinístico.
 *
 * Cobertura:
 *  1. detecção EN / hindi / hinglish (+ "miltajulta") e negativos de preço;
 *  2. patologia (caso padrão de laboratório) → checagem humana, sem status
 *     nem prazo inventado, e entrega;
 *  3. registro prévio no histórico estabelece a categoria (sem pergunta);
 *  4. sem história → pergunta de categoria e escolha guardada;
 *  5/6. biopsy e radiologia → coleta campo a campo até a entrega, com os
 *     campos coletados em `handover.detalhes` (eles viram a passagem);
 *  7. retry da mesma mensagem → nada duplicado; turno interrompido → reexecuta;
 *  8. preço e outros intents que já funcionam continuam com o modelo;
 *  9. módulo desligado → `null` sem UMA consulta no banco;
 * 10. segurança: nenhum texto dos 3 idiomas passa no detector de promessa
 *     humana; a entrega não é bloqueada pelo teto de envios do turno.
 * + ordem no motor: o bloco entra depois do opt-out e antes do roteiro.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { detectHumanPromise } from '../../guardrails/human-promise';
import type { Queryable } from '../../queue/queue';
import {
  detectarIdioma,
  detectarServico,
  ehPerguntaDeLaudo,
  ehOutraIntencao,
  respostaDeServico,
  servicoDaMensagemDeRegistro,
} from './intent';
import { executarFluxoDeProntoAtendimento, type FluxoDeLaudoDeps } from './workflow';
import { textosDoFluxo, variante } from './templates';
import type { EstadoFluxo } from './state';

const ORG = 'org-teste';
const CONV = 'conv-teste';
const LEAD = 'lead-teste';

const VERIFICAR_EQUIPE = textosDoFluxo('en').verificarPelaEquipe;

/** Fake das três consultas de estado (ler / claim / salvar) sobre `conversations.metadata`. */
function fakeDb(estadoInicial: EstadoFluxo | null = null) {
  let estado: EstadoFluxo | null = estadoInicial;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('as estado')) return { rows: [{ estado }], rowCount: 1 };
    if (sql.includes('and not (')) {
      // claim: falha só quando a mensagem já está COMPLETA (mesma msg, sem processo)
      const proposto = JSON.parse(params[2] as string) as EstadoFluxo;
      const completo = estado !== null && estado.msg === proposto.msg && estado.processando === false;
      if (completo) return { rows: [], rowCount: 0 };
      estado = proposto;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('- $3::text')) {
      estado = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('jsonb_build_object($3')) {
      estado = JSON.parse(params[3] as string) as EstadoFluxo;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`sql não previsto no fake do teste: ${sql.slice(0, 90)}`);
  });
  return {
    db: { query } as unknown as Queryable,
    query,
    ler: () => estado,
    seed: (e: EstadoFluxo | null) => {
      estado = e;
    },
  };
}

interface Opcoes {
  estadoInicial?: EstadoFluxo | null;
  texto?: string;
  historico?: string[];
  maxSends?: number;
  moduloLigado?: boolean;
}

function criar(op: Opcoes = {}) {
  const banco = fakeDb(op.estadoInicial ?? null);
  const envios: string[] = [];
  const handovers: Array<{
    titulo: string;
    resumo: string;
    detalhes: Record<string, string>;
    chave: string;
  }> = [];
  const deps: FluxoDeLaudoDeps = {
    db: banco.db,
    log: { info: vi.fn(), warn: vi.fn() },
    tenantId: ORG,
    leadId: LEAD,
    conversationId: CONV,
    msgId: 'm1',
    texto: op.texto ?? 'Is my report ready?',
    moduloLigado: () => op.moduloLigado ?? true,
    maxSends: op.maxSends ?? 3,
    buscarHistorico: async () => op.historico ?? [],
    enviar: async (corpo: string) => {
      envios.push(corpo);
      return true;
    },
    handover: async (o) => {
      handovers.push(o);
    },
  };
  return { deps, envios, handovers, banco };
}

describe('detecção de laudo pronto e escapes', () => {
  it('reconhece em inglês, hindi e hinglish, incluindo "miltajulta"', () => {
    expect(ehPerguntaDeLaudo('Is my report ready?')).toBe(true);
    expect(ehPerguntaDeLaudo('Mera report mil gaya?')).toBe(true);
    expect(ehPerguntaDeLaudo('Report kab milegi?')).toBe(true);
    expect(ehPerguntaDeLaudo('मेरी रिपोर्ट कब तक मिलेगी?')).toBe(true);
    expect(ehPerguntaDeLaudo('Where is my report?')).toBe(true);
    expect(ehPerguntaDeLaudo('Miltajulta')).toBe(true);
    expect(detectarIdioma('Report kab milegi?')).toBe('hinglish');
    expect(detectarIdioma('मेरी रिपोर्ट तैयार है?')).toBe('hi');
    expect(detectarIdioma('Is my report ready?')).toBe('en');
  });

  it('perguntas de preço/horário NÃO engajam o fluxo (intent existente intacto)', () => {
    expect(ehPerguntaDeLaudo('What is the price of CBC?')).toBe(false);
    expect(ehPerguntaDeLaudo('What time do you open?')).toBe(false);
    expect(ehPerguntaDeLaudo('share your report')).toBe(false);
    expect(ehOutraIntencao('How much is TSH test?')).toBe(true);
    expect(ehOutraIntencao('TSH ka kitna rate?')).toBe(true);
  });

  it('detecção de serviço e resposta de categoria', () => {
    expect(detectarServico('My ultrasound report kab milegi?')).toBe('radiology');
    expect(detectarServico('biopsy report ready?')).toBe('biopsy');
    expect(detectarServico('CBC report ready?')).toBe('pathology');
    expect(detectarServico('Is my report ready?')).toBeNull();
    expect(respostaDeServico('2')).toBe('biopsy');
    expect(respostaDeServico('3.')).toBe('radiology');
    expect(respostaDeServico('Pathology test')).toBe('pathology');
    expect(servicoDaMensagemDeRegistro(['nothing here'])).toBeNull();
    expect(servicoDaMensagemDeRegistro(['Your appointment is confirmed — token 45'])).toBe('pathology');
  });
});

describe('patologia: checagem humana, sem status inventado', () => {
  it('pergunta de laudo com teste de patologia explícito → mensagem para o time + entrega', async () => {
    const t = criar({ texto: 'CBC report ready?' });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r?.engajado).toBe(true);
    expect(t.envios).toEqual([VERIFICAR_EQUIPE]);
    expect(t.handovers).toHaveLength(1);
    expect(t.handovers[0]?.resumo).toContain('checagem manual');
    // A chave de idempotência é a MENSAGEM reivindicada deste turno: é ela que
    // o handoff guarda como recibo (uma linha por tentativa — #2885).
    expect(t.handovers[0]?.chave).toBe('m1');
    expect(t.envios[0]).not.toMatch(/ready|तैयार|taiyar(?! nahi)/i);
    expect(t.banco.ler()?.etapa).toBe('encerrado');
  });

  it('a mensagem de patologia nunca afirma status nem prazo (nenhuma variante de tempo)', () => {
    for (const idioma of ['en', 'hi', 'hinglish'] as const) {
      expect(textosDoFluxo(idioma).verificarPelaEquipe).not.toMatch(/\d+\s*(hour|day|ghante|din|hours|days)/i);
    }
  });

  it('paciente escolhe patologia (1) na categoria → checagem + entrega', async () => {
    const t = criar({ historico: [], texto: 'When will I get my report?' });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.envios[0]).toContain('1) Pathology');

    t.deps.msgId = 'm2';
    t.deps.texto = '1';
    const segunda = await executarFluxoDeProntoAtendimento(t.deps);
    expect(segunda?.engajado).toBe(true);
    expect(t.envios).toEqual([
      variante(LEAD, textosDoFluxo('en').perguntarCategoria),
      VERIFICAR_EQUIPE,
    ]);
    expect(t.handovers).toHaveLength(1);
    expect(t.banco.ler()?.etapa).toBe('encerrado');
  });

  it('registro prévio identifica paciente de patologia → checagem + entrega, sem pergunta de categoria', async () => {
    const t = criar({
      historico: ['Your appointment is confirmed — token 45, CBC test'],
      texto: 'Is my report ready?',
    });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r?.engajado).toBe(true);
    expect(t.envios).toEqual([VERIFICAR_EQUIPE]);
    expect(t.handovers).toHaveLength(1);
    expect(t.envios[0]).not.toMatch(/1\) Pathology/);
  });

  it('sem história → pergunta de categoria e a escolha alimenta a coleta', async () => {
    const t = criar({ historico: [], texto: 'When will I get my report?' });
    const primeira = await executarFluxoDeProntoAtendimento(t.deps);
    expect(primeira?.engajado).toBe(true);
    expect(t.envios[0]).toContain('1) Pathology');
    expect(t.banco.ler()).toMatchObject({ etapa: 'categoria' });

    t.deps.msgId = 'm2';
    t.deps.texto = '2';
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.envios[1]).toBe(textosDoFluxo('en').perguntarBiopsy.nome);
    expect(t.banco.ler()).toMatchObject({ etapa: 'coleta', servico: 'biopsy', pendente: 'nome' });
  });
});

describe('biopsy e radiologia: coleta campo a campo até a entrega', () => {
  it('biopsy: nome → data da cirurgia → médico/hospital, sem repetir campo, e entrega com os campos', async () => {
    // "kab milegi" → hinglish: as perguntas do fluxo saem em hinglish e o
    // idioma fica guardado no estado (turnos seguintes não trocam de idioma).
    const H = textosDoFluxo('hinglish');
    const t = criar({ texto: 'My biopsy report kab milegi?' });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.envios).toEqual([H.perguntarBiopsy.nome]);

    const passos: Array<[string, string]> = [
      ['m2', 'Ravi Kumar'],
      ['m3', '12/03/2024'],
      ['m4', 'Dr. Sen'],
    ];
    for (const [msgId, texto] of passos) {
      t.deps.msgId = msgId;
      t.deps.texto = texto;
      await executarFluxoDeProntoAtendimento(t.deps);
    }
    expect(t.envios).toEqual([
      H.perguntarBiopsy.nome,
      H.perguntarBiopsy.data_cirurgia,
      H.perguntarBiopsy.medico,
      H.detalhesAnotados,
    ]);
    expect(t.handovers).toHaveLength(1);
    // Os campos coletados vão ESTRUTURADOS em `detalhes` — é o que o call
    // site repassa como `camposColetados` do handoff (para a passagem).
    expect(t.handovers[0]?.detalhes).toEqual({
      nome: 'Ravi Kumar',
      data_cirurgia: '12/03/2024',
      medico: 'Dr. Sen',
    });
    // A chave acompanha a mensagem do turno da ENTREGA (m4), não a primeira:
    // é o escopo exato do recibo — retry de m4 não duplica, m5 seria fato novo.
    expect(t.handovers[0]?.chave).toBe('m4');
    expect(t.banco.ler()?.etapa).toBe('encerrado');
  });

  it('radiologia em hinglish: nome → data → exame, e entrega', async () => {
    const t = criar({ texto: 'Report kab milegi?' });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(textosDoFluxo('hinglish').perguntarCategoria).toContain(t.envios[0]);

    const passos: Array<[string, string]> = [
      ['m2', '3'],
      ['m3', 'Ravi'],
      ['m4', '15/04/2024'],
      ['m5', 'Ultrasound abdomen'],
    ];
    for (const [msgId, texto] of passos) {
      t.deps.msgId = msgId;
      t.deps.texto = texto;
      await executarFluxoDeProntoAtendimento(t.deps);
    }
    expect(t.envios).toEqual([
      variante(LEAD, textosDoFluxo('hinglish').perguntarCategoria),
      textosDoFluxo('hinglish').perguntarRadiologia.nome,
      textosDoFluxo('hinglish').perguntarRadiologia.data_exame,
      textosDoFluxo('hinglish').perguntarRadiologia.exame,
      textosDoFluxo('hinglish').detalhesAnotados,
    ]);
    expect(t.handovers).toHaveLength(1);
    expect(t.handovers[0]?.detalhes).toMatchObject({
      exame: 'Ultrasound abdomen',
      data_exame: '15/04/2024',
    });
  });

  it('respostas não úteis x3 na coleta → entrega com o que havia (nunca pergunta para sempre)', async () => {
    // 'ok' é o caso real: saudação/ack curto, rejeitado por `ehPreenchimentoUtil`
    // — não vale como preenchimento e não zera o contador de tentativas.
    const t = criar({
      estadoInicial: {
        v: 1,
        msg: 'm0',
        processando: false,
        etapa: 'coleta',
        idioma: 'en',
        servico: 'biopsy',
        pendente: 'nome',
        detalhes: {},
      },
      texto: 'ok',
    });
    for (const [i, msgId] of ['m1', 'm2', 'm3'].entries()) {
      t.deps.msgId = msgId;
      await executarFluxoDeProntoAtendimento(t.deps);
      if (i < 2) expect(t.handovers).toHaveLength(0);
    }
    expect(t.handovers).toHaveLength(1);
    expect(t.envios.at(-1)).toBe(textosDoFluxo('en').naoEntendi);
    expect(t.banco.ler()?.etapa).toBe('encerrado');
  });
});

describe('idempotência de retry', () => {
  it('mesma mensagem já concluída → nenhuma ação, nenhum envio, nenhuma entrega', async () => {
    const t = criar({ texto: 'CBC report ready?' });
    const primeira = await executarFluxoDeProntoAtendimento(t.deps);
    expect(primeira?.acoes).toBe(2); // envio + entrega

    const segunda = await executarFluxoDeProntoAtendimento(t.deps);
    expect(segunda).toEqual({ engajado: true, acoes: 0 });
    expect(t.envios).toHaveLength(1);
    expect(t.handovers).toHaveLength(1);
  });

  it('turno interrompido (processando: true) reexecuta e completa', async () => {
    const t = criar({
      estadoInicial: {
        v: 1,
        msg: 'm1',
        processando: true,
        etapa: 'categoria',
        idioma: 'en',
      },
      texto: '2',
    });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r?.engajado).toBe(true);
    expect(r?.acoes).toBeGreaterThan(0);
    expect(t.envios[0]).toBe(textosDoFluxo('en').perguntarBiopsy.nome);
    expect(t.banco.ler()).toMatchObject({ etapa: 'coleta', processando: false });
  });
});

describe('intents existentes intactos', () => {
  it('sem estado e mensagem de preço → modelo responde (não engaja)', async () => {
    const t = criar({ texto: 'What is the price of CBC?' });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r).toEqual({ engajado: false, acoes: 0 });
    expect(t.envios).toHaveLength(0);
    expect(t.handovers).toHaveLength(0);
  });

  it('no meio da coleta, mensagem de preço larga o fluxo e devolve ao modelo', async () => {
    const t = criar({
      estadoInicial: {
        v: 1,
        msg: 'm0',
        processando: false,
        etapa: 'coleta',
        idioma: 'en',
        servico: 'biopsy',
        pendente: 'nome',
      },
      texto: 'How much is TSH test?',
    });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r).toEqual({ engajado: false, acoes: 0 });
    expect(t.envios).toHaveLength(0);
    expect(t.banco.ler()).toMatchObject({ etapa: 'encerrado' });
  });
});

describe('ativação (nada muda de produção sem o módulo ligar)', () => {
  it('módulo desligado → null sem UMA consulta no banco', async () => {
    const t = criar({ moduloLigado: false });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r).toBeNull();
    expect(t.banco.query).not.toHaveBeenCalled();
  });

  it('a chave do módulo é lida ANTES de qualquer consulta de estado', () => {
    const fonte = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/report-readiness/workflow.ts'), 'utf8');
    const iGate = fonte.indexOf('if (!(await deps.moduloLigado()))');
    expect(iGate).toBeGreaterThan(0);
    expect(iGate).toBeLessThan(fonte.indexOf('await lerEstado'));
  });
});

describe('segurança dos textos (guardrails do motor)', () => {
  it('nenhum texto dos 3 idiomas passa no detector determinístico de promessa humana', () => {
    for (const idioma of ['en', 'hi', 'hinglish'] as const) {
      const T = textosDoFluxo(idioma);
      const textos = [
        ...T.perguntarCategoria,
        T.verificarPelaEquipe,
        ...Object.values(T.perguntarBiopsy),
        ...Object.values(T.perguntarRadiologia),
        T.detalhesAnotados,
        T.naoEntendi,
      ];
      for (const texto of textos) {
        expect(detectHumanPromise(texto), `${idioma}: ${texto}`).toBe(false);
      }
    }
  });

  it('a entrega para humano NÃO depende do teto de envios do turno (teto 1: envio sai e a entrega também)', async () => {
    const t = criar({ texto: 'CBC report ready?', maxSends: 1 });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r?.engajado).toBe(true);
    expect(t.envios).toEqual([VERIFICAR_EQUIPE]);
    expect(t.handovers).toHaveLength(1);
  });
});

describe('ordem no motor (mesma vigilância do teste de ordem do roteiro)', () => {
  it('o bloco do fluxo entra DEPOIS do gate de opt-out e ANTES do roteiro', () => {
    const fonte = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'), 'utf8');
    const iOptOut = fonte.indexOf('return; // bot silencia: a confirmação já saiu');
    const iFluxo = fonte.indexOf('await executarFluxoDeProntoAtendimento(');
    const iRoteiro = fonte.indexOf('await prepararRoteiroDoTurno(');
    expect(iOptOut).toBeGreaterThan(0);
    expect(iFluxo).toBeGreaterThan(iOptOut);
    expect(iRoteiro).toBeGreaterThan(iFluxo);
  });

  it('o handover do fluxo leva os campos coletados como camposColetados (para a passagem)', () => {
    const fonte = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'), 'utf8');
    const iHandover = fonte.indexOf("reason: 'report_readiness'");
    expect(iHandover).toBeGreaterThan(0);
    expect(fonte.slice(iHandover, iHandover + 600)).toContain('camposColetados: o.detalhes');
  });

  it('a entrega do fluxo declara o desfecho do aviso (gravado, não notificado) e para o digitando', () => {
    const fonte = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'), 'utf8');
    // O handover carrega `avisoAoLead` — a guarda congelada `handoff-avisa-o-lead`
    // casa o identificador no call site; aqui se pinça o VALOR: ele vem do
    // resultado do envio do fluxo, não de um `true` fixo.
    const iHandover = fonte.indexOf("reason: 'report_readiness'");
    expect(iHandover).toBeGreaterThan(0);
    const opcoes = fonte.slice(iHandover, iHandover + 900);
    expect(opcoes).toContain('avisoAoLead:');
    expect(opcoes).toContain('mensagemDoEstadoSaiu === true');
    // O envio do fluxo REGISTRA o desfecho do último envio...
    const iRegistro = fonte.indexOf('mensagemDoEstadoSaiu = saiu;');
    expect(iRegistro).toBeGreaterThan(0);
    // ...e para o "digitando" antes de cada bolha, igual aos outros `send:`
    // do arquivo (a guarda anti-ban congelada cobre o padrão).
    const iFluxo = fonte.indexOf('await executarFluxoDeProntoAtendimento(');
    const iSend = fonte.indexOf('send: (finalBody: string) => {', iFluxo);
    expect(iSend).toBeGreaterThan(iFluxo);
    expect(fonte.slice(iSend, iSend + 120)).toContain('pararDigitando();');
  });
});
