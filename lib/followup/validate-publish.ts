import type { FlowGraph, FlowEdge, FlowNode, NodeType } from './graph-schema';
import type { FollowupFlowSurface } from './api-schemas';
import { branchIdForCondition, nodeBranches } from './graph-schema';
import { rotuloDoRamo } from './rotulo-do-ramo';
import type { NomesDeValor } from './vocabulario';

/**
 * Structural publish validator for follow-up flow graphs.
 * Checks are purely structural (reachability, coverage, cycles) — no DB access.
 * What only the database knows (which stages exist) arrives injected through
 * `ContextoDoPublish`, so this stays a pure function.
 */

export const PUBLISH_ERROR_CODES = [
  'no_trigger',
  'multiple_triggers',
  'unreachable_node',
  'no_end_path',
  'missing_class_edge',
  'missing_branch_edge',
  'missing_no_reply_edge',
  'missing_always_fallback',
  'empty_check_value',
  'check_value_not_number',
  'check_stage_not_found',
  'check_stage_archived',
  'grace_too_short',
  'long_wait_needs_template',
  'immune_wait_too_short',
  'cycle_without_wait',
  'max_steps_exceeded',
  'no_fora_da_superficie',
  'roteiro_ramificado',
  'campo_repetido',
  'roteiro_em_ciclo',
] as const;
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

export type PublishValidationError = {
  node_id: string | null;
  code: PublishErrorCode;
  message: string;
  /** Qual saída do nó ficou descoberta — o editor ancora o aviso na bolinha certa, não no nó inteiro. */
  branch_id?: string;
};

export type PublishValidationResult =
  | { ok: true }
  | { ok: false; errors: PublishValidationError[] };

/**
 * O que só o banco sabe, lido por quem chama (a rota de publish). Ausente, a
 * conferência que depende dele não roda — nunca adivinha.
 */
export interface ContextoDoPublish {
  /** Etapas da organização por `stage_id`, com o nome como a tela mostra («Etapa · Funil»). */
  etapas?: ReadonlyMap<string, { nome: string; arquivada: boolean }>;
  /** Superfície do pointer. Ausente = follow-up (o que a coluna tem por padrão). */
  surface?: FollowupFlowSurface;
  /**
   * Roteiro: o id do que está sendo publicado e, dos OUTROS roteiros ativos da
   * empresa, para onde o "ao concluir" de cada um encadeia (versão publicada).
   * Com os dois, a publicação que FECHARIA um ciclo A → B → A é recusada — é
   * sempre a última publicação do ciclo que o fecha, então conferir só nela basta.
   */
  roteiro?: RoteiroDoPublish;
}

export interface RoteiroDoPublish {
  pointerId: string;
  encadeamentos: ReadonlyMap<string, { nome: string; proximos: readonly string[] }>;
}

