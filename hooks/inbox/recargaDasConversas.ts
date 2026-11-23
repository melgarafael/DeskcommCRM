import type { InfiniteData, QueryClient } from "@tanstack/react-query";

/**
 * A RECARGA QUE O REALTIME PEDE, AGRUPADA — e sem cancelar a busca em voo.
 *
 * Uma única mensagem que chega gera uma RAJADA de eventos (o INSERT em
 * `messages` e várias escritas em `conversations`), e cada evento invalidava
 * `["conversations"]` na hora. `invalidateQueries` cancela a busca em curso
 * (`cancelRefetch` é o padrão), então a rajada virava várias buscas da lista,
 * cada uma cancelando a anterior — no trace do CI, 5 GET em 5ms.
 *
 * O que isto NÃO é: a causa da falha intermitente do e2e
 * `encerramento-atendimento`. O controle aprovado (run 37329560310) tem a
 * MESMA rajada de 5 GET cancelados e passou; o que separou a falha (run
 * 37320609105) foi o servidor respondendo em ~4s pedidos que nunca são
 * cancelados. O ganho aqui é menos carga, não o conserto daquela asserção.
 *
 * Duas regras, e as duas importam:
 *  - a rajada vira UMA busca, que começa depois da janela;
 *  - se já há busca da lista em voo, ESPERA ela terminar e só então recarrega.
 *    Cancelar perde a resposta; não recarregar perde a escrita que chegou
 *    depois de ela começar.
 *
 * Também recarrega `["conversation", id]` — a conversa aberta que NÃO está na
 * aba atual (fechada, de outro filtro) vem só dessa busca, e nenhum evento a
 * alcançava: ela ficava velha até um F5.
 *
 * Por QueryClient, e não por hook: os dois canais do inbox (lista e mensagens)
 * pedem a mesma recarga, e agrupar só um deles deixaria o outro cancelando.
 *
 * ─── O TETO DE PÁGINAS (#4325 item 5) ───────────────────────────────────────
 * A lista é uma `useInfiniteQuery`: invalidar refaz, EM SÉRIE, todas as páginas
 * já carregadas. Quem clicou em "Carregar mais" cinco vezes pagava SEIS
 * requisições por evento — e o inbox recebe um evento por mensagem recebida,
 * por atendente com a tela aberta. Era o custo que crescia com o uso, não com
 * o volume: quanto mais o operador rolava, mais caro ficava cada mensagem nova.
 *
 * A correção é a que a issue aponta: ANTES de invalidar, cortar o cache para a
 * primeira página. Só a página 0 é refeita (1 GET, sempre), o topo da lista
 * fica correto — que é o único lugar onde uma mensagem nova aparece — e o
 * histórico antigo volta pelo botão de carregar mais, quando alguém pedir.
 *
 * Cortar em vez de `maxPages`: `maxPages` LIMITA o que a lista pode guardar (e
 * no v5 exige `getPreviousPageParam`), ou seja, muda o alcance da rolagem. O
 * corte é pontual: acontece no instante da recarga, e só nele.
 *
 * A janela de agrupamento sobe de 150 ms para 1,5 s pelo mesmo motivo que a
 * contagem: agora uma recarga custa 1 GET, e agrupar mais eventos nela custa
 * menos do que antes — o que o operador percebe é a lista parando de piscar.
 */
const JANELA_MS = 1500;
const agendadas = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

/** Uma página da lista, do jeito que o `useInfiniteQuery` a guarda. */
type PaginaDaLista = unknown;

/**
 * Corta `["conversations"]` para a primeira página, em todos os filtros que
 * estiverem em cache. Idempotente e barato: só toca em quem tem mais de uma.
 *
 * `pageParams` acompanha o corte — é ele que o `fetchNextPage` usa como
 * cursor da próxima página, e deixá-lo maior que `pages` faria o react-query
 * buscar uma página que não existe mais.
 */
export function cortarParaPrimeiraPagina(qc: QueryClient): void {
  qc.setQueriesData<InfiniteData<PaginaDaLista>>({ queryKey: ["conversations"] }, (dado) => {
    if (!dado || !Array.isArray(dado.pages) || dado.pages.length <= 1) return dado;
    return {
      ...dado,
      pages: dado.pages.slice(0, 1),
      pageParams: dado.pageParams.slice(0, 1),
    };
  });
}

export function agendarRecargaDasConversas(qc: QueryClient): void {
  if (agendadas.has(qc)) return;
  agendadas.set(qc, setTimeout(() => descarregar(qc), JANELA_MS));
}

function descarregar(qc: QueryClient): void {
  // ponytail: espera por polling na janela; sem teto — uma busca que nunca
  // termina adia a recarga até ela falhar, que é o que o cancelamento fazia pior.
  if (qc.isFetching({ queryKey: ["conversations"] }) > 0) {
    agendadas.set(qc, setTimeout(() => descarregar(qc), JANELA_MS));
    return;
  }
  agendadas.delete(qc);
  // O CORTE VEM ANTES: invalidar já dispara o refetch, e cortar depois seria
  // uma segunda busca — exatamente o que este arquivo existe para não fazer.
  cortarParaPrimeiraPagina(qc);
  void qc.invalidateQueries({ queryKey: ["conversations"] });
  void qc.invalidateQueries({ queryKey: ["conversation"] });
}
