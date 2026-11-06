import { describe, it, expect } from 'vitest';
import { algumCanalExigeModeloForaDaJanela, CONTA_NO_TETO, custoNoMotorDoFluxo, validateFlowForPublish } from './validate-publish';
import { CUSTO_NO_MOTOR, TETO_DE_PASSOS_DO_MOTOR } from './custo-no-motor';
import { idsDeEtapaCitados } from './etapas-citadas';
import { flowGraphSchema, NODE_TYPES, type FlowGraph, type FlowNode, type FlowEdge } from './graph-schema';
import { CHANNEL_CAPABILITIES, PROVIDERS_DE_MENSAGEM, PROVIDERS_SEM_MENSAGEM } from '../channels/capabilities';

const pos = { x: 0, y: 0 };
const TEMPLATE_ID = '00000000-0000-4000-8000-000000000000';

function trigger(id: string): FlowNode {
  return { id, type: 'trigger', label: id, position: pos, config: {} };
}
function wait(id: string, config: Extract<FlowNode, { type: 'wait' }>['config']): FlowNode {
  return { id, type: 'wait', label: id, position: pos, config };
}
function condition(id: string): FlowNode {
  return {
    id,
    type: 'condition',
    label: id,
    position: pos,
    config: { combinator: 'and', checks: [{ field: 'steps_taken', op: 'gte', value: 0 }] },
  };
}
function classify(id: string, classes: string[], graceMs = 900_000): FlowNode {
  return {
    id,
    type: 'ai_classify',
    label: id,
    position: pos,
    config: { classes, grace_timeout_ms: graceMs, target: 'last_reply' },
  };
}
function actionTemplate(id: string, templateId = TEMPLATE_ID): FlowNode {
  return { id, type: 'action', label: id, position: pos, config: { mode: 'template', template_id: templateId } };
}
function actionAiMessage(id: string, opts: { fallback?: string } = {}): FlowNode {
  return {
    id,
    type: 'action',
    label: id,
    position: pos,
    config: { mode: 'ai_message', prompt_hint: 'hint', fallback_template_id: opts.fallback },
  };
}
function end(id: string, outcome: 'converted' | 'exhausted' | 'custom' = 'exhausted'): FlowNode {
  return { id, type: 'end', label: id, position: pos, config: { outcome } };
}

let edgeSeq = 0;
function edge(source: string, target: string, condition: FlowEdge['condition']): FlowEdge {
  edgeSeq++;
  return { id: `e${edgeSeq}`, source, target, priority: 0, condition };
}
const always = (): FlowEdge['condition'] => ({ type: 'always' });
const classMatch = (value: string): FlowEdge['condition'] => ({ type: 'class_match', value });
const condResult = (value: boolean): FlowEdge['condition'] => ({ type: 'cond_result', value });

function graph(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  return { nodes, edges };
}

