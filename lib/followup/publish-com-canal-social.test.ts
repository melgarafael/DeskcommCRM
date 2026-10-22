/**
 * #3109 — a conta com WhatsApp por QR **e** Instagram/Facebook conectados não
 * conseguia publicar um fluxo que só roda no WhatsApp.
 *
 * O caminho 2 do relato, que é o que este arquivo prova: com o plano B tirado de
 * um passo de IA depois de ≥24 h de espera, o publish recusava com
 * `long_wait_needs_template` — porque `algumCanalExigeModeloForaDaJanela` olhava
 * TODAS as conexões da organização e o canal social fecha a janela de 24 h
 * (`freeformOutsideWindow: false`). Só que esse canal não tem catálogo de modelo
 * aprovado nenhum (`requiresTemplates: false`): não existe aprovado para
 * oferecer, então a exigência não tinha como ser cumprida em configuração
 * nenhuma — nem com plano B (caminho 1, `modelo_inexistente`), nem sem ele.
 *
 * A régua nova conta só conexão que EXIGE modelo fora da janela **e** tem
 * catálogo aprovado para oferecer. O canal social deixa de exigir o plano B para
 * a organização inteira; quem tem catálogo continua exigindo.
 *
 * Dublês puros: nada de banco, nada de stack. As conexões da conta vêm da matriz
 * de `lib/channels/capabilities` — o teste não nomeia provider (invariante 1 da
 * doutrina de restrição de canal), ele lê capacidades.
 */
import { describe, it, expect } from 'vitest';
import { algumCanalExigeModeloForaDaJanela, validateFlowForPublish } from './validate-publish';
import {
  CHANNEL_CAPABILITIES,
  PROVIDERS_DE_MENSAGEM,
  capabilitiesOf,
  transportaMensagem,
  type ChannelProvider,
} from '../channels/capabilities';
import type { TriggerConfig } from './api-schemas';
import type { FlowEdge, FlowGraph, FlowNode } from './graph-schema';

const pos = { x: 0, y: 0 };
const TEMPLATE_ID = '00000000-0000-4000-8000-000000000000';

function trigger(id: string): FlowNode {
  return { id, type: 'trigger', label: id, position: pos, config: {} };
}
function wait24h(id: string): FlowNode {
  return { id, type: 'wait', label: id, position: pos, config: { mode: 'fixed', duration_ms: 86_400_000 } };
}
function iaSemPlanoB(id: string): FlowNode {
  return {
    id,
    type: 'action',
    label: id,
    position: pos,
    config: { mode: 'ai_message', prompt_hint: 'retome a conversa' },
  };
}
function iaComPlanoB(id: string, fallback: string): FlowNode {
  return {
    id,
    type: 'action',
    label: id,
    position: pos,
    config: { mode: 'ai_message', prompt_hint: 'retome a conversa', fallback_template_id: fallback },
  };
}
function end(id: string): FlowNode {
  return { id, type: 'end', label: id, position: pos, config: { outcome: 'exhausted' } };
}

let seq = 0;
function edge(source: string, target: string): FlowEdge {
  seq++;
  return { id: `e${seq}`, source, target, priority: 0, condition: { type: 'always' } };
}
function graph(nodes: FlowNode[]): FlowGraph {
  return { nodes, edges: nodes.slice(0, -1).map((n, i) => edge(n.id, nodes[i + 1]!.id)) };
}

/**
 * O grafo do relato: dois passos de IA, cada um alcançado por 24 h de espera —
 * "mensagens por IA após esperas de 24 h ou mais". Sem plano B nos dois.
 */
function fluxoDoRelato(): FlowGraph {
  return graph([trigger('t'), wait24h('w1'), iaSemPlanoB('a1'), wait24h('w2'), iaSemPlanoB('a2'), end('e')]);
}

/**
 * A régua que estava na `main` quando a issue foi aberta, copiada aqui de
 * propósito: é com ELA que este arquivo declara o ANTES, medido. A sabotagem
 * devolve exatamente esta expressão ao arquivo de produção — se este espelho
 * divergir da função de produção, o teste para de provar o que diz provar.
 */
const regraAntiga = (providers: readonly (string | null)[]): boolean =>
  providers.some((p) => transportaMensagem(p) && !capabilitiesOf(p as ChannelProvider).freeformOutsideWindow);

/** Conexões da conta, lidas da matriz — sem nomear provider em lugar nenhum. */
const CANAIS_SEM_JANELA = PROVIDERS_DE_MENSAGEM.filter((p) => CHANNEL_CAPABILITIES[p].freeformOutsideWindow);
/** O canal que EXIGE modelo: fecha a janela E tem catálogo aprovado para oferecer. */
const CANAIS_QUE_EXIGEM_MODELO = PROVIDERS_DE_MENSAGEM.filter(
  (p) => !CHANNEL_CAPABILITIES[p].freeformOutsideWindow && CHANNEL_CAPABILITIES[p].requiresTemplates,
);
/** O caso da issue: fecha a janela e NÃO tem catálogo aprovado (Instagram/Facebook). */
const CANAIS_SEM_CATALOGO = PROVIDERS_DE_MENSAGEM.filter(
  (p) => !CHANNEL_CAPABILITIES[p].freeformOutsideWindow && !CHANNEL_CAPABILITIES[p].requiresTemplates,
);

/** A conta do relato: WhatsApp por QR (sem janela) + o social (janela sem catálogo). */
const CONTA_DO_RELATO: readonly (string | null)[] = [...CANAIS_SEM_JANELA, ...CANAIS_SEM_CATALOGO];

