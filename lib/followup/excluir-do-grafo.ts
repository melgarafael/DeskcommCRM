/**
 * Tira um nó (e as arestas que tocavam nele) ou uma aresta do grafo vivo.
 * Quem chama é o canvas: o rascunho só muda depois do Salvar.
 */

export function semNo<N extends { id: string }>(nodes: N[], id: string): N[] {
  return nodes.filter((n) => n.id !== id);
}

export function semArestasDoNo<E extends { source: string; target: string }>(
  edges: E[],
  id: string,
): E[] {
  return edges.filter((e) => e.source !== id && e.target !== id);
}

export function semAresta<E extends { id: string }>(edges: E[], id: string): E[] {
  return edges.filter((e) => e.id !== id);
}