/** Para onde o "ao concluir" dos Fins de um grafo encadeia (ids de ponteiro). */
export function proximosDoGrafo(graph: unknown): string[] {
  const nodes = (graph as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((n) => {
    const fim = (n as { type?: unknown; config?: { ao_finalizar?: { tipo?: unknown; fluxo?: unknown } } }).config
      ?.ao_finalizar;
    return (n as { type?: unknown }).type === 'end' && fim?.tipo === 'proximo_fluxo' && typeof fim.fluxo === 'string'
      ? [fim.fluxo]
      : [];
  });
}

/**
 * Caminho do encadeamento que volta ao próprio roteiro (nomes, para a
 * mensagem), ou `null`. Sem isto dois roteiros que se apontam recomeçam um ao
 * outro a cada conclusão, e o cliente responde as mesmas perguntas sem fim.
 */
function cicloDoEncadeamento(
  graph: FlowGraph,
  roteiro: RoteiroDoPublish,
): string[] | null {
  const visitados = new Set<string>();
  const busca = (id: string, caminho: string[]): string[] | null => {
    if (id === roteiro.pointerId) return caminho;
    if (visitados.has(id)) return null;
    visitados.add(id);
    const outro = roteiro.encadeamentos.get(id);
    if (!outro) return null;
    for (const prox of outro.proximos) {
      const achou = busca(prox, [...caminho, roteiro.encadeamentos.get(prox)?.nome ?? 'este roteiro']);
      if (achou) return achou;
    }
    return null;
  };
  for (const prox of proximosDoGrafo(graph)) {
    const achou = busca(prox, [roteiro.encadeamentos.get(prox)?.nome ?? 'este roteiro']);
    if (achou) return achou;
  }
  return null;
}

/**
 * Os tipos de nó que cada superfície EXECUTA. É a mesma lista que a paleta do
 * editor oferece: o que um motor não sabe rodar, a tela não deixa pôr.
 *
 * O roteiro de atendimento (`lib/followup/atendimento.ts`) percorre só
 * início → pergunta/skill → fim, em linha. O relógio do follow-up nunca vê
 * `collect`/`skill` — no motor dele, os dois são passagem (`node-handlers.ts`),
 * e publicar um fluxo de retomada com pergunta seria fluxo com passo mudo.
 * Na prova prática do #1130 a paleta do roteiro oferecia seis caixas que o motor
 * recusava em silêncio; a recusa aqui é o erro que a pessoa lê no editor.
 */
export const NOS_DA_SUPERFICIE: Record<FollowupFlowSurface, readonly NodeType[]> = {
  followup: ['trigger', 'wait', 'condition', 'ai_classify', 'match_reply', 'repeat', 'action', 'end'],
  crm_automation: ['trigger', 'wait', 'condition', 'ai_classify', 'match_reply', 'repeat', 'action', 'end'],
  atendimento: ['trigger', 'collect', 'skill', 'end'],
};

/** Regras do roteiro de atendimento que o grafo sozinho não carrega. */
function validarSuperficie(
  graph: FlowGraph,
  surface: FollowupFlowSurface,
  errors: PublishValidationError[],
  roteiro?: RoteiroDoPublish,
): void {
  const permitidos = new Set<NodeType>(NOS_DA_SUPERFICIE[surface]);
  for (const n of [...graph.nodes].sort(byId)) {
    if (!permitidos.has(n.type)) {
      errors.push({
        node_id: n.id,
        code: 'no_fora_da_superficie',
        message:
          surface === 'atendimento'
            ? `A caixa "${n.label}" não é de roteiro de atendimento — use Pergunta, Skill e Fim.`
            : `A caixa "${n.label}" é de roteiro de atendimento e não roda num follow-up.`,
      });
    }
  }
  if (surface !== 'atendimento') return;

  const saidas = new Map<string, number>();
  for (const e of graph.edges) {
    saidas.set(e.source, (saidas.get(e.source) ?? 0) + 1);
    if (e.condition.type !== 'always') {
      errors.push({
        node_id: e.source,
        code: 'roteiro_ramificado',
        message: 'No roteiro de atendimento as caixas são ligadas direto, sem condição.',
      });
    }
  }
  for (const [origem, n] of [...saidas.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (n > 1) {
      errors.push({
        node_id: origem,
        code: 'roteiro_ramificado',
        message: 'O roteiro de atendimento segue uma linha só: cada caixa liga em uma próxima.',
      });
    }
  }
  const chaves = new Map<string, string>();
  for (const n of [...graph.nodes].sort(byId)) {
    if (n.type !== 'collect') continue;
    const dona = chaves.get(n.config.key);
    if (dona !== undefined) {
      errors.push({
        node_id: n.id,
        code: 'campo_repetido',
        message: `O campo "${n.config.key}" já é perguntado em outra caixa — cada pergunta grava um campo diferente.`,
      });
    } else {
      chaves.set(n.config.key, n.id);
    }
  }
  if (roteiro) {
    const ciclo = cicloDoEncadeamento(graph, roteiro);
    if (ciclo) {
      const fim = [...graph.nodes].sort(byId).find((n) => proximosDoGrafo({ nodes: [n] }).length > 0);
      errors.push({
        node_id: fim?.id ?? null,
        code: 'roteiro_em_ciclo',
        message: `O "ao concluir" volta a este roteiro pela cadeia (${['este roteiro', ...ciclo].join(' → ')}) — o cliente responderia as mesmas perguntas sem fim. Escolha outro roteiro ou "Nada".`,
      });
    }
  }
}

const LONG_WAIT_THRESHOLD_MS = 86_400_000; // 24h
const MIN_CYCLE_WAIT_MS = 300_000; // 5min
const MAX_PATH_STEPS = 30;

function waitMs(config: Extract<FlowNode, { type: 'wait' }>['config']): number {
  return config.mode === 'fixed' ? config.duration_ms : config.max_ms;
}

/** A wait node whose duration meets the 5min floor required to break a cycle. */
function isSufficientWaitNode(node: FlowNode): boolean {
  if (node.type === 'match_reply') return node.config.grace_timeout_ms >= MIN_CYCLE_WAIT_MS;
  if (node.type !== 'wait') return false;
  return node.config.mode === 'fixed'
    ? node.config.duration_ms >= MIN_CYCLE_WAIT_MS
    : node.config.min_ms >= MIN_CYCLE_WAIT_MS;
}

function buildOutEdges(edges: FlowEdge[]): Map<string, FlowEdge[]> {
  const map = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    const list = map.get(edge.source);
    if (list) list.push(edge);
    else map.set(edge.source, [edge]);
  }
  return map;
}

function bfsReachable(startIds: string[], outEdges: Map<string, FlowEdge[]>): Set<string> {
  const visited = new Set<string>(startIds);
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of outEdges.get(id) ?? []) {
      if (!visited.has(edge.target)) {
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return visited;
}

/**
 * Tarjan strongly-connected-components. Returned components are in the
 * algorithm's natural finishing order, which is the REVERSE of a topological
 * order of the condensation DAG (a component finishes only after every
 * component reachable from it has already finished). Callers that need a
 * source-to-sink sweep should iterate the result back-to-front.
 */
function stronglyConnectedComponents(
  nodeIds: string[],
  outEdges: Map<string, FlowEdge[]>
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function strongconnect(v: string) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const edge of outEdges.get(v) ?? []) {
      const w = edge.target;
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (const id of nodeIds) {
    if (!indices.has(id)) strongconnect(id);
  }
  return components;
}

/**
 * Whether a component (as returned by stronglyConnectedComponents) is an
 * actual cycle in `outEdges`: more than one node, or a single node with a
 * self-loop.
 */
function isCycleComponent(component: string[], outEdges: Map<string, FlowEdge[]>): boolean {
  if (component.length > 1) return true;
  const onlyId = component[0]!; // Tarjan never yields an empty component
  return (outEdges.get(onlyId) ?? []).some((e) => e.target === onlyId);
}

/**
 * SCC condensation + topological forward sweep from the trigger, computing —
 * per component reachable from it — the MAX accumulated wait (fixed ->
 * duration_ms, smart -> max_ms) and MAX accumulated step count over any path
 * from the trigger. A component's own internal wait/step total is counted
 * once no matter how many original-graph cycles loop inside it (implements
 * "cycles count 1 iteration"). Polynomial (O(V+E)): no per-path enumeration,
 * so branching/reconverging DAGs can't blow it up.
 *
 * ponytail: dentro de um SCC multi-ramo o total soma TODOS os waits/nós do
 * componente — upper bound conservador (nunca aceita grafo ruim; pode gerar
 * 422 a mais num SCC com sub-loops independentes). Máximo exato por caminho
 * simples é NP-difícil; upgrade só se 422 falso-positivo aparecer na prática.
 */
function analyzeCondensedPaths(
  startId: string,
  nodes: FlowNode[],
  nodesById: Map<string, FlowNode>,
  outEdges: Map<string, FlowEdge[]>
): { longWaitNodeIds: Set<string>; maxStepsExceeded: boolean } {
  const longWaitNodeIds = new Set<string>();
  let maxStepsExceeded = false;

  const components = stronglyConnectedComponents(
    nodes.map((n) => n.id),
    outEdges
  );
  const componentIndexById = new Map<string, number>();
  components.forEach((comp, idx) => comp.forEach((id) => componentIndexById.set(id, idx)));

  const waitWeight = components.map((comp) =>
    comp.reduce((sum, id) => {
      const node = nodesById.get(id);
      return node && node.type === 'wait' ? sum + waitMs(node.config) : sum;
    }, 0)
  );
  const stepWeight = components.map((comp) => comp.length);

  const condOut = new Map<number, Set<number>>();
  for (const edgeList of outEdges.values()) {
    for (const edge of edgeList) {
      const cu = componentIndexById.get(edge.source);
      const cv = componentIndexById.get(edge.target);
      if (cu === undefined || cv === undefined || cu === cv) continue;
      const succs = condOut.get(cu);
      if (succs) succs.add(cv);
      else condOut.set(cu, new Set([cv]));
    }
  }

  const startComp = componentIndexById.get(startId);
  if (startComp === undefined) return { longWaitNodeIds, maxStepsExceeded };

  const arriveWait = new Map<number, number>([[startComp, 0]]);
  const arriveSteps = new Map<number, number>([[startComp, 0]]);

  // components[] is in reverse-topological (Tarjan finishing) order; walking
  // it back-to-front visits every predecessor component before its successors.
  for (let idx = components.length - 1; idx >= 0; idx--) {
    const arrivedWait = arriveWait.get(idx);
    if (arrivedWait === undefined) continue; // not reachable from the trigger
    const arrivedSteps = arriveSteps.get(idx)!;

    const totalWait = arrivedWait + waitWeight[idx]!;
    const totalSteps = arrivedSteps + stepWeight[idx]!;

    if (totalSteps > MAX_PATH_STEPS) maxStepsExceeded = true;

    for (const id of components[idx]!) {
      const node = nodesById.get(id);
      if (
        node &&
        node.type === 'action' &&
        node.config.mode === 'ai_message' &&
        !node.config.fallback_template_id &&
        totalWait >= LONG_WAIT_THRESHOLD_MS
      ) {
        longWaitNodeIds.add(id);
      }
    }

    for (const succ of condOut.get(idx) ?? []) {
      arriveWait.set(succ, Math.max(arriveWait.get(succ) ?? -Infinity, totalWait));
      arriveSteps.set(succ, Math.max(arriveSteps.get(succ) ?? -Infinity, totalSteps));
    }
  }

  return { longWaitNodeIds, maxStepsExceeded };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}


/**
 * Toda saída declarada do nó precisa levar a algum lugar, e a mensagem nomeia
 * QUAL ficou solta. Serve tanto ao `condition` por regra quanto ao
 * `ai_classify` migrado: a pergunta é a mesma — "existe aresta para este
 * ramo?" — e escrevê-la duas vezes é como a cobertura de classes ficou para
 * trás quando os ramos nasceram.
 */
function cobrirRamos(
  node: FlowNode,
  outgoing: FlowEdge[],
  errors: PublishValidationError[],
  nomes: NomesDeValor
): void {
  for (const branch of nodeBranches(node)) {
    if (outgoing.some((e) => branchIdForCondition(node, e.condition) === branch.id)) continue;
    if (branch.kind === 'fallback') {
      errors.push({
        node_id: node.id,
        code: 'missing_always_fallback',
        branch_id: branch.id,
        message: `Nó "${node.id}" não tem a saída de escape: um lead que não se encaixar em nenhuma saída fica parado aqui.`,
      });
      continue;
    }
    errors.push({
      node_id: node.id,
      code: 'missing_branch_edge',
      branch_id: branch.id,
      message: `Nó "${node.id}": a saída "${rotuloDoRamo(branch, nomes)}" não está ligada a nada.`,
    });
  }
}

/**
 * Uma regra de condição que não pode decidir nada. O rascunho aceita todas estas
 * formas — trabalho pela metade precisa salvar —, mas publicada cada uma é uma
 * saída que nunca é tomada ou que é tomada sempre, com cara de regra pronta:
 * - valor vazio: `eq` nunca casa e `neq` sempre casa;
 * - passos que não é número: maior/menor nunca é verdadeiro;
 * - etapa que não é `stage_id` de etapa ativa: o motor compara o id, então o
 *   nome digitado ("PAGO", fluxo anterior ao seletor) nunca casa, e etapa
 *   arquivada não tem negócio nenhum dentro.
 * Vale nos DOIS modos do nó: nenhuma destas formas funciona em fluxo antigo
 * também, então recusá-las não reprova nada que esteja decidindo de verdade.
 */
function conferirRegras(
  node: Extract<FlowNode, { type: 'condition' }>,
  contexto: ContextoDoPublish,
  errors: PublishValidationError[]
): void {
  node.config.checks.forEach((check, i) => {
    const regra = `Regra ${i + 1}`;
    const ancora = {
      node_id: node.id,
      ...(node.config.branching === 'per_check' && check.id !== undefined ? { branch_id: check.id } : {}),
    };
    const valor = String(check.value).trim();

    if (valor === '') {
      errors.push({ ...ancora, code: 'empty_check_value', message: `${regra} sem valor: preencha ou remova a regra.` });
      return;
    }
    // A pergunta é "o motor consegue comparar isto?", não "é inteiro?": ele
    // compara passos como número, e um valor que vira número (inclusive escrito
    // como texto) decide de verdade. Recusar 2.5 seria recusar o que funciona.
    if (check.field === 'steps_taken' && !Number.isFinite(Number(valor))) {
      errors.push({
        ...ancora,
        code: 'check_value_not_number',
        message: `${regra}: “${valor}” não é um número de passos.`,
      });
      return;
    }
    if (check.field !== 'lead_stage' || contexto.etapas === undefined) return;

    const etapa = contexto.etapas.get(valor);
    if (etapa === undefined) {
      errors.push({
        ...ancora,
        code: 'check_stage_not_found',
        // Id que não existe mais não vira texto de tela; o nome digitado à mão,
        // sim — é a única pista de qual regra a pessoa escreveu.
        message: UUID_RX.test(valor)
          ? `${regra}: a etapa escolhida não existe mais — escolha a etapa na lista.`
          : `${regra}: “${valor}” não é uma etapa do funil — escolha a etapa na lista.`,
      });
      return;
    }
    if (etapa.arquivada) {
      errors.push({
        ...ancora,
        code: 'check_stage_archived',
        // "está arquivada" é o que o banco disse; "nenhum negócio fica nela" era
        // afirmação que o produto NÃO garante (mover um lead de volta não é barrado).
        message: `${regra}: a etapa “${etapa.nome}” foi arquivada e não está mais no quadro — escolha uma etapa ativa.`,
      });
    }
  });
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateFlowForPublish(
  graph: FlowGraph,
  contexto: ContextoDoPublish = {}
): PublishValidationResult {
  const { nodes, edges } = graph;
  const errors: PublishValidationError[] = [];
  validarSuperficie(graph, contexto.surface ?? 'followup', errors, contexto.roteiro);
  const etapas = contexto.etapas;
  const nomes: NomesDeValor = etapas ? { etapa: (id) => etapas.get(id)?.nome ?? null } : {};
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const outEdges = buildOutEdges(edges);
  const inEdges = buildOutEdges(edges.map((e) => ({ ...e, source: e.target, target: e.source })));

  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) {
    errors.push({
      node_id: null,
      code: 'no_trigger',
      message: 'O fluxo precisa de exatamente um nó trigger.',
    });
  }
  if (triggers.length > 1) {
    for (const extra of triggers.slice(1)) {
      errors.push({
        node_id: extra.id,
        code: 'multiple_triggers',
        message: `Nó trigger duplicado: "${extra.id}".`,
      });
    }
  }

  const startTrigger = triggers[0];
  if (startTrigger) {
    const reachable = bfsReachable([startTrigger.id], outEdges);
    for (const node of [...nodes].sort(byId)) {
      if (!reachable.has(node.id)) {
        errors.push({
          node_id: node.id,
          code: 'unreachable_node',
          message: `Nó "${node.id}" não é alcançável a partir do trigger.`,
        });
      }
    }

    const endNodes = nodes.filter((n) => n.type === 'end');
    const canReachEnd = bfsReachable(endNodes.map((n) => n.id), inEdges);
    for (const node of [...nodes].sort(byId)) {
      if (reachable.has(node.id) && !canReachEnd.has(node.id)) {
        errors.push({
          node_id: node.id,
          code: 'no_end_path',
          message: `Nó "${node.id}" não tem caminho até um nó de fim.`,
        });
      }
    }

    const { longWaitNodeIds, maxStepsExceeded } = analyzeCondensedPaths(
      startTrigger.id,
      nodes,
      nodesById,
      outEdges
    );
    for (const id of [...longWaitNodeIds].sort()) {
      errors.push({
        node_id: id,
        code: 'long_wait_needs_template',
        message: `Nó "${id}" acumula ≥24h de espera e precisa de fallback_template_id.`,
      });
    }
    if (maxStepsExceeded) {
      errors.push({
        node_id: null,
        code: 'max_steps_exceeded',
        message: `O caminho mais longo a partir do trigger excede ${MAX_PATH_STEPS} passos.`,
      });
    }
  }

  // Espera imune é para cadência LONGA. Uma imune de dez minutos prende um lead
  // no meio da conversa: ele responde, e nada no motor encurta a espera — que é
  // exatamente o que a imunidade promete, e exatamente o que ninguém quer num
  // intervalo curto. O piso é o mesmo 24h que já separa espera curta de longa.
  for (const node of [...nodes].sort(byId)) {
    if (node.type !== 'wait') continue;
    const cfg = node.config;
    if (cfg.mode !== 'fixed' || cfg.immune_to_reply !== true) continue;
    if (cfg.duration_ms < LONG_WAIT_THRESHOLD_MS) {
      errors.push({
        node_id: node.id,
        code: 'immune_wait_too_short',
        message: `Nó "${node.id}" é imune à resposta e precisa de pelo menos 24h de espera.`,
      });
    }
  }

  // Cobertura por ramo — SÓ no modo 'per_check'. É deliberado que o modo
  // combinado fique de fora: hoje nenhuma regra exige aresta por resultado num
  // nó de condição, e passar a exigir reprovaria no publish fluxos v1 que estão
  // rodando. Regra nova só vale para a forma nova.
  for (const node of [...nodes].sort(byId)) {
    if (node.type !== 'condition' || node.config.branching !== 'per_check') continue;
    const outgoing = outEdges.get(node.id) ?? [];

    cobrirRamos(node, outgoing, errors, nomes);
  }

  for (const node of [...nodes].sort(byId)) {
    if (node.type === 'condition') conferirRegras(node, contexto, errors);
  }

  for (const node of [...nodes].sort(byId)) {
    if (node.type !== 'ai_classify' && node.type !== 'match_reply' && node.type !== 'repeat') continue;
    const outgoing = outEdges.get(node.id) ?? [];

    if (node.type === 'match_reply' || node.type === 'repeat' || node.config.branches !== undefined) {
      cobrirRamos(node, outgoing, errors, nomes);
      if (node.type === 'repeat') continue;
      if (node.config.grace_timeout_ms < 900_000) {
        errors.push({
          node_id: node.id,
          code: 'grace_too_short',
          message: `Nó "${node.id}" tem grace_timeout_ms abaixo do mínimo de 15min.`,
        });
      }
      continue;
    }

    for (const cls of node.config.classes) {
      const hasEdge = outgoing.some(
        (e) => e.condition.type === 'class_match' && e.condition.value === cls
      );
      if (!hasEdge) {
        errors.push({
          node_id: node.id,
          code: 'missing_class_edge',
          message: `Nó "${node.id}" não tem edge class_match para a classe "${cls}".`,
        });
      }
    }

    const hasNoReply = outgoing.some(
      (e) => e.condition.type === 'class_match' && e.condition.value === 'no_reply'
    );
    if (!hasNoReply) {
      errors.push({
        node_id: node.id,
        code: 'missing_no_reply_edge',
        message: `Nó "${node.id}" não tem edge class_match para "no_reply".`,
      });
    }

    const hasAlways = outgoing.some((e) => e.condition.type === 'always');
    if (!hasAlways) {
      errors.push({
        node_id: node.id,
        code: 'missing_always_fallback',
        message: `Nó "${node.id}" não tem edge "always" de fallback.`,
      });
    }

    if (node.config.grace_timeout_ms < 900_000) {
      errors.push({
        node_id: node.id,
        code: 'grace_too_short',
        message: `Nó "${node.id}" tem grace_timeout_ms abaixo do mínimo de 15min.`,
      });
    }
  }

  // cycle_without_wait — exact, not an approximation: a directed cycle with no
  // sufficient-wait node exists IFF removing every sufficient-wait node still
  // leaves a cycle (SCC with >1 node, or a self-loop) in the remaining
  // subgraph. Runs independently of trigger reachability — a node can carry
  // both unreachable_node and cycle_without_wait at once; that's intentional,
  // each signal is independently actionable for the editor UI.
  const sufficientWaitIds = new Set(nodes.filter(isSufficientWaitNode).map((n) => n.id));
  const remainingIds = nodes.map((n) => n.id).filter((id) => !sufficientWaitIds.has(id));
  const remainingEdges = edges.filter(
    (e) => !sufficientWaitIds.has(e.source) && !sufficientWaitIds.has(e.target)
  );
  const remainingOutEdges = buildOutEdges(remainingEdges);
  const cycleComponents = stronglyConnectedComponents(remainingIds, remainingOutEdges);
  for (const component of cycleComponents) {
    if (!isCycleComponent(component, remainingOutEdges)) continue;
    const nodeId = [...component].sort()[0]!;
    errors.push({
      node_id: nodeId,
      code: 'cycle_without_wait',
      message: `Ciclo sem espera mínima de 5min detectado (contém "${nodeId}").`,
    });
  }

  if (errors.length === 0) return { ok: true };

  errors.sort((a, b) => {
    const rankDiff = PUBLISH_ERROR_CODES.indexOf(a.code) - PUBLISH_ERROR_CODES.indexOf(b.code);
    if (rankDiff !== 0) return rankDiff;
    return (a.node_id ?? '').localeCompare(b.node_id ?? '');
  });

  return { ok: false, errors };
}
