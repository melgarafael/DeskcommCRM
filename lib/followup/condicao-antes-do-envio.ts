import type { FlowEdge, FlowNode } from "./graph-schema";
import { evaluateCondition, selectEdge, type LeadFacts } from "./node-handlers";

/**
 * A CONDIÇÃO É REAVALIADA NO INSTANTE DO ENVIO, NÃO QUANDO O FLUXO PASSOU POR ELA.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * A condição só era avaliada quando a inscrição ESTAVA no nó `condition`. O nó
 * de ação não relia nada. Num grafo normal — «está na etapa X?» → espera de 48 h
 * → manda a mensagem — o lead que saiu da etapa X durante a espera recebia a
 * mensagem de qualquer jeito: a decisão tinha dois dias de idade.
 *
 * É o caso comum, não a borda: o fluxo de "proposta sem retorno" existe
 * justamente para quem NÃO andou, e quem andou (fechou, desistiu, virou
 * cliente) é quem mais não pode receber a cobrança.
 *
 * ─── A regra ───────────────────────────────────────────────────────────────
 *
 * Antes de enfileirar o envio, o motor sobe pelas arestas a partir do nó de
 * ação, ATRAVESSANDO APENAS ESPERAS, até achar a condição que governa aquele
 * envio. Reavalia com os fatos de AGORA. Se a resposta mudou, o envio não sai e
 * o fluxo segue pelo ramo que a condição aponta agora.
 *
 * Não cancela e não mata a inscrição: "mudou de etapa" é o fluxo funcionando,
 * não defeito. Quem morre calado é ilha, e o desvio grava evento próprio
 * (`condition_revalidated`) para o dossiê dizer o que houve.
 *
 * ─── O que fica DE FORA, e por quê ─────────────────────────────────────────
 *
 * Só o modo `combined` da condição (as duas saídas Sim/Não, `cond_result`), que
 * é o de todo fluxo v1 e o dos cinco fluxos medidos. No modo `per_check` a
 * aresta referencia `branch_id`, e "qual regra roteia agora" não é um booleano
 * — reavaliar ali exigiria escolher entre N ramos, e escolher errado é pior que
 * não reavaliar. Ali a travessia devolve `null` e o comportamento é o de antes.
 *
 * Travessia com teto e com conjunto de visitados: grafo pode ter ciclo
 * (`repeat`), e subir sem freio penduraria o tick.
 */

/** Quantos nós a travessia sobe antes de desistir — espera→espera em cadeia é raro e 8 é folga. */
const MAX_SUBIDA = 8;

/** Campos que nem o fluxo nem o relógio mudam entre a condição e o envio. */
const CAMPOS_REAVALIADOS: ReadonlySet<string> = new Set(["lead_stage", "tag"]);

export interface CondicaoQueGoverna {
  condicao: Extract<FlowNode, { type: "condition" }>;
  /** O que o caminho até o envio assumiu: veio pelo ramo do Sim (`true`) ou do Não. */
  esperado: boolean;
}

/**
 * A condição que governa este envio, ou `null` quando não há uma só e
 * inequívoca — e aí nada é reavaliado.
 */
export function condicaoQueGoverna(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  idDoEnvio: string,
): CondicaoQueGoverna | null {
  let atual = idDoEnvio;
  const visitados = new Set<string>([atual]);

  for (let passo = 0; passo < MAX_SUBIDA; passo += 1) {
    const entradas = edges.filter((e) => e.target === atual);
    // Zero = nó órfão. Mais de uma = o envio é alcançado por caminhos
    // diferentes, e não há UMA condição que o governe.
    if (entradas.length !== 1) return null;

    const entrada = entradas[0]!;
    const origem = nodes.find((n) => n.id === entrada.source);
    if (!origem || visitados.has(origem.id)) return null;
    visitados.add(origem.id);

    if (origem.type === "condition") {
      // Só o modo de duas saídas. `always` numa condição é a saída de escape, e
      // escape não é promessa de nada — reavaliar seria inventar intenção.
      if (entrada.condition.type !== "cond_result") return null;
      if (origem.config.branching === "per_check") return null;
      // Só reavalia o que muda FORA do fluxo e que o relógio não mexe. Os outros
      // campos mudam por causa do próprio caminho até aqui, e reavaliá-los
      // desviaria envio legítimo:
      //  - `steps_taken` sobe a cada passo (a espera já o incrementou);
      //  - `last_outcome` o motor só carrega no nó `condition` — no envio é `null`;
      //  - `lead_date` é relativo ao relógio: "falta 3 dias → espera 3 dias"
      //    deixa de valer pela própria espera.
      if (origem.config.checks.some((c) => !CAMPOS_REAVALIADOS.has(c.field))) return null;
      return { condicao: origem, esperado: entrada.condition.value };
    }

    // Atravessa espera: é o nó que cria a defasagem que isto conserta.
    if (origem.type === "wait") {
      atual = origem.id;
      continue;
    }

    // Qualquer outro nó no caminho (classificação, menu, outra ação) é decisão
    // própria e mais recente que a condição — parar aqui é o conservador.
    return null;
  }
  return null;
}

/**
 * `null` = pode enviar (nada a reavaliar, ou a condição diz o mesmo).
 * Caso contrário, o nó para onde o fluxo deve seguir em vez de enviar.
 */
export function desvioAntesDoEnvio(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  idDoEnvio: string,
  lead: LeadFacts,
  instante: Date,
): { proximo: string; esperado: boolean; agora: boolean } | null {
  const governa = condicaoQueGoverna(nodes, edges, idDoEnvio);
  if (!governa) return null;

  const agora = evaluateCondition(governa.condicao.config, lead, instante);
  if (agora === governa.esperado) return null;

  // Para onde a condição aponta AGORA. `selectEdge` é o MESMO seletor que o
  // motor usa no nó de condição — o desvio não pode escolher aresta por outra
  // régua que a do roteamento normal.
  const saida =
    selectEdge([...edges], governa.condicao.id, { type: "cond_result", value: agora }) ??
    selectEdge([...edges], governa.condicao.id, { type: "always" });
  // Sem saída desenhada para o novo resultado, o envio NÃO sai: a condição
  // deixou de valer, e mandar a mensagem por falta de aresta seria decidir pelo
  // caminho que o operador não desenhou.
  if (!saida) return { proximo: governa.condicao.id, esperado: governa.esperado, agora };
  return { proximo: saida.target, esperado: governa.esperado, agora };
}