describe('validateFlowForPublish', () => {
  it('flags no_trigger when there is no trigger node', () => {
    const g = graph(
      [wait('w1', { mode: 'fixed', duration_ms: 300_000 }), end('e1')],
      [edge('w1', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['no_trigger']);
      expect(result.errors[0]!.node_id).toBeNull();
    }
  });

  it('flags multiple_triggers for every trigger beyond the first', () => {
    const g = graph(
      [trigger('t1'), trigger('t2'), end('e1')],
      [edge('t1', 't2', always()), edge('t2', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['multiple_triggers']);
      expect(result.errors[0]!.node_id).toBe('t2');
    }
  });

  it('flags unreachable_node for nodes not reachable from the trigger', () => {
    const g = graph([trigger('t1'), end('e1'), end('orphan')], [edge('t1', 'e1', always())]);
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['unreachable_node']);
      expect(result.errors[0]!.node_id).toBe('orphan');
    }
  });

  it('flags no_end_path for reachable nodes that cannot reach an end', () => {
    const g = graph(
      [trigger('t1'), end('e1'), actionTemplate('deadend')],
      [edge('t1', 'e1', always()), edge('t1', 'deadend', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['no_end_path']);
      expect(result.errors[0]!.node_id).toBe('deadend');
    }
  });

  it('flags missing_class_edge when a declared class has no outgoing edge', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot', 'cold']), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'e1', classMatch('hot')),
        edge('c1', 'e1', classMatch('no_reply')),
        edge('c1', 'e1', always()),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['missing_class_edge']);
      expect(result.errors[0]!.node_id).toBe('c1');
    }
  });

  it('flags missing_no_reply_edge when there is no class_match "no_reply" edge', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot']), end('e1')],
      [edge('t1', 'c1', always()), edge('c1', 'e1', classMatch('hot')), edge('c1', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['missing_no_reply_edge']);
    }
  });

  it('flags missing_always_fallback when there is no always edge', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot']), end('e1')],
      [edge('t1', 'c1', always()), edge('c1', 'e1', classMatch('hot')), edge('c1', 'e1', classMatch('no_reply'))]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['missing_always_fallback']);
    }
  });

  it('flags grace_too_short when grace_timeout_ms is below the 15min floor', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot'], 500_000), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'e1', classMatch('hot')),
        edge('c1', 'e1', classMatch('no_reply')),
        edge('c1', 'e1', always()),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['grace_too_short']);
    }
  });

  it('flags long_wait_needs_template when accumulated wait reaches 24h before an ai_message action without fallback', () => {
    const g = graph(
      [trigger('t1'), wait('w1', { mode: 'fixed', duration_ms: 86_400_000 }), actionAiMessage('a1'), end('e1')],
      [edge('t1', 'w1', always()), edge('w1', 'a1', always()), edge('a1', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['long_wait_needs_template']);
      expect(result.errors[0]!.node_id).toBe('a1');
    }
  });

  it('does not flag long_wait_needs_template when a fallback_template_id is set', () => {
    const g = graph(
      [
        trigger('t1'),
        wait('w1', { mode: 'fixed', duration_ms: 86_400_000 }),
        actionAiMessage('a1', { fallback: TEMPLATE_ID }),
        end('e1'),
      ],
      [edge('t1', 'w1', always()), edge('w1', 'a1', always()), edge('a1', 'e1', always())]
    );
    expect(validateFlowForPublish(g).ok).toBe(true);
  });

  // Revisão do #1729: o plano B só sai com a janela de 24 h fechada, e o seletor
  // dele só oferece modelo aprovado. Numa organização cujos canais não têm janela,
  // exigi-lo travava o publish de "espera 1 dia -> IA escreve".
  it('does not flag long_wait_needs_template when no channel of the org has a 24h window', () => {
    const g = graph(
      [trigger('t1'), wait('w1', { mode: 'fixed', duration_ms: 90_000_000 }), actionAiMessage('a1'), end('e1')],
      [edge('t1', 'w1', always()), edge('w1', 'a1', always()), edge('a1', 'e1', always())]
    );
    expect(validateFlowForPublish(g, { exigeModeloForaDaJanela: false }).ok).toBe(true);
    const comJanela = validateFlowForPublish(g, { exigeModeloForaDaJanela: true });
    expect(comJanela.ok).toBe(false);
    if (!comJanela.ok) expect(comJanela.errors.map((e) => e.code)).toEqual(['long_wait_needs_template']);
  });

  it('algumCanalExigeModeloForaDaJanela: só conta canal que EXIGE modelo e tem catálogo aprovado', () => {
    // Pela matriz de capabilities, sem nomear provider (invariante 1 da restrição de canal).
    const semJanela = PROVIDERS_DE_MENSAGEM.filter((p) => CHANNEL_CAPABILITIES[p].freeformOutsideWindow);
    // Exigir o plano B só faz sentido em canal que fecha a janela E tem
    // DEFINIÇÕES aprovadas para oferecer (#3109): o canal social de
    // Instagram/Facebook fecha a janela e não tem catálogo nenhum, então exigir
    // por causa dele reprovava o publish da organização inteira sem oferecer saída.
    const exigeModelo = PROVIDERS_DE_MENSAGEM.filter(
      (p) => !CHANNEL_CAPABILITIES[p].freeformOutsideWindow && CHANNEL_CAPABILITIES[p].requiresTemplates,
    );
    const fechaSemCatalogo = PROVIDERS_DE_MENSAGEM.filter(
      (p) => !CHANNEL_CAPABILITIES[p].freeformOutsideWindow && !CHANNEL_CAPABILITIES[p].requiresTemplates,
    );
    expect(semJanela.length).toBeGreaterThan(0);
    expect(exigeModelo.length).toBeGreaterThan(0);
    // A matriz tem de continuar tendo o caso que a issue mediu; sem ele este
    // teste deixaria de cobrir a existência do canal que fecha a janela sem modelo.
    expect(fechaSemCatalogo.length).toBeGreaterThan(0);
    expect(algumCanalExigeModeloForaDaJanela([])).toBe(false);
    expect(algumCanalExigeModeloForaDaJanela(semJanela)).toBe(false);
    expect(algumCanalExigeModeloForaDaJanela(fechaSemCatalogo)).toBe(false);
    for (const p of exigeModelo) expect(algumCanalExigeModeloForaDaJanela([...semJanela, p])).toBe(true);
    expect(algumCanalExigeModeloForaDaJanela([...PROVIDERS_SEM_MENSAGEM, 'provider_do_futuro', null])).toBe(false);
  });

  it('flags cycle_without_wait for a cycle containing no sufficient wait node', () => {
    const g = graph(
      [trigger('t1'), condition('c1'), condition('c2'), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'c2', condResult(true)),
        edge('c2', 'c1', condResult(true)),
        edge('c1', 'e1', condResult(false)),
        edge('c2', 'e1', condResult(false)),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['cycle_without_wait']);
    }
  });

  it('does not flag cycle_without_wait when the cycle contains a sufficient wait node', () => {
    const g = graph(
      [trigger('t1'), condition('c1'), wait('w1', { mode: 'fixed', duration_ms: 300_000 }), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'w1', condResult(true)),
        edge('w1', 'c1', always()),
        edge('c1', 'e1', condResult(false)),
      ]
    );
    expect(validateFlowForPublish(g).ok).toBe(true);
  });

  // A regression fixture for the SCC-based cycle_without_wait check: A and B
  // form a cycle with no wait in it; C is a *separate* cycle with A that DOES
  // have a sufficient wait. A naive "does the whole component contain a wait"
  // check would merge A/B/C into one component (since C links back into A)
  // and wrongly conclude the component is safe. Removing sufficient-wait
  // nodes before computing SCCs (the actual algorithm) keeps A<->B a cycle on
  // its own and correctly flags it.
  it('flags cycle_without_wait when a wait-free cycle shares a node with a wait-guarded one', () => {
    const g = graph(
      [trigger('t1'), condition('A'), condition('B'), wait('C', { mode: 'fixed', duration_ms: 300_000 }), end('end1')],
      [
        edge('t1', 'A', always()),
        edge('A', 'B', condResult(true)),
        edge('B', 'A', condResult(true)),
        edge('A', 'C', condResult(false)),
        edge('C', 'A', always()),
        edge('B', 'end1', condResult(false)),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['cycle_without_wait']);
    }
  });

  it('does not flag max_steps_exceeded for 28 waits (30 boxes) — the wait counts, the trigger and the end do not', () => {
    const waitNodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    let prev = 't1';
    for (let i = 1; i <= 28; i++) {
      const id = `w${i}`;
      waitNodes.push(wait(id, { mode: 'fixed', duration_ms: 300_000 }));
      edges.push(edge(prev, id, always()));
      prev = id;
    }
    edges.push(edge(prev, 'e1', always()));
    const g = graph([trigger('t1'), ...waitNodes, end('e1')], edges); // 30 boxes, 28 counted steps
    expect(validateFlowForPublish(g).ok).toBe(true);
  });

  it('also publishes 29 waits (31 boxes): the trigger and the end stopped being a step the client feels (#2896)', () => {
    // Este fixture ERA o limite, e a troca é o conserto: 31 caixas + gatilho +
    // fim davam 31 passos e reprovavam, embora só as esperas cheguem ao cliente.
    // Hoje quem conta é o que ele sente (as 29 esperas), e o teto continua
    // valendo para elas — ver o caso de 31 passos contados abaixo.
    const waitNodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    let prev = 't1';
    for (let i = 1; i <= 29; i++) {
      const id = `w${i}`;
      waitNodes.push(wait(id, { mode: 'fixed', duration_ms: 300_000 }));
      edges.push(edge(prev, id, always()));
      prev = id;
    }
    edges.push(edge(prev, 'e1', always()));
    const g = graph([trigger('t1'), ...waitNodes, end('e1')], edges);
    expect(validateFlowForPublish(g).ok).toBe(true);
  });

  /**
   * #2896 — o teto de passos conta o que o CLIENTE sente.
   *
   * A régua antiga dava o mesmo peso a TODO nó do caminho: o gatilho, a condição
   * que decide, a tag gravada, o mover no funil e o fim valiam uma mensagem
   * cada. Com isso a retomada de 7 toques que o reporter montou — 32 caixas em
   * que só 14 chegam ao cliente — era recusada, e a única saída era cortar
   * toque. Os dois lados da troca estão abaixo: o fluxo dele publica, e a
   * cadência que ABUSA de mensagem continua reprovada.
   */
  describe('o teto conta o que o cliente sente (#2896)', () => {
    const codigos = (r: ReturnType<typeof validateFlowForPublish>) => (r.ok ? [] : r.errors.map((e) => e.code));
    const marcar = (id: string, tags: string[]): FlowNode => ({
      id,
      type: 'edit_lead_tag',
      label: id,
      position: pos,
      config: { tags },
    });

    /** `n` mensagens em linha: o caminho mais longo conta exatamente `n` passos. */
    function mensagens(n: number): FlowGraph {
      const nodes: FlowNode[] = [trigger('t1')];
      const edges: FlowEdge[] = [];
      let anterior = 't1';
      for (let i = 1; i <= n; i++) {
        const id = `a${i}`;
        nodes.push(actionTemplate(id));
        edges.push(edge(anterior, id, always()));
        anterior = id;
      }
      nodes.push(end('fim'));
      edges.push(edge(anterior, 'fim', always()));
      return graph(nodes, edges);
    }

    it('publica com 30 passos contados, e reprova no 31º — o teto continua sendo 30', () => {
      expect(validateFlowForPublish(mensagens(30))).toEqual({ ok: true });

      const r = validateFlowForPublish(mensagens(31));
      expect(codigos(r)).toEqual(['max_steps_exceeded']);
      if (r.ok) return;
      expect(r.errors[0]!.message).toMatch(/30 passos que o cliente sente/);
    });

    it('a espera pesa igual à mensagem: 16 toques com espera (32 passos) reprovam', () => {
      const nodes: FlowNode[] = [trigger('t1')];
      const edges: FlowEdge[] = [];
      let anterior = 't1';
      for (let toque = 1; toque <= 16; toque++) {
        nodes.push(actionTemplate(`a${toque}`), wait(`w${toque}`, { mode: 'fixed', duration_ms: 300_000 }));
        edges.push(edge(anterior, `a${toque}`, always()), edge(`a${toque}`, `w${toque}`, always()));
        anterior = `w${toque}`;
      }
      nodes.push(end('fim'));
      edges.push(edge(anterior, 'fim', always()));

      expect(codigos(validateFlowForPublish(graph(nodes, edges)))).toEqual(['max_steps_exceeded']);
    });

    /**
     * O fluxo do reporter, caixa por caixa: gatilho, filtro de entrada, 7 ×
     * (mensagem + condição por etapa com uma saída por regra + tag), 7 esperas,
     * mover para Perdido e fim — 32 caixas, 14 passos que o cliente sente (as
     * caixas internas e as arestas das regras não contam). Era esta a
     * publicação que o publish recusava.
     */
    it('publica a retomada de 7 toques com registro por toque (32 caixas, 14 passos)', () => {
      const QUALIFICADO = 'bbbbbbbb-2222-4222-8222-222222222222';
      const NEGOCIACAO = 'cccccccc-3333-4333-8333-333333333333';
      const PERDIDO = 'aaaaaaaa-1111-4111-8111-111111111111';
      const etapa = (nome: string, isPerda = false) => ({
        nome,
        arquivada: false,
        isPerda,
        settingsDoFunil: isPerda ? { lost_reasons: ['Sem orçamento'] } : null,
      });
      const etapas = new Map([
        [QUALIFICADO, etapa('Qualificado · Vendas')],
        [NEGOCIACAO, etapa('Negociação · Vendas')],
        [PERDIDO, etapa('Perdido · Vendas', true)],
      ]);
      /** A condição de cada toque: uma saída por regra, como o reporter montou. */
      const confereEtapa = (id: string): FlowNode => ({
        id,
        type: 'condition',
        label: id,
        position: pos,
        config: {
          combinator: 'and',
          branching: 'per_check',
          checks: [
            { id: 'qualificado', label: 'Qualificado', field: 'lead_stage', op: 'eq', value: QUALIFICADO },
            { id: 'negociacao', label: 'Negociação', field: 'lead_stage', op: 'eq', value: NEGOCIACAO },
          ],
        },
      });
      const branch = (branchId: string): FlowEdge['condition'] => ({ type: 'branch', branch_id: branchId });

      const nodes: FlowNode[] = [trigger('t1'), condition('filtro')];
      const edges: FlowEdge[] = [edge('t1', 'filtro', always())];
      let anterior = 'filtro';
      for (let toque = 1; toque <= 7; toque++) {
        nodes.push(
          actionTemplate(`msg${toque}`),
          wait(`espera${toque}`, { mode: 'fixed', duration_ms: 300_000 }),
          confereEtapa(`confere${toque}`),
          marcar(`marca${toque}`, [`toque-${toque}`]),
        );
        edges.push(
          edge(anterior, `msg${toque}`, always()),
          edge(`msg${toque}`, `espera${toque}`, always()),
          edge(`espera${toque}`, `confere${toque}`, always()),
          edge(`confere${toque}`, `marca${toque}`, branch('qualificado')),
          edge(`confere${toque}`, `marca${toque}`, branch('negociacao')),
          edge(`confere${toque}`, `marca${toque}`, always()),
        );
        anterior = `marca${toque}`;
      }
      nodes.push(
        { id: 'mover', type: 'move_lead', label: 'Mover', position: pos, config: { stage_id: PERDIDO, lost_reason: 'no_response' } },
        end('fim'),
      );
      edges.push(edge(anterior, 'mover', always()), edge('mover', 'fim', always()));

      expect(nodes.length).toBe(32);
      expect(validateFlowForPublish(graph(nodes, edges), { etapas })).toEqual({ ok: true });
    });

    /**
     * A régua é COMPLETA: cada tipo de nó diz se conta. Um tipo novo quebra o
     * typecheck (`Record<NodeType, boolean>`) e este teste, em vez de cair fora
     * da conta calado — que é como o teto passou a mentir.
     */
    it('classifica todo tipo de nó: contam mensagem, pergunta, skill e o que faz esperar', () => {
      expect(Object.keys(CONTA_NO_TETO).sort()).toEqual([...NODE_TYPES].sort());
      expect(NODE_TYPES.filter((tipo) => CONTA_NO_TETO[tipo])).toEqual([
        'wait',
        'ai_classify',
        'match_reply',
        'collect',
        'skill',
        'action',
      ]);
    });
  });

  /**
   * #2965 — o SEGUNDO teto: o do MOTOR.
   *
   * O teto de passos do publish conta o que o cliente SENTE (`CONTA_NO_TETO`).
   * O relógio conta TICKS (`steps_taken`, `MAX_STEPS`) e mata a inscrição quando
   * começa um tick acima do teto. Até aqui ninguém cruzava as duas pontas: um
   * fluxo passava nos 30 passos sentidos, publicava, e morria no meio no motor —
   * sem gravar as últimas caixas nem chegar ao fim (medido pelo mantenedor).
   *
   * Estes casos cruzam o VALIDADOR com o CUSTO no motor: o mesmo grafo passa
   * pelas duas réguas e o veredito da publicação tem de bater com o que o motor
   * consegue terminar.
   */
  describe('o motor também tem teto (#2965)', () => {
    const codigos = (r: ReturnType<typeof validateFlowForPublish>) => (r.ok ? [] : r.errors.map((e) => e.code));
    const ramo = (branchId: string): FlowEdge['condition'] => ({ type: 'branch', branch_id: branchId });
    const marcar = (id: string, valor: string): FlowNode => ({
      id,
      type: 'edit_lead_tag',
      label: id,
      position: pos,
      config: { tags: [valor] },
    });

    /**
     * O fluxo medido pelo mantenedor, caixa por caixa: `n` toques, cada um
     * mensagem → tag → tag → espera, entre o gatilho e o fim. Ele somou 14 toques
     * e 85 ticks — sem o `fim`, porque o motor morre antes de chegar lá; com o
     * `fim` (que também gasta o seu tick) são 86, e os dois passam de 80.
     */
    function toques(n: number): FlowGraph {
      const nodes: FlowNode[] = [trigger('t1')];
      const edges: FlowEdge[] = [];
      let anterior = 't1';
      for (let i = 1; i <= n; i++) {
        nodes.push(
          actionTemplate(`msg${i}`),
          marcar(`tag${i}a`, `a${i}`),
          marcar(`tag${i}b`, `b${i}`),
          wait(`espera${i}`, { mode: 'fixed', duration_ms: 300_000 })
        );
        edges.push(
          edge(anterior, `msg${i}`, always()),
          edge(`msg${i}`, `tag${i}a`, always()),
          edge(`tag${i}a`, `tag${i}b`, always()),
          edge(`tag${i}b`, `espera${i}`, always())
        );
        anterior = `espera${i}`;
      }
      nodes.push(end('fim'));
      edges.push(edge(anterior, 'fim', always()));
      return graph(nodes, edges);
    }

    it('diz quanto cada tipo de nó custa em ticks — a régua é completa', () => {
      expect(Object.keys(CUSTO_NO_MOTOR).sort()).toEqual([...NODE_TYPES].sort());
      // Fatos das invariantes que o CI já roda (tests/invariants/followup-engine.test.ts):
      expect(CUSTO_NO_MOTOR.trigger).toBe(1); // :344 — gatilho → fim leva 2 ticks
      expect(CUSTO_NO_MOTOR.wait).toBe(2); // :376 — arma num tick, vence e avança no outro
      expect(CUSTO_NO_MOTOR.end).toBe(1);
      // A mensagem custa 2: o motor ENFILEIRA (engine.ts) e a ponte CONCLUI (turn-bridge.ts).
      expect(CUSTO_NO_MOTOR.action).toBe(2);
      // Caixa interna é passagem: um tick cada (node-handlers.ts).
      expect(CUSTO_NO_MOTOR.condition).toBe(1);
      expect(CUSTO_NO_MOTOR.edit_lead_tag).toBe(1);
      expect(CUSTO_NO_MOTOR.move_lead).toBe(1);
    });

    it('recusa a retomada de 14 toques: 86 ticks no motor, com só 28 passos sentidos', () => {
      const g = toques(14);
      // 1 gatilho + 14 × (mensagem 2 + tag 1 + tag 1 + espera 2) + 1 fim = 86.
      expect(custoNoMotorDoFluxo(g).total).toBe(86);
      expect(custoNoMotorDoFluxo(g).total).toBeGreaterThan(TETO_DE_PASSOS_DO_MOTOR);

      // O teto dos passos SENTIDOS (30) sozinho NÃO pega este fluxo — 28 é o que
      // o cliente sente —, e era por isso que ele publicava e morria no motor.
      expect(codigos(validateFlowForPublish(g))).toEqual(['max_engine_steps_exceeded']);
    });

    it('publica 13 toques, que cabem no orçamento do motor (80 ticks)', () => {
      const g = toques(13);
      // 1 + 13 × 6 + 1 = 80 — exatamente o teto do motor.
      expect(custoNoMotorDoFluxo(g).total).toBe(80);
      expect(custoNoMotorDoFluxo(g).total).toBeLessThanOrEqual(TETO_DE_PASSOS_DO_MOTOR);
      expect(validateFlowForPublish(g)).toEqual({ ok: true });
    });

    it('não julga o roteiro de atendimento — quem o conduz é o motor do turno', () => {
      const g = graph([trigger('t1'), end('fim')], [edge('t1', 'fim', always())]);
      expect(validateFlowForPublish(g, { surface: 'atendimento' })).toEqual({ ok: true });
    });

    /**
     * #2977 — o ciclo do `repeat` no teto do motor.
     *
     * A régua do #2965 parava na primeira aresta que entra num ciclo: nada que só
     * se alcança DEPOIS do ciclo era somado, e o `repeat` — que dá até 20 voltas
     * (`repeatConfigSchema`, `graph-schema.ts`) — não era multiplicado por nada.
     * O grafo do gatilho da issue publicava e morria no motor com
     * `cancel_reason = 'max_steps'`.
     */
    describe('o ciclo do repeat entra no teto do motor (#2977)', () => {
      /**
       * O grafo do gatilho da issue: `trigger → repeat(max_count) → [mensagem →
       * espera] → repeat → fim`, com `done` e `always` do repeat indo para o fim.
       */
      function repeatComVoltas(maxCount: number): FlowGraph {
        return graph(
          [
            trigger('t1'),
            { id: 'r1', type: 'repeat', label: 'r1', position: pos, config: { max_count: maxCount } },
            actionTemplate('msg1'),
            wait('w1', { mode: 'fixed', duration_ms: 300_000 }),
            end('fim'),
          ],
          [
            edge('t1', 'r1', always()),
            edge('r1', 'msg1', ramo('body')),
            edge('msg1', 'w1', always()),
            edge('w1', 'r1', always()),
            edge('r1', 'fim', ramo('done')),
            edge('r1', 'fim', always()),
          ]
        );
      }

      /**
       * O caso do mantenedor na issue: o `repeat` de UMA volta e a cauda linear de
       * `n` toques (a do caso do #2965) pendurada na saída `done`. São `n` toques,
       * não 14: com o ciclo a mais, 14 toques passariam do teto de 60 nós do
       * `flowGraphSchema` — e o ponto medido é o mesmo.
       */
      function repeatComCauda(n: number): FlowGraph {
        const nodes: FlowNode[] = [
          trigger('t1'),
          { id: 'r1', type: 'repeat', label: 'r1', position: pos, config: { max_count: 1 } },
          actionTemplate('msg1'),
          wait('w1', { mode: 'fixed', duration_ms: 300_000 }),
        ];
        const edges: FlowEdge[] = [
          edge('t1', 'r1', always()),
          edge('r1', 'msg1', ramo('body')),
          edge('msg1', 'w1', always()),
          edge('w1', 'r1', always()),
        ];
        let anterior = 'r1'; // o `done` do repeat é a porta da cauda
        for (let i = 1; i <= n; i++) {
          nodes.push(
            actionTemplate(`cauda${i}`),
            marcar(`tag${i}a`, `a${i}`),
            marcar(`tag${i}b`, `b${i}`),
            wait(`espera${i}`, { mode: 'fixed', duration_ms: 300_000 })
          );
          edges.push(
            edge(anterior, `cauda${i}`, i === 1 ? ramo('done') : always()),
            edge(`cauda${i}`, `tag${i}a`, always()),
            edge(`tag${i}a`, `tag${i}b`, always()),
            edge(`tag${i}b`, `espera${i}`, always())
          );
          anterior = `espera${i}`;
        }
        nodes.push(end('fim'));
        edges.push(edge(anterior, 'fim', always()), edge('r1', 'fim', always()));
        return graph(nodes, edges);
      }

      it('recusa o repeat de 20 voltas: 103 ticks no motor, e publicava antes', () => {
        const g = repeatComVoltas(20);
        expect(flowGraphSchema.safeParse(g).success).toBe(true);

        // 1 gatilho + 21 passadas pelo repeat (20 voltas + a que pega `done`)
        // + 20 × (mensagem 2 + espera 2) + 1 fim = 103 ticks, contra o teto de 80.
        const custo = custoNoMotorDoFluxo(g);
        expect(custo.total).toBe(103);
        expect(custo.cicloDeRepeat).toEqual({ node_id: 'r1', voltas: 20, peso: 5 });
        expect(codigos(validateFlowForPublish(g))).toEqual(['max_engine_steps_exceeded']);
      });

      it('a recusa nomeia as voltas, para a pessoa saber o que encurtar', () => {
        const r = validateFlowForPublish(repeatComVoltas(20));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.errors[0]!.message).toContain('custa 5 passos por volta');
        expect(r.errors[0]!.message).toContain('até 20 voltas');
      });

      it('a recusa nomeia a caixa pelo rótulo que a pessoa vê, não pelo id interno', () => {
        const g = repeatComVoltas(20);
        const comRotulo = graph(
          g.nodes.map((n) => (n.id === 'r1' ? { ...n, label: 'Lembretes semanais' } : n)),
          g.edges
        );
        const r = validateFlowForPublish(comRotulo);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.errors[0]!.message).toContain('a caixa "Lembretes semanais" repete');
      });

      it('com uma volta só, a culpa é da cadência: a recusa não manda reduzir voltas', () => {
        const r = validateFlowForPublish(repeatComCauda(13));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.errors[0]!.message).not.toContain('reduza as voltas');
        expect(r.errors[0]!.message).toContain('Encurte a cadência.');
      });

      it('o repeat de um ramo paralelo não leva a culpa: a recusa cita o caminho que estoura', () => {
        // Ramo A: repeat de 3 voltas curto até o fim (19 ticks). Ramo B: a cadência
        // de 13 toques (1 + 1 + 13 × 6 + 1 = 81 > 80). Quem estoura é B, e reduzir
        // as voltas de A não muda nada.
        const nodes: FlowNode[] = [
          trigger('t1'),
          condition('c1'),
          { id: 'r1', type: 'repeat', label: 'r1', position: pos, config: { max_count: 3 } },
          actionTemplate('msg1'),
          wait('w1', { mode: 'fixed', duration_ms: 300_000 }),
        ];
        const edges: FlowEdge[] = [
          edge('t1', 'c1', always()),
          edge('c1', 'r1', condResult(true)),
          edge('r1', 'msg1', ramo('body')),
          edge('msg1', 'w1', always()),
          edge('w1', 'r1', always()),
          edge('r1', 'fim', ramo('done')),
          edge('r1', 'fim', always()),
        ];
        let anterior = 'c1';
        for (let i = 1; i <= 13; i++) {
          nodes.push(
            actionTemplate(`cauda${i}`),
            marcar(`tag${i}a`, `a${i}`),
            marcar(`tag${i}b`, `b${i}`),
            wait(`espera${i}`, { mode: 'fixed', duration_ms: 300_000 })
          );
          edges.push(
            edge(anterior, `cauda${i}`, i === 1 ? condResult(false) : always()),
            edge(`cauda${i}`, `tag${i}a`, always()),
            edge(`tag${i}a`, `tag${i}b`, always()),
            edge(`tag${i}b`, `espera${i}`, always())
          );
          anterior = `espera${i}`;
        }
        nodes.push(end('fim'));
        edges.push(edge(anterior, 'fim', always()));
        const g = graph(nodes, edges);

        const custo = custoNoMotorDoFluxo(g);
        expect(custo.total).toBe(81);
        expect(custo.cicloDeRepeat).toBeNull();
        const r = validateFlowForPublish(g);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.errors.map((e) => e.code)).toContain('max_engine_steps_exceeded');
        const recusa = r.errors.find((e) => e.code === 'max_engine_steps_exceeded')!;
        expect(recusa.message).not.toContain('reduza as voltas');
        expect(recusa.message).toContain('Encurte a cadência.');
      });

      it('publica o mesmo desenho com 15 voltas: 78 ticks, dentro do orçamento', () => {
        // 1 gatilho + 15 × 5 do corpo + 1 da passada do `done` + 1 fim = 78 ≤ 80.
        expect(custoNoMotorDoFluxo(repeatComVoltas(15)).total).toBe(78);
        expect(validateFlowForPublish(repeatComVoltas(15))).toEqual({ ok: true });
      });

      it('recusa na primeira volta que passa do teto: 83 ticks com 16', () => {
        // 1 + 16 × 5 + 1 + 1 = 83. A fronteira é a volta, não o desenho.
        expect(custoNoMotorDoFluxo(repeatComVoltas(16)).total).toBe(83);
        expect(codigos(validateFlowForPublish(repeatComVoltas(16)))).toEqual(['max_engine_steps_exceeded']);
      });

      it('e a cauda depois do ciclo volta a contar (o caso do mantenedor)', () => {
        const g = repeatComCauda(13);
        expect(g.nodes.length).toBeLessThanOrEqual(60);
        // 1 (gatilho) + 5 (a volta) + 1 (o `done`) + 13 × 6 (a cauda) + 1 (fim) = 86.
        expect(custoNoMotorDoFluxo(g).total).toBe(86);
        // 28 passos SENTIDOS (13 × 2 da cauda + a mensagem e a espera do ciclo):
        // o teto dos 30 não pega este fluxo. Era o motor que morria — e a régua
        // antiga devolvia 1 para ele, porque parava na aresta que entra no ciclo.
        expect(codigos(validateFlowForPublish(g))).toEqual(['max_engine_steps_exceeded']);
      });

      it('controle negativo: sem a saída `done` o validador continua recusando', () => {
        const umaVolta = repeatComVoltas(1);
        // O controle vivo: este mesmo desenho, com a saída `done` no lugar,
        // publica — a régua não passou a recusar todo `repeat`.
        expect(validateFlowForPublish(umaVolta)).toEqual({ ok: true });

        const semDone = graph(
          umaVolta.nodes,
          umaVolta.edges.filter((e) => e.condition.type !== 'branch' || e.condition.branch_id !== 'done')
        );
        const r = validateFlowForPublish(semDone);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.errors.map((e) => [e.code, e.branch_id])).toEqual([['missing_branch_edge', 'done']]);
      });
    });
  });

  // Regression for the old per-path DFS: a width-2 "diamond" DAG re-converges
  // every layer, so the number of distinct trigger->leaf paths is 2^layers —
  // astronomically more than the old MAX_DFS_CALLS cap could enumerate for a
  // schema-legal 60-node graph, which silently truncated and could miss a
  // violation. The SCC-condensation sweep is O(V+E) regardless of path count,
  // so this must both finish fast and still catch the violator correctly.
  it('flags long_wait_needs_template in a wide reconverging DAG without blowing up', () => {
    // 27 wait layers + the action = 28 counted steps (#2896: the trigger and
    // the end stopped counting), so this exercises long_wait_needs_template in
    // isolation without also crossing the (separately regression-tested)
    // max_steps_exceeded boundary.
    const LAYERS = 27;
    const LAYER_WAIT_MS = 3_200_000; // 27 * 3.2M = 86.4M ms == 24h threshold
    const nodes: FlowNode[] = [trigger('t1')];
    const edges: FlowEdge[] = [];

    const layerId = (layer: number, branch: 'a' | 'b') => `d${layer}_${branch}`;

    for (let layer = 1; layer <= LAYERS; layer++) {
      nodes.push(wait(layerId(layer, 'a'), { mode: 'fixed', duration_ms: LAYER_WAIT_MS }));
      nodes.push(wait(layerId(layer, 'b'), { mode: 'fixed', duration_ms: LAYER_WAIT_MS }));

      const sources =
        layer === 1 ? (['t1', 't1'] as const) : ([layerId(layer - 1, 'a'), layerId(layer - 1, 'b')] as const);
      for (const source of sources) {
        edges.push(edge(source, layerId(layer, 'a'), always()));
        edges.push(edge(source, layerId(layer, 'b'), always()));
      }
    }

    nodes.push(actionAiMessage('act_bad')); // violator: no fallback_template_id
    nodes.push(actionTemplate('act_ok'));
    nodes.push(end('end_diamond'));
    for (const source of [layerId(LAYERS, 'a'), layerId(LAYERS, 'b')] as const) {
      edges.push(edge(source, 'act_bad', always()));
      edges.push(edge(source, 'act_ok', always()));
    }
    edges.push(edge('act_bad', 'end_diamond', always()));
    edges.push(edge('act_ok', 'end_diamond', always()));

    expect(nodes.length).toBe(58); // well within the schema's 60-node cap

    const start = performance.now();
    const result = validateFlowForPublish(graph(nodes, edges));
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(1000); // polynomial, not exponential
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['long_wait_needs_template']);
      expect(result.errors[0]!.node_id).toBe('act_bad');
    }
  });

  it('passes a well-formed flow using all six node types', () => {
    const g = graph(
      [
        trigger('t1'),
        wait('w1', { mode: 'fixed', duration_ms: 300_000 }),
        condition('cond1'),
        classify('cl1', ['hot', 'cold']),
        actionTemplate('a_hot'),
        actionAiMessage('a_cold', { fallback: TEMPLATE_ID }),
        end('end_won', 'converted'),
        end('end_lost', 'exhausted'),
      ],
      [
        edge('t1', 'w1', always()),
        edge('w1', 'cond1', always()),
        edge('cond1', 'cl1', condResult(true)),
        edge('cond1', 'end_lost', condResult(false)),
        edge('cl1', 'a_hot', classMatch('hot')),
        edge('cl1', 'a_cold', classMatch('cold')),
        edge('cl1', 'end_lost', classMatch('no_reply')),
        edge('cl1', 'end_lost', always()),
        edge('a_hot', 'end_won', always()),
        edge('a_cold', 'end_won', always()),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(true);
  });
});