function codigos(r: ReturnType<typeof validateFlowForPublish>): string[] {
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe('#3109 — publish numa conta de WhatsApp por QR + canal social (janela, sem modelo aprovado)', () => {
  it('a régua nova não conta o canal que fecha a janela sem ter catálogo aprovado', () => {
    // Guarda de forma: sem estes dois lados a matriz deixaria de ter os casos que
    // esta issue mediu, e o teste passaria a não provar nada sobre o cenário real.
    expect(CANAIS_SEM_CATALOGO.length).toBeGreaterThan(0);
    expect(CANAIS_QUE_EXIGEM_MODELO.length).toBeGreaterThan(0);
    expect(algumCanalExigeModeloForaDaJanela(CONTA_DO_RELATO)).toBe(false);
    // Controle no sentido oposto: com canal que tem janela E catálogo, exige.
    expect(algumCanalExigeModeloForaDaJanela([...CANAIS_SEM_JANELA, ...CANAIS_QUE_EXIGEM_MODELO])).toBe(true);
  });

  it('ANTES: o fluxo do relato recusava com long_wait_needs_template nos dois passos de IA', () => {
    const antes = validateFlowForPublish(fluxoDoRelato(), {
      exigeModeloForaDaJanela: regraAntiga(CONTA_DO_RELATO),
    });
    expect(antes.ok).toBe(false);
    if (!antes.ok) {
      expect(antes.errors.map((e) => e.code)).toEqual([
        'long_wait_needs_template',
        'long_wait_needs_template',
      ]);
      expect(antes.errors.map((e) => e.node_id)).toEqual(['a1', 'a2']);
    }
  });

  it('DEPOIS: o fluxo do relato publica, com o plano B fora', () => {
    const depois = validateFlowForPublish(fluxoDoRelato(), {
      exigeModeloForaDaJanela: algumCanalExigeModeloForaDaJanela(CONTA_DO_RELATO),
    });
    expect(codigos(depois)).toEqual([]);
    expect(depois.ok).toBe(true);
  });

  it('CONTROLE: conexão com janela E catálogo aprovado continua exigindo o plano B', () => {
    const r = validateFlowForPublish(fluxoDoRelato(), {
      exigeModeloForaDaJanela: algumCanalExigeModeloForaDaJanela([
        ...CANAIS_SEM_JANELA,
        ...CANAIS_QUE_EXIGEM_MODELO,
      ]),
    });
    expect(codigos(r)).toEqual(['long_wait_needs_template', 'long_wait_needs_template']);
  });

  it('CONTROLE: canal com janela e SEM modelo aprovado não exige plano B — e não se inventa aprovado nenhum', () => {
    // Sem catálogo não há o que escolher: a lista do seletor é vazia de verdade
    // (`modelosQueOFluxoEnvia` só devolve `meta_templates` que disparam). Exigir o
    // plano B aqui seria exigir um modelo que a conta não tem como oferecer.
    for (const p of CANAIS_SEM_CATALOGO) {
      expect(algumCanalExigeModeloForaDaJanela([p])).toBe(false);
      expect(algumCanalExigeModeloForaDaJanela([...CANAIS_SEM_JANELA, p])).toBe(false);
    }
  });

  it('o caminho 1 do relato segue recusado: plano B que não é modelo aprovado do canal', () => {
    // O que a issue manteve no passo de IA foi um TEXTO PRONTO
    // (`message_templates`) como plano B. Ele existe na conta, mas não é modelo
    // aprovado de canal — e o motor só procura o plano B em `meta_templates`.
    // Mantido recusado de propósito: é referência morta, e é a recusa que diz
    // isso em vez de publicar um plano B que nunca sairia. A saída é tirar o
    // plano B, e AÍ o publish passa (caso DEPOIS, acima).
    const doRelato = graph([trigger('t'), wait24h('w1'), iaComPlanoB('a1', TEMPLATE_ID), end('e')]);
    const r = validateFlowForPublish(doRelato, {
      exigeModeloForaDaJanela: algumCanalExigeModeloForaDaJanela(CONTA_DO_RELATO),
      modelos: { prontos: new Set([TEMPLATE_ID]), doCanal: new Set() },
    });
    expect(codigos(r)).toEqual(['modelo_inexistente']);
    // Nenhuma conexão da conta exige plano B: não há exigência a cobrar por cima.
    expect(codigos(r)).not.toContain('long_wait_needs_template');
  });

  it('o contorno do relato (trigger_config pelo PATCH) não destrava o publish', () => {
    // O gatilho não entra em nenhuma recusa — só nos avisos. Gravar as opções
    // novas pelo PATCH muda o que a varredura lê, e não o que o publish exige.
    const gatilhoDoRelato: TriggerConfig = {
      kind: 'silence',
      params: {
        threshold_minutes: 60,
        exige_resposta_da_equipe: true,
        max_enrollments_por_contato: 3,
      },
      cancel_on_reply: true,
    };
    const comGatilho = validateFlowForPublish(fluxoDoRelato(), {
      exigeModeloForaDaJanela: regraAntiga(CONTA_DO_RELATO),
      trigger: gatilhoDoRelato,
    });
    expect(codigos(comGatilho)).toEqual(['long_wait_needs_template', 'long_wait_needs_template']);
    const comGatilhoEReguaNova = validateFlowForPublish(fluxoDoRelato(), {
      exigeModeloForaDaJanela: algumCanalExigeModeloForaDaJanela(CONTA_DO_RELATO),
      trigger: gatilhoDoRelato,
    });
    expect(comGatilhoEReguaNova.ok).toBe(true);
  });
});
