import type { Stage } from "./types";

/**
 * A RÉGUA ÚNICA da ordem das etapas (#3874).
 *
 * ⚠️ POR QUE ISTO EXISTE. A ordem do funil é `crm_stages.position`, e ela já
 * era aplicada em TRÊS consultas do servidor (`/board`, `/stages`,
 * `/agent-mapping`). Do lado do cliente, porém, cada superfície confiava na
 * ordem de chegada: o quadro desenhava as colunas na ordem do array, e o
 * «Mover para…» do card listava as etapas na ordem que recebeu por prop. Duas
 * listas que hoje concordam por coincidência — e que divergem no primeiro dia
 * em que alguém alimentar uma delas com outra leitura (deep link, cache antigo,
 * troca de funil, teste).
 *
 * O sintoma de divergir é caro: o dono reordena a coluna em Configurações, o
 * quadro mostra a ordem nova e o seletor do card oferece a antiga. Ninguém
 * confia mais na tela — e a conclusão errada é «não salvou».
 *
 * Por isso a comparação mora AQUI, uma vez, e as duas superfícies a usam:
 * `KanbanBoard` (as colunas) e `KanbanCardActions` (o seletor de etapa).
 * Mudar a régua aqui muda as duas juntas; para divergirem de novo seria
 * preciso alguém escrever um segundo `sort` — que é exatamente o que este
 * arquivo existe para impedir.
 *
 * ⚠️ O DESEMPATE É `id`, não `name`. `position` é `numeric` e a reordenação
 * grava FRAÇÕES entre vizinhos (`posicaoEntre`), então empate é estado
 * possível — e dois empates ordenados por nome trocam de lugar quando alguém
 * RENOMEIA a etapa, o que confundiria «mudou a ordem» com «mudou o nome».
 * `id` é imutável e nasce único, então a ordem é estável em toda leitura.
 */
export function compararEtapasDoFunil(a: Stage, b: Stage): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** As etapas na ordem do funil. Não filtra nada: quem filtra é quem chama. */
export function ordenarEtapasDoFunil<T extends Stage>(etapas: readonly T[]): T[] {
  return [...etapas].sort(compararEtapasDoFunil);
}

/**
 * As etapas que o seletor do card pode oferecer — as MESMAS colunas do quadro,
 * na mesma ordem, sem a etapa em que o negócio já está.
 *
 * ⚠️ ETAPA ARQUIVADA (desativada) NÃO É DESTINO. Ela é histórico: some das
 * listas de criação, e oferecê-la no seletor seria reativar pela porta dos
 * fundos uma coluna que o gestor tirou do quadro — o índice parcial de
 * ganho/perda e o próprio quadro já a ignoram.
 *
 * ⚠️ MAS A ETAPA ATUAL SAI POR ID, ANTES DO FILTRO DE ARQUIVADA. Um negócio
 * cuja etapa foi desativada por fora (importação, escrita direta no banco,
 * restauração) continua no card, e o seletor precisa mostrar as opções de
 * SAÍDA dele. Filtrar por arquivada primeiro esconderia o card da lista sem
 * movimento possível; a ordem correta é: remove a atual, remove as inativas.
 */
export function etapasParaMover<T extends Stage>(
  etapas: readonly T[],
  etapaAtualId: string | null | undefined,
): T[] {
  return ordenarEtapasDoFunil(etapas).filter(
    (e) => e.id !== etapaAtualId && !e.is_archived,
  );
}