/**
 * Cobertura por ramo no modo 'per_check'. A regra é NOVA e vale só para a forma
 * nova: um nó de condição combinado continua publicando sob as mesmas exigências
 * de sempre, senão o publish passaria a reprovar fluxo que já está rodando.
 */
describe('validateFlowForPublish — cobertura por ramo (per_check)', () => {
  const VIP = { id: 'chk_vip', label: 'Cliente VIP', field: 'tag' as const, op: 'contains' as const, value: 'vip' };
  const FRIO = { id: 'chk_frio', field: 'steps_taken' as const, op: 'gte' as const, value: 3 };
  const branch = (branchId: string): FlowEdge['condition'] => ({ type: 'branch', branch_id: branchId });

  function perCheck(id: string): FlowNode {
    return {
      id,
      type: 'condition',
      label: id,
      position: pos,
      config: { combinator: 'and', branching: 'per_check', checks: [VIP, FRIO] },
    };
  }

  /** trigger -> c1 -> (ramos) -> end. `extra` são as arestas de saída do nó de condição. */
  function comRamos(extra: FlowEdge[]): FlowGraph {
    return graph(
      [trigger('t1'), perCheck('c1'), end('fim')],
      [edge('t1', 'c1', always()), ...extra]
    );
  }

  it('publica quando toda saída, inclusive a de "nenhuma delas", tem destino', () => {
    const result = validateFlowForPublish(
      comRamos([
        edge('c1', 'fim', branch('chk_vip')),
        edge('c1', 'fim', branch('chk_frio')),
        edge('c1', 'fim', always()),
      ])
    );
    expect(result).toEqual({ ok: true });
  });

  it('reprova nomeando a REGRA que ficou sem saída, não "o nó está incompleto"', () => {
    const result = validateFlowForPublish(
      comRamos([edge('c1', 'fim', branch('chk_vip')), edge('c1', 'fim', always())])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const semSaida = result.errors.filter((e) => e.code === 'missing_branch_edge');
    expect(semSaida).toHaveLength(1);
    expect(semSaida[0]!.branch_id).toBe('chk_frio');
    expect(semSaida[0]!.node_id).toBe('c1');
  });

  it('usa o rótulo que o usuário escreveu na mensagem', () => {
    const result = validateFlowForPublish(
      comRamos([edge('c1', 'fim', branch('chk_frio')), edge('c1', 'fim', always())])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.find((e) => e.branch_id === 'chk_vip')!.message).toContain('Cliente VIP');
  });

  it('sem rótulo, quem descreve a regra é o vocabulário — nunca o id cru', () => {
    const result = validateFlowForPublish(
      comRamos([edge('c1', 'fim', branch('chk_vip')), edge('c1', 'fim', always())])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const msg = result.errors.find((e) => e.branch_id === 'chk_frio')!.message;
    expect(msg).not.toContain('chk_frio');
    expect(msg).not.toContain('steps_taken');
    expect(msg).toMatch(/passos/i);
  });

  it('reprova quando falta a saída "nenhuma delas" — é ela que impede lead parado', () => {
    const result = validateFlowForPublish(
      comRamos([edge('c1', 'fim', branch('chk_vip')), edge('c1', 'fim', branch('chk_frio'))])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const semEscape = result.errors.filter((e) => e.code === 'missing_always_fallback');
    expect(semEscape).toHaveLength(1);
    expect(semEscape[0]!.branch_id).toBe('else');
  });

  it('NÃO aplica a regra nova a um nó combinado — fluxo v1 publica como sempre publicou', () => {
    // Mesmas duas regras, modo de hoje, e só a saída do "sim" ligada: sob a regra
    // do per_check isto teria 2 erros. Em combinado tem que continuar passando.
    const combinado: FlowNode = {
      id: 'c1',
      type: 'condition',
      label: 'c1',
      position: pos,
      config: { combinator: 'and', checks: [VIP, FRIO] },
    };
    const g = graph(
      [trigger('t1'), combinado, end('fim')],
      [edge('t1', 'c1', always()), edge('c1', 'fim', condResult(true))]
    );
    expect(validateFlowForPublish(g)).toEqual({ ok: true });
  });
});

/**
 * Terceira ocorrência da mesma classe de defeito, apontada pelo DevVivo: a
 * cobertura de classes exigia aresta `class_match` por classe e para
 * `no_reply`. Num nó já migrado para ramos nomeados as arestas são `branch` —
 * então um grafo VÁLIDO era reprovado no publish, e o operador ficava sem
 * conseguir publicar sem entender por quê.
 */
describe('validateFlowForPublish — cobertura por ramo num ai_classify migrado', () => {
  const RAMOS = [
    { id: 'br_quente', label: 'quente' },
    { id: 'br_frio', label: 'frio' },
  ];
  const branch = (branchId: string): FlowEdge['condition'] => ({ type: 'branch', branch_id: branchId });

  function classifyV2(id: string): FlowNode {
    return {
      id,
      type: 'ai_classify',
      label: id,
      position: pos,
      config: { classes: ['quente', 'frio'], branches: RAMOS, grace_timeout_ms: 900_000, target: 'last_reply' },
    };
  }

  function grafo(saidas: FlowEdge[]): FlowGraph {
    return graph(
      [trigger('t1'), classifyV2('ac1'), end('fim')],
      [edge('t1', 'ac1', always()), ...saidas]
    );
  }

  it('publica um grafo v2 com uma aresta por ramo — sem exigir class_match nenhum', () => {
    const result = validateFlowForPublish(
      grafo([
        edge('ac1', 'fim', branch('br_quente')),
        edge('ac1', 'fim', branch('br_frio')),
        edge('ac1', 'fim', branch('no_reply')),
        edge('ac1', 'fim', always()),
      ])
    );
    expect(result).toEqual({ ok: true });
  });

  it('reprova nomeando a CLASSE que ficou sem saída', () => {
    const result = validateFlowForPublish(
      grafo([
        edge('ac1', 'fim', branch('br_quente')),
        edge('ac1', 'fim', branch('no_reply')),
        edge('ac1', 'fim', always()),
      ])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const semSaida = result.errors.filter((e) => e.code === 'missing_branch_edge');
    expect(semSaida).toHaveLength(1);
    expect(semSaida[0]!.branch_id).toBe('br_frio');
    expect(semSaida[0]!.message).toContain('frio');
  });

  it('reprova quando falta a saída de quem não respondeu', () => {
    const result = validateFlowForPublish(
      grafo([
        edge('ac1', 'fim', branch('br_quente')),
        edge('ac1', 'fim', branch('br_frio')),
        edge('ac1', 'fim', always()),
      ])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.branch_id === 'no_reply')).toBe(true);
  });
});

describe('validateFlowForPublish — cobertura por ramo num match_reply', () => {
  const RAMOS = [
    { id: 'br_sim', label: 'Sim', op: 'eq' as const, pattern: 'sim' },
    { id: 'br_nao', label: 'Não', op: 'contains' as const, pattern: 'nao' },
  ];
  const branch = (branchId: string): FlowEdge['condition'] => ({ type: 'branch', branch_id: branchId });

  function matchV2(id: string): FlowNode {
    return {
      id,
      type: 'match_reply',
      label: id,
      position: pos,
      config: { branches: RAMOS, grace_timeout_ms: 900_000 },
    };
  }

  function grafo(saidas: FlowEdge[]): FlowGraph {
    return graph(
      [trigger('t1'), matchV2('mr1'), end('fim')],
      [edge('t1', 'mr1', always()), ...saidas]
    );
  }

  it('publica com uma aresta por ramo + no_reply + always', () => {
    const result = validateFlowForPublish(
      grafo([
        edge('mr1', 'fim', branch('br_sim')),
        edge('mr1', 'fim', branch('br_nao')),
        edge('mr1', 'fim', branch('no_reply')),
        edge('mr1', 'fim', always()),
      ])
    );
    expect(result).toEqual({ ok: true });
  });

  it('reprova ramo declarado sem saída', () => {
    const result = validateFlowForPublish(
      grafo([
        edge('mr1', 'fim', branch('br_sim')),
        edge('mr1', 'fim', branch('no_reply')),
        edge('mr1', 'fim', always()),
      ])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const semSaida = result.errors.filter((e) => e.code === 'missing_branch_edge');
    expect(semSaida).toHaveLength(1);
    expect(semSaida[0]!.branch_id).toBe('br_nao');
  });
});

describe('validateFlowForPublish — cobertura por ramo num repeat', () => {
  const branch = (branchId: string): FlowEdge['condition'] => ({ type: 'branch', branch_id: branchId });

  function repeatNode(id: string): FlowNode {
    return { id, type: 'repeat', label: id, position: pos, config: { max_count: 12 } };
  }

  it('publica com body + done + always e um wait no ciclo', () => {
    const result = validateFlowForPublish(
      graph(
        [
          trigger('t1'),
          repeatNode('rp1'),
          wait('w1', { mode: 'fixed', duration_ms: 300_000 }),
          end('fim'),
        ],
        [
          edge('t1', 'rp1', always()),
          edge('rp1', 'w1', branch('body')),
          edge('rp1', 'fim', branch('done')),
          edge('rp1', 'fim', always()),
          edge('w1', 'rp1', always()),
        ]
      )
    );
    expect(result).toEqual({ ok: true });
  });

  it('reprova sem a saída de próxima volta', () => {
    const result = validateFlowForPublish(
      graph(
        [trigger('t1'), repeatNode('rp1'), end('fim')],
        [
          edge('t1', 'rp1', always()),
          edge('rp1', 'fim', branch('done')),
          edge('rp1', 'fim', always()),
        ]
      )
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.branch_id === 'body')).toBe(true);
  });
});

/**
 * Regra que não decide nada não publica. Três formas MEDIDAS de uma regra que a
 * tela deixava com cara de pronta e o motor nunca satisfaz (ou satisfaz sempre):
 * valor vazio, número de passos que não é número, e etapa que não é etapa — a
 * clínica digitava "PAGO" e o motor compara o `stage_id`. O rascunho continua
 * aceitando tudo isso (trabalho pela metade precisa salvar); quem recusa é o
 * publish, no momento em que há alguém na tela para corrigir.
 */
describe('validateFlowForPublish — a regra precisa poder decidir', () => {
  const ETAPA_PAGO = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  const ETAPA_ARQUIVADA = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
  const ETAPA_APAGADA = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
  const etapas = new Map([
    [ETAPA_PAGO, { nome: 'Pago · Vendas', arquivada: false, isPerda: false, settingsDoFunil: null }],
    [ETAPA_ARQUIVADA, { nome: 'Antiga · Vendas', arquivada: true, isPerda: false, settingsDoFunil: null }],
  ]);
  type Check = Extract<FlowNode, { type: 'condition' }>['config']['checks'][number];

  /** trigger -> c1 -> fim, com TODA saída ligada: o único erro possível é o da regra. */
  function comRegras(checks: Check[], modo: 'combined' | 'per_check' = 'combined'): FlowGraph {
    const porRegra = modo === 'per_check';
    const c1: FlowNode = {
      id: 'c1',
      type: 'condition',
      label: 'c1',
      position: pos,
      config: {
        combinator: 'and',
        ...(porRegra ? { branching: 'per_check' as const } : {}),
        checks: porRegra ? checks.map((c, i) => ({ ...c, id: `regra-${i + 1}` })) : checks,
      },
    };
    const saidas = porRegra
      ? [...checks.map((_, i) => edge('c1', 'fim', { type: 'branch', branch_id: `regra-${i + 1}` })), edge('c1', 'fim', always())]
      : [edge('c1', 'fim', condResult(true)), edge('c1', 'fim', condResult(false))];
    return graph([trigger('t1'), c1, end('fim')], [edge('t1', 'c1', always()), ...saidas]);
  }

  const codigos = (r: ReturnType<typeof validateFlowForPublish>) => (r.ok ? [] : r.errors.map((e) => e.code));

  it('regra sem valor reprova nos dois modos, e no modo por regra aponta a saída', () => {
    const vazia: Check = { field: 'tag', op: 'eq', value: '  ' };
    expect(codigos(validateFlowForPublish(comRegras([vazia]), { etapas }))).toEqual(['empty_check_value']);

    const r = validateFlowForPublish(comRegras([{ field: 'tag', op: 'eq', value: 'vip' }, vazia], 'per_check'), { etapas });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ node_id: 'c1', code: 'empty_check_value', branch_id: 'regra-2' });
    expect(r.errors[0]!.message).toMatch(/Regra 2/);
  });

  it('passos com texto que não é número reprova; o número digitado como texto passa', () => {
    expect(codigos(validateFlowForPublish(comRegras([{ field: 'steps_taken', op: 'gte', value: 'três' }]), { etapas }))).toEqual([
      'check_value_not_number',
    ]);
    expect(validateFlowForPublish(comRegras([{ field: 'steps_taken', op: 'gte', value: '3' }]), { etapas })).toEqual({ ok: true });
    // O motor compara 2.5 sem problema: recusar seria recusar o que funciona.
    expect(validateFlowForPublish(comRegras([{ field: 'steps_taken', op: 'lte', value: 2.5 }]), { etapas })).toEqual({ ok: true });
  });

  it('etapa digitada pelo nome (fluxo antigo) reprova pedindo para escolher na lista', () => {
    const r = validateFlowForPublish(comRegras([{ field: 'lead_stage', op: 'eq', value: 'PAGO' }]), { etapas });
    expect(codigos(r)).toEqual(['check_stage_not_found']);
    if (r.ok) return;
    expect(r.errors[0]!.message).toContain('PAGO');
    expect(r.errors[0]!.message).toMatch(/escolha a etapa/i);
  });

  it('etapa apagada reprova sem ecoar o identificador', () => {
    const r = validateFlowForPublish(comRegras([{ field: 'lead_stage', op: 'neq', value: ETAPA_APAGADA }]), { etapas });
    expect(codigos(r)).toEqual(['check_stage_not_found']);
    if (r.ok) return;
    expect(r.errors[0]!.message).not.toContain(ETAPA_APAGADA);
  });

  it('etapa arquivada reprova — nenhum negócio fica nela, a regra nunca decide', () => {
    const r = validateFlowForPublish(comRegras([{ field: 'lead_stage', op: 'eq', value: ETAPA_ARQUIVADA }]), { etapas });
    expect(codigos(r)).toEqual(['check_stage_archived']);
    if (r.ok) return;
    expect(r.errors[0]!.message).toContain('Antiga · Vendas');
  });

  it('etapa ativa publica, e outra falha no mesmo nó fala o NOME da etapa, nunca o id', () => {
    expect(validateFlowForPublish(comRegras([{ field: 'lead_stage', op: 'eq', value: ETAPA_PAGO }]), { etapas })).toEqual({ ok: true });

    const semSaida = comRegras([{ field: 'lead_stage', op: 'eq', value: ETAPA_PAGO }], 'per_check');
    semSaida.edges = semSaida.edges.filter((e) => e.condition.type !== 'branch');
    const r = validateFlowForPublish(semSaida, { etapas });
    expect(codigos(r)).toEqual(['missing_branch_edge']);
    if (r.ok) return;
    expect(r.errors[0]!.message).toContain('Pago · Vendas');
    expect(r.errors[0]!.message).not.toContain(ETAPA_PAGO);
  });

  it('sem a lista de etapas a etapa não é conferida — só quem lê o banco pode dizer se ela existe', () => {
    expect(validateFlowForPublish(comRegras([{ field: 'lead_stage', op: 'eq', value: 'PAGO' }]))).toEqual({ ok: true });
  });
});

describe('publish por superfície (roteiro de atendimento, #1130)', () => {
  function pergunta(id: string, key = id): FlowNode {
    return {
      id,
      type: 'collect',
      label: id,
      position: pos,
      config: { key, label: id, type: 'text', required: true, permite_correcao: true },
    };
  }
  const codigos = (g: FlowGraph, surface?: 'followup' | 'atendimento') => {
    const r = validateFlowForPublish(g, surface ? { surface } : {});
    return r.ok ? [] : r.errors.map((e) => e.code);
  };

  it('roteiro linear início → pergunta → fim publica', () => {
    const g = graph(
      [trigger('t'), pergunta('nome'), end('f', 'converted')],
      [edge('t', 'nome', always()), edge('nome', 'f', always())],
    );
    expect(validateFlowForPublish(g, { surface: 'atendimento' })).toEqual({ ok: true });
  });

  it('roteiro com espera é recusado com a caixa nomeada', () => {
    const g = graph(
      [trigger('t'), wait('w', { mode: 'fixed', duration_ms: 3_600_000 }), end('f')],
      [edge('t', 'w', always()), edge('w', 'f', always())],
    );
    expect(codigos(g, 'atendimento')).toContain('no_fora_da_superficie');
  });

  it('follow-up com pergunta é recusado (o relógio não pergunta)', () => {
    const g = graph(
      [trigger('t'), pergunta('nome'), end('f')],
      [edge('t', 'nome', always()), edge('nome', 'f', always())],
    );
    expect(codigos(g)).toContain('no_fora_da_superficie');
    expect(codigos(g, 'followup')).toContain('no_fora_da_superficie');
  });

  it('roteiro que ramifica é recusado', () => {
    const g = graph(
      [trigger('t'), pergunta('a'), pergunta('b'), end('f')],
      [edge('t', 'a', always()), edge('t', 'b', always()), edge('a', 'f', always()), edge('b', 'f', always())],
    );
    expect(codigos(g, 'atendimento')).toContain('roteiro_ramificado');
  });

  it('duas perguntas no mesmo campo são recusadas', () => {
    const g = graph(
      [trigger('t'), pergunta('a', 'cidade'), pergunta('b', 'cidade'), end('f')],
      [edge('t', 'a', always()), edge('a', 'b', always()), edge('b', 'f', always())],
    );
    expect(codigos(g, 'atendimento')).toContain('campo_repetido');
  });

  describe('encadeamento em ciclo (revisão do #1573)', () => {
    const encadeiaPara = (fluxo: string): FlowNode => ({
      id: 'f',
      type: 'end',
      label: 'f',
      position: pos,
      config: { outcome: 'converted', ao_finalizar: { tipo: 'proximo_fluxo', fluxo } },
    });
    const roteiroQueVaiPara = (fluxo: string) =>
      graph([trigger('t'), pergunta('a'), encadeiaPara(fluxo)], [edge('t', 'a', always()), edge('a', 'f', always())]);
    const ctx = (encadeamentos: Array<[string, string[]]>) => ({
      surface: 'atendimento' as const,
      roteiro: {
        pointerId: 'A',
        encadeamentos: new Map(encadeamentos.map(([id, proximos]) => [id, { nome: `Roteiro ${id}`, proximos }])),
      },
    });
    const erros = (g: FlowGraph, c: ReturnType<typeof ctx>) => {
      const r = validateFlowForPublish(g, c);
      return r.ok ? [] : r.errors;
    };

    it('⭐ A → B → A é recusado no Fim, com a cadeia na mensagem', () => {
      const e = erros(roteiroQueVaiPara('B'), ctx([['B', ['A']]]));
      expect(e.map((x) => x.code)).toEqual(['roteiro_em_ciclo']);
      expect(e[0]!.node_id).toBe('f');
      expect(e[0]!.message).toContain('este roteiro → Roteiro B → este roteiro');
    });

    it('A → B → C → A também (ciclo longo)', () => {
      expect(erros(roteiroQueVaiPara('B'), ctx([['B', ['C']], ['C', ['A']]])).map((x) => x.code)).toEqual([
        'roteiro_em_ciclo',
      ]);
    });

    it('A → A é recusado', () => {
      expect(erros(roteiroQueVaiPara('A'), ctx([])).map((x) => x.code)).toEqual(['roteiro_em_ciclo']);
    });

    it('A → B → C (sem volta) passa, e ciclo entre OUTROS (B ↔ C) não trava a busca', () => {
      expect(erros(roteiroQueVaiPara('B'), ctx([['B', ['C']], ['C', []]]))).toEqual([]);
      expect(erros(roteiroQueVaiPara('B'), ctx([['B', ['C']], ['C', ['B']]]))).toEqual([]);
    });
  });
});

/**
 * #2065 — os nós de ação no publish, com o contexto montado como a rota monta:
 * o banco só devolve as etapas que `idsDeEtapaCitados` pediu. Antes do conserto
 * essa função só olhava nós de condição, e todo `move_lead` lia como "etapa que
 * não existe mais" — nenhum fluxo com a caixa conseguia ser publicado.
 */
describe('validateFlowForPublish — nós de ação (#2065)', () => {
  const ATIVA = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  const ARQUIVADA = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
  const banco = new Map([
    [ATIVA, { nome: 'Proposta · Vendas', arquivada: false, isPerda: false, settingsDoFunil: null }],
    [ARQUIVADA, { nome: 'Antiga · Vendas', arquivada: true, isPerda: false, settingsDoFunil: null }],
  ]);
  const codigos = (r: ReturnType<typeof validateFlowForPublish>) => (r.ok ? [] : r.errors.map((e) => e.code));

  function comAcao(acao: FlowNode): FlowGraph {
    return graph([trigger('t1'), acao, end('fim')], [edge('t1', acao.id, always()), edge(acao.id, 'fim', always())]);
  }
  const mover = (stage_id: string): FlowNode => ({ id: 'm1', type: 'move_lead', label: 'Mover', position: pos, config: { stage_id } });
  const marcar = (tags: string[]): FlowNode => ({ id: 'g1', type: 'edit_lead_tag', label: 'Tag', position: pos, config: { tags } });

  /** O que `carregaEtapasCitadas` faz, sem Postgres: consulta só os ids citados. */
  function publicar(g: FlowGraph) {
    const etapas = new Map(idsDeEtapaCitados(g.nodes).flatMap((id) => (banco.has(id) ? [[id, banco.get(id)!] as const] : [])));
    return validateFlowForPublish(g, { etapas });
  }

  it('mover para etapa ativa publica', () => {
    expect(publicar(comAcao(mover(ATIVA)))).toEqual({ ok: true });
  });

  it('mover sem etapa escolhida recusa, mesmo sem nada lido do banco', () => {
    expect(codigos(validateFlowForPublish(comAcao(mover('  '))))).toEqual(['etapa_destino_ausente']);
  });

  it('mover para etapa arquivada recusa com o nome da etapa', () => {
    const r = publicar(comAcao(mover(ARQUIVADA)));
    expect(codigos(r)).toEqual(['etapa_destino_arquivada']);
    if (r.ok) return;
    expect(r.errors[0]!.message).toContain('Antiga · Vendas');
  });

  it('tag vazia ou em branco recusa; tag escrita publica', () => {
    expect(codigos(publicar(comAcao(marcar([]))))).toEqual(['tag_ausente']);
    expect(codigos(publicar(comAcao(marcar(['vip', '  ']))))).toEqual(['tag_ausente']);
    expect(publicar(comAcao(marcar(['vip'])))).toEqual({ ok: true });
  });
});
